import { describe, expect, it } from 'vitest'
import type { CodeHostProvider } from '@agentconnect.md/protocol'
import { CodeHostRefResolver } from '../src/codehost/ref-resolver.js'
import type {
  CodeHostRepositoryModule,
  ProviderAnswer,
  ProviderResolveContext,
  ProviderResolveInput,
  RepositoryReadTokens,
  RepositoryTokenAsk
} from '../src/codehost/repository.js'
import { GitCredUnavailableError } from '../src/cp/git-credential.js'

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)
const REF = 'refs/heads/main'

type Behavior = (input: ProviderResolveInput, ctx: ProviderResolveContext, call: number) => Promise<ProviderAnswer>

function fakeModule(behavior: Behavior) {
  const calls: ProviderResolveInput[] = []
  const module: CodeHostRepositoryModule = {
    provider: 'github',
    apiBaseUrl: () => 'https://api.example.test',
    readTokenAsk: () => ({ plane: 'git' }),
    resolve: async (input, ctx) => {
      calls.push(input)
      return behavior(input, ctx, calls.length)
    }
  }
  return { module, calls }
}

function fakeTokens(opts: { fail?: () => Error } = {}) {
  let minted = 0
  const invalidated: Array<{ agentId: string; ask: RepositoryTokenAsk; token: string }> = []
  const asked: string[] = []
  const tokens: RepositoryReadTokens = {
    async get(agentId) {
      asked.push(agentId)
      if (opts.fail) throw opts.fail()
      minted += 1
      return { token: `${agentId}-tok-${minted}` }
    },
    invalidate(agentId, ask, token) {
      invalidated.push({ agentId, ask, token })
    }
  }
  return { tokens, invalidated, asked }
}

function build(
  behavior: Behavior,
  extra: { tokens?: RepositoryReadTokens; maxEntries?: number; timeoutMs?: number } = {}
) {
  let clock = 1_000_000
  const mod = fakeModule(behavior)
  const tok = fakeTokens()
  const resolver = new CodeHostRefResolver({
    tokens: extra.tokens ?? tok.tokens,
    modules: (provider: CodeHostProvider) => (provider === 'gitea' ? undefined : mod.module),
    now: () => clock,
    ...(extra.maxEntries !== undefined ? { maxEntries: extra.maxEntries } : {}),
    ...(extra.timeoutMs !== undefined ? { timeoutMs: extra.timeoutMs } : {})
  })
  const resolve = (agentId = 'agent-a', externalId = '501', provider: CodeHostProvider = 'github') =>
    resolver.resolveRef({
      agentId,
      repository: { provider, externalId, cloneUrl: 'https://github.com/acme/infra', path: 'acme/infra' },
      ref: REF,
      hosts: {}
    })
  return { resolver, resolve, calls: mod.calls, tok, advance: (ms: number) => (clock += ms), now: () => clock }
}

const ok = (commit: string, etag = '"e"'): ProviderAnswer => ({
  ok: true,
  commit,
  validators: { refEtag: etag, commit }
})
const fail = (reason: 'access_denied' | 'unavailable' = 'unavailable', extra: Partial<ProviderAnswer> = {}) =>
  ({ ok: false, reason, detail: 'x', ...extra }) as ProviderAnswer

