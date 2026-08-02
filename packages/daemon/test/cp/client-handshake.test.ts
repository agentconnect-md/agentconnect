import { describe, it, expect } from 'vitest'
import { buildEnvelope } from '@agentconnect.md/protocol'
import { CpClient, type CpClientDeps } from '../../src/cp/client.js'
import { FakeTransport } from './fake-transport.js'
import { FakeClock } from './fake-clock.js'

const DAEMON_ID = '22222222-2222-4222-8222-222222222222'
const silent = { trace() {}, debug() {}, info() {}, warn() {}, error() {} }

function makeDeps(transport: FakeTransport, over: Partial<CpClientDeps> = {}): CpClientDeps {
  const snap = {
    applyConfigPush() {},
    applyReconcileSnapshot() {},
    upsertCron() {},
    removeCron() {},
    applyRouteAssign() {},
    applyRouteUpdate() {}
  }
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
    configApply: snap,
    clock: new FakeClock(),
    connect: async () => transport,
    log: silent,
    jitter: () => 0,
    ...over
  }
}

/** Resolve queued microtasks so the client's async connect chain advances. */
const tick = () => new Promise((r) => setImmediate(r))

describe('CpClient handshake', () => {
  it('dials, authenticates, registers, and reaches READY', async () => {
    const t = new FakeTransport()
    const applied: any[] = []
    const client = new CpClient(
      makeDeps(t, {
        configApply: {
          applyConfigPush() {},
          applyReconcileSnapshot: (s) => applied.push(s),
          upsertCron() {},
          removeCron() {},
          applyRouteAssign() {},
          applyRouteUpdate() {}
        }
      })
    )
    client.start()
    await tick()

    // 1. first frame is `auth`
    const auth = t.lastSent()
    expect(auth.type).toBe('auth')
    expect(auth.payload.apiKey).toBe('tok_abc')
    expect(auth.payload.daemonId).toBe(DAEMON_ID)

    // 2. CP replies auth/ok → client adopts the epoch
    t.pushInbound(
      JSON.stringify(
        buildEnvelope(
          'auth/ok',
          {
            daemonId: DAEMON_ID,
            sessionEpoch: 7,
            heartbeatSec: 20,
            serverTime: '2026-06-26T00:00:00.000Z'
          },
          { corr: auth.id }
        )
      )
    )
    await tick()
    expect(client.sessionEpoch).toBe(7)

    // 3. next frame is `register`
    const reg = t.lastSent()
    expect(reg.type).toBe('register')
    expect(reg.payload.capabilities.runtimes).toEqual(['claude'])
    expect(reg.payload.localState.agents).toEqual([])
    expect(reg.payload.localState.integrations).toEqual([])
    expect(reg.payload.localState.stagedAgents).toEqual([])

    // 4. CP replies register/ok → snapshot applied, READY
    t.pushInbound(
      JSON.stringify(
        buildEnvelope(
          'register/ok',
          {
            routingEpoch: 3,
            assignments: [],
            crons: [],
            leases: [],
            drop: { assignments: [], crons: [] }
          },
          { corr: reg.id }
        )
      )
    )
    await tick()
    expect(client.state).toBe('READY')
    expect(client.routingEpoch).toBe(3)
    expect(applied).toHaveLength(1)
  })

  it('joins a blocked reconcile snapshot on stop and never transitions that connection to READY', async () => {
    const t = new FakeTransport()
    let releaseSnapshot!: () => void
    const blocked = new Promise<void>((resolve) => (releaseSnapshot = resolve))
    let markSnapshotEntered!: () => void
    const entered = new Promise<void>((resolve) => (markSnapshotEntered = resolve))
    let ready = false
    const client = new CpClient(
      makeDeps(t, {
        configApply: {
          applyConfigPush() {},
          async applyReconcileSnapshot() {
            markSnapshotEntered()
            await blocked
          },
          upsertCron() {},
          removeCron() {},
          applyRouteAssign() {},
          applyRouteUpdate() {}
        },
        onReady: () => {
          ready = true
        }
      })
    )
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
    await entered

    let stopped = false
    const stopping = client.stop().then(() => {
      stopped = true
    })
    await tick()
    expect(stopped).toBe(false)

    releaseSnapshot()
    await stopping
    expect(client.state).toBe('CLOSED')
    expect(ready).toBe(false)
    expect(t.sent.map((value) => JSON.parse(value)).some((frame) => frame.type === 'facts/daemon-runtimes')).toBe(false)
  })

  it('queues controls after register/ok until snapshot convergence and drains them FIFO before READY', async () => {
    const t = new FakeTransport()
    const prematureAgentId = '33333333-3333-4333-8333-333333333333'
    const removedAgentIds = ['44444444-4444-4444-8444-444444444444', '55555555-5555-4555-8555-555555555555']
    let releaseSnapshot!: () => void
    const blocked = new Promise<void>((resolve) => (releaseSnapshot = resolve))
    let markSnapshotEntered!: () => void
    const entered = new Promise<void>((resolve) => (markSnapshotEntered = resolve))
    const events: string[] = []
    const client = new CpClient(
      makeDeps(t, {
        configApply: {
          applyConfigPush() {},
          async applyReconcileSnapshot() {
            events.push('snapshot:start')
            markSnapshotEntered()
            await blocked
            events.push('snapshot:end')
          },
          applyAgentRemove(agentId: string) {
            events.push(`remove:${agentId}`)
          },
          async applyAgentUpsert(upsert: { agentId: string }) {
            events.push(`upsert:${upsert.agentId}`)
            return { ok: true }
          },
          upsertCron() {},
          removeCron() {},
          applyRouteAssign() {},
          applyRouteUpdate() {}
        },
        onReady: () => events.push('ready')
      })
    )
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

    // Merely sending register is not enough to open the barrier: controls before
    // the correlated register/ok remain protocol errors and never reach config.
    const prematureRemove = buildEnvelope(
      'agent/remove',
      { agentId: prematureAgentId },
      { epoch: 7, agentId: prematureAgentId }
    )
    t.pushInbound(JSON.stringify(prematureRemove))
    expect(events).toEqual([])
    expect(t.sent.map((value) => JSON.parse(value))).toContainEqual(
      expect.objectContaining({
        type: 'error',
        corr: prematureRemove.id,
        payload: expect.objectContaining({ code: 'PROTOCOL_STATE' })
      })
    )

    // Deliver register/ok and the first controls in one JS turn. The handshake
    // continuation has not started snapshot convergence yet, so this exercises
    // the exact CP-ready/daemon-REGISTERING race.
    t.pushInbound(
      JSON.stringify(
        buildEnvelope(
          'register/ok',
          { routingEpoch: 3, assignments: [], crons: [], leases: [], drop: { assignments: [], crons: [] } },
          { corr: reg.id }
        )
      )
    )
    const queuedControls = [
      buildEnvelope('agent/remove', { agentId: removedAgentIds[0] }, { epoch: 7, agentId: removedAgentIds[0] }),
      buildEnvelope(
        'agent/upsert',
        { agentId: removedAgentIds[0], spec: { name: 'restored-after-remove' } },
        { epoch: 7, agentId: removedAgentIds[0] }
      ),
      buildEnvelope('agent/remove', { agentId: removedAgentIds[1] }, { epoch: 7, agentId: removedAgentIds[1] })
    ]
    for (const control of queuedControls) t.pushInbound(JSON.stringify(control))
    await entered
    await tick()

    expect(client.state).toBe('REGISTERING')
    expect(events).toEqual(['snapshot:start'])
    for (const control of queuedControls) {
      expect(t.sent.map((value) => JSON.parse(value))).not.toContainEqual(
        expect.objectContaining({ type: 'error', corr: control.id })
      )
    }

    releaseSnapshot()
    await tick()
    expect(client.state).toBe('READY')
    expect(events).toEqual([
      'snapshot:start',
      'snapshot:end',
      `remove:${removedAgentIds[0]}`,
      `upsert:${removedAgentIds[0]}`,
      `remove:${removedAgentIds[1]}`,
      'ready'
    ])
  })

  it('fails a malformed correlated register/ok immediately instead of timing out', async () => {
    const t = new FakeTransport()
    const warnings: string[] = []
    const client = new CpClient(
      makeDeps(t, {
        log: { ...silent, warn: (message) => warnings.push(message) }
      })
    )
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

    // Valid envelope + correlation, invalid register/ok payload.
    t.pushInbound(
      JSON.stringify(
        buildEnvelope(
          'register/ok',
          {
            routingEpoch: 'not-a-number',
            assignments: [],
            crons: [],
            leases: [],
            drop: { assignments: [], crons: [] }
          },
          { corr: reg.id }
        )
      )
    )
    await tick()

    expect(t.closed?.code).toBe(1011)
    expect(client.state).toBe('DEGRADED')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('invalid correlated reply')
    expect(warnings[0]).not.toContain('no ack after')
  })

  it('emits one facts/daemon-runtimes snapshot once READY', async () => {
    const t = new FakeTransport()
    const client = new CpClient(
      makeDeps(t, {
        runtimeProfiles: () => [
          { runtime: 'claude-acp', version: '1.2.3', models: [], acpSupport: 'full', toolCalling: true },
          { runtime: 'codex-acp', version: '2.0.0', models: [], acpSupport: 'full', toolCalling: true }
        ]
      })
    )
    client.start()
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
    // No facts before register completes.
    expect(t.sent.map((s) => JSON.parse(s)).some((f) => f.type === 'facts/daemon-runtimes')).toBe(false)
    const reg = t.lastSent()
    t.pushInbound(
      JSON.stringify(
        buildEnvelope(
          'register/ok',
          { routingEpoch: 1, assignments: [], crons: [], leases: [], drop: { assignments: [], crons: [] } },
          { corr: reg.id }
        )
      )
    )
    await tick()
    expect(client.state).toBe('READY')
    const snaps = t.sent.map((s) => JSON.parse(s)).filter((f) => f.type === 'facts/daemon-runtimes')
    expect(snaps).toHaveLength(1)
    expect(snaps[0].payload.runtimes).toHaveLength(2)
    expect(snaps[0].payload.runtimes[0]).toMatchObject({ runtime: 'claude-acp', version: '1.2.3', models: [] })
  })

  it('fires onReady after the initial runtime snapshot', async () => {
    const t = new FakeTransport()
    let readySnapshotsAtCall = -1
    const client: CpClient = new CpClient(
      makeDeps(t, {
        runtimeProfiles: () => [
          { runtime: 'claude-acp', version: '1.0.0', models: [], acpSupport: 'full', toolCalling: true }
        ],
        onReady: () => {
          // onReady runs after the handshake's initial emit, so exactly one snapshot is out.
          readySnapshotsAtCall = t.sent
            .map((s) => JSON.parse(s))
            .filter((f) => f.type === 'facts/daemon-runtimes').length
        }
      })
    )

    client.start()
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
    const reg = t.lastSent()
    t.pushInbound(
      JSON.stringify(
        buildEnvelope(
          'register/ok',
          { routingEpoch: 1, assignments: [], crons: [], leases: [], drop: { assignments: [], crons: [] } },
          { corr: reg.id }
        )
      )
    )
    await tick()
    expect(client.state).toBe('READY')
    expect(readySnapshotsAtCall).toBe(1)
  })

  it('emitDaemonRuntimes pushes the full snapshot only when READY', async () => {
    const t = new FakeTransport()
    const client = new CpClient(makeDeps(t))

    // Before READY, emitDaemonRuntimes is a no-op.
    client.emitDaemonRuntimes([{ runtime: 'x', version: '', models: [], acpSupport: 'full', toolCalling: true }])
    expect(t.sent).toHaveLength(0)

    client.start()
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
    const reg = t.lastSent()
    t.pushInbound(
      JSON.stringify(
        buildEnvelope(
          'register/ok',
          { routingEpoch: 1, assignments: [], crons: [], leases: [], drop: { assignments: [], crons: [] } },
          { corr: reg.id }
        )
      )
    )
    await tick()
    expect(client.state).toBe('READY')

    // READY — the post-sweep snapshot reaches the wire as one frame (after the
    // handshake's initial empty snapshot).
    client.emitDaemonRuntimes([
      { runtime: 'claude-acp', version: '1.0.0', models: ['opus'], acpSupport: 'full', toolCalling: true },
      { runtime: 'codex-acp', version: '2.0.0', models: [], acpSupport: 'full', toolCalling: true }
    ])
    const snaps = t.sent.map((s) => JSON.parse(s)).filter((f) => f.type === 'facts/daemon-runtimes')
    expect(snaps).toHaveLength(2)
    expect(snaps[0].payload.runtimes).toHaveLength(0) // handshake snapshot (runtimeProfiles() is [])
    expect(snaps[1].payload.runtimes).toHaveLength(2)
    expect(snaps[1].payload.runtimes[0]).toMatchObject({ runtime: 'claude-acp', models: ['opus'] })
  })

  it('stop() closes the transport and rejects in-flight requests', async () => {
    const t = new FakeTransport()
    const client = new CpClient(makeDeps(t))
    client.start()
    await tick()
    await client.stop()
    expect(t.closed?.code).toBe(1000)
    expect(client.state).toBe('CLOSED')
  })

  it('token-only (no daemonId): omits daemonId from auth, adopts the id from auth/ok', async () => {
    const t = new FakeTransport()
    const adopted: string[] = []
    const ASSIGNED = '99999999-9999-4999-8999-999999999999'
    const client = new CpClient(makeDeps(t, { daemonId: undefined, onDaemonId: (id) => adopted.push(id) }))
    client.start()
    await tick()

    // auth carries the token but NO daemonId — the token's `sub` is authoritative.
    const auth = t.lastSent()
    expect(auth.type).toBe('auth')
    expect(auth.payload.apiKey).toBe('tok_abc')
    expect(auth.payload.daemonId).toBeUndefined()

    // CP assigns the id in auth/ok → the client adopts it.
    t.pushInbound(
      JSON.stringify(
        buildEnvelope(
          'auth/ok',
          { daemonId: ASSIGNED, sessionEpoch: 1, heartbeatSec: 15, serverTime: '2026-06-26T00:00:00.000Z' },
          { corr: auth.id }
        )
      )
    )
    await tick()
    expect(adopted).toEqual([ASSIGNED])
  })
})
