// GitLab final-answer poster (gitlab-com-integration.md 14.1): one note per completed turn, single-publish, auth-retry once.
import { describe, it, expect, vi } from 'vitest'
import { GitlabFinalPoster } from '../src/gitlab/poster.js'
import type { PosterScheduler } from '../src/github/poster.js'

const PROJECT = '4455667'

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
    return new Response(opts.okBody ?? '{"id":12345,"noteable_iid":77}', {
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
  subject: 'issue' | 'merge_request' = 'merge_request',
  iid = 77
) {
  return new GitlabFinalPoster(
    {
      token: deps.token ?? (async () => 'glpat-effect'),
      ...(deps.invalidateToken ? { invalidateToken: deps.invalidateToken } : {}),
      log,
      apiBaseUrl: () => 'https://gitlab.com/api/v4',
      fetchImpl: deps.fetchImpl,
      scheduler: fakeScheduler({ ...(deps.fireDeadline ? { fireDeadline: true } : {}) }).sched
    },
    PROJECT,
    subject,
    iid
  )
}

describe('GitlabFinalPoster (§14.1)', () => {
  it('posts one MR note with the private-token header and reports the provider-neutral identity', async () => {
    const { fetchImpl, calls } = fakeFetch()
    const p = poster({ fetchImpl })

    const published = await p.publish('the primary is back')

    expect(published).toEqual({ provider: 'gitlab', kind: 'note', externalId: '12345' })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.url).toBe(`https://gitlab.com/api/v4/projects/${PROJECT}/merge_requests/77/notes`)
    expect(calls[0]!.headers['private-token']).toBe('glpat-effect')
    expect(calls[0]!.body).toContain('the primary is back')
    expect(p.failure).toBeUndefined()
  })

  it('is a single-publish barrier: a second publish returns the same promise without a second POST', async () => {
    const { fetchImpl, calls } = fakeFetch()
    const p = poster({ fetchImpl })

    const first = p.publish('answer')
    const second = p.publish('a different answer')

    expect(second).toBe(first)
    expect(await first).toEqual({ provider: 'gitlab', kind: 'note', externalId: '12345' })
    expect(await second).toEqual(await first)
    expect(calls).toHaveLength(1)
  })

  it('preserves a note id beyond the safe-integer range as a string', async () => {
    const { fetchImpl } = fakeFetch({ okBody: '{"id":9007199254740993123,"noteable_iid":77}' })

    const published = await poster({ fetchImpl }).publish('answer')

    expect(published).toEqual({ provider: 'gitlab', kind: 'note', externalId: '9007199254740993123' })
  })

  it('never posts an empty or whitespace-only final, and that is a no-op rather than a failure', async () => {
    const empty = fakeFetch()
    const blank = fakeFetch()
    const nothing = poster({ fetchImpl: empty.fetchImpl })
    const whitespace = poster({ fetchImpl: blank.fetchImpl })
    const absent = poster({ fetchImpl: empty.fetchImpl })

    expect(await nothing.publish('')).toBeUndefined()
    expect(await whitespace.publish('   \n\t ')).toBeUndefined()
    expect(await absent.publish(undefined)).toBeUndefined()
    expect(empty.calls).toHaveLength(0)
    expect(blank.calls).toHaveLength(0)
    // Nothing was owed, so nothing is missing — the hook run must still complete successfully.
    expect([nothing.failure, whitespace.failure, absent.failure]).toEqual([undefined, undefined, undefined])
  })

  it('retries exactly once with a fresh token after a definite auth rejection', async () => {
    const { fetchImpl, calls } = fakeFetch({ statuses: [401] })
    const invalidated: string[] = []
    let minted = 0

    const retried = poster({
      fetchImpl,
      token: async () => `glpat-${(minted += 1)}`,
      invalidateToken: (token) => invalidated.push(token)
    })
    const published = await retried.publish('answer')

    expect(published).toEqual({ provider: 'gitlab', kind: 'note', externalId: '12345' })
    expect(invalidated).toEqual(['glpat-1'])
    expect(calls).toHaveLength(2)
    expect(calls[0]!.headers['private-token']).toBe('glpat-1')
    expect(calls[1]!.headers['private-token']).toBe('glpat-2')
    expect(retried.failure).toBeUndefined()
  })

  it('gives up after a second auth rejection rather than looping', async () => {
    const { fetchImpl, calls } = fakeFetch({ statuses: [401, 403] })
    const invalidated: string[] = []

    const p = poster({ fetchImpl, invalidateToken: (token) => invalidated.push(token) })
    const published = await p.publish('answer')

    expect(published).toBeUndefined()
    expect(calls).toHaveLength(2)
    expect(invalidated).toHaveLength(1)
    expect(p.failure).toBe('auth_rejected')
  })

  it('does not retry a server error — an ambiguous write must never double-post', async () => {
    const { fetchImpl, calls } = fakeFetch({ statuses: [500] })
    const invalidated: string[] = []

    const p = poster({ fetchImpl, invalidateToken: (token) => invalidated.push(token) })
    const published = await p.publish('answer')

    expect(published).toBeUndefined()
    expect(calls).toHaveLength(1)
    expect(invalidated).toHaveLength(0)
    expect(p.failure).toBe('post_failed')
  })

  it('reports token_unavailable when the effect lease is refused — nothing was ever sent', async () => {
    const { fetchImpl, calls } = fakeFetch()
    const p = poster({
      fetchImpl,
      token: async () => {
        throw new Error('LEASE_DENIED')
      }
    })

    expect(await p.publish('answer')).toBeUndefined()
    expect(calls).toHaveLength(0)
    expect(p.failure).toBe('token_unavailable')
  })

  it('reports post_failed when the POST itself throws', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNRESET')
    }) as unknown as typeof fetch
    const p = poster({ fetchImpl })

    expect(await p.publish('answer')).toBeUndefined()
    expect(p.failure).toBe('post_failed')
  })

  it('reports publish_timeout when the deadline abandons the publish', async () => {
    const { fetchImpl, calls } = fakeFetch()
    const p = poster({ fetchImpl, fireDeadline: true })

    expect(await p.publish('answer')).toBeUndefined()
    expect(calls).toHaveLength(0)
    expect(p.failure).toBe('publish_timeout')
  })

  it('classifies a 403 with no token invalidator as auth_rejected, not as a generic post failure', async () => {
    const { fetchImpl } = fakeFetch({ statuses: [403] })
    const p = poster({ fetchImpl })

    expect(await p.publish('answer')).toBeUndefined()
    expect(p.failure).toBe('auth_rejected')
  })

  it('posts an issue subject on the issues note path', async () => {
    const { fetchImpl, calls } = fakeFetch()

    const published = await poster({ fetchImpl }, 'issue', 42).publish('answer')

    expect(published).toEqual({ provider: 'gitlab', kind: 'note', externalId: '12345' })
    expect(calls[0]!.url).toBe(`https://gitlab.com/api/v4/projects/${PROJECT}/issues/42/notes`)
  })
})
