// GitLab final-answer poster (gitlab-com-integration.md 14.1): one note per completed turn, single-publish, auth-retry once.
import { describe, it, expect, vi } from 'vitest'
import { GitlabFinalPoster } from '../src/gitlab/poster.js'
import type { PosterScheduler } from '../src/github/poster.js'

const PROJECT = '4455667'

/** A hand-driven clock so the publish deadline never depends on wall time. */
function fakeScheduler() {
  const now = 0
  let nextId = 1
  const pending = new Map<number, { fn: () => void; at: number }>()
  const sched: PosterScheduler = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = nextId++
      pending.set(id, { fn, at: now + ms })
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
  },
  subject: 'issue' | 'merge_request' = 'merge_request',
  iid = 77
) {
  return new GitlabFinalPoster(
    {
      token: deps.token ?? (async () => 'glpat-effect'),
      ...(deps.invalidateToken ? { invalidateToken: deps.invalidateToken } : {}),
      log,
      fetchImpl: deps.fetchImpl,
      scheduler: fakeScheduler().sched
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

  it('never posts an empty or whitespace-only final', async () => {
    const empty = fakeFetch()
    const blank = fakeFetch()

    expect(await poster({ fetchImpl: empty.fetchImpl }).publish('')).toBeUndefined()
    expect(await poster({ fetchImpl: blank.fetchImpl }).publish('   \n\t ')).toBeUndefined()
    expect(await poster({ fetchImpl: empty.fetchImpl }).publish(undefined)).toBeUndefined()
    expect(empty.calls).toHaveLength(0)
    expect(blank.calls).toHaveLength(0)
  })

  it('retries exactly once with a fresh token after a definite auth rejection', async () => {
    const { fetchImpl, calls } = fakeFetch({ statuses: [401] })
    const invalidated: string[] = []
    let minted = 0

    const published = await poster({
      fetchImpl,
      token: async () => `glpat-${(minted += 1)}`,
      invalidateToken: (token) => invalidated.push(token)
    }).publish('answer')

    expect(published).toEqual({ provider: 'gitlab', kind: 'note', externalId: '12345' })
    expect(invalidated).toEqual(['glpat-1'])
    expect(calls).toHaveLength(2)
    expect(calls[0]!.headers['private-token']).toBe('glpat-1')
    expect(calls[1]!.headers['private-token']).toBe('glpat-2')
  })

  it('gives up after a second auth rejection rather than looping', async () => {
    const { fetchImpl, calls } = fakeFetch({ statuses: [401, 403] })
    const invalidated: string[] = []

    const published = await poster({
      fetchImpl,
      invalidateToken: (token) => invalidated.push(token)
    }).publish('answer')

    expect(published).toBeUndefined()
    expect(calls).toHaveLength(2)
    expect(invalidated).toHaveLength(1)
  })

  it('does not retry a server error — an ambiguous write must never double-post', async () => {
    const { fetchImpl, calls } = fakeFetch({ statuses: [500] })
    const invalidated: string[] = []

    const published = await poster({
      fetchImpl,
      invalidateToken: (token) => invalidated.push(token)
    }).publish('answer')

    expect(published).toBeUndefined()
    expect(calls).toHaveLength(1)
    expect(invalidated).toHaveLength(0)
  })

  it('posts an issue subject on the issues note path', async () => {
    const { fetchImpl, calls } = fakeFetch()

    const published = await poster({ fetchImpl }, 'issue', 42).publish('answer')

    expect(published).toEqual({ provider: 'gitlab', kind: 'note', externalId: '12345' })
    expect(calls[0]!.url).toBe(`https://gitlab.com/api/v4/projects/${PROJECT}/issues/42/notes`)
  })
})
