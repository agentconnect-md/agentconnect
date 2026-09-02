/**
 * Fencing gate (design §4.8, protocol §4.2).
 *
 * Drives the connection FSM's fencing gate over the `InMemoryDaemonStub` +
 * `FakeClock` (no real socket). An inbound control frame carrying a `ControlExt`
 * block is validated in the order **epoch → launchId**; each rejection is a
 * correlated `error` REP:
 *
 *   - `epoch < current` → `STALE_EPOCH`
 *   - a superseded `launchId` → `STALE_LAUNCH`
 *
 * The pure predicates live in `orchestrator/fencing.ts`
 * (`checkEpoch`/`checkLaunch`); `ws/connection.ts` calls them in order against
 * the connection's fencing baseline (`sessionEpoch` and the agent's current
 * `launchId`).
 */
import { describe, it, expect } from 'vitest'
import { isFrame } from '@agentconnect.md/protocol'
import { FakeClock } from '../fakes/fake-clock.js'
import { InMemoryDaemonStub } from '../fakes/daemon-stub.js'
import { DaemonConnection } from '../../src/ws/connection.js'
import { FrameRouter } from '../../src/ws/handlers/index.js'
import { ConnectionRegistry } from '../../src/ws/registry.js'
import type { DaemonWsDeps } from '../../src/ws/deps.js'
import { AgentMutationGate } from '../../src/orchestrator/agentMutationGate.js'

const DAEMON = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const AGENT = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1'
const LAUNCH = '11111111-1111-4111-8111-111111111111'
const OLD_LAUNCH = '99999999-9999-4999-8999-999999999999'
const FOREIGN_AGENT = 'a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2'

/** Minimal deps — fencing is pure FSM logic, no DB/auth/registry needed. */
function fencingDeps(clock: FakeClock): DaemonWsDeps {
  const connReg = new ConnectionRegistry()
  return {
    log: { error: () => undefined },
    auth: {} as DaemonWsDeps['auth'],
    memberSets: {} as DaemonWsDeps['memberSets'],
    lifecycleOps: {} as DaemonWsDeps['lifecycleOps'],
    registry: {} as DaemonWsDeps['registry'],
    orchestrator: {} as DaemonWsDeps['orchestrator'],
    placementResolver: {
      mayAct: async () => true,
      servingDaemon: async () => null,
      servingDaemons: async () => [],
      dispatchDaemon: async () => null,
      resolveDirectory: async (rows: unknown[]) => rows
    } as unknown as DaemonWsDeps['placementResolver'],
    connReg,
    agent: {} as DaemonWsDeps['agent'],
    session: {} as DaemonWsDeps['session'],
    events: {} as DaemonWsDeps['events'],
    usageWriter: {} as DaemonWsDeps['usageWriter'],
    integration: {} as DaemonWsDeps['integration'],
    integrationChannel: {} as DaemonWsDeps['integrationChannel'],
    agentMutations: new AgentMutationGate(),
    recoverStagedAgent: async () => {},
    collabRoutes: {} as DaemonWsDeps['collabRoutes'],
    dutyLease: {} as DaemonWsDeps['dutyLease'],
    cron: {} as DaemonWsDeps['cron'],
    hook: {} as DaemonWsDeps['hook'],
    relayRoster: async () => [],
    clock,
    config: { HEARTBEAT_SEC: 15, ACK_TIMEOUT_MS: 5000 }
  }
}

/**
 * Stand up a READY connection at `sessionEpoch`, with one launched agent whose
 * current launch is `LAUNCH`.
 */
function readyConn(opts: { sessionEpoch: number }) {
  const clock = new FakeClock()
  const deps = fencingDeps(clock)
  const stub = new InMemoryDaemonStub()
  const conn = new DaemonConnection(stub, deps, new FrameRouter())
  conn.start()
  conn.daemonId = DAEMON
  conn.orgId = 'org-a'
  conn.sessionEpoch = opts.sessionEpoch
  conn.state = 'READY'
  deps.connReg.add({
    daemonId: DAEMON,
    orgId: conn.orgId,
    conn,
    sessionEpoch: opts.sessionEpoch,
    state: 'READY',
    maxAgents: 1,
    load: { cpu: 0, mem: 0, agents: 1 },
    health: 'ok',
    lastBeatAt: clock.now(),
    reachable: true,
    assignments: new Set(),
    launches: new Map(),
    orgByAgent: new Map([[AGENT, 'org-a']])
  })
  // Establish the per-agent fencing baseline the CP holds (current launch).
  conn.fencing.setLaunch(AGENT, LAUNCH)
  return { conn, stub, clock }
}

