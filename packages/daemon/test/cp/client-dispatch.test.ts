import { describe, it, expect, vi } from 'vitest'
import { buildEnvelope, decodeEnvelope, MAX_FRAME_BYTES, SESSION_LIVE_TAIL_FEATURE } from '@agentconnect.md/protocol'
import { CpClient, type CpClientDeps } from '../../src/cp/client.js'
import { WorkspaceConflictError, WorkspaceViolationError } from '../../src/cp/workspace-reader.js'
import { MemorySandboxUnavailableError } from '../../src/cp/memory-reader.js'
import { TaskViolationError } from '../../src/cp/task-reader.js'
import { AgentWakeViolationError } from '../../src/cp/agent-wake.js'
import { createRuntimeCommandsReader } from '../../src/cp/runtime-commands-reader.js'
import { RuntimeCommandsCache } from '../../src/runtimes/runtime-commands.js'
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

async function readyClient(
  over: Partial<CpClientDeps> = {},
  serverFeatures: string[] = ['hook-report-ack-v1'],
  organizationMode: 'connection' | 'frame' = 'connection'
) {
  const t = new FakeTransport()
  const clock = new FakeClock()
  // Merge configApply/sessionRead/workspaceRead overrides into the default mocks — do NOT let ...over clobber them.
  const {
    configApply: configApplyOver,
    sessionRead: _sessionReadOver,
    workspaceRead: _workspaceReadOver,
    workspaceGit: _workspaceGitOver,
    taskReader: _taskReaderOver,
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
    toolBody: vi.fn(() => ({ sessionId: DAEMON_ID, toolCallId: 'tool', data: '', totalBytes: 0 })),
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
    diff: vi.fn(async () => ({ agentId: 'a', path: 'f', isRepo: false, exists: false })),
    log: vi.fn(async () => ({ agentId: 'a', isRepo: false, commits: [], truncated: false })),
    pull: vi.fn(async () => ({ agentId: 'a', isRepo: false, ok: false })),
    ...((over.workspaceGit as any) ?? {})
  }
  const taskReader = {
    list: vi.fn(async () => ({ agentId: 'a', sessionId: 'acp-1', tracked: false, tasks: [], truncated: false })),
    ...((over.taskReader as any) ?? {})
  }
  const deps = {
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
    taskReader,
    clock,
    connect: async () => t,
    log: silent,
    jitter: () => 0,
    ...overRest
  }
  const client = new CpClient(deps as unknown as CpClientDeps)
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
          serverTime: '2026-06-26T00:00:00.000Z',
          organizationMode
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
  return { t, clock, client, configApply, workspaceRead, workspaceGit, taskReader }
}

