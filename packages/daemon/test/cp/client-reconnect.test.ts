import { describe, it, expect, vi } from 'vitest'
import { buildEnvelope } from '@agentconnect.md/protocol'
import { CpClient, type CpClientDeps } from '../../src/cp/client.js'
import { FakeTransport } from './fake-transport.js'
import { FakeClock } from './fake-clock.js'

const DAEMON_ID = '22222222-2222-4222-8222-222222222222'
const silent = { trace() {}, debug() {}, info() {}, warn() {}, error() {} }
const tick = () => new Promise((r) => setImmediate(r))

function deps(connect: () => Promise<FakeTransport>, clock: FakeClock): CpClientDeps {
  return {
    url: 'wss://cp/daemon/ws',
    token: 't',
    daemonId: DAEMON_ID,
    agentVersion: '0.0.0',
    host: 'h',
    heartbeatDefaultMs: 15000,
    maxAgents: 4,
    capabilities: () => ({ platforms: ['slack'], runtimes: [], acp: true, features: [] }),
    runtimeProfiles: () => [],
    localState: () => ({ assignments: [], crons: [], leases: [], agents: [], integrations: [], stagedAgents: [] }),
    loadSnapshot: () => ({ cpu: 0, mem: 0, agents: 0 }),
    activeSessions: () => 0,
    configApply: {
      applyConfigPush() {},
      applyReconcileSnapshot() {},
      upsertCron() {},
      removeCron() {},
      applyRouteAssign() {},
      applyRouteUpdate() {}
    },
    clock,
    connect,
    log: silent,
    jitter: () => 0
  } as unknown as CpClientDeps
}

