/**
 * Phase 3 — drain / rebalance, no double-assign window (design §6 Phase 3;
 * protocol §5.3, §4.9). Drives `Placement.rebalanceFrom` + `ControlSender` +
 * `Watchdog` over two `DaemonConnection`s on `InMemoryDaemonStub`s + a `FakeClock`
 * against real Testcontainers Postgres (the routing table + the partial-unique
 * single-owner index are load-bearing here):
 *
 *  - a `daemon/drain` is issued to the losing daemon and acknowledged by
 *    `drain/done`;
 *  - the CP withholds any new `route/assign` for the released `sessionKey` UNTIL
 *    `drain/done` arrives — assert no `route/assign` to the new owner before
 *    then (no double-assign window);
 *  - after `drain/done`, the session is reassigned to the other daemon under a
 *    **new (bumped) routingEpoch**, and exactly one active owner exists in C6.
 */
import { describe, it, expect, vi } from 'vitest'
import { isFrame } from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import {
  PgDaemonRepo,
  PgAgentRepo,
  PgAssignmentRepo,
  PgLaunchRepo,
  PgCronRepo,
  PgSecretLeaseRepo,
  PgIntegrationRepo,
  PgBotSecretStore,
  PgAgentSecretStore,
  PgBotRepo,
  PgIntegrationChannelRepo
} from '../../src/persistence/index.js'
import { PlaintextSecretCipher } from '../../src/secrets/cipher.js'
import { AgentSpecAssembler } from '../../src/orchestrator/agentSpecAssembler.js'
import { ControlSender } from '../../src/orchestrator/outbound.js'
import { Placement } from '../../src/orchestrator/placement.js'
import { Watchdog } from '../../src/orchestrator/watchdog.js'
import { EpochService } from '../../src/orchestrator/epoch.js'
import { ConnectionRegistry, type DaemonConnState } from '../../src/ws/registry.js'
import { AgentMutationGate } from '../../src/orchestrator/agentMutationGate.js'
import { DaemonConnection } from '../../src/ws/connection.js'
import { FrameRouter } from '../../src/ws/handlers/index.js'
import type { DaemonWsDeps } from '../../src/ws/deps.js'
import { FakeClock } from '../fakes/fake-clock.js'
import { InMemoryDaemonStub } from '../fakes/daemon-stub.js'
import { DaemonId } from '../../src/domain/ids.js'
import { buildCpPlatformRegistry } from '../../src/platforms/registry.js'
import { createSlackCpProvider } from '../../src/platforms/slack/provider.js'

const DAEMON_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const DAEMON_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const AGENT = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1'
const WORKSPACE = 'f5f5f5f5-f5f5-4f5f-8f5f-f5f5f5f5f5f5'
const KEY = { platform: 'slack' as const, channel: 'C1', thread: 'T1' }

const ACK_TIMEOUT_MS = 5000
const REASSIGN_GRACE_SEC = 60
const HEARTBEAT_SEC = 15
const MISSED_BEATS = 3

interface Built {
  placement: Placement
  watchdog: Watchdog
  connReg: ConnectionRegistry
  clock: FakeClock
  stubA: InMemoryDaemonStub
  stubB: InMemoryDaemonStub
  assignmentRepo: PgAssignmentRepo
}

async function seed(): Promise<void> {
  await prisma.daemon.create({
    data: { id: DAEMON_A, orgId: DEFAULT_ORG_ID, sessionEpoch: 5n, routingEpoch: 2n, maxAgents: 4, status: 'ready' }
  })
  await prisma.daemon.create({
    data: { id: DAEMON_B, orgId: DEFAULT_ORG_ID, sessionEpoch: 3n, routingEpoch: 1n, maxAgents: 4, status: 'ready' }
  })
  await prisma.agent.create({
    data: {
      id: AGENT,
      orgId: DEFAULT_ORG_ID,
      name: 'agent-1',
      runtime: 'claude',
      daemonId: DAEMON_A
    }
  })
  await prisma.assignment.create({
    data: {
      platform: 'slack',
      channel: 'C1',
      thread: 'T1',
      agentId: AGENT,
      daemonId: DAEMON_A,
      workspaceId: WORKSPACE,
      assignedEpoch: 5n,
      routingEpoch: 2n,
      state: 'active'
    }
  })
}