/** An agent-scoped control frame (carries ControlExt epoch/agentId/launchId). */
function agentActivity() {
  return {
    agentId: AGENT,
    sessionId: 'session-1',
    launchId: LAUNCH,
    state: 'thinking' as const,
    ts: new Date().toISOString()
  }
}

describe('fencing gate — epoch → launchId, typed error REPs', () => {
  it('epoch < current → STALE_EPOCH', () => {
    const { stub } = readyConn({ sessionEpoch: 5 })
    const id = stub.inject('agent/activity', agentActivity(), {
      ext: { epoch: 4, agentId: AGENT, launchId: LAUNCH } // epoch 4 < 5
    })

    const err = stub.lastSent('error')
    if (!err || !isFrame('error')(err)) throw new Error('expected error frame')
    expect(err.corr).toBe(id)
    expect(err.payload.code).toBe('STALE_EPOCH')
  })

  it('a superseded launchId → STALE_LAUNCH', () => {
    const { stub } = readyConn({ sessionEpoch: 5 })
    const id = stub.inject(
      'agent/activity',
      { ...agentActivity(), launchId: OLD_LAUNCH },
      { ext: { epoch: 5, agentId: AGENT, launchId: OLD_LAUNCH } } // dead launch
    )

    const err = stub.lastSent('error')
    if (!err || !isFrame('error')(err)) throw new Error('expected error frame')
    expect(err.corr).toBe(id)
    expect(err.payload.code).toBe('STALE_LAUNCH')
  })

  it('validation order is epoch → launchId (both wrong → STALE_EPOCH wins)', () => {
    const { stub } = readyConn({ sessionEpoch: 5 })
    // epoch stale AND launch stale — the epoch check must win.
    stub.inject(
      'agent/activity',
      { ...agentActivity(), launchId: OLD_LAUNCH },
      { ext: { epoch: 4, agentId: AGENT, launchId: OLD_LAUNCH } }
    )
    const err1 = stub.lastSent('error')
    if (!err1 || !isFrame('error')(err1)) throw new Error('expected error frame')
    expect(err1.payload.code).toBe('STALE_EPOCH')
  })

  it('a well-fenced frame passes (no error)', () => {
    const { stub } = readyConn({ sessionEpoch: 5 })
    stub.inject('agent/activity', agentActivity(), {
      ext: { epoch: 5, agentId: AGENT, launchId: LAUNCH }
    })
    // No error REP for a valid frame.
    expect(stub.lastSent('error')).toBeUndefined()
  })

  it('a frame with no ControlExt (epoch absent) is not fenced', () => {
    const { stub } = readyConn({ sessionEpoch: 5 })
    // agent/activity carries no ControlExt here — the fencing gate must skip it
    // entirely (no epoch ⇒ not a fenced frame).
    stub.inject('agent/activity', agentActivity())
    expect(stub.lastSent('error')).toBeUndefined()
  })
})

