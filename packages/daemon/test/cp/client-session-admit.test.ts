// `session/admit` goes once over a live link to a CP that advertised it, or waits out a reconnect for an enforcing organization, and never throws (org-session-policy.md).
import { describe, it, expect } from 'vitest'
import { SESSION_ADMIT_FEATURE, SESSION_LIMIT_REACHED, buildEnvelope } from '@agentconnect.md/protocol'
import { CpClient, SESSION_ADMIT_BUDGET_MS, type CpClientDeps } from '../../src/cp/client.js'
import { FakeTransport } from './fake-transport.js'
import { FakeClock } from './fake-clock.js'

const DAEMON_ID = '22222222-2222-4222-8222-222222222222'
const AGENT = '33333333-3333-4333-8333-333333333333'
const SESSION = '44444444-4444-4444-8444-444444444444'
const ORG = 'org-a'

const tick = () => new Promise((r) => setImmediate(r))

/** A frame-mode client that reached READY against a CP advertising `serverFeatures`. */
async function ready(serverFeatures: string[]) {
  const transports: FakeTransport[] = []
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
    connect: async () => {
      const transport = new FakeTransport()
      transports.push(transport)
      return transport
    },
    log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
    jitter: () => 0
  } as unknown as CpClientDeps
  const client = new CpClient(deps)
  client.start()
  await tick()
  await handshake(transports[0]!, serverFeatures)
  return { client, t: transports[0]!, transports, clock }
}

async function handshake(t: FakeTransport, serverFeatures: string[]) {
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
}

const admits = (t: FakeTransport) => t.sent.map((raw) => JSON.parse(raw)).filter((f) => f.type === 'session/admit')

describe('CpClient.admitSession', () => {
  it('sends nothing to a CP that does not advertise the frame', async () => {
    const { client, t } = await ready([])
    expect(client.admitsSessions()).toBe(false)
    await expect(client.admitSession(AGENT, SESSION)).resolves.toEqual({ kind: 'unsupported' })
    expect(admits(t)).toEqual([])
  })

  it('sends nothing while the link is down, rather than waiting for a reconnect', async () => {
    const { client, t } = await ready([SESSION_ADMIT_FEATURE])
    t.simulateClose(1006)
    await tick()
    expect(client.admitsSessions()).toBe(false)
    await expect(client.admitSession(AGENT, SESSION)).resolves.toEqual({ kind: 'unsupported' })
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
    await expect(outcome).resolves.toEqual({ kind: 'admitted' })
  })

  it('carries a maintenance purpose only when given one', async () => {
    const { client, t } = await ready([SESSION_ADMIT_FEATURE])
    void client.admitSession(AGENT, SESSION, 'memory-dream')
    void client.admitSession(AGENT, 'other-session')
    await tick()
    const [dream, plain] = admits(t)
    expect(dream.payload).toEqual({ agentId: AGENT, sessionId: SESSION, purpose: 'memory-dream' })
    expect(plain.payload).toEqual({ agentId: AGENT, sessionId: 'other-session' })
    client.stop()
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
    await expect(outcome).resolves.toEqual({ kind: 'failed' })
    clock.advance(10_000)
    expect(admits(t)).toHaveLength(1)
  })

  it('resolves failed once its single attempt times out', async () => {
    const { client, t, clock } = await ready([SESSION_ADMIT_FEATURE])
    const outcome = client.admitSession(AGENT, SESSION)
    await tick()
    clock.advance(2_000)
    await expect(outcome).resolves.toEqual({ kind: 'failed' })
    expect(admits(t)).toHaveLength(1)
  })

  it('resolves failed when the agent has no resolvable org', async () => {
    const { client, t } = await ready([SESSION_ADMIT_FEATURE])
    await expect(client.admitSession('55555555-5555-4555-8555-555555555555', SESSION)).resolves.toEqual({
      kind: 'failed'
    })
    expect(admits(t)).toEqual([])
  })
})

const reply = (t: FakeTransport, corr: string, payload: unknown) =>
  t.pushInbound(JSON.stringify(buildEnvelope('session/admit/result', payload, { corr, orgId: ORG })))