function connState(
  daemonId: string,
  conn: DaemonConnection,
  sessionEpoch: number,
  clock: FakeClock,
  agents: number
): DaemonConnState {
  return {
    daemonId,
    conn,
    sessionEpoch,
    state: 'READY',
    maxAgents: 4,
    load: { cpu: 0, mem: 0, agents },
    health: 'ok',
    lastBeatAt: clock.now(),
    reachable: true,
    assignments: new Set(),
    launches: new Map()
  }
}

function build(): Built {
  const clock = new FakeClock(1_700_000_000_000)
  const connReg = new ConnectionRegistry()
  const deps: DaemonWsDeps = {
    auth: {} as DaemonWsDeps['auth'],
    lifecycleOps: {} as DaemonWsDeps['lifecycleOps'],
    registry: {} as DaemonWsDeps['registry'],
    orchestrator: {} as DaemonWsDeps['orchestrator'],
    connReg,
    agent: {} as DaemonWsDeps['agent'],
    session: {} as DaemonWsDeps['session'],
    events: {} as DaemonWsDeps['events'],
    sessionUsage: {} as DaemonWsDeps['sessionUsage'],
    integration: {} as DaemonWsDeps['integration'],
    integrationChannel: {} as DaemonWsDeps['integrationChannel'],
    agentMutations: new AgentMutationGate(),
    recoverStagedAgent: async () => {},
    collabRoutes: {} as DaemonWsDeps['collabRoutes'],
    cron: {} as DaemonWsDeps['cron'],
    hook: {} as DaemonWsDeps['hook'],
    relayRoster: async () => [],
    clock,
    config: { HEARTBEAT_SEC, ACK_TIMEOUT_MS }
  }

  const stubA = new InMemoryDaemonStub()
  const connA = new DaemonConnection(stubA, deps, new FrameRouter())
  connA.start()
  connA.daemonId = DAEMON_A
  connA.sessionEpoch = 5
  connA.state = 'READY'

  const stubB = new InMemoryDaemonStub()
  const connB = new DaemonConnection(stubB, deps, new FrameRouter())
  connB.start()
  connB.daemonId = DAEMON_B
  connB.sessionEpoch = 3
  connB.state = 'READY'

  connReg.add(connState(DAEMON_A, connA, 5, clock, 1))
  connReg.bindSession(KEY, DAEMON_A)
  connReg.add(connState(DAEMON_B, connB, 3, clock, 0))

  const daemonRepo = new PgDaemonRepo(prisma)
  const agentRepo = new PgAgentRepo(prisma)
  const assignmentRepo = new PgAssignmentRepo(prisma)
  const launchRepo = new PgLaunchRepo(prisma)
  const cronRepo = new PgCronRepo(prisma)
  const leaseRepo = new PgSecretLeaseRepo(prisma)
  const integrationRepo = new PgIntegrationRepo(prisma)
  const cipher = new PlaintextSecretCipher()
  const botSecretStore = new PgBotSecretStore(prisma, cipher)
  const agentSecretStore = new PgAgentSecretStore(prisma, cipher)
  const botRepo = new PgBotRepo(prisma)
  const integrationChannelRepo = new PgIntegrationChannelRepo(prisma)
  const epoch = new EpochService(daemonRepo, clock)
  const sender = new ControlSender(connReg, launchRepo)
  const placement = new Placement(
    daemonRepo,
    agentRepo,
    assignmentRepo,
    cronRepo,
    leaseRepo,
    integrationRepo,
    botSecretStore,
    new AgentSpecAssembler(agentSecretStore),
    integrationChannelRepo,
    botRepo,
    // §9 spec projection. This suite seeds no integrations, so only the registry's
    // presence matters; slack alone keeps the fixture minimal.
    buildCpPlatformRegistry([createSlackCpProvider({})]),
    {
      registry: connReg,
      sender,
      epoch,
      clock,
      config: { REASSIGN_GRACE_SEC, ACK_TIMEOUT_MS }
    }
  )
  const watchdog = new Watchdog(connReg, clock, placement, { HEARTBEAT_SEC, MISSED_BEATS, REASSIGN_GRACE_SEC })

  return { placement, watchdog, connReg, clock, stubA, stubB, assignmentRepo }
}

