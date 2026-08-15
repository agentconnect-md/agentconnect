import { afterEach, describe, expect, it } from 'vitest'
import { getEventListeners } from 'node:events'
import { Backoff, FakeClock } from '@agentconnect.md/connection'
import { K8sHttp } from './http.js'
import { watchCollection, type ResourceEvent } from './watch.js'
import { closeFakeApiServers, fakeApiServer } from './testing/index.js'

afterEach(closeFakeApiServers)

/** Minimal poll helper — the abort test only needs "the snapshot arrived". */
async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition not met in time')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function take<T>(source: AsyncGenerator<T>, count: number): Promise<T[]> {
  const out: T[] = []
  for await (const item of source) {
    out.push(item)
    if (out.length === count) break
  }
  return out
}

describe('watchCollection', () => {
  it('seeds the resume point from the list and resumes the watch at that version', async () => {
    const { config, requests } = await fakeApiServer(({ url }) =>
      url.searchParams.get('watch')
        ? {
            lines: [
              { type: 'ADDED', object: { metadata: { name: 'a', resourceVersion: '11' } } },
              { type: 'MODIFIED', object: { metadata: { name: 'a', resourceVersion: '12' } } }
            ]
          }
        : { json: { metadata: { resourceVersion: '10' }, items: [{ metadata: { name: 'seed' } }] } }
    )
    const clock = new FakeClock()
    const events = await take(
      watchCollection(new K8sHttp(config), {
        path: '/apis/x/claims',
        clock,
        backoff: new Backoff({ jitter: () => 0 })
      }),
      3
    )
    expect(events[0]).toEqual({ kind: 'synced', items: [{ metadata: { name: 'seed' } }] })
    expect(events[1]?.kind).toBe('added')
    expect(events[2]?.kind).toBe('modified')
    const watchRequest = requests.find((url) => url.searchParams.get('watch'))
    expect(watchRequest?.searchParams.get('resourceVersion')).toBe('10')
    // Bookmarks are what keep an idle watch's resume point fresh enough to reuse.
    expect(watchRequest?.searchParams.get('allowWatchBookmarks')).toBe('true')
  })

  it('advances the resume point on a BOOKMARK without emitting it', async () => {
    let watches = 0
    const { config, requests } = await fakeApiServer(({ url }) => {
      if (!url.searchParams.get('watch')) return { json: { metadata: { resourceVersion: '10' }, items: [] } }
      watches += 1
      return watches === 1
        ? { lines: [{ type: 'BOOKMARK', object: { metadata: { resourceVersion: '77' } } }] }
        : { lines: [{ type: 'ADDED', object: { metadata: { name: 'later', resourceVersion: '78' } } }] }
    })
    const clock = new FakeClock()
    const events = await take(
      watchCollection(new K8sHttp(config), {
        path: '/apis/x/claims',
        clock,
        backoff: new Backoff({ jitter: () => 0 })
      }),
      2
    )
    // synced, then the post-reconnect ADDED — the bookmark itself is not an event.
    expect(events.map((event) => event.kind)).toEqual(['synced', 'added'])
    const watchVersions = requests
      .filter((url) => url.searchParams.get('watch'))
      .map((url) => url.searchParams.get('resourceVersion'))
    expect(watchVersions).toEqual(['10', '77'])
  })

  it('re-lists when the resume point has expired, rather than failing the watch', async () => {
    let lists = 0
    let watches = 0
    const { config } = await fakeApiServer(({ url }) => {
      if (!url.searchParams.get('watch')) {
        lists += 1
        return { json: { metadata: { resourceVersion: lists === 1 ? '10' : '900' }, items: [] } }
      }
      watches += 1
      if (watches === 1) return { status: 410, json: { kind: 'Status', reason: 'Expired', code: 410 } }
      return { lines: [{ type: 'ADDED', object: { metadata: { name: 'fresh', resourceVersion: '901' } } }] }
    })
    const clock = new FakeClock()
    const events = await take(
      watchCollection(new K8sHttp(config), {
        path: '/apis/x/claims',
        clock,
        backoff: new Backoff({ jitter: () => 0 })
      }),
      3
    )
    // A 410 forces a fresh snapshot; the consumer sees a second `synced` and can
    // converge instead of assuming its incremental view is still valid.
    expect(events.map((event) => event.kind)).toEqual(['synced', 'synced', 'added'])
    expect(lists).toBe(2)
  })

  it('re-lists on an in-band Expired ERROR event', async () => {
    let lists = 0
    let watches = 0
    const { config } = await fakeApiServer(({ url }) => {
      if (!url.searchParams.get('watch')) {
        lists += 1
        return { json: { metadata: { resourceVersion: `${lists}0` }, items: [] } }
      }
      watches += 1
      return watches === 1
        ? { lines: [{ type: 'ERROR', object: { kind: 'Status', reason: 'Expired', code: 410 } }] }
        : { lines: [{ type: 'ADDED', object: { metadata: { name: 'after', resourceVersion: '31' } } }] }
    })
    const events = await take(
      watchCollection(new K8sHttp(config), {
        path: '/apis/x/claims',
        clock: new FakeClock(),
        backoff: new Backoff({ jitter: () => 0 })
      }),
      3
    )
    expect(events.map((event) => event.kind)).toEqual(['synced', 'synced', 'added'])
    expect(lists).toBe(2)
  })

  it('backs off a failed connection without accumulating abort listeners', async () => {
    let lists = 0
    const { config } = await fakeApiServer(() => {
      lists += 1
      return lists < 4
        ? { status: 500, json: { kind: 'Status', reason: 'InternalError', message: 'apiserver down' } }
        : { json: { metadata: { resourceVersion: '10' }, items: [] } }
    })
    const controller = new AbortController()
    const clock = new FakeClock()
    const source = watchCollection(new K8sHttp(config), {
      path: '/apis/x/claims',
      signal: controller.signal,
      clock,
      backoff: new Backoff({ jitter: () => 0 })
    })
    const collected: string[] = []
    const drain = (async () => {
      for await (const event of source) {
        collected.push(event.kind)
        break
      }
    })()
    // Each failed list parks on a clock-driven delay; advancing releases it. A retry
    // whose timer wins must unregister its listener, or a long outage grows them
    // without bound on this one long-lived signal. Wait for the armed timer rather than
    // for the server's hit count: that lands while the request is still in flight, still
    // holding the listener node:http registers for its own lifetime.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await waitUntil(() => clock.pending === 1)
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1)
      clock.advance(60_000)
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
    }
    await drain
    expect(collected).toEqual(['synced'])
    expect(lists).toBe(4)
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
    controller.abort()
  })

  it('returns immediately from a backoff delay on an already-aborted signal', async () => {
    const controller = new AbortController()
    controller.abort()
    const { config } = await fakeApiServer(() => ({ status: 500, json: { kind: 'Status' } }))
    const clock = new FakeClock()
    const collected: string[] = []
    // The loop must not park on a full backoff delay when the signal is already
    // aborted before the listener is registered.
    for await (const event of watchCollection(new K8sHttp(config), {
      path: '/apis/x/claims',
      signal: controller.signal,
      clock,
      backoff: new Backoff({ jitter: () => 0 })
    })) {
      collected.push(event.kind)
    }
    expect(collected).toEqual([])
  })

  it('stops when aborted', async () => {
    const controller = new AbortController()
    const { config } = await fakeApiServer(({ url }) =>
      url.searchParams.get('watch')
        ? { lines: [], hold: true }
        : { json: { metadata: { resourceVersion: '1' }, items: [] } }
    )
    const source = watchCollection(new K8sHttp(config), {
      path: '/apis/x/claims',
      signal: controller.signal,
      clock: new FakeClock()
    })
    const collected: ResourceEvent<never>[] = []
    const drain = (async () => {
      for await (const event of source) collected.push(event as ResourceEvent<never>)
    })()
    await waitUntil(() => collected.length === 1)
    controller.abort()
    await drain
    expect(collected.map((event) => event.kind)).toEqual(['synced'])
  })
})