describe('CpClient reconnect', () => {
  it('closes the orphaned transport and schedules reconnect when auth handshake never gets a reply', async () => {
    // Regression for I1: dial succeeds but CP never sends auth/ok → correlator
    // exhausts retransmit budget (maxTries=5, ackTimeout=5000ms each) and rejects.
    // The catch block must close+null the stale transport before scheduling reconnect.
    const clock = new FakeClock()
    const connect = vi.fn(async () => new FakeTransport())
    const client = new CpClient(deps(connect, clock))
    client.start()
    await tick()
    expect(connect).toHaveBeenCalledTimes(1)

    const t1 = (await connect.mock.results[0]!.value) as FakeTransport
    // CP never sends auth/ok — drive the correlator through its full retransmit budget.
    // ReqRep: maxTries=5, ackTimeoutMs=5000. It rejects after the 5th timer fires.
    for (let i = 0; i < 6; i++) {
      clock.advance(5000)
      await tick()
    }

    // (a) The original transport was closed by the catch block with code 1011.
    expect(t1.closed).toBeDefined()
    expect(t1.closed?.code).toBe(1011)

    // (b) A reconnect was triggered. The 1000ms backoff timer fires within the advance
    // loop above (total wall-time advanced >> 1000ms), so connect is called a 2nd time.
    expect(connect).toHaveBeenCalledTimes(2)
  })

  it('schedules a backoff reconnect after a non-4401 drop and dials again', async () => {
    const clock = new FakeClock()
    const connect = vi.fn(async () => new FakeTransport())
    const client = new CpClient(deps(connect, clock))
    client.start()
    await tick()
    expect(connect).toHaveBeenCalledTimes(1)

    // CP drops the socket (server restarting).
    const t1 = (await connect.mock.results[0]!.value) as FakeTransport
    t1.simulateClose(1012, 'restarting')
    expect(client.state).toBe('DEGRADED')
    // A reconnect timer is armed (~1000ms with jitter()=0).
    expect(clock.pending()).toContain(1000)

    clock.advance(1000)
    await tick()
    expect(connect).toHaveBeenCalledTimes(2)
  })

  it('authenticates without an organization after a frame-scoped connection drops', async () => {
    const clock = new FakeClock()
    const transports: FakeTransport[] = []
    const connect = vi.fn(async () => {
      const transport = new FakeTransport()
      transports.push(transport)
      return transport
    })
    const client = new CpClient(deps(connect, clock))
    client.start()
    await tick()

    const first = transports[0]!
    const firstAuth = first.lastSent()
    first.pushInbound(
      JSON.stringify(
        buildEnvelope(
          'auth/ok',
          {
            daemonId: DAEMON_ID,
            sessionEpoch: 1,
            heartbeatSec: 15,
            serverTime: '2026-08-14T00:00:00.000Z',
            organizationMode: 'frame'
          },
          { corr: firstAuth.id }
        )
      )
    )
    await tick()
    const register = first.lastSent()
    first.pushInbound(
      JSON.stringify(
        buildEnvelope(
          'register/ok',
          {
            routingEpoch: 1,
            assignments: [],
            crons: [],
            leases: [],
            drop: { assignments: [], crons: [] }
          },
          { corr: register.id }
        )
      )
    )
    await tick()
    expect(client.state).toBe('READY')

    first.simulateClose(1012, 'restarting')
    clock.advance(1000)
    await tick()

    const reconnectAuth = transports[1]!.lastSent()
    expect(reconnectAuth.type).toBe('auth')
    expect(reconnectAuth.orgId).toBeUndefined()
  })

  it('does NOT reconnect after a 4401 close, and an API-key daemon stays up for the operator', async () => {
    const clock = new FakeClock()
    const connect = vi.fn(async () => new FakeTransport())
    const onAuthFatal = vi.fn()
    const client = new CpClient({ ...deps(connect, clock), onAuthFatal })
    client.start()
    await tick()
    const t1 = (await connect.mock.results[0]!.value) as FakeTransport
    t1.simulateClose(4401, 'AUTH_FAILED')
    expect(clock.pending()).not.toContain(1000)
    clock.advance(60000)
    await tick()
    expect(connect).toHaveBeenCalledTimes(1)
    // Only a projected identity is re-minted by restarting; a rejected key needs a human.
    expect(onAuthFatal).not.toHaveBeenCalled()
  })

  it('backoff grows exponentially up to the 30s cap', async () => {
    const clock = new FakeClock()
    // Always fail the dial so we only see backoff scheduling.
    const connect = vi.fn(async () => {
      throw new Error('refused')
    })
    const client = new CpClient(deps(connect, clock))
    client.start()
    await tick()
    // attempt 0 failed → ~1000ms armed
    expect(clock.pending()).toContain(1000)
    clock.advance(1000)
    await tick() // attempt 1 → 2000
    expect(clock.pending()).toContain(2000)
    clock.advance(2000)
    await tick() // attempt 2 → 4000
    expect(clock.pending()).toContain(4000)
  })

  it('clamps the jittered delay at the 30s cap (regression: capped tail was [30s,60s))', async () => {
    const clock = new FakeClock()
    const connect = vi.fn(async () => {
      throw new Error('refused')
    })
    const client = new CpClient({ ...deps(connect, clock), jitter: () => 0.5 })
    client.start()
    await tick()
    // attempts 0..4 → base + base/2
    for (const d of [1500, 3000, 6000, 12000, 24000]) {
      expect(clock.pending()).toContain(d)
      clock.advance(d)
      await tick()
    }
    // attempt 5: base hits the cap (30000); jitter would push the delay to 45000 — clamped.
    expect(clock.pending()).toContain(30000)
    expect(clock.pending()).not.toContain(45000)
  })

  it('does not adopt the transport when stop() raced an in-flight dial', async () => {
    const clock = new FakeClock()
    let resolveDial: ((t: FakeTransport) => void) | undefined
    const connect = vi.fn(() => new Promise<FakeTransport>((r) => (resolveDial = r)))
    const client = new CpClient(deps(connect, clock))
    client.start()
    await tick()
    expect(resolveDial).toBeDefined()

    await client.stop()
    resolveDial!(new FakeTransport())
    await tick()

    const t = (await connect.mock.results[0]!.value) as FakeTransport
    expect(t.closed).toEqual({ code: 1000, reason: 'shutdown' })
    expect(t.sent).toEqual([]) // no auth frame — the handshake never started
    expect(client.state).toBe('CLOSED')
  })
})
