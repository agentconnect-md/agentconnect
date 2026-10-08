import { describe, expect, it } from 'vitest'
import { githubRepository } from '../src/github/repository.js'
import type { ProviderAnswer, ProviderResolveInput, RefValidators } from '../src/codehost/repository.js'

const SHA = 'A'.repeat(40)
const OTHER = 'b'.repeat(40)

interface Seen {
  url: string
  headers: Record<string, string>
}

type Reply = Response | Error | ((url: string) => Response | Error)

function harness(replies: Reply[]) {
  const seen: Seen[] = []
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    seen.push({ url, headers: { ...(init?.headers as Record<string, string>) } })
    const next = replies.shift()
    if (next === undefined) throw new Error(`unexpected request ${url}`)
    const reply = typeof next === 'function' ? next(url) : next
    if (reply instanceof Error) throw reply
    return reply
  }) as typeof globalThis.fetch
  const run = (input: Partial<ProviderResolveInput> = {}, prior?: RefValidators): Promise<ProviderAnswer> =>
    githubRepository.resolve(
      {
        apiBaseUrl: githubRepository.apiBaseUrl({}),
        repository: {
          provider: 'github',
          externalId: '501',
          cloneUrl: 'https://github.com/acme/infra',
          path: 'acme/infra'
        },
        ref: { kind: 'branch', name: 'main' },
        token: 'ghs_token',
        ...(prior ? { prior } : {}),
        ...input
      },
      { fetch, signal: new AbortController().signal, now: () => 1_000_000 }
    )
  return { seen, run }
}

const identity = (body: string, init: ResponseInit = {}) =>
  new Response(body, { status: 200, ...init, headers: { 'content-type': 'application/json', ...init.headers } })
const repo = (id = '501', fullName = 'Acme/Infra', etag = '"id-1"') =>
  identity(`{"id": ${id}, "full_name": "${fullName}", "private": true}`, { headers: { etag } })
const sha = (value: string, etag = '"ref-1"') => new Response(value, { status: 200, headers: { etag } })
const status = (code: number, headers: Record<string, string> = {}) =>
  new Response(code === 304 ? null : 'x', { status: code, headers })