describe('CodeHostRefResolver', () => {
  it('isolates agents: each pays its own call and never sees another agent’s answer', async () => {
    const h = build(async (input) => ok(input.token.startsWith('agent-a') ? SHA_A : SHA_B))
    expect(await h.resolve('agent-a')).toMatchObject({ ok: true, commit: SHA_A })
    expect(await h.resolve('agent-b')).toMatchObject({ ok: true, commit: SHA_B })
    expect(h.calls).toHaveLength(2)
  })

  it('serves a hit within 60 s and refreshes with stored validators after', async () => {
    const h = build(async () => ok(SHA_A))
    const first = await h.resolve()
    h.advance(59_999)
    expect(await h.resolve()).toEqual(first)
    expect(h.calls).toHaveLength(1)
    h.advance(1)
    await h.resolve()
    expect(h.calls).toHaveLength(2)
    expect(h.calls[1]!.prior).toEqual({ refEtag: '"e"', commit: SHA_A })
  })

  it('runs one request per key at a time, distinct keys in parallel', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const h = build(async () => {
      await gate
      return ok(SHA_A)
    })
    const same = Promise.all([h.resolve(), h.resolve(), h.resolve()])
    const other = h.resolve('agent-a', '502')
    await new Promise((r) => setImmediate(r))
    expect(h.calls).toHaveLength(2)
    release()
    const results = await same
    expect(results.every((r) => r.ok && r.commit === SHA_A)).toBe(true)
    await other
    expect(h.calls).toHaveLength(2)
  })

  it('backs off failures 5 s, 10 s, … capped at 60 s, and a success resets the count', async () => {
    let next: ProviderAnswer = fail()
    const h = build(async () => next)
    await h.resolve()
    h.advance(4_999)
    await h.resolve()
    expect(h.calls).toHaveLength(1)
    h.advance(1)
    await h.resolve()
    expect(h.calls).toHaveLength(2)
    h.advance(9_999)
    await h.resolve()
    expect(h.calls).toHaveLength(2)
    h.advance(1)
    for (const window of [20_000, 40_000, 60_000, 60_000]) {
      await h.resolve()
      const before = h.calls.length
      h.advance(window - 1)
      await h.resolve()
      expect(h.calls).toHaveLength(before)
      h.advance(1)
    }
    next = ok(SHA_A)
    await h.resolve()
    next = fail()
    h.advance(60_000)
    await h.resolve()
    const count = h.calls.length
    h.advance(5_000)
    await h.resolve()
    expect(h.calls).toHaveLength(count + 1)
  })

  it('extends the backoff to the provider’s retry-after', async () => {
    const h = build(async () => fail('unavailable', { retryAfterMs: 120_000 }))
    await h.resolve()
    h.advance(119_999)
    await h.resolve()
    expect(h.calls).toHaveLength(1)
    h.advance(1)
    await h.resolve()
    expect(h.calls).toHaveLength(2)
  })

  it('lets a failure replace a cached success and never serves a stale success', async () => {
    let next: ProviderAnswer = ok(SHA_A)
    const h = build(async () => next)
    await h.resolve()
    next = fail('access_denied')
    h.advance(60_000)
    expect(await h.resolve()).toMatchObject({ ok: false, reason: 'access_denied' })
    h.advance(1_000)
    expect(await h.resolve()).toMatchObject({ ok: false, reason: 'access_denied' })
  })

  it('re-mints once after the host rejects the token, then gives up', async () => {
    let rejectTimes = 1
    const h = build(async () =>
      rejectTimes-- > 0 ? fail('access_denied', { tokenRejected: true, detail: 'token_rejected' }) : ok(SHA_A)
    )
    expect(await h.resolve()).toMatchObject({ ok: true })
    expect(h.tok.invalidated).toEqual([{ agentId: 'agent-a', ask: { plane: 'git' }, token: 'agent-a-tok-1' }])
    expect(h.calls.map((c) => c.token)).toEqual(['agent-a-tok-1', 'agent-a-tok-2'])

    const g = build(async () => fail('access_denied', { tokenRejected: true, detail: 'token_rejected' }))
    expect(await g.resolve()).toMatchObject({ ok: false, reason: 'access_denied' })
    expect(g.calls).toHaveLength(2)
  })

  it('maps a CP refusal to access_denied and an outage to unavailable', async () => {
    const denied = build(async () => ok(SHA_A), {
      tokens: fakeTokens({ fail: () => new GitCredUnavailableError('no', true, 'agent') }).tokens
    })
    expect(await denied.resolve()).toMatchObject({ ok: false, reason: 'access_denied' })
    expect(denied.calls).toHaveLength(0)
    const down = build(async () => ok(SHA_A), {
      tokens: fakeTokens({ fail: () => new GitCredUnavailableError('cp away', false) }).tokens
    })
    expect(await down.resolve()).toMatchObject({ ok: false, reason: 'unavailable', detail: 'credential_unavailable' })
  })

  it('reports a timed-out provider as unavailable', async () => {
    const h = build(
      (_input, ctx) =>
        new Promise((resolve) => ctx.signal.addEventListener('abort', () => resolve(fail('unavailable')))),
      { timeoutMs: 5 }
    )
    expect(await h.resolve()).toMatchObject({ ok: false, reason: 'unavailable', detail: 'timeout' })
  })

  it('refuses a host without a resolution module and does not cache it', async () => {
    const mod = fakeModule(async () => ok(SHA_A))
    let lookups = 0
    const resolver = new CodeHostRefResolver({
      tokens: fakeTokens().tokens,
      // No module on the first lookup, a real one on the second: a cached refusal would hide it.
      modules: () => (++lookups === 1 ? undefined : mod.module),
      now: () => 1_000_000
    })
    const request = {
      agentId: 'agent-a',
      repository: {
        provider: 'gitea' as const,
        externalId: '9',
        cloneUrl: 'https://gitea.com/acme/infra',
        path: 'acme/infra'
      },
      ref: REF,
      hosts: {}
    }
    expect(await resolver.resolveRef(request)).toMatchObject({
      ok: false,
      reason: 'unavailable',
      detail: 'unsupported_provider'
    })
    expect(mod.calls).toHaveLength(0)
    expect(await resolver.resolveRef(request)).toMatchObject({ ok: true, commit: SHA_A })
    expect(mod.calls).toHaveLength(1)
  })

  it('keys a commit ref on its normalized SHA so letter case shares one entry', async () => {
    const h = build(async (input) => ok(input.ref.kind === 'commit' ? input.ref.sha : SHA_B))
    const sha = 'abcdef0123'.repeat(4)
    const at = (ref: string) =>
      h.resolver.resolveRef({
        agentId: 'agent-a',
        repository: {
          provider: 'github',
          externalId: '501',
          cloneUrl: 'https://github.com/acme/infra',
          path: 'acme/infra'
        },
        ref,
        hosts: {}
      })
    expect(await at(sha.toUpperCase())).toMatchObject({ ok: true, commit: sha })
    expect(await at(sha)).toMatchObject({ ok: true, commit: sha })
    expect(h.calls).toHaveLength(1)
  })

  it('refuses an invalid ref or id before any call', async () => {
    const h = build(async () => ok(SHA_A))
    const base = {
      agentId: 'a',
      hosts: {},
      repository: { provider: 'github' as const, externalId: '1', cloneUrl: '', path: 'a/b' }
    }
    expect(await h.resolver.resolveRef({ ...base, ref: 'main' })).toMatchObject({ detail: 'invalid_ref' })
    expect(
      await h.resolver.resolveRef({ ...base, ref: REF, repository: { ...base.repository, externalId: '01' } })
    ).toMatchObject({ detail: 'invalid_repository' })
    expect(h.calls).toHaveLength(0)
  })

  it('bounds the cache, evicting the least recently used entry', async () => {
    const h = build(async () => ok(SHA_A), { maxEntries: 2 })
    await h.resolve('a', '1')
    await h.resolve('a', '2')
    await h.resolve('a', '1')
    await h.resolve('a', '3')
    expect(h.calls).toHaveLength(3)
    await h.resolve('a', '1')
    expect(h.calls).toHaveLength(3)
    await h.resolve('a', '2')
    expect(h.calls).toHaveLength(4)
  })

  it('forgetAgent drops only that agent’s entries', async () => {
    const h = build(async () => ok(SHA_A))
    await h.resolve('agent-a')
    await h.resolve('agent-b')
    h.resolver.forgetAgent('agent-a')
    await h.resolve('agent-a')
    await h.resolve('agent-b')
    expect(h.calls).toHaveLength(3)
  })

  it('never lets a call after forgetAgent join a resolution started before it', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const h = build(async (_input, _ctx, call) => {
      if (call === 1) await gate
      return ok(call === 1 ? SHA_A : SHA_B)
    })
    const before = h.resolve('agent-a')
    await new Promise((r) => setImmediate(r))
    h.resolver.forgetAgent('agent-a')
    const after = h.resolve('agent-a')
    release()
    expect(await before).toMatchObject({ ok: true, commit: SHA_A })
    expect(await after).toMatchObject({ ok: true, commit: SHA_B })
    expect(h.calls).toHaveLength(2)
    expect(await h.resolve('agent-a')).toMatchObject({ ok: true, commit: SHA_B })
    expect(h.calls).toHaveLength(2)
  })
})
