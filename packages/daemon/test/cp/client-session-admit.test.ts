// `session/admit` goes on the wire only to a CP that advertised it over a live link, once, and never throws (org-session-policy.md, Admission).
import { describe, it, expect } from 'vitest'
import { SESSION_ADMIT_FEATURE, buildEnvelope } from '@agentconnect.md/protocol'
import { CpClient, type CpClientDeps } from '../../src/cp/client.js'
import { FakeTransport } from './fake-transport.js'
import { FakeClock } from './fake-clock.js'

const DAEMON_ID = '22222222-2222-4222-8222-222222222222'
const AGENT = '33333333-3333-4333-8333-333333333333'
const SESSION = '44444444-4444-4444-8444-444444444444'
const ORG = 'org-a'

const tick = () => new Promise((r) => setImmediate(r))

/** A frame-mode client that reached READY against a CP advertising `serverFeatures`. */
async function ready(serverFeatures: string[]) {
  const t = new FakeTransport()
  const clock = new FakeClock()
  const deps = {
    url: 'wss://cp.example.test/daemon/ws',
    token: 't',
    daemonId: DAEMON_ID,
    agentVersion: '0.0.0',
    host: 'h',
    heartbeatDefaultMs: 15_000,
    maxAgents: 4,
    capabilities: () => ({ platforms: [], runtimes: [], acp: true, features: [] }),
    runtimeProfiles: () => [],
    localState: () => ({ assignments: [], crons: [], leases: [], agents: [], integrations: [], stagedAgents: [] }),
    loadSnapshot: () => ({ cpu: 0, mem: 0, agents: 0 }),
    activeSessions: () => 0,
    orgForAgent: (id: string) => (id === AGENT ? ORG : undefined),
    configApply: { applyConfigPush() {}, applyReconcileSnapshot() {} },
    clock,
    connect: async () => t,
    log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
    jitter: () => 0
  } as unknown as CpClientDeps
  const client = new CpClient(deps)
  client.start()
  await tick()
  const authOk = {
    daemonId: DAEMON_ID,
    sessionEpoch: 1,
    heartbeatSec: 15,
    dutyLeaseMs: 120_000,
    serverTime: '2026-09-23T00:00:00.000Z',
    organizationMode: 'frame'
  }
  t.pushInbound(JSON.stringify(buildEnvelope('auth/ok', authOk, { corr: t.lastSent().id })))
  await tick()
  const snapshot = {
    routingEpoch: 1,
    serverFeatures,
    assignments: [],
    crons: [],
    leases: [],
    drop: { assignments: [], crons: [] }
  }
  t.pushInbound(JSON.stringify(buildEnvelope('register/ok', snapshot, { corr: t.lastSent().id })))
  await tick()
  return { client, t, clock }
}

const admits = (t: FakeTransport) => t.sent.map((raw) => JSON.parse(raw)).filter((f) => f.type === 'session/admit')

describe('CpClient.admitSession', () => {
  it('sends nothing to a CP that does not advertise the frame', async () => {
    const { client, t } = await ready([])
    expect(client.admitsSessions()).toBe(false)
    await expect(client.admitSession(AGENT, SESSION)).resolves.toBe('unsupported')
    expect(admits(t)).toEqual([])
  })

  it('sends nothing while the link is down, rather than waiting for a reconnect', async () => {
    const { client, t } = await ready([SESSION_ADMIT_FEATURE])
    t.simulateClose(1006)
    await tick()
    expect(client.admitsSessions()).toBe(false)
    await expect(client.admitSession(AGENT, SESSION)).resolves.toBe('unsupported')
    expect(admits(t)).toEqual([])
    client.stop()
  })

  it("sends one request in the agent's org and resolves admitted on the result", async () => {
    const { client, t } = await ready([SESSION_ADMIT_FEATURE])
    expect(client.admitsSessions()).toBe(true)
    const outcome = client.admitSession(AGENT, SESSION)
    await tick()
    const [sent] = admits(t)
    expect(sent).toMatchObject({ orgId: ORG, payload: { agentId: AGENT, sessionId: SESSION } })
    t.pushInbound(
      JSON.stringify(
        buildEnvelope('session/admit/result', { admitted: true, counted: true }, { corr: sent.id, orgId: ORG })
      )
    )
    await expect(outcome).resolves.toBe('admitted')
  })

  it('resolves failed on an error reply without retrying', async () => {
    const { client, t, clock } = await ready([SESSION_ADMIT_FEATURE])
    const outcome = client.admitSession(AGENT, SESSION)
    await tick()
    const [sent] = admits(t)
    t.pushInbound(
      JSON.stringify(
        buildEnvelope(
          'error',
          { code: 'INTERNAL', message: 'agent placement is mutating; retry the admission', retryable: true },
          { corr: sent.id, orgId: ORG }
        )
      )
    )
    await expect(outcome).resolves.toBe('failed')
    clock.advance(10_000)
    expect(admits(t)).toHaveLength(1)
  })

  it('resolves failed once its single attempt times out', async () => {
    const { client, t, clock } = await ready([SESSION_ADMIT_FEATURE])
    const outcome = client.admitSession(AGENT, SESSION)
    await tick()
    clock.advance(2_000)
    await expect(outcome).resolves.toBe('failed')
    expect(admits(t)).toHaveLength(1)
  })

  it('resolves failed when the agent has no resolvable org', async () => {
    const { client, t } = await ready([SESSION_ADMIT_FEATURE])
    await expect(client.admitSession('55555555-5555-4555-8555-555555555555', SESSION)).resolves.toBe('failed')
    expect(admits(t)).toEqual([])
  })
})