describe('drain / rebalance — withhold reassignment until drain/done, then NEW epoch', () => {
  it('issues daemon/drain to the losing daemon and withholds route/assign until drain/done', async () => {
    await seed()
    const b = build()
    // Daemon B acks any route/assign it receives (so placement completes).
    b.stubB.respondTo('route/assign', (req) => ({
      type: 'route/assign/ack',
      payload: { ok: true, sessionKey: (req.payload as { sessionKey: unknown }).sessionKey }
    }))

    // Kick a rebalance off daemon A (operator-initiated scale-down).
    const done = b.placement.rebalanceFrom(DaemonId(DAEMON_A))

    // A daemon/drain is sent to A, fenced under A's epoch; NO route/assign to B yet.
    const drainFrame = await b.stubA.expectFrame('daemon/drain')
    if (!isFrame('daemon/drain')(drainFrame)) throw new Error('expected daemon/drain')
    expect(drainFrame.epoch).toBe(5)
    expect(b.stubB.lastSent('route/assign')).toBeUndefined() // ← no double-assign window

    // The losing daemon completes draining and releases KEY.
    b.stubA.reply(drainFrame.id, 'drain/done', { released: [KEY] })
    await done

    // NOW exactly one route/assign was issued — to daemon B.
    const assignToB = b.stubB.lastSent('route/assign')
    if (!assignToB || !isFrame('route/assign')(assignToB)) throw new Error('expected route/assign to B')
    expect(assignToB.payload.sessionKey).toEqual(KEY)
    expect(assignToB.payload.agentId).toBe(AGENT)
    expect(b.stubA.lastSent('route/assign')).toBeUndefined() // none to A

    // C6: exactly one active owner — daemon B — at a bumped routingEpoch (was 1).
    const owner = await b.assignmentRepo.ownerOf(KEY)
    expect(owner?.daemonId).toBe(DAEMON_B)
    expect(owner?.state).toBe('active')
    expect(Number(owner?.routingEpoch)).toBeGreaterThan(1)
    const activeRows = await prisma.assignment.findMany({
      where: { platform: 'slack', channel: 'C1', threadKey: 'T1', state: { in: ['active', 'draining', 'frozen'] } }
    })
    expect(activeRows).toHaveLength(1)
  })

  it('watchdog: a missed heartbeat freezes (no reassign), then rebalances only after the grace window', async () => {
    await seed()
    const b = build()
    b.stubB.respondTo('route/assign', (req) => ({
      type: 'route/assign/ack',
      payload: { ok: true, sessionKey: (req.payload as { sessionKey: unknown }).sessionKey }
    }))

    // Arm the watchdog for A; it then misses its beats.
    b.watchdog.track(DaemonId(DAEMON_A))

    // Advance past 3×heartbeat → A is frozen (unreachable), but NOT reassigned yet.
    b.clock.advance(HEARTBEAT_SEC * MISSED_BEATS * 1000 + 1)
    expect(b.connReg.get(DAEMON_A)?.reachable).toBe(false)
    expect(b.stubB.lastSent('route/assign')).toBeUndefined() // no reassignment during grace
    await vi.waitFor(async () => {
      const frozen = await prisma.assignment.findFirst({ where: { daemonId: DAEMON_A } })
      if (frozen?.state !== 'frozen') throw new Error('not frozen yet')
    })

    // Advance past the reassign grace → rebalance fires; A is gone so it reassigns to B.
    b.clock.advance(REASSIGN_GRACE_SEC * 1000 + 1)
    await vi.waitFor(() => {
      if (!b.stubB.lastSent('route/assign')) throw new Error('reassignment not issued yet')
    })
    const reassigned = b.stubB.lastSent('route/assign')
    if (!reassigned || !isFrame('route/assign')(reassigned)) throw new Error('expected route/assign to B')
    expect(reassigned.payload.sessionKey).toEqual(KEY)

    const owner = await b.assignmentRepo.ownerOf(KEY)
    expect(owner?.daemonId).toBe(DAEMON_B)
  })
})
