import { describe, expect, it } from 'vitest'
import { gitlabRepository } from '../src/gitlab/repository.js'
import type { ProviderAnswer, ProviderResolveInput, RefValidators } from '../src/codehost/repository.js'

const SHA = 'C'.repeat(40)
const OTHER = 'd'.repeat(40)

interface Seen {
  url: string
  headers: Record<string, string>
}

function harness(replies: Array<Response | Error>, gitlabHost?: string) {
  const seen: Seen[] = []
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(input), headers: { ...(init?.headers as Record<string, string>) } })
    const next = replies.shift()
    if (next === undefined) throw new Error(`unexpected request ${String(input)}`)
    if (next instanceof Error) throw next
    return next
  }) as typeof globalThis.fetch
  const run = (input: Partial<ProviderResolveInput> = {}, prior?: RefValidators): Promise<ProviderAnswer> =>
    gitlabRepository.resolve(
      {
        apiBaseUrl: gitlabRepository.apiBaseUrl(gitlabHost !== undefined ? { gitlabHost } : {}),
        repository: {
          provider: 'gitlab',
          externalId: '77',
          cloneUrl: 'https://gitlab.com/group/sub/proj.git',
          path: 'group/sub/proj'
        },
        ref: { kind: 'branch', name: 'release/1.0' },
        token: 'glpat_read',
        ...(prior ? { prior } : {}),
        ...input
      },
      { fetch, signal: new AbortController().signal, now: () => 0 }
    )
  return { seen, run }
}

const json = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...headers } })
const project = (id: number | string = 77, path = 'Group/Sub/Proj') =>
  json({ id, path_with_namespace: path }, { etag: 'W/"p1"' })
const branch = (commit: string) => json({ name: 'release/1.0', commit: { id: commit } }, { etag: 'W/"b1"' })
const status = (code: number, headers: Record<string, string> = {}) =>
  new Response(code === 304 ? null : 'x', { status: code, headers })

describe('gitlabRepository.resolve', () => {
  it('reads the project by id then the branch head with the read token', async () => {
    const h = harness([project(), branch(SHA)])
    expect(await h.run()).toEqual({
      ok: true,
      commit: SHA.toLowerCase(),
      validators: {
        identityEtag: 'W/"p1"',
        identityPath: 'Group/Sub/Proj',
        refEtag: 'W/"b1"',
        commit: SHA.toLowerCase()
      }
    })
    expect(h.seen.map((s) => s.url)).toEqual([
      'https://gitlab.com/api/v4/projects/77',
      'https://gitlab.com/api/v4/projects/77/repository/branches/release%2F1.0'
    ])
    expect(h.seen[0]!.headers['private-token']).toBe('glpat_read')
    expect(h.seen[0]!.headers.authorization).toBeUndefined()
  })

  it('keeps a self-managed instance path prefix by concatenating the API root', async () => {
    const h = harness([project(), branch(SHA)], 'https://git.example.com/gitlab/')
    expect(await h.run()).toMatchObject({ ok: true })
    expect(h.seen[0]!.url).toBe('https://git.example.com/gitlab/api/v4/projects/77')
  })

  it('reuses the prior answer on 304', async () => {
    const prior = { identityEtag: 'W/"p1"', identityPath: 'group/sub/proj', refEtag: 'W/"b1"', commit: OTHER }
    const h = harness([status(304), status(304)])
    expect(await h.run({}, prior)).toEqual({ ok: true, commit: OTHER, validators: prior })
    expect(h.seen.map((s) => s.headers['if-none-match'])).toEqual(['W/"p1"', 'W/"b1"'])
  })

  it('refuses a replaced or renamed project', async () => {
    expect(await harness([project(78)]).run()).toMatchObject({ ok: false, reason: 'replaced', detail: 'id_mismatch' })
    expect(await harness([project(77, 'group/other')]).run()).toMatchObject({
      ok: false,
      reason: 'replaced',
      detail: 'renamed'
    })
  })

  it('classifies project failures', async () => {
    expect(await harness([status(404)]).run()).toMatchObject({ ok: false, reason: 'not_found' })
    expect(await harness([status(403)]).run()).toMatchObject({ ok: false, reason: 'access_denied' })
    expect(await harness([status(401)]).run()).toMatchObject({
      ok: false,
      reason: 'access_denied',
      tokenRejected: true
    })
  })

  it('classifies branch failures', async () => {
    expect(await harness([project(), status(404)]).run()).toMatchObject({ ok: false, reason: 'ref_not_found' })
    expect(await harness([project(), status(429, { 'retry-after': '30' })]).run()).toEqual({
      ok: false,
      reason: 'unavailable',
      detail: 'rate_limited',
      retryAfterMs: 30_000
    })
    const down = new Error('ECONNRESET')
    expect(await harness([project(), down, down, down]).run()).toMatchObject({ ok: false, detail: 'network' })
    expect(await harness([project(), branch('nope')]).run()).toMatchObject({ ok: false, detail: 'invalid_sha' })
  })

  it('takes a pinned commit as given after the project check alone', async () => {
    const h = harness([project()])
    expect(await h.run({ ref: { kind: 'commit', sha: OTHER } })).toMatchObject({ ok: true, commit: OTHER })
    expect(h.seen).toHaveLength(1)
  })

  it('compares a project id beyond the safe-integer range exactly', async () => {
    const big = '9007199254740993'
    const body = `{"id": ${big}, "path_with_namespace": "group/sub/proj"}`
    const h = harness([new Response(body, { status: 200 }), branch(SHA)])
    expect(
      await h.run({ repository: { provider: 'gitlab', externalId: big, cloneUrl: '', path: 'group/sub/proj' } })
    ).toMatchObject({ ok: true })
  })

  it('asks for the glab-plane read token for the spec project', () => {
    expect(gitlabRepository.readTokenAsk({ externalId: '77' })).toEqual({
      plane: 'glab',
      provider: 'gitlab',
      externalRepoId: '77',
      requestedAccess: 'read'
    })
  })
})
