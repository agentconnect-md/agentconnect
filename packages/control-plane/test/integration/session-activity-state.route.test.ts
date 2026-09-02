// `agent/activity` → `SessionMeta.activityState` → `GET /sessions?activityState=…` (slack-approval-dm.md §7).
import { describe, it, expect, afterEach, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '../setup.db.js'
import { seedDaemon, seedAgent, seedLaunch } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { PgAgentRepo, PgHookRepo, PgSessionRepo, PgWebchatConversationRepo } from '../../src/persistence/index.js'
import { AgentId, DaemonId, SessionId } from '../../src/domain/ids.js'
import { handleAgentActivity, handleEventSession } from '../../src/ws/handlers/index.js'
import type { DaemonConnection } from '../../src/ws/connection.js'
import type { DaemonWsDeps } from '../../src/ws/deps.js'
import type { AnyFrame } from '@agentconnect.md/protocol'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { InMemorySessionEventSink, type SessionEventEnvelope } from '../../src/events/sink.js'
import { AgentMutationGate } from '../../src/orchestrator/agentMutationGate.js'
import { ConnectionRegistry } from '../../src/ws/registry.js'
import { FakeClock } from '../fakes/fake-clock.js'
import { clearAwaitingApprovals } from '../../src/ws/approval-waits.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`

let running: HttpApp | undefined
afterEach(async () => {
  await running?.close()
  running = undefined
})

const DAEMON = 'd1d1d1d1-dddd-4ddd-8ddd-dddddddddddd'
const OTHER_DAEMON = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const AGENT = 'a0a0a0a0-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const LAUNCH = '10101010-1111-4111-8111-111111111111'
const SESSION = '4691f21b-3911-4d7f-a45d-28ce75d79337'

function frame(type: string, payload: Record<string, unknown>): AnyFrame {
  return { v: 1, id: randomUUID(), ts: new Date().toISOString(), type, payload } as AnyFrame
}

function deps(events: InMemorySessionEventSink, connReg = new ConnectionRegistry()): DaemonWsDeps {
  return {
    connReg,
    agent: new PgAgentRepo(prisma),
    agentMutations: new AgentMutationGate(),
    hook: new PgHookRepo(prisma),
    session: new PgSessionRepo(prisma),
    webchatConversation: new PgWebchatConversationRepo(prisma),
    events
  } as unknown as DaemonWsDeps
}

async function reportSession(events: InMemorySessionEventSink, phase: 'start' | 'end', daemonId = DAEMON) {
  await handleEventSession(
    frame('event/session', {
      sessionId: SESSION,
      agentId: AGENT,
      launchId: LAUNCH,
      phase,
      platform: 'slack',
      channel: 'C123',
      thread: 'T9',
      title: 'Roll out api@1.4.2',
      ts: '2026-07-05T00:00:00.000Z'
    }),
    { daemonId, orgId: DEFAULT_ORG_ID } as DaemonConnection,
    deps(events)
  )
}

async function reportActivity(
  events: InMemorySessionEventSink,
  state: string,
  daemonId = DAEMON,
  connReg = new ConnectionRegistry(),
  connState: 'READY' | 'CLOSED' = 'READY'
) {
  await handleAgentActivity(
    frame('agent/activity', { agentId: AGENT, sessionId: SESSION, state, ts: '2026-07-05T00:00:01.000Z' }),
    { daemonId, orgId: DEFAULT_ORG_ID, state: connState } as DaemonConnection,
    deps(events, connReg)
  )
}

function clearDeps(events: InMemorySessionEventSink) {
  return { session: new PgSessionRepo(prisma), events, clock: new FakeClock(Date.parse('2026-07-05T00:00:02.000Z')) }
}

async function awaitingSessions(app: HttpApp): Promise<string[]> {
  const res = await app.app.inject({
    method: 'GET',
    url: `${ORG}/sessions?view=flat&activityState=awaiting_permission&limit=50`
  })
  expect(res.statusCode).toBe(200)
  return (res.json() as { sessions: Array<{ sessionId: string }> }).sessions.map((s) => s.sessionId)
}

async function storedState(): Promise<string | undefined> {
  return (await prisma.sessionMeta.findUnique({ where: { id: SESSION } }))?.activityState
}

describe('agent/activity → SessionMeta.activityState → GET /sessions?activityState (§7)', () => {
  it('persists the wait, lists it under the filter, publishes it, and clears it on idle', async () => {
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    await seedLaunch(prisma, LAUNCH, AGENT, DAEMON)
    running = buildHttpApp(prisma)
    const events = new InMemorySessionEventSink()
    const seen: SessionEventEnvelope[] = []
    events.subscribe((e) => seen.push(e))

    await reportSession(events, 'start')
    expect(await storedState()).toBe('idle')
    expect(await awaitingSessions(running)).toEqual([])

    await reportActivity(events, 'awaiting_permission')
    expect(await storedState()).toBe('awaiting_permission')
    expect(await awaitingSessions(running)).toEqual([SESSION])
    expect(seen.filter((e) => e.state).map((e) => e.state?.state)).toEqual(['awaiting_permission'])

    // The unfiltered list carries the state too, so the console reads one shape everywhere.
    const flat = await running.app.inject({ method: 'GET', url: `${ORG}/sessions?view=flat` })
    expect((flat.json() as { sessions: Array<{ activityState: string }> }).sessions[0]?.activityState).toBe(
      'awaiting_permission'
    )

    await reportActivity(events, 'idle')
    expect(await storedState()).toBe('idle')
    expect(await awaitingSessions(running)).toEqual([])
    expect(seen.filter((e) => e.state).map((e) => e.state?.state)).toEqual(['awaiting_permission', 'idle'])
  })

  it('drops a frame from a daemon that does not serve the agent, and one for an unknown session', async () => {
    await seedDaemon(prisma, DAEMON)
    await seedDaemon(prisma, OTHER_DAEMON)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    await seedLaunch(prisma, LAUNCH, AGENT, DAEMON)
    const events = new InMemorySessionEventSink()
    const publishState = vi.spyOn(events, 'publishState')

    // No session row yet: nothing to flag, nothing to publish.
    await reportActivity(events, 'awaiting_permission')
    expect(publishState).not.toHaveBeenCalled()

    await reportSession(events, 'start')
    await reportActivity(events, 'awaiting_permission', OTHER_DAEMON)
    expect(await storedState()).toBe('idle')
    expect(publishState).not.toHaveBeenCalled()
  })

  it('a finished session waits on nobody: the end milestone resets a stale wait', async () => {
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    await seedLaunch(prisma, LAUNCH, AGENT, DAEMON)
    const events = new InMemorySessionEventSink()
    const seen: SessionEventEnvelope[] = []
    events.subscribe((e) => seen.push(e))

    await reportSession(events, 'start')
    await reportActivity(events, 'awaiting_permission')
    await reportSession(events, 'end')
    expect(await storedState()).toBe('idle')
    expect(seen.filter((e) => e.state).map((e) => e.state?.state)).toEqual(['awaiting_permission', 'idle'])
  })

  it('a reconnect replay lands after a still-running disconnect clear, never under it', async () => {
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    await seedLaunch(prisma, LAUNCH, AGENT, DAEMON)
    const events = new InMemorySessionEventSink()
    const connReg = new ConnectionRegistry()
    const repo = new PgSessionRepo(prisma)
    await reportSession(events, 'start')
    await reportActivity(events, 'awaiting_permission')

    // The old socket's clear is queued but stalls mid-flight while the daemon reconnects and replays.
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    let cleared: Array<{ id: string }> = []
    void connReg.runApprovalMutation(DAEMON, async () => {
      await gate
      cleared = await repo.clearAwaitingPermissionForDaemon(DaemonId(DAEMON))
    })
    const replay = reportActivity(events, 'awaiting_permission', DAEMON, connReg)
    await new Promise((resolve) => setTimeout(resolve, 20))
    // Still waiting on the clear: nothing has been written by the replay yet.
    expect(cleared).toEqual([])
    release()
    await replay
    expect(cleared.map((row) => row.id)).toEqual([SESSION])
    // The clear committed `idle` first; the replay's `awaiting_permission` is the final word.
    expect(await storedState()).toBe('awaiting_permission')
    await connReg.approvalMutationsSettled(DAEMON)
  })

  it('a closing socket’s in-flight write is outlived by its own close clear, never the reverse', async () => {
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    await seedLaunch(prisma, LAUNCH, AGENT, DAEMON)
    const events = new InMemorySessionEventSink()
    const connReg = new ConnectionRegistry()
    await reportSession(events, 'start')

    // The write was accepted before the close; the close clear queues behind it on the same tail.
    const write = reportActivity(events, 'awaiting_permission', DAEMON, connReg)
    const clear = connReg.runApprovalMutation(DAEMON, () => clearAwaitingApprovals(clearDeps(events), DAEMON, true))
    await Promise.all([write, clear])
    expect(await storedState()).toBe('idle')

    // A frame whose connection already closed before its turn on the tail writes nothing at all.
    const publishState = vi.spyOn(events, 'publishState')
    await reportActivity(events, 'awaiting_permission', DAEMON, connReg, 'CLOSED')
    expect(await storedState()).toBe('idle')
    expect(publishState).not.toHaveBeenCalled()
  })

  it('the register-time clear resets silently; the replay that follows publishes the live wait', async () => {
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    await seedLaunch(prisma, LAUNCH, AGENT, DAEMON)
    const events = new InMemorySessionEventSink()
    const connReg = new ConnectionRegistry()
    await reportSession(events, 'start')
    await reportActivity(events, 'awaiting_permission', DAEMON, connReg)

    const seen: SessionEventEnvelope[] = []
    events.subscribe((e) => seen.push(e))
    await connReg.runApprovalMutation(DAEMON, () => clearAwaitingApprovals(clearDeps(events), DAEMON, false))
    expect(await storedState()).toBe('idle')
    expect(seen).toEqual([])
    await reportActivity(events, 'awaiting_permission', DAEMON, connReg)
    expect(await storedState()).toBe('awaiting_permission')
    expect(seen.map((e) => e.state?.state)).toEqual(['awaiting_permission'])
  })

  it('a disconnected daemon has its waits cleared, and only its own', async () => {
    await seedDaemon(prisma, DAEMON)
    await seedDaemon(prisma, OTHER_DAEMON)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    await seedLaunch(prisma, LAUNCH, AGENT, DAEMON)
    const events = new InMemorySessionEventSink()
    await reportSession(events, 'start')
    await reportActivity(events, 'awaiting_permission')

    const repo = new PgSessionRepo(prisma)
    expect(await repo.clearAwaitingPermissionForDaemon(DaemonId(OTHER_DAEMON))).toEqual([])
    expect(await storedState()).toBe('awaiting_permission')

    expect(await repo.clearAwaitingPermissionForDaemon(DaemonId(DAEMON))).toEqual([
      { id: SessionId(SESSION), agentId: AgentId(AGENT) }
    ])
    expect(await storedState()).toBe('idle')
    // Idempotent: nothing left to clear.
    expect(await repo.clearAwaitingPermissionForDaemon(DaemonId(DAEMON))).toEqual([])
  })
})
