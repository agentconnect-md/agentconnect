import { describe, it, expect, vi } from 'vitest'
import { buildEnvelope, decodeEnvelope, MAX_FRAME_BYTES } from '@agentconnect.md/protocol'
import { CpClient, type CpClientDeps } from '../../src/cp/client.js'
import { WorkspaceViolationError } from '../../src/cp/workspace-reader.js'
import { FakeTransport } from './fake-transport.js'
import { FakeClock } from './fake-clock.js'

const DAEMON_ID = '22222222-2222-4222-8222-222222222222'
const CRON_ID = '55555555-5555-4555-8555-555555555555'
const CRON_AGENT_ID = '66666666-6666-4666-8666-666666666666'
const MOVE_ID = '77777777-7777-4777-8777-777777777777'
const SESSION_KEY = { platform: 'slack', channel: 'C1' }
const silent = { trace() {}, debug() {}, info() {}, warn() {}, error() {} }
const tick = () => new Promise((r) => setImmediate(r))

function frame(type: string, payload: unknown, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ ...buildEnvelope(type as any, payload), ...extra })
}

async function readyClient(over: Partial<CpClientDeps> = {}, serverFeatures: string[] = ['hook-report-ack-v1']) {
  const t = new FakeTransport()
  const clock = new FakeClock()
  // Merge configApply/sessionRead/workspaceRead overrides into the default mocks — do NOT let ...over clobber them.
  const {
    configApply: configApplyOver,
    sessionRead: _sessionReadOver,
    workspaceRead: _workspaceReadOver,
    workspaceGit: _workspaceGitOver,
    ...overRest
  } = over
  const configApply = {
    applyConfigPush: vi.fn(),
    applyReconcileSnapshot: vi.fn(),
    applyAgentUpsert: vi.fn(async () => ({ ok: true })),
    applyAgentRemove: vi.fn(),
    applyAgentDetach: vi.fn(async () => ({ ok: true })),
    applyAgentActivate: vi.fn(async () => ({ ok: true })),
    upsertCron: vi.fn(),
    removeCron: vi.fn(),
    runCron: vi.fn(() => ({ ok: true })),
    applyRouteAssign: vi.fn(),
    applyRouteUpdate: vi.fn(),
    applyRelayRoster: vi.fn(),
    applyCollabRoutes: vi.fn(),
    applyIntegrationUpsert: vi.fn(),
    applyIntegrationRemove: vi.fn(),
    applyMcpServerUpsert: vi.fn(),
    applyMcpServerRemove: vi.fn(),
    applyMemoryConnectionUpsert: vi.fn(async () => ({ ok: true })),
    applyMemoryConnectionRemove: vi.fn(),
    applyAgentLaunch: vi.fn(async () => ({
      agentId: DAEMON_ID,
      launchId: DAEMON_ID,
      startedAt: '2026-06-26T00:00:00.000Z',
      runtime: 'claude'
    })),
    applyAgentStop: vi.fn(async () => ({ ok: true })),
    applyDaemonDrain: vi.fn(async (_d: unknown, onProgress: (p: unknown) => void) => {
      onProgress({ remaining: 0, drained: [] })
      return { released: [SESSION_KEY] }
    }),
    applyDaemonRestart: vi.fn(() => ({ accepted: true, willDrainUntil: '2026-06-26T00:00:25.000Z' })),
    applyDaemonUpgrade: vi.fn(() => ({ accepted: true, willDrainUntil: '2026-06-26T00:00:25.000Z' })),
    ...((configApplyOver as any) ?? {})
  }
  const sessionRead = {
    list: vi.fn(() => ({ sessions: [] })),
    history: vi.fn(() => ({ sessionId: DAEMON_ID, messages: [] })),
    ...((over.sessionRead as any) ?? {})
  }
  const workspaceRead = {
    list: vi.fn(async () => ({ agentId: 'a', path: '', exists: true, entries: [] })),
    read: vi.fn(async () => ({ agentId: 'a', path: 'f', exists: false })),
    write: vi.fn(async () => ({ agentId: 'a', path: 'f', size: 0, mtime: '2026-06-26T00:00:00.000Z' })),
    delete: vi.fn(async () => ({ agentId: 'a', path: 'f' })),
    ...((over.workspaceRead as any) ?? {})
  }
  const workspaceGit = {
    status: vi.fn(async () => ({ agentId: 'a', isRepo: false, clean: true })),
    pull: vi.fn(async () => ({ agentId: 'a', isRepo: false, ok: false })),
    ...((over.workspaceGit as any) ?? {})
  }
  const deps: CpClientDeps = {
    url: 'wss://cp/daemon/ws',
    token: 't',
    daemonId: DAEMON_ID,
    agentVersion: '0.0.0',
    host: 'h',
    heartbeatDefaultMs: 15000,
    maxAgents: 4,
    capabilities: () => ({ platforms: ['slack'], runtimes: [], acp: true, features: [] }),
    runtimeProfiles: () => [],
    localState: () => ({ assignments: [], crons: [], leases: [], agents: [], integrations: [], stagedAgents: [] }),
    loadSnapshot: () => ({ cpu: 0.1, mem: 0.2, agents: 1 }),
    activeSessions: () => 2,
    configApply,
    sessionRead,
    workspaceRead,
    workspaceGit,
    clock,
    connect: async () => t,
    log: silent,
    jitter: () => 0,
    ...overRest
  }
  const client = new CpClient(deps)
  client.start()
  await tick()
  const auth = t.lastSent()
  t.pushInbound(
    JSON.stringify(
      buildEnvelope(
        'auth/ok',
        {
          daemonId: DAEMON_ID,
          sessionEpoch: 5,
          heartbeatSec: 15,
          serverTime: '2026-06-26T00:00:00.000Z'
        },
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
        {
          routingEpoch: 1,
          serverFeatures,
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
  t.sent.length = 0 // clear handshake frames
  vi.clearAllMocks() // reset mock call counts after handshake
  return { t, clock, client, configApply, workspaceRead, workspaceGit }
}

describe('CpClient dispatch', () => {
  it('tracks additive CP features negotiated through register/ok', async () => {
    const { client } = await readyClient({}, ['hook-report-ack-v1', 'gitcred-actions-v1'])
    expect(client.supportsServerFeature('gitcred-actions-v1')).toBe(true)
    expect(client.supportsServerFeature('future-feature')).toBe(false)
  })

  it('keeps hook/report correlated until the CP durably ACKs it', async () => {
    const { t, client } = await readyClient()
    let settled = false
    const reporting = client
      .emitHookReport({
        hookId: '11111111-1111-4111-8111-111111111111',
        agentId: CRON_AGENT_ID,
        deliveryKey: 'delivery-1',
        status: 'success'
      })
      .then(() => {
        settled = true
      })
    const request = t.lastSent()
    expect(request.type).toBe('hook/report')
    await tick()
    expect(settled).toBe(false)

    t.pushInbound(JSON.stringify(buildEnvelope('ack', { ok: true }, { corr: request.id })))
    await reporting
    expect(settled).toBe(true)
  })

  it('uses one legacy hook/report EVT without waiting when CP has no ACK capability', async () => {
    const { t, client } = await readyClient({}, [])
    await expect(
      client.emitHookReport({
        hookId: '11111111-1111-4111-8111-111111111111',
        agentId: CRON_AGENT_ID,
        deliveryKey: 'delivery-1',
        status: 'success'
      })
    ).resolves.toBe('legacy-sent')

    expect(t.sent).toHaveLength(1)
    expect(t.lastSent()).toMatchObject({ type: 'hook/report' })
    expect(t.lastSent().corr).toBeUndefined()
  })

  it('emits a heartbeat every heartbeatSec with the load snapshot', async () => {
    const { t, clock } = await readyClient()
    clock.advance(15000)
    const hb = JSON.parse(t.sent[0]!)
    expect(hb.type).toBe('heartbeat')
    expect(hb.payload.load).toEqual({ cpu: 0.1, mem: 0.2, agents: 1 })
    expect(hb.payload.activeSessions).toBe(2)
  })

  it('surfaces the degradedScopes dep in the heartbeat payload', async () => {
    const { t, clock } = await readyClient({ degradedScopes: () => ['x'] })
    clock.advance(15000)
    const hb = JSON.parse(t.sent[0]!)
    expect(hb.type).toBe('heartbeat')
    expect(hb.payload.degradedScopes).toEqual(['x'])
  })

  it('defaults degradedScopes to [] when no dep is provided', async () => {
    const { t, clock } = await readyClient()
    clock.advance(15000)
    const hb = JSON.parse(t.sent[0]!)
    expect(hb.payload.degradedScopes).toEqual([])
  })

  it('applies config/push (no reply — it is an EVT)', async () => {
    const { t, configApply } = await readyClient()
    t.pushInbound(frame('config/push', { keys: { 'logging.level': 'debug' } }, { epoch: 5 }))
    expect(configApply.applyConfigPush).toHaveBeenCalledWith({ 'logging.level': 'debug' })
    expect(t.sent).toHaveLength(0)
  })

  it('upserts a cron and acks ok', async () => {
    const { t, configApply } = await readyClient()
    const f = JSON.parse(
      frame(
        'cron/upsert',
        {
          cronId: CRON_ID,
          agentId: CRON_AGENT_ID,
          schedule: '0 * * * *',
          timezone: 'UTC',
          target: { channel: 'C1' },
          trigger: 'hi',
          enabled: true
        },
        { epoch: 5 }
      )
    )
    t.pushInbound(JSON.stringify(f))
    expect(configApply.upsertCron).toHaveBeenCalled()
    const ack = JSON.parse(t.sent[0]!)
    expect(ack.type).toBe('ack')
    expect(ack.payload.ok).toBe(true)
    expect(ack.corr).toBe(f.id)
  })

  it('cron/run acks with the configApply verdict (console "Run now")', async () => {
    const { t, configApply } = await readyClient({
      configApply: { runCron: vi.fn(() => ({ ok: false, reason: 'unknown cron' })) } as any
    })
    const f = JSON.parse(frame('cron/run', { cronId: CRON_ID }, { epoch: 5 }))
    t.pushInbound(JSON.stringify(f))
    expect(configApply.runCron).toHaveBeenCalledWith(CRON_ID)
    const ack = JSON.parse(t.sent[0]!)
    expect(ack.type).toBe('ack')
    expect(ack.corr).toBe(f.id)
    expect(ack.payload).toEqual({ ok: false, reason: 'unknown cron' })
  })

  it('errors a cron with a bad schedule', async () => {
    const { t } = await readyClient({
      configApply: {
        upsertCron: () => {
          throw new Error('bad cron')
        }
      } as any
    })
    const f = JSON.parse(
      frame(
        'cron/upsert',
        {
          cronId: CRON_ID,
          agentId: CRON_AGENT_ID,
          schedule: 'not-a-cron',
          timezone: 'UTC',
          target: { channel: 'C1' },
          trigger: 'hi',
          enabled: true
        },
        { epoch: 5 }
      )
    )
    t.pushInbound(JSON.stringify(f))
    const err = JSON.parse(t.sent[0]!)
    expect(err.type).toBe('error')
    expect(err.corr).toBe(f.id)
  })

  it('applies route/assign (no longer a no-op) and acks ok', async () => {
    const { t, configApply } = await readyClient()
    const f = JSON.parse(
      frame(
        'route/assign',
        {
          sessionKey: SESSION_KEY,
          agentId: DAEMON_ID,
          workspaceId: DAEMON_ID,
          bindRules: [{ match: { kind: 'auto' } }]
        },
        { epoch: 5 }
      )
    )
    t.pushInbound(JSON.stringify(f))
    expect(configApply.applyRouteAssign).toHaveBeenCalled()
    const ack = JSON.parse(t.sent[0]!)
    expect(ack.type).toBe('route/assign/ack')
    expect(ack.payload.ok).toBe(true)
    expect(ack.corr).toBe(f.id)
  })

  it('applies agent/upsert and replies after the live reconcile barrier', async () => {
    const { t, configApply } = await readyClient()
    t.pushInbound(
      frame(
        'agent/upsert',
        { agentId: DAEMON_ID, spec: { name: 'helper', model: 'opus' } },
        { epoch: 5, agentId: DAEMON_ID }
      )
    )
    // Legacy payloads still receive the inbound collection default, but the
    // outbound list remains absent with its optional policy so a mixed-version
    // update cannot clear an existing selected allow-list. skills defaults to [].
    expect(configApply.applyAgentUpsert).toHaveBeenCalledWith({
      agentId: DAEMON_ID,
      spec: {
        name: 'helper',
        model: 'opus',
        mcpServers: [],
        skills: [],
        allowedCallerAgentIds: []
      }
    })
    await vi.waitFor(() => expect(t.sent).toHaveLength(1))
    const ack = JSON.parse(t.sent[0]!)
    expect(ack.type).toBe('ack')
    expect(ack.payload.ok).toBe(true)
  })

  it('applies agent/remove (EVT, no reply)', async () => {
    const { t, configApply } = await readyClient()
    t.pushInbound(frame('agent/remove', { agentId: DAEMON_ID }, { epoch: 5, agentId: DAEMON_ID }))
    expect(configApply.applyAgentRemove).toHaveBeenCalledWith(DAEMON_ID)
    expect(t.sent).toHaveLength(0)
  })

  it('detaches an agent and replies with the lifecycle ACK', async () => {
    const { t, configApply } = await readyClient()
    const payload = { agentId: DAEMON_ID, moveId: MOVE_ID }
    const f = JSON.parse(frame('agent/detach', payload, { epoch: 5, agentId: DAEMON_ID }))
    t.pushInbound(JSON.stringify(f))
    await tick()
    expect(configApply.applyAgentDetach).toHaveBeenCalledWith(payload)
    expect(JSON.parse(t.sent[0]!)).toMatchObject({ type: 'ack', corr: f.id, payload: { ok: true } })
  })

  it('activates an agent and preserves a negative lifecycle ACK', async () => {
    const { t, configApply } = await readyClient({
      configApply: { applyAgentActivate: vi.fn(async () => ({ ok: false, reason: 'runtime unavailable' })) } as any
    })
    const payload = { agentId: DAEMON_ID, moveId: MOVE_ID, spec: { name: 'helper' }, integrations: [], crons: [] }
    const f = JSON.parse(frame('agent/activate', payload, { epoch: 5, agentId: DAEMON_ID }))
    t.pushInbound(JSON.stringify(f))
    await tick()
    expect(configApply.applyAgentActivate).toHaveBeenCalledWith({
      ...payload,
      spec: { name: 'helper', mcpServers: [], skills: [], allowedCallerAgentIds: [] }
    })
    expect(JSON.parse(t.sent[0]!)).toMatchObject({
      type: 'ack',
      corr: f.id,
      payload: { ok: false, reason: 'runtime unavailable' }
    })
  })

  it('applies route/update (EVT, no reply)', async () => {
    const { t, configApply } = await readyClient()
    t.pushInbound(
      frame('route/update', { routingEpoch: 2, rules: [{ match: { kind: 'dm' }, agentId: DAEMON_ID }] }, { epoch: 5 })
    )
    expect(configApply.applyRouteUpdate).toHaveBeenCalled()
    expect(t.sent).toHaveLength(0)
  })

  it('applies relay/roster (EVT, no reply) → converge the relay dial set (shared-bot-relay.md §5)', async () => {
    const { t, configApply } = await readyClient()
    const relays = [{ relayId: DAEMON_ID, url: 'wss://relay-0.example.test' }]
    t.pushInbound(frame('relay/roster', { relays }, { epoch: 5 }))
    expect(configApply.applyRelayRoster).toHaveBeenCalledWith(relays)
    expect(t.sent).toHaveLength(0)
  })

  it('ACKs daemon-private memory connection upsert after probing; remove remains an EVT', async () => {
    const { t, configApply } = await readyClient()
    const connectionId = '11111111-1111-4111-8111-111111111111'
    const spec = {
      connectionId,
      revision: 1,
      transport: 'streamable-http',
      relayUrl: `https://relay.example/memory/${connectionId}`,
      grantKey: 'private-grant',
      config: { projectId: 'p1' },
      secretKeys: ['apiKey'],
      pin: {
        pluginId: 'ai.example.memory',
        profileMajor: 1,
        secretHeaders: [{ name: 'apiKey', header: 'X-Api-Key', required: true }]
      }
    }
    t.pushInbound(frame('memoryconnection/upsert', spec, { epoch: 5 }))
    await tick()
    expect(configApply.applyMemoryConnectionUpsert).toHaveBeenCalledWith(spec)
    expect(JSON.parse(t.sent[0]!)).toMatchObject({ type: 'ack', payload: { ok: true } })

    t.sent.length = 0
    t.pushInbound(frame('memoryconnection/remove', { connectionId }, { epoch: 5 }))
    expect(configApply.applyMemoryConnectionRemove).toHaveBeenCalledWith(connectionId)
    expect(t.sent).toHaveLength(0)
  })

  it('emits metadata-only memory connection facts only while READY', async () => {
    const { t, client } = await readyClient()
    const fact = {
      connectionId: '11111111-1111-4111-8111-111111111111',
      revision: 1,
      pluginId: 'ai.example.memory',
      status: 'ready' as const
    }
    client.emitMemoryConnectionFacts([fact])
    expect(JSON.parse(t.sent[0]!)).toMatchObject({
      type: 'facts/memory-connections',
      payload: { connections: [fact] }
    })
    await client.stop()
    t.sent.length = 0
    client.emitMemoryConnectionFacts([fact])
    expect(t.sent).toHaveLength(0)
  })

  it('chunks large memory connection fact snapshots below the wire frame cap', async () => {
    const { t, client } = await readyClient()
    const declaredEgressHosts = Array.from(
      { length: 128 },
      (_, index) => `${String(index).padStart(3, '0')}.${'h'.repeat(240)}.example`
    )
    const facts = Array.from({ length: 20 }, (_, index) => ({
      connectionId: `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`,
      revision: 1,
      pluginId: 'ai.example.memory',
      declaredEgressHosts,
      status: 'ready' as const
    }))

    client.emitMemoryConnectionFacts(facts)

    expect(t.sent.length).toBeGreaterThan(1)
    const received = t.sent.flatMap((raw) => {
      expect(Buffer.byteLength(raw, 'utf8')).toBeLessThanOrEqual(MAX_FRAME_BYTES)
      const decoded = decodeEnvelope(raw)
      expect(decoded.ok).toBe(true)
      if (!decoded.ok || decoded.frame.type !== 'facts/memory-connections') return []
      return decoded.frame.payload.connections
    })
    expect(received).toEqual(facts)
  })

  it('rejects a stale-epoch control frame with STALE_EPOCH', async () => {
    const { t } = await readyClient() // sessionEpoch = 5
    const f = JSON.parse(frame('config/push', { keys: {} }, { epoch: 4 }))
    t.pushInbound(JSON.stringify(f))
    const err = JSON.parse(t.sent[0]!)
    expect(err.type).toBe('error')
    expect(err.payload.code).toBe('STALE_EPOCH')
  })

  it('launches an agent and replies agent/launched', async () => {
    const { t, configApply } = await readyClient()
    const f = JSON.parse(
      frame(
        'agent/launch',
        {
          agentId: DAEMON_ID,
          runtime: 'claude',
          workspaceId: DAEMON_ID,
          capabilities: [],
          spec: { name: 'helper' },
          mode: 'long_lived'
        },
        { epoch: 5 }
      )
    )
    t.pushInbound(JSON.stringify(f))
    await tick()
    expect(configApply.applyAgentLaunch).toHaveBeenCalled()
    const rep = JSON.parse(t.sent[0]!)
    expect(rep.type).toBe('agent/launched')
    expect(rep.corr).toBe(f.id)
    expect(rep.payload.agentId).toBe(DAEMON_ID)
  })

  it('stops an agent and acks ok', async () => {
    const { t, configApply } = await readyClient()
    const f = JSON.parse(
      frame('agent/stop', { agentId: DAEMON_ID, launchId: DAEMON_ID, reason: 'rebalance' }, { epoch: 5 })
    )
    t.pushInbound(JSON.stringify(f))
    await tick()
    expect(configApply.applyAgentStop).toHaveBeenCalled()
    const ack = JSON.parse(t.sent[0]!)
    expect(ack.type).toBe('ack')
    expect(ack.payload.ok).toBe(true)
    expect(ack.corr).toBe(f.id)
  })

  it('replies workspace/write/ok from the scratch workspace file seam', async () => {
    const write = vi.fn(async () => ({
      agentId: 'a1',
      path: 'notes.md',
      size: 7,
      mtime: '2026-06-26T00:01:00.000Z'
    }))
    const { t, workspaceRead } = await readyClient({ workspaceRead: { write } as any })
    const payload = {
      agentId: 'a1',
      path: 'notes.md',
      contentBase64: Buffer.from('updated').toString('base64'),
      ifMatchMtime: '2026-06-26T00:00:00.000Z'
    }
    const f = JSON.parse(frame('workspace/write', payload, { epoch: 5 }))
    t.pushInbound(JSON.stringify(f))
    await tick()
    expect(workspaceRead.write).toHaveBeenCalledWith(payload)
    const rep = JSON.parse(t.sent[0]!)
    expect(rep.type).toBe('workspace/write/ok')
    expect(rep.corr).toBe(f.id)
    expect(rep.payload.size).toBe(7)
  })

  it('replies workspace/delete/ok from the scratch workspace file seam', async () => {
    const del = vi.fn(async () => ({ agentId: 'a1', path: 'notes.md' }))
    const { t, workspaceRead } = await readyClient({ workspaceRead: { delete: del } as any })
    const payload = {
      agentId: 'a1',
      path: 'notes.md',
      ifMatchMtime: '2026-06-26T00:00:00.000Z'
    }
    const f = JSON.parse(frame('workspace/delete', payload, { epoch: 5 }))
    t.pushInbound(JSON.stringify(f))
    await tick()
    expect(workspaceRead.delete).toHaveBeenCalledWith(payload)
    const rep = JSON.parse(t.sent[0]!)
    expect(rep.type).toBe('workspace/delete/ok')
    expect(rep.corr).toBe(f.id)
  })

  it('replies workspace/gitstatus/result from the workspaceGit seam', async () => {
    const status = vi.fn(async () => ({
      agentId: 'a1',
      isRepo: true,
      clean: false,
      branch: 'main',
      ahead: 0,
      behind: 2,
      files: [{ path: 'src/x.ts', index: ' ', workingDir: 'M' }]
    }))
    const { t, workspaceGit } = await readyClient({ workspaceGit: { status } as any })
    const f = JSON.parse(frame('workspace/gitstatus', { agentId: 'a1' }, { epoch: 5 }))
    t.pushInbound(JSON.stringify(f))
    await tick()
    expect(workspaceGit.status).toHaveBeenCalledWith('a1')
    const rep = JSON.parse(t.sent[0]!)
    expect(rep.type).toBe('workspace/gitstatus/result')
    expect(rep.corr).toBe(f.id)
    expect(rep.payload.clean).toBe(false)
    expect(rep.payload.behind).toBe(2)
  })

  it('replies workspace/gitpull/result (a failed pull is data, not an error)', async () => {
    const pull = vi.fn(async () => ({ agentId: 'a1', isRepo: true, ok: false, detail: 'pull timed out' }))
    const { t, workspaceGit } = await readyClient({ workspaceGit: { pull } as any })
    const f = JSON.parse(frame('workspace/gitpull', { agentId: 'a1' }, { epoch: 5 }))
    t.pushInbound(JSON.stringify(f))
    await tick()
    expect(workspaceGit.pull).toHaveBeenCalledWith('a1')
    const rep = JSON.parse(t.sent[0]!)
    expect(rep.type).toBe('workspace/gitpull/result')
    expect(rep.corr).toBe(f.id)
    expect(rep.payload.ok).toBe(false)
    expect(rep.payload.detail).toBe('pull timed out')
  })

  it('maps an unknown-agent workspace git violation to BAD_PAYLOAD', async () => {
    const { t } = await readyClient({
      workspaceGit: {
        status: async () => {
          throw new WorkspaceViolationError('unknown agent "nope"')
        }
      } as any
    })
    const f = JSON.parse(frame('workspace/gitstatus', { agentId: 'nope' }, { epoch: 5 }))
    t.pushInbound(JSON.stringify(f))
    await tick()
    const err = JSON.parse(t.sent[0]!)
    expect(err.type).toBe('error')
    expect(err.corr).toBe(f.id)
    expect(err.payload.code).toBe('BAD_PAYLOAD')
  })

  it('drains: enters DRAINING, emits drain/progress, replies drain/done, returns to READY', async () => {
    const { t, client } = await readyClient()
    const f = JSON.parse(
      frame('daemon/drain', { scope: { kind: 'daemon' }, deadline: '2026-06-26T00:00:25.000Z' }, { epoch: 5 })
    )
    t.pushInbound(JSON.stringify(f))
    await tick()
    const progress = JSON.parse(t.sent[0]!)
    expect(progress.type).toBe('drain/progress')
    expect(progress.corr).toBeUndefined() // EVT, not correlated
    const done = JSON.parse(t.sent[1]!)
    expect(done.type).toBe('drain/done')
    expect(done.corr).toBe(f.id)
    expect(client.state).toBe('READY')
  })

  it('acks daemon/restart with daemon/control/ack', async () => {
    const { t, configApply } = await readyClient()
    const f = JSON.parse(frame('daemon/restart', { reason: 'redeploy', drainFirst: true }, { epoch: 5 }))
    t.pushInbound(JSON.stringify(f))
    expect(configApply.applyDaemonRestart).toHaveBeenCalled()
    const ack = JSON.parse(t.sent[0]!)
    expect(ack.type).toBe('daemon/control/ack')
    expect(ack.payload.accepted).toBe(true)
    expect(ack.corr).toBe(f.id)
  })

  it('answers session/list with a session/list/page reply correlated to the req', async () => {
    const { t } = await readyClient()
    const f = JSON.parse(frame('session/list', {}, { epoch: 5 }))
    t.pushInbound(JSON.stringify(f))
    const rep = JSON.parse(t.sent[0]!)
    expect(rep.type).toBe('session/list/page')
    expect(rep.corr).toBe(f.id)
  })

  it('answers session/history with a session/history/page reply correlated to the req', async () => {
    const { t } = await readyClient()
    const f = JSON.parse(
      frame('session/history', { agentId: CRON_AGENT_ID, sessionId: DAEMON_ID, limit: 50 }, { epoch: 5 })
    )
    t.pushInbound(JSON.stringify(f))
    const rep = JSON.parse(t.sent[0]!)
    expect(rep.type).toBe('session/history/page')
    expect(rep.corr).toBe(f.id)
  })
})
