// `history-retention/confirm` goes once, install-wide, to a CP that advertised it, and throws on anything but its result (org-session-policy.md, Reclaim).
import { describe, it, expect } from 'vitest'
import {
  HISTORY_RETENTION_CONFIRM_FEATURE,
  HISTORY_RETENTION_CONFIRM_MAX,
  buildEnvelope
} from '@agentconnect.md/protocol'
import { CpClient, type CpClientDeps } from '../../src/cp/client.js'
import { FakeTransport } from './fake-transport.js'
import { FakeClock } from './fake-clock.js'

const DAEMON_ID = '22222222-2222-4222-8222-222222222222'
const AGENT = '33333333-3333-4333-8333-333333333333'
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

const confirms = (t: FakeTransport) =>
  t.sent.map((raw) => JSON.parse(raw)).filter((f) => f.type === 'history-retention/confirm')

describe('CpClient.confirmHistoryRetention', () => {
  it('refuses to ask a CP that does not advertise the frame', async () => {
    const { client, t } = await ready([])
    await expect(client.confirmHistoryRetention([ORG])).rejects.toThrow(/does not answer/)
    expect(confirms(t)).toEqual([])
    client.stop()
  })

  it('refuses to ask while the link is down', async () => {
    const { client, t } = await ready([HISTORY_RETENTION_CONFIRM_FEATURE])
    t.simulateClose(1006)
    await tick()
    await expect(client.confirmHistoryRetention([ORG])).rejects.toThrow(/unreachable/)
    expect(confirms(t)).toEqual([])
    client.stop()
  })

  it('sends one install-wide request and resolves its answer', async () => {
    const { client, t } = await ready([HISTORY_RETENTION_CONFIRM_FEATURE])
    const answer = client.confirmHistoryRetention([ORG, 'org-b'])
    await tick()
    const [sent] = confirms(t)
    expect(sent.orgId).toBeUndefined()
    expect(sent.payload).toEqual({ orgIds: [ORG, 'org-b'] })
    const result = { entries: [{ orgId: ORG, revision: 2, historyRetentionDays: 7 }], noPolicy: ['org-b'], denied: [] }
    t.pushInbound(JSON.stringify(buildEnvelope('history-retention/confirm/result', result, { corr: sent.id })))
    await expect(answer).resolves.toEqual(result)
    client.stop()
  })

  it('splits a long list into capped requests and merges the answers', async () => {
    const { client, t } = await ready([HISTORY_RETENTION_CONFIRM_FEATURE])
    const orgIds = Array.from({ length: HISTORY_RETENTION_CONFIRM_MAX + 1 }, (_, i) => `org-${i}`)
    const answer = client.confirmHistoryRetention(orgIds)
    await tick()
    let [sent] = confirms(t)
    expect(sent.payload.orgIds).toHaveLength(HISTORY_RETENTION_CONFIRM_MAX)
    t.pushInbound(
      JSON.stringify(
        buildEnvelope(
          'history-retention/confirm/result',
          { entries: [], noPolicy: sent.payload.orgIds, denied: [] },
          { corr: sent.id }
        )
      )
    )
    await tick()
    sent = confirms(t)[1]
    expect(sent.payload.orgIds).toEqual([`org-${HISTORY_RETENTION_CONFIRM_MAX}`])
    t.pushInbound(
      JSON.stringify(
        buildEnvelope(
          'history-retention/confirm/result',
          { entries: [], noPolicy: [], denied: sent.payload.orgIds },
          { corr: sent.id }
        )
      )
    )
    const merged = await answer
    expect(merged.noPolicy).toHaveLength(HISTORY_RETENTION_CONFIRM_MAX)
    expect(merged.denied).toEqual([`org-${HISTORY_RETENTION_CONFIRM_MAX}`])
    client.stop()
  })

  it('throws on an error reply and on a timeout, without a retry', async () => {
    const { client, t, clock } = await ready([HISTORY_RETENTION_CONFIRM_FEATURE])
    const failed = client.confirmHistoryRetention([ORG])
    await tick()
    const [sent] = confirms(t)
    t.pushInbound(
      JSON.stringify(
        buildEnvelope('error', { code: 'INTERNAL', message: 'read failed', retryable: true }, { corr: sent.id })
      )
    )
    await expect(failed).rejects.toThrow()
    const timedOut = client.confirmHistoryRetention([ORG])
    const rejected = expect(timedOut).rejects.toThrow()
    await tick()
    clock.advance(10_000)
    await rejected
    expect(confirms(t)).toHaveLength(2)
    client.stop()
  })
})