describe('organization gate', () => {
  it('stamps an explicit organization on pool-member downlink frames', () => {
    const { conn, stub } = readyConn({ sessionEpoch: 5 })
    conn.orgId = null
    conn.send('mcpserver/remove', { orgId: 'org-a', name: 'shared-name' }, { epoch: 5 })
    expect(stub.lastSent('mcpserver/remove')?.orgId).toBe('org-a')
  })

  it('derives downlink organization from sourceAgentId', () => {
    const { conn, stub } = readyConn({ sessionEpoch: 5 })
    conn.orgId = null
    conn.send(
      'knowledge/suggestion/review',
      { sourceAgentId: AGENT, dreamId: 'dream-1', candidateId: LAUNCH, state: 'accepted' },
      { epoch: 5 }
    )
    expect(stub.lastSent('knowledge/suggestion/review')?.orgId).toBe('org-a')
  })

  it('requires orgId on tenant-scoped frames from an install-wide daemon', () => {
    const { conn, stub } = readyConn({ sessionEpoch: 5 })
    conn.orgId = null
    const id = stub.inject('agent/activity', agentActivity(), {
      ext: { epoch: 5, agentId: AGENT, launchId: LAUNCH }
    })
    const err = stub.lastSent('error')
    if (!err || !isFrame('error')(err)) throw new Error('expected error frame')
    expect(err.corr).toBe(id)
    expect(err.payload.code).toBe('SCOPE_DENIED')
  })

  it('accepts a tenant-scoped frame carrying orgId from an install-wide daemon', () => {
    const { conn, stub } = readyConn({ sessionEpoch: 5 })
    conn.orgId = null
    stub.inject('agent/activity', agentActivity(), {
      orgId: 'org-a',
      ext: { epoch: 5, agentId: AGENT, launchId: LAUNCH }
    })
    expect(stub.lastSent('error')).toBeUndefined()
  })

  it('rejects an orgId that conflicts with the targeted agent on an install-wide daemon', () => {
    const { conn, stub } = readyConn({ sessionEpoch: 5 })
    conn.orgId = null
    stub.inject('agent/activity', agentActivity(), {
      orgId: 'org-b',
      ext: { epoch: 5, agentId: AGENT, launchId: LAUNCH }
    })
    const err = stub.lastSent('error')
    if (!err || !isFrame('error')(err)) throw new Error('expected error frame')
    expect(err.payload.code).toBe('SCOPE_DENIED')
  })

  it('rejects a conflicting orgId on an organization-scoped connection', () => {
    const { stub } = readyConn({ sessionEpoch: 5 })
    stub.inject('agent/activity', agentActivity(), {
      orgId: 'org-b',
      ext: { epoch: 5, agentId: AGENT, launchId: LAUNCH }
    })
    const err = stub.lastSent('error')
    if (!err || !isFrame('error')(err)) throw new Error('expected error frame')
    expect(err.payload.code).toBe('SCOPE_DENIED')
  })

  // #968: the replay a pool member sends after READY. Unscoped it never reaches the handler.
  it('rejects an unscoped organization-suggestion sync from an install-wide daemon', () => {
    const { conn, stub } = readyConn({ sessionEpoch: 5 })
    conn.orgId = null
    const id = stub.inject('knowledge/suggestions/sync', { suggestions: [] })
    const err = stub.lastSent('error')
    if (!err || !isFrame('error')(err)) throw new Error('expected error frame')
    expect(err.corr).toBe(id)
    expect(err.payload.code).toBe('SCOPE_DENIED')
  })

  it('accepts an org-scoped organization-suggestion sync from an install-wide daemon', () => {
    const { conn, stub } = readyConn({ sessionEpoch: 5 })
    conn.orgId = null
    stub.inject('knowledge/suggestions/sync', { suggestions: [] }, { orgId: 'org-a' })
    expect(stub.lastSent('error')).toBeUndefined()
  })

  // A duty holder never registered the agent, so the id→org map cannot answer for it.
  it('stamps the caller-supplied organization on a suggestion review the map cannot resolve', () => {
    const { conn, stub } = readyConn({ sessionEpoch: 5 })
    conn.orgId = null
    const review = { sourceAgentId: FOREIGN_AGENT, dreamId: 'dream-1', candidateId: LAUNCH, state: 'accepted' }
    expect(() => conn.send('knowledge/suggestion/review', review, { epoch: 5 })).toThrow(/organization is required/)
    conn.send('knowledge/suggestion/review', review, { epoch: 5 }, 'org-b')
    expect(stub.lastSent('knowledge/suggestion/review')?.orgId).toBe('org-b')
  })

  // M4: on an install-wide connection an install-wide frame names no org; one that does is refused.
  it('rejects an install-wide frame carrying an org from an install-wide daemon', () => {
    const { conn, stub } = readyConn({ sessionEpoch: 5 })
    conn.orgId = null
    const id = stub.inject(
      'heartbeat',
      { load: { cpu: 0, mem: 0, agents: 0 }, health: 'ok', activeSessions: 0 },
      {
        orgId: 'org-a'
      }
    )
    const err = stub.lastSent('error')
    if (!err || !isFrame('error')(err)) throw new Error('expected error frame')
    expect(err.corr).toBe(id)
    expect(err.payload.code).toBe('SCOPE_DENIED')
  })

  it('still takes an install-wide frame carrying the connection org from an org-scoped daemon', () => {
    const { stub } = readyConn({ sessionEpoch: 5 })
    stub.inject(
      'heartbeat',
      { load: { cpu: 0, mem: 0, agents: 0 }, health: 'ok', activeSessions: 0 },
      { orgId: 'org-a' }
    )
    expect(stub.lastSent('error')).toBeUndefined()
  })

  it('never stamps an org on an install-wide downlink frame to a pool member, even when a caller passes one', () => {
    const { conn, stub } = readyConn({ sessionEpoch: 5 })
    conn.orgId = null
    conn.send('daemon/drain', { scope: { kind: 'daemon' }, deadline: new Date().toISOString() }, { epoch: 5 }, 'org-a')
    expect(stub.lastSent('daemon/drain')?.orgId).toBeUndefined()
  })

  // A generic reply that correlates to nothing is dropped, never answered — else two peers would trade errors forever.
  it('drops an uncorrelated error from an install-wide daemon without answering it', () => {
    const { conn, stub } = readyConn({ sessionEpoch: 5 })
    conn.orgId = null
    stub.inject('error', { code: 'INTERNAL', message: 'late', retryable: false }, { corr: LAUNCH })
    expect(stub.sent.filter((f) => f.type === 'error')).toEqual([])
  })
})

