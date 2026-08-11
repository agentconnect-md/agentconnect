import { afterEach, describe, expect, it } from 'vitest'
import { FakeClock } from '@agentconnect.md/connection'
import { K8sHttp } from './http.js'
import { LeaseElector } from './lease.js'
import { closeFakeApiServers, fakeApiServer, type FakeRoute } from './testing/index.js'

afterEach(closeFakeApiServers)

async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition not met in time')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

interface StoredLease {
  metadata: { name: string; namespace: string; resourceVersion: string }
  spec: Record<string, unknown>
}

/** Tiny stateful Lease endpoint: 404 until created, resourceVersion-guarded writes. */
function leaseStore(initial?: StoredLease['spec']): { route: FakeRoute; current: () => StoredLease | undefined } {
  let lease: StoredLease | undefined = initial
    ? { metadata: { name: 'op', namespace: 'org-test', resourceVersion: '1' }, spec: initial }
    : undefined
  let version = 1
  const route: FakeRoute = ({ method, body }) => {
    if (method === 'GET') {
      return lease ? { json: lease } : { status: 404, json: { kind: 'Status', reason: 'NotFound' } }
    }
    const incoming = JSON.parse(body) as { metadata?: { resourceVersion?: string }; spec: Record<string, unknown> }
    if (method === 'POST') {
      if (lease) return { status: 409, json: { kind: 'Status', reason: 'AlreadyExists' } }
      lease = { metadata: { name: 'op', namespace: 'org-test', resourceVersion: `${++version}` }, spec: incoming.spec }
      return { status: 201, json: lease }
    }
    if (!lease || incoming.metadata?.resourceVersion !== lease.metadata.resourceVersion) {
      return { status: 409, json: { kind: 'Status', reason: 'Conflict' } }
    }
    lease = { metadata: { ...lease.metadata, resourceVersion: `${++version}` }, spec: incoming.spec }
    return { json: lease }
  }
  return { route, current: () => lease }
}

function elector(http: K8sHttp, clock: FakeClock, events: string[]): LeaseElector {
  return new LeaseElector(http, {
    namespace: 'org-test',
    leaseName: 'op',
    identity: 'pod-a',
    leaseDurationSeconds: 15,
    renewIntervalMs: 5_000,
    clock,
    onStartedLeading: () => events.push('started'),
    onStoppedLeading: () => events.push('stopped')
  })
}

describe('LeaseElector', () => {
  it('creates an absent lease and starts leading', async () => {
    const { route, current } = leaseStore()
    const { config } = await fakeApiServer(route)
    const clock = new FakeClock()
    const events: string[] = []
    const lease = elector(new K8sHttp(config), clock, events)
    const run = lease.start()
    await waitUntil(() => events.includes('started'))
    expect(lease.isLeader).toBe(true)
    expect(current()?.spec.holderIdentity).toBe('pod-a')
    await lease.stop()
    await run
  })

  it('renews while holding without re-firing onStartedLeading', async () => {
    const { route, current } = leaseStore()
    const { config } = await fakeApiServer(route)
    const clock = new FakeClock()
    const events: string[] = []
    const lease = elector(new K8sHttp(config), clock, events)
    const run = lease.start()
    await waitUntil(() => events.length === 1)
    const renewedBefore = current()?.spec.renewTime
    clock.advance(5_000)
    await waitUntil(() => current()?.spec.renewTime !== renewedBefore)
    expect(events).toEqual(['started'])
    expect(lease.isLeader).toBe(true)
    await lease.stop()
    await run
  })

  it('stays follower while another holder renews inside its lease duration', async () => {
    const held = {
      holderIdentity: 'pod-b',
      leaseDurationSeconds: 15,
      renewTime: new Date(0).toISOString(),
      leaseTransitions: 0
    }
    const { route, current } = leaseStore(held)
    const { config, requests } = await fakeApiServer(route)
    const clock = new FakeClock()
    const events: string[] = []
    const lease = elector(new K8sHttp(config), clock, events)
    const run = lease.start()
    await waitUntil(() => requests.length >= 1)
    expect(lease.isLeader).toBe(false)
    expect(events).toEqual([])
    expect(current()?.spec.holderIdentity).toBe('pod-b')
    await lease.stop()
    await run
  })

  it('takes over once the holder misses its lease duration', async () => {
    const held = {
      holderIdentity: 'pod-b',
      leaseDurationSeconds: 15,
      renewTime: new Date(0).toISOString(),
      leaseTransitions: 3
    }
    const { route, current } = leaseStore(held)
    const { config, requests } = await fakeApiServer(route)
    const clock = new FakeClock(16_000)
    const events: string[] = []
    const lease = elector(new K8sHttp(config), clock, events)
    const run = lease.start()
    await waitUntil(() => events.includes('started'))
    expect(current()?.spec.holderIdentity).toBe('pod-a')
    expect(current()?.spec.leaseTransitions).toBe(4)
    expect(requests.length).toBeGreaterThanOrEqual(2)
    await lease.stop()
    await run
  })

  it('treats a lost write race as staying follower', async () => {
    let gets = 0
    const route: FakeRoute = ({ method }) => {
      if (method === 'GET') {
        gets += 1
        // Expired holder, but the version we hand out never matches on write.
        return {
          json: {
            metadata: { name: 'op', namespace: 'org-test', resourceVersion: `${gets}` },
            spec: { holderIdentity: 'pod-b', leaseDurationSeconds: 15, renewTime: new Date(0).toISOString() }
          }
        }
      }
      return { status: 409, json: { kind: 'Status', reason: 'Conflict' } }
    }
    const { config } = await fakeApiServer(route)
    const clock = new FakeClock(60_000)
    const events: string[] = []
    const lease = elector(new K8sHttp(config), clock, events)
    const run = lease.start()
    await waitUntil(() => gets >= 1)
    expect(lease.isLeader).toBe(false)
    expect(events).toEqual([])
    await lease.stop()
    await run
  })

  it('demotes after renewals keep failing past the lease duration', async () => {
    let healthy = true
    const { route } = leaseStore()
    const wrapped: FakeRoute = (req) => (healthy ? route(req) : { status: 500, json: { kind: 'Status' } })
    const { config } = await fakeApiServer(wrapped)
    const clock = new FakeClock()
    const events: string[] = []
    const lease = elector(new K8sHttp(config), clock, events)
    const run = lease.start()
    await waitUntil(() => events.includes('started'))
    healthy = false
    // Each advance releases one renew tick; past 15s of failures the elector must surrender.
    for (let tick = 0; tick < 5 && !events.includes('stopped'); tick += 1) {
      clock.advance(5_000)
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    expect(events).toEqual(['started', 'stopped'])
    expect(lease.isLeader).toBe(false)
    await lease.stop()
    await run
  })

  it('releases the lease on stop so the next candidate need not wait', async () => {
    const { route, current } = leaseStore()
    const { config } = await fakeApiServer(route)
    const clock = new FakeClock()
    const events: string[] = []
    const lease = elector(new K8sHttp(config), clock, events)
    const run = lease.start()
    await waitUntil(() => events.includes('started'))
    await lease.stop()
    await run
    expect(events).toEqual(['started', 'stopped'])
    expect(current()?.spec.holderIdentity).toBe('')
  })
})
