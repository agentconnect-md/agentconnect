/**
 * `capabilities/update` (D→C EVT) — the mid-connection capability refresh.
 *
 * `register` runs before the agent roster is applied and before the runtime
 * probe sweep, so a feature derived from either would stay hidden until the
 * next reconnect without this frame. The client
 * must re-announce ONLY when the computed set actually changed, and never
 * before the connection is READY.
 */
import { describe, it, expect } from 'vitest'
import { buildEnvelope, type RegisterReq } from '@agentconnect.md/protocol'
import { CpClient, type CpClientDeps } from '../../src/cp/client.js'
import { FakeTransport } from './fake-transport.js'
import { FakeClock } from './fake-clock.js'

const DAEMON_ID = '22222222-2222-4222-8222-222222222222'
const silent = { trace() {}, debug() {}, info() {}, warn() {}, error() {} }

function makeDeps(transport: FakeTransport, over: Partial<CpClientDeps> = {}): CpClientDeps {
  return {
    url: 'wss://cp.example/daemon/ws',
    token: 'tok_abc',
    daemonId: DAEMON_ID,
    agentVersion: '0.0.0',
    host: 'host-1',
    heartbeatDefaultMs: 15000,
    maxAgents: 4,
    capabilities: () => ({ platforms: ['slack'], runtimes: ['claude'], acp: true, features: [] }),
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
    clock: new FakeClock(),
    connect: async () => transport,
    log: silent,
    jitter: () => 0,
    ...over
  } as CpClientDeps
}

const tick = () => new Promise((r) => setImmediate(r))

async function reachReady(t: FakeTransport, client: CpClient): Promise<void> {
  client.start()
  await tick()
  const auth = t.lastSent()
  t.pushInbound(
    JSON.stringify(
      buildEnvelope(
        'auth/ok',
        { daemonId: DAEMON_ID, sessionEpoch: 7, heartbeatSec: 20, serverTime: '2026-06-26T00:00:00.000Z' },
        { corr: auth.id }
      )
    )
  )
  await tick()
  const reg = t.lastSent()
  t.pushInbound(
    JSON.stringify(
      buildEnvelope(
        'register/ok',
        { routingEpoch: 3, assignments: [], crons: [], leases: [], drop: { assignments: [], crons: [] } },
        { corr: reg.id }
      )
    )
  )
  await tick()
  expect(client.state).toBe('READY')
}

const updates = (t: FakeTransport): any[] =>
  t.sent.map((s) => JSON.parse(s)).filter((f) => f.type === 'capabilities/update')

describe('CpClient.updateCapabilities', () => {
  it('rechecks after entering READY when reconcile changed capabilities during registration', async () => {
    const caps: RegisterReq['capabilities'] = { platforms: ['slack'], runtimes: ['claude'], acp: true, features: [] }
    const t = new FakeTransport()
    const client = new CpClient(
      makeDeps(t, {
        capabilities: () => ({ ...caps, features: [...caps.features] }),
        configApply: {
          ...makeDeps(t).configApply,
          applyReconcileSnapshot() {
            caps.features = ['webchat_remote_mcp_v1']
          }
        }
      })
    )

    await reachReady(t, client)

    const sent = updates(t)
    expect(sent).toHaveLength(1)
    expect(sent[0].payload.capabilities.features).toEqual(['webchat_remote_mcp_v1'])
  })

  it('emits only when the computed set changed since register, then dedups', async () => {
    const caps: RegisterReq['capabilities'] = { platforms: ['slack'], runtimes: ['claude'], acp: true, features: [] }
    const t = new FakeTransport()
    const client = new CpClient(makeDeps(t, { capabilities: () => ({ ...caps, features: [...caps.features] }) }))
    await reachReady(t, client)

    // Unchanged since register ⇒ silent.
    client.updateCapabilities()
    expect(updates(t)).toHaveLength(0)

    // The feature set moved (builtin agent synced / probe completed) ⇒ one EVT.
    caps.features = ['webchat_remote_mcp_v1']
    client.updateCapabilities()
    const sent = updates(t)
    expect(sent).toHaveLength(1)
    expect(sent[0].payload.capabilities.features).toEqual(['webchat_remote_mcp_v1'])

    // Same set again ⇒ no duplicate frame.
    client.updateCapabilities()
    expect(updates(t)).toHaveLength(1)
  })

  it('is a no-op before the connection is READY', async () => {
    const t = new FakeTransport()
    const client = new CpClient(makeDeps(t))
    client.start()
    await tick() // CONNECTING/AUTHENTICATING — auth sent, no auth/ok yet
    client.updateCapabilities()
    expect(updates(t)).toHaveLength(0)
  })
})
