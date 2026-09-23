// `integration/revoked` goes on the wire only to a CP that advertised it, scoped to the reported integration's org.
import { describe, it, expect } from 'vitest'
import { INTEGRATION_REVOKED_FEATURE, buildEnvelope } from '@agentconnect.md/protocol'
import { CpClient, type CpClientDeps } from '../../src/cp/client.js'
import { FakeTransport } from './fake-transport.js'
import { FakeClock } from './fake-clock.js'

const DAEMON_ID = '22222222-2222-4222-8222-222222222222'
const INTEGRATION = '0f0e0d0c-0b0a-4908-8706-050403020100'
const ORG = 'org-a'
const REPORT = {
  integrationIds: [INTEGRATION],
  reason: 'app_uninstalled' as const,
  eventAtMs: 1_780_000_000_000,
  botUserId: 'U0FIXTURE',
  workspaceId: 'T0FIXTURE'
}

const tick = () => new Promise((r) => setImmediate(r))

/** A frame-mode client that reached READY against a CP advertising `serverFeatures`. */
async function ready(serverFeatures: string[]) {
  const t = new FakeTransport()
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
    orgForIntegration: (id: string) => (id === INTEGRATION ? ORG : undefined),
    configApply: { applyConfigPush() {}, applyReconcileSnapshot() {} },
    clock: new FakeClock(),
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
  return { client, t }
}

const reports = (t: FakeTransport) =>
  t.sent.map((raw) => JSON.parse(raw)).filter((f) => f.type === 'integration/revoked')

describe('CpClient.reportIntegrationRevoked', () => {
  it('sends nothing to a CP that does not advertise the frame', async () => {
    const { client, t } = await ready([])
    await expect(client.reportIntegrationRevoked(REPORT)).resolves.toBe('unsupported')
    expect(reports(t)).toEqual([])
  })

  it("sends the report in the integration's org and resolves with the CP's committed verdict", async () => {
    const { client, t } = await ready([INTEGRATION_REVOKED_FEATURE])
    const verdict = client.reportIntegrationRevoked(REPORT)
    await tick()
    const [sent] = reports(t)
    expect(sent).toMatchObject({ orgId: ORG, payload: REPORT })
    t.pushInbound(
      JSON.stringify(buildEnvelope('integration/revoked/ok', { applied: true }, { corr: sent.id, orgId: ORG }))
    )
    await expect(verdict).resolves.toEqual({ applied: true })
  })
})