describe('reply organization gate', () => {
  it('frame mode: a typed reply carrying the request org settles it', async () => {
    const { conn, stub } = readyConn({ sessionEpoch: 5 })
    conn.orgId = null
    const pending = conn.request('session/list', { agentId: AGENT }, { epoch: 5 })
    const req = stub.lastSent('session/list')!
    expect(req.orgId).toBe('org-a')
    stub.inject('session/list/page', { sessions: [] }, { corr: req.id, orgId: 'org-a' })
    await expect(pending).resolves.toEqual({ sessions: [] })
  })

  it('frame mode: a reply naming another org fails the request with SCOPE_DENIED and applies nothing', async () => {
    const { conn, stub } = readyConn({ sessionEpoch: 5 })
    conn.orgId = null
    const pending = conn.request('session/list', { agentId: AGENT }, { epoch: 5 })
    const req = stub.lastSent('session/list')!
    stub.inject('session/list/page', { sessions: [] }, { corr: req.id, orgId: 'org-b' })
    await expect(pending).rejects.toMatchObject({ code: 'SCOPE_DENIED' })
    expect(conn.correlator.inflight()).toBe(0)
  })

  it('frame mode: a reply that omits the request org is refused too', async () => {
    const { conn, stub } = readyConn({ sessionEpoch: 5 })
    conn.orgId = null
    const pending = conn.request('session/list', { agentId: AGENT }, { epoch: 5 })
    const req = stub.lastSent('session/list')!
    stub.inject('session/list/page', { sessions: [] }, { corr: req.id })
    await expect(pending).rejects.toMatchObject({ code: 'SCOPE_DENIED' })
  })

  it('frame mode: an error reply needs no org and still rejects the request with its own code', async () => {
    const { conn, stub } = readyConn({ sessionEpoch: 5 })
    conn.orgId = null
    const pending = conn.request('session/list', { agentId: AGENT }, { epoch: 5 })
    const req = stub.lastSent('session/list')!
    stub.inject('error', { code: 'NO_SESSION', message: 'gone', retryable: false }, { corr: req.id })
    await expect(pending).rejects.toMatchObject({ code: 'NO_SESSION' })
  })

  it('frame mode: an install-wide reply carrying an org is refused', async () => {
    const { conn, stub } = readyConn({ sessionEpoch: 5 })
    conn.orgId = null
    const pending = conn.request(
      'daemon/drain',
      { scope: { kind: 'daemon' }, deadline: new Date().toISOString() },
      { epoch: 5 }
    )
    const req = stub.lastSent('daemon/drain')!
    stub.inject('drain/done', { released: [] }, { corr: req.id, orgId: 'org-a' })
    await expect(pending).rejects.toMatchObject({ code: 'SCOPE_DENIED' })
  })

  it('connection mode: a reply without an org still settles (an older daemon does not echo it)', async () => {
    const { conn, stub } = readyConn({ sessionEpoch: 5 })
    const pending = conn.request('session/list', { agentId: AGENT }, { epoch: 5 })
    const req = stub.lastSent('session/list')!
    expect(req.orgId).toBe('org-a')
    stub.inject('session/list/page', { sessions: [] }, { corr: req.id })
    await expect(pending).resolves.toEqual({ sessions: [] })
  })

  it('connection mode: a reply naming another org is refused', async () => {
    const { conn, stub } = readyConn({ sessionEpoch: 5 })
    const pending = conn.request('session/list', { agentId: AGENT }, { epoch: 5 })
    const req = stub.lastSent('session/list')!
    stub.inject('session/list/page', { sessions: [] }, { corr: req.id, orgId: 'org-b' })
    await expect(pending).rejects.toMatchObject({ code: 'SCOPE_DENIED' })
  })
})
