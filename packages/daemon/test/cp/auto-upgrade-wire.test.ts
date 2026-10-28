import { describe, expect, it, vi } from 'vitest'
import { buildEnvelope, DAEMON_LIFECYCLE_BEGIN_FEATURE } from '@agentconnect.md/protocol'
import { WireError } from '@agentconnect.md/connection'
import { CpClient, type CpClientDeps } from '../../src/cp/client.js'
import type { ConfigApply } from '../../src/cp/config-apply.js'
import { applyConfigPush, type ConfigApplyCoreHost } from '../../src/cp/config-apply-handlers.js'
import { ConfigSchema } from '../../src/config/config-schema.js'
import type { AutoUpgradeConfigSink } from '../../src/lifecycle/auto-upgrader.js'
import { FakeTransport } from './fake-transport.js'
import { FakeClock } from './fake-clock.js'

const DAEMON_ID = '22222222-2222-4222-8222-222222222222'
const tick = () => new Promise((r) => setImmediate(r))

describe('config/push auto-upgrade routing', () => {
  function pushHost(sink?: AutoUpgradeConfigSink) {
    const cfg = ConfigSchema.parse({ version: 1 })
    const log = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const host = {
      cfg: () => cfg,
      log: () => log,
      setLog: () => {},
      ...(sink ? { autoUpgrade: () => sink } : {})
    } as unknown as ConfigApplyCoreHost
    return { cfg, log, host }
  }

  it('routes upgrade.auto and upgrade.latest to the upgrader, not cfg, and does not report them ignored', () => {
    const sink: AutoUpgradeConfigSink = {
      applyConfigKeys: vi.fn((keys: Record<string, unknown>) => ({ applied: Object.keys(keys), ignored: [] })),
      applyRegisterOk: vi.fn()
    }
    const { cfg, log, host } = pushHost(sink)
    const release = { channel: 'latest', version: '1.41.0' }
    applyConfigPush(host, { 'upgrade.auto': true, 'upgrade.latest': release, 'logging.level': 'warn' })
    expect(sink.applyConfigKeys).toHaveBeenCalledWith({ 'upgrade.auto': true, 'upgrade.latest': release })
    expect(cfg.logging.level).toBe('warn')
    expect(cfg).not.toHaveProperty('upgrade')
    expect(log.info).toHaveBeenCalledWith('cp: applied config keys: logging.level, upgrade.auto, upgrade.latest')
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('reports the keys ignored when no upgrader is wired', () => {
    const { log, host } = pushHost()
    applyConfigPush(host, { 'upgrade.auto': true })
    expect(log.warn).toHaveBeenCalledWith('cp: ignored config keys: upgrade.auto')
  })
})

describe('CpClient auto-upgrade seams', () => {
  function makeDeps(transport: FakeTransport, over: Partial<CpClientDeps> = {}): CpClientDeps {
    return {
      url: 'wss://cp.example/daemon/ws',
      token: 'tok_abc',
      daemonId: DAEMON_ID,
      agentVersion: '0.0.0',
      host: 'host-1',
      heartbeatDefaultMs: 15000,
      maxAgents: 4,
      capabilities: () => ({ platforms: [], runtimes: [], acp: true, features: [] }),
      runtimeProfiles: () => [],
      localState: () => ({ assignments: [], crons: [], leases: [], agents: [], integrations: [], stagedAgents: [] }),
      loadSnapshot: () => ({ cpu: 0, mem: 0, agents: 0 }),
      activeSessions: () => 0,
      configApply: { applyReconcileSnapshot() {} } as unknown as ConfigApply,
      clock: new FakeClock(),
      connect: async () => transport,
      log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
      jitter: () => 0,
      ...over
    } as CpClientDeps
  }

  async function authenticate(t: FakeTransport): Promise<any> {
    await tick()
    const auth = t.lastSent()
    t.pushInbound(
      JSON.stringify(
        buildEnvelope(
          'auth/ok',
          { daemonId: DAEMON_ID, sessionEpoch: 1, heartbeatSec: 20, serverTime: '2026-06-26T00:00:00.000Z' },
          { corr: auth.id }
        )
      )
    )
    await tick()
    return t.lastSent()
  }

  it('hands a non-retryable register rejection to onRegisterRejected', async () => {
    const t = new FakeTransport()
    const onRegisterRejected = vi.fn()
    const client = new CpClient(makeDeps(t, { onRegisterRejected }))
    client.start()
    const reg = await authenticate(t)
    expect(reg.type).toBe('register')
    t.pushInbound(
      JSON.stringify(
        buildEnvelope('error', { code: 'PROTOCOL_STATE', message: 'refused', retryable: false }, { corr: reg.id })
      )
    )
    await tick()
    expect(onRegisterRejected).toHaveBeenCalledTimes(1)
    const err = onRegisterRejected.mock.calls[0]![0] as WireError
    expect(err).toBeInstanceOf(WireError)
    expect(err.code).toBe('PROTOCOL_STATE')
    client.stop()
  })

  it('opens a lifecycle record only on a READY link to a CP that advertises the frame', async () => {
    const t = new FakeTransport()
    const client = new CpClient(makeDeps(t))
    expect(client.canBeginLifecycle()).toBe(false)
    client.start()
    const reg = await authenticate(t)
    expect(client.handshaking()).toBe(true)
    t.pushInbound(
      JSON.stringify(
        buildEnvelope(
          'register/ok',
          {
            routingEpoch: 1,
            assignments: [],
            crons: [],
            leases: [],
            drop: { assignments: [], crons: [] },
            serverFeatures: [DAEMON_LIFECYCLE_BEGIN_FEATURE]
          },
          { corr: reg.id }
        )
      )
    )
    await tick()
    expect(client.state).toBe('READY')
    expect(client.handshaking()).toBe(false)
    expect(client.canBeginLifecycle()).toBe(true)

    const begun = client.beginLifecycle({
      op: 'upgrade',
      trigger: 'auto',
      fromVersion: '1.0.0',
      targetVersion: '1.1.0'
    })
    const req = t.lastSent()
    expect(req.type).toBe('daemon/lifecycle/begin')
    t.pushInbound(JSON.stringify(buildEnvelope('daemon/lifecycle/begin/ok', { operationId: 'op-1' }, { corr: req.id })))
    await expect(begun).resolves.toEqual({ operationId: 'op-1' })

    const conflicted = client.beginLifecycle({
      op: 'upgrade',
      trigger: 'auto',
      fromVersion: '1.0.0',
      targetVersion: '1.1.0'
    })
    const second = t.lastSent()
    t.pushInbound(
      JSON.stringify(
        buildEnvelope('error', { code: 'CONFLICT', message: 'pending', retryable: false }, { corr: second.id })
      )
    )
    await expect(conflicted).rejects.toMatchObject({ code: 'CONFLICT' })
    client.stop()
  })
})