describe('CpClient.admitSession answers', () => {
  it('reads whether the organization enforces, and an older CP’s answer without it', async () => {
    const { client, t } = await ready([SESSION_ADMIT_FEATURE])
    const enforcing = client.admitSession(AGENT, SESSION)
    const older = client.admitSession(AGENT, 'other-session')
    await tick()
    const [a, b] = admits(t)
    reply(t, a.id, { admitted: true, counted: true, enforcing: true })
    reply(t, b.id, { admitted: true, counted: false })
    await expect(enforcing).resolves.toEqual({ kind: 'admitted', enforcing: true })
    await expect(older).resolves.toEqual({ kind: 'admitted' })
  })

  it('reads the refusal variant and the same refusal sent as an error', async () => {
    const { client, t } = await ready([SESSION_ADMIT_FEATURE])
    const variant = client.admitSession(AGENT, SESSION)
    const asError = client.admitSession(AGENT, 'other-session')
    await tick()
    const [a, b] = admits(t)
    const numbers = { limit: 3, used: 3, resetsAt: '2026-12-01T00:00:00.000Z' }
    reply(t, a.id, { admitted: false, reason: SESSION_LIMIT_REACHED, ...numbers, enforcing: true })
    t.pushInbound(
      JSON.stringify(
        buildEnvelope(
          'error',
          {
            code: 'RATE_LIMITED',
            message: 'the organization reached its monthly session limit',
            retryable: false,
            details: { reason: SESSION_LIMIT_REACHED, ...numbers }
          },
          { corr: b.id, orgId: ORG }
        )
      )
    )
    await expect(variant).resolves.toEqual({ kind: 'refused', ...numbers })
    await expect(asError).resolves.toEqual({ kind: 'refused', ...numbers })
  })
})

describe('CpClient.admitSession while its organization enforces', () => {
  it('waits out a dropped link and sends the same id on the new one', async () => {
    const { client, transports, clock } = await ready([SESSION_ADMIT_FEATURE])
    transports[0]!.simulateClose(1012, 'restarting')
    const outcome = client.admitSession(AGENT, SESSION, undefined, { wait: true })
    await tick()
    clock.advance(1000)
    await tick()
    await handshake(transports[1]!, [SESSION_ADMIT_FEATURE])
    expect(admits(transports[0]!)).toEqual([])
    const [sent] = admits(transports[1]!)
    expect(sent.payload).toEqual({ agentId: AGENT, sessionId: SESSION })
    reply(transports[1]!, sent.id, { admitted: true, counted: true, enforcing: true })
    await expect(outcome).resolves.toEqual({ kind: 'admitted', enforcing: true })
    client.stop()
  })

  it('re-sends the same id once when the link drops after it was sent', async () => {
    const { client, transports, clock } = await ready([SESSION_ADMIT_FEATURE])
    const outcome = client.admitSession(AGENT, SESSION, undefined, { wait: true })
    await tick()
    expect(admits(transports[0]!)).toHaveLength(1)
    transports[0]!.simulateClose(1012, 'restarting')
    await tick()
    clock.advance(1000)
    await tick()
    await handshake(transports[1]!, [SESSION_ADMIT_FEATURE])
    const [resent] = admits(transports[1]!)
    expect(resent.payload).toEqual({ agentId: AGENT, sessionId: SESSION })
    reply(transports[1]!, resent.id, { admitted: true, counted: true, enforcing: true })
    await expect(outcome).resolves.toEqual({ kind: 'admitted', enforcing: true })
    client.stop()
  })

  it('gives up as failed within its budget when no answer comes', async () => {
    const { client, transports, clock } = await ready([SESSION_ADMIT_FEATURE])
    let settled = false
    const outcome = client.admitSession(AGENT, SESSION, undefined, { wait: true }).finally(() => (settled = true))
    await tick()
    for (let elapsed = 0; elapsed < SESSION_ADMIT_BUDGET_MS - 1000; elapsed += 1000) {
      clock.advance(1000)
      await tick()
    }
    expect(settled).toBe(false)
    clock.advance(2000)
    await tick()
    await expect(outcome).resolves.toEqual({ kind: 'failed' })
    expect(admits(transports[0]!).length).toBeGreaterThanOrEqual(1)
    client.stop()
  })

  it('answers unsupported from a CP that stopped advertising admission', async () => {
    const { client, transports, clock } = await ready([SESSION_ADMIT_FEATURE])
    transports[0]!.simulateClose(1012, 'restarting')
    const outcome = client.admitSession(AGENT, SESSION, undefined, { wait: true })
    await tick()
    clock.advance(1000)
    await tick()
    await handshake(transports[1]!, [])
    await expect(outcome).resolves.toEqual({ kind: 'unsupported' })
    expect(admits(transports[1]!)).toEqual([])
    client.stop()
  })
})