describe('CpClient dispatch', () => {
  it('tracks additive CP features negotiated through register/ok', async () => {
    const { client } = await readyClient({}, ['hook-report-ack-v1', 'gitcred-actions-v1'])
    expect(client.supportsServerFeature('gitcred-actions-v1')).toBe(true)
    expect(client.supportsServerFeature('future-feature')).toBe(false)
  })

  it('emits body-free session activity only when the CP negotiated live tails', async () => {
    const activity = {
      sessionId: 'session-live',
      agentId: CRON_AGENT_ID,
      revision: '12',
      ts: '2026-07-27T00:00:00.000Z'
    }
    const current = await readyClient({}, [SESSION_LIVE_TAIL_FEATURE])
    current.client.emitSessionActivity(activity)
    expect(JSON.parse(current.t.sent[0]!)).toMatchObject({
      type: 'event/session-activity',
      payload: activity
    })

    const legacy = await readyClient({}, [])
    legacy.client.emitSessionActivity(activity)
    expect(legacy.t.sent).toHaveLength(0)
  })

  it('stamps agent-scoped outbound frames with orgId in frame organization mode', async () => {
    const { t, client } = await readyClient(
      { orgForAgent: (agentId) => (agentId === CRON_AGENT_ID ? 'org-1' : undefined) },
      [SESSION_LIVE_TAIL_FEATURE],
      'frame'
    )

    client.emitSessionActivity({
      sessionId: 'session-live',
      agentId: CRON_AGENT_ID,
      revision: '12',
      ts: '2026-07-27T00:00:00.000Z'
    })

    expect(JSON.parse(t.sent[0]!)).toMatchObject({ type: 'event/session-activity', orgId: 'org-1' })
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
        managedSkills: [],
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
    await tick()
    expect(configApply.applyAgentRemove).toHaveBeenCalledWith(DAEMON_ID)
    expect(t.sent).toHaveLength(0)
  })

  it('contains a synchronous agent/remove admission failure in the EVT rejection path', async () => {
    const error = vi.fn()
    const applyAgentRemove = vi.fn(() => {
      throw new Error('marker write failed')
    })
    const { t } = await readyClient({
      configApply: { applyAgentRemove } as any,
      log: { ...silent, error }
    })

    t.pushInbound(frame('agent/remove', { agentId: DAEMON_ID }, { epoch: 5, agentId: DAEMON_ID }))
    await tick()

    expect(applyAgentRemove).toHaveBeenCalledWith(DAEMON_ID)
    expect(error).toHaveBeenCalledWith('cp: agent/remove failed closed: marker write failed')
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
      spec: { name: 'helper', mcpServers: [], skills: [], managedSkills: [], allowedCallerAgentIds: [] }
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
    expect(workspaceGit.status).toHaveBeenCalledWith('a1', undefined, undefined)
    const rep = JSON.parse(t.sent[0]!)
    expect(rep.type).toBe('workspace/gitstatus/result')
    expect(rep.corr).toBe(f.id)
    expect(rep.payload.clean).toBe(false)
    expect(rep.payload.behind).toBe(2)
  })

  it('forwards the repo scope of a gitstatus / gitpull to the seam', async () => {
    const status = vi.fn(async () => ({ agentId: 'a1', isRepo: true, clean: true }))
    const scoped = await readyClient({ workspaceGit: { status } as any })
    scoped.t.pushInbound(frame('workspace/gitstatus', { agentId: 'a1', repo: 'acme/infra' }, { epoch: 5 }))
    await tick()
    expect(scoped.workspaceGit.status).toHaveBeenCalledWith('a1', undefined, 'acme/infra')

    const pull = vi.fn(async () => ({ agentId: 'a1', isRepo: true, ok: true }))
    const pulled = await readyClient({ workspaceGit: { pull } as any })
    pulled.t.pushInbound(frame('workspace/gitpull', { agentId: 'a1', repo: 'acme/infra' }, { epoch: 5 }))
    await tick()
    expect(pulled.workspaceGit.pull).toHaveBeenCalledWith('a1', 'acme/infra')
  })

  it('replies workspace/gitpull/result (a failed pull is data, not an error)', async () => {
    const pull = vi.fn(async () => ({ agentId: 'a1', isRepo: true, ok: false, detail: 'pull timed out' }))
    const { t, workspaceGit } = await readyClient({ workspaceGit: { pull } as any })
    const f = JSON.parse(frame('workspace/gitpull', { agentId: 'a1' }, { epoch: 5 }))
    t.pushInbound(JSON.stringify(f))
    await tick()
    expect(workspaceGit.pull).toHaveBeenCalledWith('a1', undefined)
    const rep = JSON.parse(t.sent[0]!)
    expect(rep.type).toBe('workspace/gitpull/result')
    expect(rep.corr).toBe(f.id)
    expect(rep.payload.ok).toBe(false)
    expect(rep.payload.detail).toBe('pull timed out')
  })

  it('replies workspace/gitdiff/result and forwards the whole scoped request', async () => {
    const diff = vi.fn(async () => ({
      agentId: 'a1',
      path: 'src/x.ts',
      isRepo: true,
      exists: true,
      diff: '@@ -1 +1 @@\n-a\n+b\n',
      truncated: true
    }))
    const { t, workspaceGit } = await readyClient({ workspaceGit: { diff } as any })
    const payload = { agentId: 'a1', sessionId: 'acp-1', path: 'src/x.ts', staged: true }
    const f = JSON.parse(frame('workspace/gitdiff', payload, { epoch: 5 }))
    t.pushInbound(JSON.stringify(f))
    await tick()
    expect(workspaceGit.diff).toHaveBeenCalledWith(payload)
    const rep = JSON.parse(t.sent[0]!)
    expect(rep.type).toBe('workspace/gitdiff/result')
    expect(rep.corr).toBe(f.id)
    expect(rep.payload.diff).toContain('@@ -1 +1 @@')
    expect(rep.payload.truncated).toBe(true)
  })

  it('replies workspace/gitdiff/result for a binary path (data, not an error)', async () => {
    const diff = vi.fn(async () => ({ agentId: 'a1', path: 'logo.png', isRepo: true, exists: true, binary: true }))
    const { t } = await readyClient({ workspaceGit: { diff } as any })
    const f = JSON.parse(frame('workspace/gitdiff', { agentId: 'a1', path: 'logo.png', staged: false }, { epoch: 5 }))
    t.pushInbound(JSON.stringify(f))
    await tick()
    const rep = JSON.parse(t.sent[0]!)
    expect(rep.type).toBe('workspace/gitdiff/result')
    expect(rep.payload.binary).toBe(true)
    expect(rep.payload.diff).toBeUndefined()
  })

  it('replies workspace/gitlog/result from the workspaceGit seam', async () => {
    const log = vi.fn(async () => ({
      agentId: 'a1',
      isRepo: true,
      tracking: 'origin/main',
      truncated: false,
      commits: [
        {
          sha: 'a'.repeat(40),
          shortSha: 'aaaaaaa',
          subject: 'Add the dock',
          author: 'Ada Lovelace',
          committedAt: '2026-07-02T07:00:00+00:00',
          pushed: false
        }
      ]
    }))
    const { t, workspaceGit } = await readyClient({ workspaceGit: { log } as any })
    const payload = { agentId: 'a1', sessionId: 'acp-1', limit: 20 }
    const f = JSON.parse(frame('workspace/gitlog', payload, { epoch: 5 }))
    t.pushInbound(JSON.stringify(f))
    await tick()
    expect(workspaceGit.log).toHaveBeenCalledWith(payload)
    const rep = JSON.parse(t.sent[0]!)
    expect(rep.type).toBe('workspace/gitlog/result')
    expect(rep.corr).toBe(f.id)
    expect(rep.payload.commits[0].pushed).toBe(false)
    expect(rep.payload.tracking).toBe('origin/main')
  })

  it('replies workspace/gitstage/result and workspace/gitunstage/result with the FRESH status', async () => {
    const staged = {
      agentId: 'a1',
      isRepo: true,
      clean: false,
      branch: 'main',
      files: [{ path: 'src/x.ts', index: 'M', workingDir: ' ' }]
    }
    const stage = vi.fn(async () => staged)
    const unstage = vi.fn(async () => ({ ...staged, files: [{ path: 'src/x.ts', index: ' ', workingDir: 'M' }] }))
    const { t, workspaceGit } = await readyClient({ workspaceGit: { stage, unstage } as any })

    const payload = { agentId: 'a1', sessionId: 'acp-1', paths: ['src/x.ts'] }
    t.pushInbound(frame('workspace/gitstage', payload, { epoch: 5 }))
    await tick()
    expect(workspaceGit.stage).toHaveBeenCalledWith(payload)
    const stageRep = JSON.parse(t.sent[0]!)
    expect(stageRep.type).toBe('workspace/gitstage/result')
    expect(stageRep.payload.files[0].index).toBe('M')

    t.sent.length = 0
    t.pushInbound(frame('workspace/gitunstage', payload, { epoch: 5 }))
    await tick()
    expect(workspaceGit.unstage).toHaveBeenCalledWith(payload)
    const unstageRep = JSON.parse(t.sent[0]!)
    expect(unstageRep.type).toBe('workspace/gitunstage/result')
    expect(unstageRep.payload.files[0].workingDir).toBe('M')
  })

  it('replies workspace/gitcommit/result (a refusal is data, not an error frame)', async () => {
    const commit = vi.fn(async () => ({
      agentId: 'a1',
      isRepo: true,
      ok: false,
      reason: 'no-identity' as const,
      detail: 'no registered identity'
    }))
    const { t, workspaceGit } = await readyClient({ workspaceGit: { commit } as any })
    const payload = { agentId: 'a1', sessionId: 'acp-1', message: 'feat: x' }
    t.pushInbound(frame('workspace/gitcommit', payload, { epoch: 5 }))
    await tick()
    expect(workspaceGit.commit).toHaveBeenCalledWith(payload)
    const rep = JSON.parse(t.sent[0]!)
    expect(rep.type).toBe('workspace/gitcommit/result')
    expect(rep.payload.ok).toBe(false)
    expect(rep.payload.reason).toBe('no-identity')
  })

  it('replies workspace/gitpush/result (a diverged branch is data, not an error frame)', async () => {
    const push = vi.fn(async () => ({
      agentId: 'a1',
      isRepo: true,
      ok: false,
      ahead: 2,
      reason: 'diverged' as const,
      detail: 'pull first'
    }))
    const { t, workspaceGit } = await readyClient({ workspaceGit: { push } as any })
    const payload = { agentId: 'a1', sessionId: 'acp-1' }
    t.pushInbound(frame('workspace/gitpush', payload, { epoch: 5 }))
    await tick()
    expect(workspaceGit.push).toHaveBeenCalledWith(payload)
    const rep = JSON.parse(t.sent[0]!)
    expect(rep.type).toBe('workspace/gitpush/result')
    expect(rep.payload.reason).toBe('diverged')
    expect(rep.payload.ahead).toBe(2)
  })

  it('replies workspace/gitmessage/result, and a runtime that declines is data', async () => {
    const message = vi.fn(async () => ({ agentId: 'a1', ok: true, message: 'feat(dock): draft it' }))
    const { t, workspaceGit } = await readyClient({ workspaceGit: { message } as any })
    const payload = { agentId: 'a1', sessionId: 'acp-1' }
    t.pushInbound(frame('workspace/gitmessage', payload, { epoch: 5 }))
    await tick()
    expect(workspaceGit.message).toHaveBeenCalledWith(payload)
    const rep = JSON.parse(t.sent[0]!)
    expect(rep.type).toBe('workspace/gitmessage/result')
    expect(rep.payload.message).toBe('feat(dock): draft it')
  })

  it('joins a RETRANSMITTED gitmessage REQ into the pass it already started', async () => {
    // The correlator re-sends identical bytes when a REP is slow, and a model pass is always slower
    // than one ack window — running it again would bill the press twice.
    let release!: (value: { agentId: string; ok: boolean; message: string }) => void
    const message = vi.fn(
      () => new Promise<{ agentId: string; ok: boolean; message: string }>((resolve) => (release = resolve))
    )
    const { t } = await readyClient({ workspaceGit: { message } as any })
    const req = frame('workspace/gitmessage', { agentId: 'a1' }, { epoch: 5 })
    t.pushInbound(req)
    t.pushInbound(req) // the retransmit: same id, same bytes
    await tick()
    expect(message).toHaveBeenCalledTimes(1)

    release({ agentId: 'a1', ok: true, message: 'feat: once' })
    await tick()
    // Both arrivals are answered, and the second one does NOT start a pass of its own.
    const reps = t.sent.map((raw) => JSON.parse(raw)).filter((f) => f.type === 'workspace/gitmessage/result')
    expect(reps).toHaveLength(2)
    expect(new Set(reps.map((f) => f.corr)).size).toBe(1)
    expect(message).toHaveBeenCalledTimes(1)

    // The entry is released once it settles, so a later press with a fresh id runs a fresh pass.
    t.pushInbound(frame('workspace/gitmessage', { agentId: 'a1' }, { epoch: 5 }))
    await tick()
    expect(message).toHaveBeenCalledTimes(2)
  })

  it('maps a busy-agent CONFLICT on a git write to CONFLICT with its reason', async () => {
    // The coordinator's refusal — the console renders "the agent is working", not a failure.
    const { t } = await readyClient({
      workspaceGit: {
        commit: async () => {
          throw new WorkspaceConflictError('the agent is working in this workspace; retry when it is idle')
        }
      } as any
    })
    const f = JSON.parse(frame('workspace/gitcommit', { agentId: 'a1', message: 'feat: x' }, { epoch: 5 }))
    t.pushInbound(JSON.stringify(f))
    await tick()
    const err = JSON.parse(t.sent[0]!)
    expect(err.type).toBe('error')
    expect(err.corr).toBe(f.id)
    expect(err.payload.code).toBe('CONFLICT')
    expect(err.payload.details).toEqual({ reason: 'stale' })
  })

  it('carries the violation REASON in the error frame details (400-able, not an opaque 503)', async () => {
    const { t } = await readyClient({
      workspaceRead: {
        read: async () => {
          throw new WorkspaceViolationError('path escapes the workspace root', 'path-escape')
        }
      } as any
    })
    const f = JSON.parse(frame('workspace/read', { agentId: 'a1', path: '../x', offset: 0, limit: 10 }, { epoch: 5 }))
    t.pushInbound(JSON.stringify(f))
    await tick()
    const err = JSON.parse(t.sent[0]!)
    expect(err.type).toBe('error')
    expect(err.payload.code).toBe('BAD_PAYLOAD')
    expect(err.payload.details).toEqual({ reason: 'path-escape' })
  })

  it('refuses a memory read of a sleeping sandbox with the same reason the workspace reader carries', async () => {
    // The memory tree of a cluster agent is on its sandbox volume: the CP maps this reason to the
    // transient 503 + code the console answers by waking the sandbox, not to a bad request.
    const { t } = await readyClient({
      memoryReader: {
        list: async () => {
          throw new MemorySandboxUnavailableError('agent "a1" has no running sandbox, so its memory cannot be reached')
        }
      } as any
    })
    const f = JSON.parse(frame('memory/list', { agentId: 'a1' }, { epoch: 5 }))
    t.pushInbound(JSON.stringify(f))
    await tick()
    const err = JSON.parse(t.sent[0]!)
    expect(err.type).toBe('error')
    expect(err.corr).toBe(f.id)
    expect(err.payload.code).toBe('BAD_PAYLOAD')
    expect(err.payload.details).toEqual({ reason: 'sandbox-unavailable' })
  })

  it('maps an unknown-agent workspace git violation to BAD_PAYLOAD', async () => {
    const { t } = await readyClient({
      workspaceGit: {
        status: async () => {
          throw new WorkspaceViolationError('unknown agent "nope"', 'unknown-agent')
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
    expect(err.payload.details).toEqual({ reason: 'unknown-agent' })
  })

  it('replies task/list/result from the taskReader seam', async () => {
    const list = vi.fn(async () => ({
      agentId: 'a1',
      sessionId: 'acp-1',
      tracked: true,
      truncated: false,
      tasks: [
        {
          id: 't1',
          description: 'Sleep 15',
          state: 'running' as const,
          subagent: false,
          startedAt: '2026-06-26T00:00:00.000Z'
        }
      ]
    }))
    const { t, taskReader } = await readyClient({ taskReader: { list } as any })
    const payload = { agentId: 'a1', sessionId: 'acp-1' }
    const f = JSON.parse(frame('task/list', payload, { epoch: 5 }))
    t.pushInbound(JSON.stringify(f))
    await tick()
    expect(taskReader.list).toHaveBeenCalledWith(payload)
    const rep = JSON.parse(t.sent[0]!)
    expect(rep.type).toBe('task/list/result')
    expect(rep.corr).toBe(f.id)
    expect(rep.payload.tasks[0].state).toBe('running')
    expect(rep.payload.tracked).toBe(true)
  })

  it('replies runtime/commands/list from what the runtime advertised over ACP', async () => {
    const commands = new RuntimeCommandsCache()
    commands.record(
      'a1',
      'acp-1',
      {
        sessionUpdate: 'available_commands_update',
        availableCommands: [{ name: 'code-review', description: 'Review the diff', input: { hint: '[pr]' } }]
      },
      Date.parse('2026-06-26T00:00:00.000Z')
    )
    const { t } = await readyClient({
      runtimeCommandsReader: createRuntimeCommandsReader(commands, (id) => id === 'a1')
    })
    const f = JSON.parse(frame('runtime/commands', { agentId: 'a1' }, { epoch: 5 }))
    t.pushInbound(JSON.stringify(f))
    await tick()
    const rep = JSON.parse(t.sent[0]!)
    expect(rep.type).toBe('runtime/commands/list')
    expect(rep.corr).toBe(f.id)
    expect(rep.payload).toEqual({
      reported: true,
      updatedAt: '2026-06-26T00:00:00.000Z',
      sessionId: 'acp-1',
      commands: [{ name: 'code-review', description: 'Review the diff', hint: '[pr]', skill: false }]
    })
  })

  it('replies runtime/commands/list with reported:false before any advertisement', async () => {
    const { t } = await readyClient({
      runtimeCommandsReader: createRuntimeCommandsReader(new RuntimeCommandsCache(), () => true)
    })
    t.pushInbound(frame('runtime/commands', { agentId: 'a1' }, { epoch: 5 }))
    await tick()
    const rep = JSON.parse(t.sent[0]!)
    expect(rep.type).toBe('runtime/commands/list')
    expect(rep.payload).toEqual({ reported: false, commands: [] })
  })

  it('maps an unknown-agent task violation to BAD_PAYLOAD with its reason', async () => {
    const { t } = await readyClient({
      taskReader: {
        list: async () => {
          throw new TaskViolationError('unknown agent "nope"', 'unknown-agent')
        }
      } as any
    })
    const f = JSON.parse(frame('task/list', { agentId: 'nope', sessionId: 'acp-1' }, { epoch: 5 }))
    t.pushInbound(JSON.stringify(f))
    await tick()
    const err = JSON.parse(t.sent[0]!)
    expect(err.type).toBe('error')
    expect(err.corr).toBe(f.id)
    expect(err.payload.code).toBe('BAD_PAYLOAD')
    expect(err.payload.details).toEqual({ reason: 'unknown-agent' })
  })

  it('replies agent/wake/ok from the waker seam, and unsupported when none is wired', async () => {
    const wake = vi.fn(async (req: { agentId: string }) => ({ agentId: req.agentId, state: 'starting' as const }))
    const { t } = await readyClient({ agentWake: { wake } })
    const f = JSON.parse(frame('agent/wake', { agentId: 'a1' }, { epoch: 5 }))
    t.pushInbound(JSON.stringify(f))
    await tick()
    expect(wake).toHaveBeenCalledWith({ agentId: 'a1' })
    const rep = JSON.parse(t.sent[0]!)
    expect(rep.type).toBe('agent/wake/ok')
    expect(rep.corr).toBe(f.id)
    expect(rep.payload).toEqual({ agentId: 'a1', state: 'starting' })

    const bare = await readyClient()
    const g = JSON.parse(frame('agent/wake', { agentId: 'a1' }, { epoch: 5 }))
    bare.t.pushInbound(JSON.stringify(g))
    await tick()
    expect(JSON.parse(bare.t.sent[0]!).payload).toEqual({ agentId: 'a1', state: 'unsupported' })
  })

  it('maps an unknown-agent wake violation to BAD_PAYLOAD with its reason', async () => {
    const { t } = await readyClient({
      agentWake: {
        wake: async () => {
          throw new AgentWakeViolationError('unknown agent "nope"', 'unknown-agent')
        }
      }
    })
    const f = JSON.parse(frame('agent/wake', { agentId: 'nope' }, { epoch: 5 }))
    t.pushInbound(JSON.stringify(f))
    await tick()
    const err = JSON.parse(t.sent[0]!)
    expect(err.type).toBe('error')
    expect(err.corr).toBe(f.id)
    expect(err.payload.code).toBe('BAD_PAYLOAD')
    expect(err.payload.details).toEqual({ reason: 'unknown-agent' })
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
    await tick()
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
    await tick()
    const rep = JSON.parse(t.sent[0]!)
    expect(rep.type).toBe('session/history/page')
    expect(rep.corr).toBe(f.id)
  })

  it('answers session/child-status/probe from the daemon-owned handler, correlated to the req', async () => {
    const { t } = await readyClient()
    const f = JSON.parse(
      frame('session/child-status/probe', { parentSessionId: 'acp-parent-1', childSessionId: 'k' }, { epoch: 5 })
    )
    t.pushInbound(JSON.stringify(f))
    await tick()
    const rep = JSON.parse(t.sent[0]!)
    expect(rep.type).toBe('session/child-status/probe/ok')
    expect(rep.corr).toBe(f.id)
  })
})