describe('githubRepository.resolve', () => {
  it('checks identity by numeric id then reads the branch head with the agent token', async () => {
    const h = harness([repo(), sha(SHA)])
    const answer = await h.run()
    expect(answer).toEqual({
      ok: true,
      commit: SHA.toLowerCase(),
      ref: 'refs/heads/main',
      validators: { identityEtag: '"id-1"', identityPath: 'Acme/Infra', refEtag: '"ref-1"', commit: SHA.toLowerCase() }
    })
    expect(h.seen.map((s) => s.url)).toEqual([
      'https://api.github.com/repositories/501',
      'https://api.github.com/repos/Acme/Infra/commits/heads%2Fmain'
    ])
    expect(h.seen[0]!.headers).toMatchObject({
      authorization: 'Bearer ghs_token',
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28'
    })
    expect(h.seen[1]!.headers.accept).toBe('application/vnd.github.sha')
    expect(h.seen.every((s) => s.headers['if-none-match'] === undefined)).toBe(true)
  })

  it('revalidates with stored etags and reuses the prior commit on 304', async () => {
    const h = harness([status(304), status(304)])
    const prior = { identityEtag: '"id-1"', identityPath: 'acme/infra', refEtag: '"ref-1"', commit: OTHER }
    const answer = await h.run({}, prior)
    expect(answer).toEqual({ ok: true, commit: OTHER, ref: 'refs/heads/main', validators: prior })
    expect(h.seen.map((s) => s.headers['if-none-match'])).toEqual(['"id-1"', '"ref-1"'])
  })

  it('reads a tag through tags/<name>', async () => {
    const h = harness([repo(), sha(SHA)])
    expect(await h.run({ ref: { kind: 'tag', name: 'v1.0' } })).toMatchObject({
      ok: true,
      commit: SHA.toLowerCase(),
      ref: 'refs/tags/v1.0'
    })
    expect(h.seen[1]!.url).toBe('https://api.github.com/repos/Acme/Infra/commits/tags%2Fv1.0')
  })

  it('resolves HEAD to the default branch the identity read names, and remembers it for a 304', async () => {
    const body = (branch: string) =>
      identity(`{"id": 501, "full_name": "acme/infra", "default_branch": "${branch}"}`, { headers: { etag: '"id-2"' } })
    const h = harness([body('trunk'), sha(SHA)])
    const first = await h.run({ ref: { kind: 'default' } })
    expect(first).toMatchObject({ ok: true, commit: SHA.toLowerCase(), ref: 'refs/heads/trunk' })
    expect(h.seen[1]!.url).toBe('https://api.github.com/repos/acme/infra/commits/heads%2Ftrunk')
    if (!first.ok) throw new Error('unreachable')
    expect(first.validators.defaultBranch).toBe('trunk')

    const again = harness([status(304), status(304)])
    expect(await again.run({ ref: { kind: 'default' } }, first.validators)).toMatchObject({
      ok: true,
      ref: 'refs/heads/trunk'
    })
    // A moved default branch is another ref: its old etag is never sent.
    const moved = harness([body('main'), sha(OTHER)])
    expect(await moved.run({ ref: { kind: 'default' } }, first.validators)).toMatchObject({
      ok: true,
      commit: OTHER,
      ref: 'refs/heads/main'
    })
    expect(moved.seen[1]!.headers['if-none-match']).toBeUndefined()
  })

  it('never revalidates a HEAD ask against an identity etag that recorded no default branch', async () => {
    const h = harness([repo(), sha(SHA)])
    await h.run({ ref: { kind: 'default' } }, { identityEtag: '"id-1"', identityPath: 'acme/infra' })
    expect(h.seen[0]!.headers['if-none-match']).toBeUndefined()
  })

  it('fails HEAD as unavailable when the host names no default branch', async () => {
    expect(await harness([repo()]).run({ ref: { kind: 'default' } })).toMatchObject({
      ok: false,
      reason: 'unavailable',
      detail: 'invalid_metadata'
    })
  })

  it('asks for the workspace git token, or one scoped to a named repository', () => {
    expect(githubRepository.readTokenAsk({ externalId: '501' })).toEqual({ plane: 'git' })
    expect(githubRepository.readTokenAsk({ externalId: '501', repoFullName: 'acme/skills' })).toEqual({
      plane: 'git',
      repoFullName: 'acme/skills'
    })
  })

  it('refuses a different repository behind the id, and a renamed one', async () => {
    expect(await harness([repo('502')]).run()).toMatchObject({ ok: false, reason: 'replaced', detail: 'id_mismatch' })
    expect(await harness([repo('501', 'acme/other')]).run()).toMatchObject({
      ok: false,
      reason: 'replaced',
      detail: 'renamed'
    })
    // A stored identity whose path no longer matches the spec is just as replaced.
    expect(
      await harness([status(304)]).run({}, { identityEtag: '"id-1"', identityPath: 'acme/old', commit: OTHER })
    ).toMatchObject({ ok: false, reason: 'replaced' })
  })

  it('classifies identity failures', async () => {
    expect(await harness([status(404)]).run()).toMatchObject({ ok: false, reason: 'not_found' })
    expect(await harness([status(403)]).run()).toMatchObject({
      ok: false,
      reason: 'access_denied',
      detail: 'forbidden'
    })
    expect(await harness([status(401)]).run()).toMatchObject({
      ok: false,
      reason: 'access_denied',
      tokenRejected: true
    })
    const reset = String(1_000_000 / 1000 + 120)
    expect(await harness([status(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset })]).run()).toEqual({
      ok: false,
      reason: 'unavailable',
      detail: 'rate_limited',
      retryAfterMs: 120_000
    })
  })

  it('treats a missing ref as ref_not_found', async () => {
    expect(await harness([repo(), status(422)]).run()).toMatchObject({ ok: false, reason: 'ref_not_found' })
    expect(await harness([repo(), status(404)]).run()).toMatchObject({ ok: false, reason: 'ref_not_found' })
  })

  it('reports a network failure and a persistent 5xx as unavailable', async () => {
    const down = new Error('ECONNREFUSED')
    expect(await harness([down, down, down]).run()).toMatchObject({
      ok: false,
      reason: 'unavailable',
      detail: 'network'
    })
    expect(await harness([status(502), status(502), status(502)]).run()).toMatchObject({
      ok: false,
      reason: 'unavailable',
      detail: 'status_502'
    })
  })

  it('refuses a malformed commit body', async () => {
    expect(await harness([repo(), sha('not-a-sha')]).run()).toMatchObject({
      ok: false,
      reason: 'unavailable',
      detail: 'invalid_sha'
    })
  })

  it('takes a pinned commit as given after the identity check alone', async () => {
    const h = harness([repo()])
    expect(await h.run({ ref: { kind: 'commit', sha: OTHER } })).toMatchObject({ ok: true, commit: OTHER })
    expect(h.seen).toHaveLength(1)
  })

  it('compares ids beyond the safe-integer range exactly', async () => {
    const big = '9007199254740993'
    const ok = harness([repo(big), sha(SHA)])
    expect(
      await ok.run({ repository: { provider: 'github', externalId: big, cloneUrl: '', path: 'acme/infra' } })
    ).toMatchObject({
      ok: true
    })
    const off = harness([repo('9007199254740992')])
    expect(
      await off.run({ repository: { provider: 'github', externalId: big, cloneUrl: '', path: 'acme/infra' } })
    ).toMatchObject({
      ok: false,
      reason: 'replaced'
    })
  })
})
