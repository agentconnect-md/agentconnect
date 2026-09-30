// A terminal cron outcome rides `cron/report-sync` only to a CP that advertised it; an older CP gets the EVT.
import { describe, it, expect, vi } from 'vitest'
import { buildEnvelope, CRON_REPORT_ACK_FEATURE } from '@agentconnect.md/protocol'
import { CpClient, type CpClientDeps } from '../../src/cp/client.js'
import { FakeTransport } from './fake-transport.js'
import { FakeClock } from './fake-clock.js'

const DAEMON_ID = '22222222-2222-4222-8222-222222222222'
const REPORT = {
  cronId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  agentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
  firedAt: '2026-09-30T09:00:00.000Z',
  status: 'success' as const,
  durationMs: 1200
}
const silent = { trace() {}, debug() {}, info() {}, warn() {}, error() {} }
const tick = () => new Promise((r) => setImmediate(r))

async function readyClient(serverFeatures: string[]) {
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
    jitter: () => 0
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

describe('CpClient terminal cron reports', () => {
  it('sends cron/report-sync to a CP that ACKs it and resolves on the ACK', async () => {
    const { client, transport } = await readyClient([CRON_REPORT_ACK_FEATURE])
    const pending = client.syncCronReport(REPORT)
    await tick()
    const request = transport.sent.map((text) => JSON.parse(text)).find((frame) => frame.type === 'cron/report-sync')
    expect(request?.payload).toEqual(REPORT)
    transport.pushInbound(JSON.stringify(buildEnvelope('ack', { ok: true }, { corr: request.id })))
    await expect(pending).resolves.toBe('acknowledged')
    await client.stop()
  })

  it('reports unsupported and sends nothing to a CP that does not advertise it', async () => {
    const { client, transport } = await readyClient([])
    await expect(client.syncCronReport(REPORT)).resolves.toBe('unsupported')
    expect(transport.sent.map((text) => JSON.parse(text).type)).not.toContain('cron/report-sync')
    await client.stop()
  })
})
