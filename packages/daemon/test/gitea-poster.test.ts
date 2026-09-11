// Gitea final-answer poster (gitea-integration.md §10.1): one comment per completed turn, single-publish, auth-retry once.
import { describe, it, expect, vi } from 'vitest'
import { GiteaFinalPoster } from '../src/gitea/poster.js'
import type { PosterScheduler } from '../src/github/poster.js'

const REPO_ID = '556677'
const REPO_PATH = 'example-org/example-repo'
const BASE = 'https://gitea.example.test:8443/gitea/api/v1'

/** A hand-driven clock so the publish deadline never depends on wall time. */
function fakeScheduler(opts: { fireDeadline?: boolean } = {}) {
  const now = 0
  let nextId = 1
  const pending = new Map<number, { fn: () => void; at: number }>()
  const sched: PosterScheduler = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = nextId++
      pending.set(id, { fn, at: now + ms })
      if (opts.fireDeadline) fn()
      return id
    },
    clearTimeout: (handle) => {
      pending.delete(handle as number)
    }
  }
  return { sched }
}

interface Call {
  method: string
  url: string
  headers: Record<string, string>
  body: string
}

/** `statuses` is the per-attempt response status; anything omitted succeeds with `okBody`. */
function fakeFetch(opts: { statuses?: number[]; okBody?: string } = {}) {
  const calls: Call[] = []
  let n = 0
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const status = opts.statuses?.[n]
    n += 1
    calls.push({
      method: init?.method ?? 'GET',
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body)).body
    })
    if (status !== undefined && status >= 400) return new Response('', { status })
    return new Response(opts.okBody ?? '{"id":12345,"issue_url":"x"}', {
      status: 201,
      headers: { 'content-type': 'application/json' }
    })
  }) as typeof fetch
  return { fetchImpl, calls }
}

const log = { warn: vi.fn() }

function poster(
  deps: {
    fetchImpl: typeof fetch
    token?: () => Promise<string>
    invalidateToken?: (token: string) => void
    fireDeadline?: boolean
  },
  index = 12
) {
  return new GiteaFinalPoster(
    {
      token: deps.token ?? (async () => 'gitea-token'),
      ...(deps.invalidateToken ? { invalidateToken: deps.invalidateToken } : {}),
      log,
      apiBaseUrl: () => BASE,
      fetchImpl: deps.fetchImpl,
      scheduler: fakeScheduler({ ...(deps.fireDeadline ? { fireDeadline: true } : {}) }).sched
    },
    REPO_ID,
    REPO_PATH,
    index
  )
}

