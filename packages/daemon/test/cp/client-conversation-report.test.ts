// A conversation report reaches the Control Plane only for an integration whose platform keeps a row per conversation; mail keeps none.
import { describe, it, expect, vi } from 'vitest'
import { buildEnvelope } from '@agentconnect.md/protocol'
import { CpClient, type CpClientDeps } from '../../src/cp/client.js'
import { FakeTransport } from './fake-transport.js'
import { FakeClock } from './fake-clock.js'

const DAEMON_ID = '22222222-2222-4222-8222-222222222222'
const silent = { trace() {}, debug() {}, info() {}, warn() {}, error() {} }
const tick = () => new Promise((r) => setImmediate(r))

async function readyClient(serverFeatures: string[], listsConversations: (integrationId: string) => boolean) {
  const transport = new FakeTransport()
  const deps = {
    url: 'wss://cp.example.test/daemon/ws',
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
    clock: new FakeClock(),
    connect: vi.fn(async () => transport),
    log: silent,
    jitter: () => 0,
    listsConversations
  } as unknown as CpClientDeps
  const client = new CpClient(deps)
  client.start()
  await tick()
  const auth = transport.lastSent()
  transport.pushInbound(
    JSON.stringify(
      buildEnvelope(
        'auth/ok',
        { daemonId: DAEMON_ID, sessionEpoch: 1, heartbeatSec: 15, serverTime: '2026-09-30T00:00:00.000Z' },
        { corr: auth.id }
      )
    )
  )
  await tick()
  const register = transport.lastSent()
  transport.pushInbound(
    JSON.stringify(
      buildEnvelope(
        'register/ok',
        {
          routingEpoch: 1,
          assignments: [],
          crons: [],
          leases: [],
          drop: { assignments: [], crons: [] },
          serverFeatures
        },
        { corr: register.id }
      )
    )
  )
  await tick()
  expect(client.state).toBe('READY')
  return { client, transport }
}

describe('CpClient conversation reports', () => {
  it('sends a listing platform’s report and drops one for a platform that lists no conversations', async () => {
    const { client, transport } = await readyClient([], (integrationId) => integrationId !== 'int-email')
    client.emitIntegrationChannels({
      integrationId: 'int-email',
      channels: [{ id: 'dm:alice@corp.example.test' }],
      authoritative: false
    })
    client.emitIntegrationChannels({ integrationId: 'int-slack', channels: [{ id: 'D42' }], authoritative: false })
    const reports = transport.sent
      .map((text) => JSON.parse(text))
      .filter((frame) => frame.type === 'integration/channels')
    expect(reports.map((frame) => frame.payload.integrationId)).toEqual(['int-slack'])
    await client.stop()
  })
})
