/**
 * `usageReporting.enabled` — which plane writes a session's usage to the CP.
 *
 * A daemon meters its own sessions and reports them; that is the default and the
 * console's usage history depends on it. A deployment that meters UPSTREAM of the daemon
 * turns this off so that plane is the single writer, because two writers on one session
 * would fight over the same cumulative row.
 *
 * The switch silences the report and nothing else: usage is still recorded locally, which
 * is where session status, `session/list` and compaction detection read it from. That half
 * is structural — the gate is in the CP client, downstream of the local store — so what
 * these tests pin is that the frame stops, that nothing else on the connection does, and
 * that turning it off is a deliberate act rather than a default.
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildEnvelope, USAGE_REPORTING_ENV } from '@agentconnect.md/protocol'
import { CpClient, type CpClientDeps } from '../../src/cp/client.js'
import { FakeTransport } from './fake-transport.js'
import { FakeClock } from './fake-clock.js'
import { ConfigSchema } from '../../src/config/config-schema.js'
import { loadConfig } from '../../src/config/load-config.js'

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

const report = {
  sessionId: 'acp-1',
  agentId: '11111111-1111-4111-8111-111111111111',
  lastActivityAt: '2026-08-18T00:00:00.000Z',
  usage: { totalTokens: 100, costAmount: 0.5, costCurrency: 'USD' }
}
const framesOf = (t: FakeTransport, type: string) =>
  t.sent.map((s) => JSON.parse(s) as { type: string }).filter((f) => f.type === type)

describe('usage reporting as a deployment choice', () => {
  it('reports by default — the console’s history depends on it', async () => {
    const t = new FakeTransport()
    const client = new CpClient(makeDeps(t))
    await reachReady(t, client)

    client.emitUsageReport(report)
    expect(framesOf(t, 'usage/report')).toHaveLength(1)
  })

  it('sends nothing once another plane is the writer', async () => {
    const t = new FakeTransport()
    const client = new CpClient(makeDeps(t, { usageReporting: false }))
    await reachReady(t, client)

    client.emitUsageReport(report)
    client.emitUsageReport({ ...report, sessionId: 'acp-2' })
    expect(framesOf(t, 'usage/report')).toEqual([])
  })

  it('silences ONLY the usage report, not the rest of the connection', async () => {
    const t = new FakeTransport()
    const client = new CpClient(makeDeps(t, { usageReporting: false }))
    await reachReady(t, client)
    const before = t.sent.length

    client.emitUsageReport(report)
    client.emitEventSession({
      sessionId: 'acp-1',
      agentId: report.agentId,
      phase: 'start',
      ts: '2026-06-26T00:00:00.000Z'
    })

    expect(framesOf(t, 'usage/report')).toEqual([])
    // The session milestone still goes: this switch is about who WRITES usage, not about
    // muting a daemon that has been told to stop reporting it.
    expect(t.sent.length).toBeGreaterThan(before)
    expect(framesOf(t, 'event/session')).toHaveLength(1)
  })

  it('takes the switch from the environment, because an in-cluster daemon has no file', () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-usage-env-'))
    const previous = process.env[USAGE_REPORTING_ENV]
    try {
      // `run` auto-creates `{version:1}` for a pod that ships no config, so the schema
      // default is the ONLY thing a deployment could otherwise get.
      process.env[USAGE_REPORTING_ENV] = 'false'
      expect(loadConfig({ root, autoCreate: true }).usageReporting.enabled).toBe(false)

      // A file that states a preference still wins — the env is the fallback for the pod
      // that has none, not an override of an operator who wrote one down.
      writeFileSync(join(root, 'config.json'), JSON.stringify({ version: 1, usageReporting: { enabled: true } }))
      expect(loadConfig({ root }).usageReporting.enabled).toBe(true)

      delete process.env[USAGE_REPORTING_ENV]
      rmSync(join(root, 'config.json'))
      expect(loadConfig({ root, autoCreate: true }).usageReporting.enabled).toBe(true)
    } finally {
      if (previous === undefined) delete process.env[USAGE_REPORTING_ENV]
      else process.env[USAGE_REPORTING_ENV] = previous
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('defaults to on in config, so turning it off is deliberate', () => {
    const parsed = ConfigSchema.parse({ version: 1 })
    expect(parsed.usageReporting.enabled).toBe(true)
    expect(ConfigSchema.parse({ version: 1, usageReporting: {} }).usageReporting.enabled).toBe(true)
    expect(ConfigSchema.parse({ version: 1, usageReporting: { enabled: false } }).usageReporting.enabled).toBe(false)
  })
})