describe('GiteaFinalPoster (§10.1)', () => {
  it('posts one issue comment with the token header on the prefixed instance and reports the provider-neutral identity', async () => {
    const { fetchImpl, calls } = fakeFetch()
    const p = poster({ fetchImpl })

    const published = await p.publish('the primary is back')

    expect(published).toEqual({ provider: 'gitea', kind: 'comment', externalId: '12345' })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.url).toBe(`${BASE}/repos/${REPO_PATH}/issues/12/comments`)
    expect(calls[0]!.headers['authorization']).toBe('token gitea-token')
    expect(calls[0]!.body).toContain('the primary is back')
    expect(p.failure).toBeUndefined()
  })

  it('serves issues and pull requests on the same path — Gitea comments on either through issues', async () => {
    const { fetchImpl, calls } = fakeFetch()
    await poster({ fetchImpl }, 42).publish('answer')
    expect(calls[0]!.url).toBe(`${BASE}/repos/${REPO_PATH}/issues/42/comments`)
  })

  it('is a single-publish barrier: a second publish returns the same promise without a second POST', async () => {
    const { fetchImpl, calls } = fakeFetch()
    const p = poster({ fetchImpl })

    const first = p.publish('answer')
    const second = p.publish('a different answer')

    expect(second).toBe(first)
    expect(await first).toEqual({ provider: 'gitea', kind: 'comment', externalId: '12345' })
    expect(calls).toHaveLength(1)
  })

  it('preserves a comment id beyond the safe-integer range as a string', async () => {
    const { fetchImpl } = fakeFetch({ okBody: '{"id":9007199254740993123}' })
    expect(await poster({ fetchImpl }).publish('answer')).toEqual({
      provider: 'gitea',
      kind: 'comment',
      externalId: '9007199254740993123'
    })
  })

  it('never posts an empty or whitespace-only final, and that is a no-op rather than a failure', async () => {
    const { fetchImpl, calls } = fakeFetch()
    const nothing = poster({ fetchImpl })
    expect(await nothing.publish('')).toBeUndefined()
    expect(await poster({ fetchImpl }).publish('   \n\t ')).toBeUndefined()
    expect(await poster({ fetchImpl }).publish(undefined)).toBeUndefined()
    expect(calls).toHaveLength(0)
    expect(nothing.failure).toBeUndefined()
  })

  it('retries exactly once with a fresh token after a definite auth rejection', async () => {
    const { fetchImpl, calls } = fakeFetch({ statuses: [401] })
    const invalidated: string[] = []
    let minted = 0

    const retried = poster({
      fetchImpl,
      token: async () => `gitea-${(minted += 1)}`,
      invalidateToken: (token) => invalidated.push(token)
    })
    const published = await retried.publish('answer')

    expect(published).toEqual({ provider: 'gitea', kind: 'comment', externalId: '12345' })
    expect(invalidated).toEqual(['gitea-1'])
    expect(calls).toHaveLength(2)
    expect(calls[0]!.headers['authorization']).toBe('token gitea-1')
    expect(calls[1]!.headers['authorization']).toBe('token gitea-2')
    expect(retried.failure).toBeUndefined()
  })

  it('gives up after a second auth rejection rather than looping', async () => {
    const { fetchImpl, calls } = fakeFetch({ statuses: [401, 403] })
    const invalidated: string[] = []
    const p = poster({ fetchImpl, invalidateToken: (token) => invalidated.push(token) })
    expect(await p.publish('answer')).toBeUndefined()
    expect(calls).toHaveLength(2)
    expect(invalidated).toHaveLength(1)
    expect(p.failure).toBe('auth_rejected')
  })

  it('does not retry a server error — an ambiguous write must never double-post', async () => {
    const { fetchImpl, calls } = fakeFetch({ statuses: [500] })
    const invalidated: string[] = []
    const p = poster({ fetchImpl, invalidateToken: (token) => invalidated.push(token) })
    expect(await p.publish('answer')).toBeUndefined()
    expect(calls).toHaveLength(1)
    expect(invalidated).toHaveLength(0)
    expect(p.failure).toBe('post_failed')
  })

  it('reports token_unavailable when the effect lease is refused, post_failed on a thrown POST, publish_timeout on the deadline', async () => {
    const refused = fakeFetch()
    const p = poster({
      fetchImpl: refused.fetchImpl,
      token: async () => {
        throw new Error('LEASE_DENIED')
      }
    })
    expect(await p.publish('answer')).toBeUndefined()
    expect(refused.calls).toHaveLength(0)
    expect(p.failure).toBe('token_unavailable')

    const thrown = poster({
      fetchImpl: (async () => {
        throw new Error('ECONNRESET')
      }) as unknown as typeof fetch
    })
    expect(await thrown.publish('answer')).toBeUndefined()
    expect(thrown.failure).toBe('post_failed')

    const late = fakeFetch()
    const timedOut = poster({ fetchImpl: late.fetchImpl, fireDeadline: true })
    expect(await timedOut.publish('answer')).toBeUndefined()
    expect(late.calls).toHaveLength(0)
    expect(timedOut.failure).toBe('publish_timeout')
  })

  it('classifies a 403 with no token invalidator as auth_rejected, not as a generic post failure', async () => {
    const { fetchImpl } = fakeFetch({ statuses: [403] })
    const p = poster({ fetchImpl })
    expect(await p.publish('answer')).toBeUndefined()
    expect(p.failure).toBe('auth_rejected')
  })
})
