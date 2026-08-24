import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { SessionPurged } from '@agentconnect.md/protocol'
import { Daemon } from '../src/daemon.js'
import { LocalStore } from '../src/store/local-store.js'
import { SqliteAsyncDatabase } from '../src/store/sqlite-async-database.js'
import { statePath } from '../src/paths.js'
import { FakeClock } from './cp/fake-clock.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'

/**
 * #1032 — on a daemon pool the session table is one table for every member, but the
 * TTL-close and retention-GC exemptions (the SDK background lease, the serial gate, the
 * pending map) live in the memory of the member that serves the agent. Both sweeps are
 * therefore holder-only, and the purge-receipt drain owns its rows per member exactly
 * like the hook-completion outbox: a peer's row is skipped, never destroyed, and never
 * head-of-line blocks the rows behind it.
 */

const AGENT_A = 'bot-a'
const AGENT_B = 'bot-b'
const GROUP_A = '11111111-1111-4111-8111-111111111111'
const GROUP_B = '22222222-2222-4222-8222-222222222222'
const TTL_MS = 900_000
const DAY_MS = 24 * 3_600_000

function scaffold(): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-sweeps-pool-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      runtimes: { claude: { command: 'node', args: ['unused'] } }
    })
  )
  for (const id of [AGENT_A, AGENT_B]) {
    const adir = join(root, 'agents', id)
    mkdirSync(adir, { recursive: true })
    writeFileSync(
      join(adir, 'agent.json'),
      JSON.stringify({
        id,
        name: id,
        status: 'active',
        runtime: 'claude',
        workspace: { mode: 'from-scratch', path: join(adir, 'workspace') },
        integrations: [],
        output: { mode: 'low' }
      })
    )
  }
  return root
}

/** One pool member: duty leases gate service, exactly like an install-wide member. */
async function boot(root: string, daemonId: string) {
  const clock = new FakeClock()
  const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root, hostFactory: () => ({}) as any, clock })
  await daemon.start()
  const inner = daemon as any
  inner.cfg.daemonId = daemonId
  const emitSessionPurged = vi.fn<(purged: SessionPurged) => Promise<'acknowledged'>>(
    async () => 'acknowledged' as const
  )
  inner.cpClient = {
    organizationScope: () => 'frame',
    memberSet: () => ({ setId: '9f11e5e7-0000-4000-8000-000000000001', name: 'Cloud' }),
    state: 'READY',
    emitSessionPurged,
    stop: async () => {},
    releaseDuties: vi.fn(async () => {}),
    reportDutiesNow: vi.fn(() => {}),
    fetchDutyAgent: vi.fn()
  }
  return { daemon, inner, clock, emitSessionPurged }
}

/** Two members over ONE store: the same root, so both open the same database. Each member keeps
 *  its own clock, so advancing one fires only that member's timers. */
async function bootPool() {
  const root = scaffold()
  const a = await boot(root, 'daemon-a')
  const b = await boot(root, 'daemon-b')
  return { a, b, root, stop: () => Promise.all([a.daemon.stop(), b.daemon.stop()]) }
}

/** Advance a member past `ms`, letting the sweep its own timer fired settle first. */
async function advance(member: { inner: any; clock: FakeClock }, ms: number): Promise<void> {
  member.clock.advance(ms)
  await vi.waitFor(() => expect(member.inner.sessionRetentionSweepInFlight).toBe(false))
}

const grant = (groupId: string, agentId: string) => ({
  groupId,
  orgId: 'org-1',
  term: '1',
  members: [{ kind: 'agent' as const, refId: agentId }]
})
const hold = (inner: any, groupId: string, agentId: string) => inner.duties.applyGrant([grant(groupId, agentId)])

const seedSession = async (
  store: LocalStore,
  key: string,
  agentId: string,
  state: 'idle' | 'closed',
  updatedAt: number
): Promise<string> => {
  await store.upsertSession({
    key,
    agentId,
    platform: 'slack',
    channel: 'C1',
    thread: key,
    acpSessionId: `acp-${key}`,
    state,
    lastDeliveredTs: null,
    updatedAt
  })
  // The outward id the session's purge receipt will be addressed by (session-concept.md §1.1).
  return (await store.getSession(key))!.sessionId!
}

/** A's in-memory background-task lease for one of its sessions: live work the TTL sweep must respect. */
function leaseLiveTask(inner: any, agentId: string, acpSessionId: string): void {
  inner.sdkLease.set(JSON.stringify([agentId, acpSessionId]), {
    agentId,
    tasks: new Map([['task-1', { isSubagent: false, startedAt: 0 }]]),
    settled: [],
    sdkState: 'idle',
    bgWakes: 0,
    armedWakes: 0,
    deliveringWakes: 0
  })
}

describe('session sweeps on a daemon pool are holder-only (#1032)', () => {
  it("a member's TTL sweep never closes a session of an agent it does not serve", async () => {
    const { a, b, stop } = await bootPool()
    hold(a.inner, GROUP_A, AGENT_A)
    hold(b.inner, GROUP_B, AGENT_B)
    const store: LocalStore = a.inner.store
    // A's turn returned end_turn, the row is idle, and only A's lease knows the task is live.
    await seedSession(store, 'a-busy', AGENT_A, 'idle', 0)
    leaseLiveTask(a.inner, AGENT_A, 'acp-a-busy')
    await seedSession(store, 'a-quiet', AGENT_A, 'idle', 0)
    await seedSession(store, 'b-quiet', AGENT_B, 'idle', 0)

    // B holds no lease for A's session — before the fix that read as quiescent and closed it.
    await advance(b, TTL_MS + 1)
    await b.inner.sweepIdle()
    expect((await store.getSession('a-busy'))?.state).toBe('idle')
    expect((await store.getSession('a-quiet'))?.state).toBe('idle')
    expect((await store.getSession('b-quiet'))?.state).toBe('closed')

    // The holder decides its own rows: the lease keeps one open, plain TTL closes the other.
    await advance(a, TTL_MS + 1)
    await a.inner.sweepIdle()
    expect((await store.getSession('a-busy'))?.state).toBe('idle')
    expect((await store.getSession('a-quiet'))?.state).toBe('closed')
    await stop()
  }, 15_000)

  it("a member's retention GC never deletes a session of an agent another member is mid-turn on", async () => {
    const { a, b, stop } = await bootPool()
    hold(a.inner, GROUP_A, AGENT_A)
    hold(b.inner, GROUP_B, AGENT_B)
    const store: LocalStore = a.inner.store
    await seedSession(store, 'a-turn', AGENT_A, 'idle', 0)
    await seedSession(store, 'b-old', AGENT_B, 'closed', 0)
    // A owns the serial gate for its session — state B cannot see.
    a.inner.inflight.add('a-turn')
    await advance(a, 8 * DAY_MS)
    await advance(b, 8 * DAY_MS)

    await b.inner.sweepSessionRetention()
    expect(await store.getSession('a-turn')).toBeDefined()
    expect(await store.getSession('b-old')).toBeUndefined()

    // A skips its own live turn, and deletes it once the turn is over.
    await a.inner.sweepSessionRetention()
    expect(await store.getSession('a-turn')).toBeDefined()
    a.inner.inflight.delete('a-turn')
    await a.inner.sweepSessionRetention()
    expect(await store.getSession('a-turn')).toBeUndefined()
    await stop()
  }, 15_000)

  it("the purge-receipt drain skips a peer's rows and still reports its own", async () => {
    const { a, b, root, stop } = await bootPool()
    hold(a.inner, GROUP_A, AGENT_A)
    hold(b.inner, GROUP_B, AGENT_B)
    // The pool's shared store: one receipt table, leased per member.
    const path = statePath(root)
    const locals: LocalStore[] = [a.inner.store, b.inner.store]
    a.inner.store = await LocalStore.open({
      database: SqliteAsyncDatabase.adopt(new DatabaseSync(path)),
      shared: true,
      ownerId: 'daemon-a',
      orgForAgent: () => 'org-1'
    })
    b.inner.store = await LocalStore.open({
      database: SqliteAsyncDatabase.adopt(new DatabaseSync(path)),
      shared: true,
      ownerId: 'daemon-b',
      orgForAgent: () => 'org-1'
    })
    const shared: LocalStore = a.inner.store
    const owed = async () =>
      (await shared.listSessionPurges(10, 0, 'daemon-a', [AGENT_A, AGENT_B])).map((row) => row.sessionId)

    // A's sweep purged two of A's sessions and one legacy, unowned receipt sits alongside;
    // B's own receipt is the youngest, so a drain that returned on the foreign group would never reach it.
    const a1 = await seedSession(shared, 'a-1', AGENT_A, 'closed', 0)
    const a2 = await seedSession(shared, 'a-2', AGENT_A, 'closed', 0)
    const aLegacy = await seedSession(shared, 'a-legacy', AGENT_A, 'closed', 0)
    const b1 = await seedSession(shared, 'b-1', AGENT_B, 'closed', 0)
    await shared.deleteSession('a-1', { reason: 'retention', at: 1_000, ownerId: 'daemon-a' })
    await shared.deleteSession('a-2', { reason: 'retention', at: 1_000, ownerId: 'daemon-a' })
    await shared.deleteSession('a-legacy', { reason: 'retention', at: 1_500 })
    await shared.deleteSession('b-1', { reason: 'retention', at: 2_000, ownerId: 'daemon-b' })
    await advance(a, 10_000)
    await advance(b, 10_000)

    await b.inner.drainSessionPurges()
    expect(b.emitSessionPurged).toHaveBeenCalledOnce()
    expect(b.emitSessionPurged.mock.calls[0]![0]).toMatchObject({ agentId: AGENT_B, sessionIds: [b1] })
    // A's live rows and the unowned row for A's agent are left for A: nothing was destroyed.
    expect((await owed()).sort()).toEqual([a1, a2, aLegacy].sort())

    await a.inner.drainSessionPurges()
    const frames = a.emitSessionPurged.mock.calls.map((call: any[]) => call[0])
    expect(frames.map((frame: any) => frame.agentId)).toEqual([AGENT_A, AGENT_A])
    expect(frames.flatMap((frame: any) => [...frame.sessionIds]).sort()).toEqual([a1, a2, aLegacy].sort())
    expect(await owed()).toEqual([])
    await stop()
    for (const local of locals) await local.close()
  }, 15_000)

  it("a member's own receipt for an agent it no longer serves is left for the holder, not reported", async () => {
    const { a, b, root, stop } = await bootPool()
    hold(a.inner, GROUP_A, AGENT_A)
    const path = statePath(root)
    const locals: LocalStore[] = [a.inner.store, b.inner.store]
    a.inner.store = await LocalStore.open({
      database: SqliteAsyncDatabase.adopt(new DatabaseSync(path)),
      shared: true,
      ownerId: 'daemon-a',
      orgForAgent: () => 'org-1'
    })
    b.inner.store = await LocalStore.open({
      database: SqliteAsyncDatabase.adopt(new DatabaseSync(path)),
      shared: true,
      ownerId: 'daemon-b',
      orgForAgent: () => 'org-1'
    })
    const shared: LocalStore = a.inner.store
    // B purged this session while it held the agent; the duty then moved to A.
    await seedSession(shared, 'moved', AGENT_A, 'closed', 0)
    await shared.deleteSession('moved', { reason: 'retention', at: 1_000, ownerId: 'daemon-b' })
    await advance(a, 10_000)
    await advance(b, 10_000)

    // The CP would ACK B without marking anything, so B must not report it...
    await b.inner.drainSessionPurges()
    expect(b.emitSessionPurged).not.toHaveBeenCalled()
    // ...and A may not take a live claim either, until it lapses.
    await a.inner.drainSessionPurges()
    expect(a.emitSessionPurged).not.toHaveBeenCalled()
    await advance(a, 2 * 60_000 + 1)
    await a.inner.drainSessionPurges()
    expect(a.emitSessionPurged).toHaveBeenCalledOnce()
    expect(await shared.listSessionPurges(10, a.clock.now(), 'daemon-b', [AGENT_A])).toEqual([])
    await stop()
    for (const local of locals) await local.close()
  }, 15_000)

  it('gaining a duty after the socket came up replays the receipt a prior holder left, once', async () => {
    const { a, b, root, stop } = await bootPool()
    const path = statePath(root)
    const locals: LocalStore[] = [a.inner.store, b.inner.store]
    a.inner.store = await LocalStore.open({
      database: SqliteAsyncDatabase.adopt(new DatabaseSync(path)),
      shared: true,
      ownerId: 'daemon-a',
      orgForAgent: () => 'org-1'
    })
    b.inner.store = await LocalStore.open({
      database: SqliteAsyncDatabase.adopt(new DatabaseSync(path)),
      shared: true,
      ownerId: 'daemon-b',
      orgForAgent: () => 'org-1'
    })
    const shared: LocalStore = b.inner.store
    // The prior holder purged this session and died before its receipt was ACKed.
    const left = await seedSession(shared, 'left', AGENT_A, 'closed', 0)
    await shared.deleteSession('left', { reason: 'retention', at: 1_000, ownerId: 'daemon-a' })
    await advance(b, 1_000 + 2 * 60_000 + 1)

    // A fresh member's READY replay runs before its post-register grant is admitted: nothing is served yet.
    await b.inner.drainSessionPurges()
    expect(b.emitSessionPurged).not.toHaveBeenCalled()
    // The grant lands: the receipt is this member's to report now, and it is reported exactly once.
    b.inner.dutyCoordinator.settleDutyChange(b.inner.duties.applyGrant([grant(GROUP_A, AGENT_A)]))
    await vi.waitFor(() => expect(b.emitSessionPurged).toHaveBeenCalledOnce())
    expect(b.emitSessionPurged.mock.calls[0]![0]).toMatchObject({ agentId: AGENT_A, sessionIds: [left] })
    await b.inner.drainSessionPurges()
    expect(b.emitSessionPurged).toHaveBeenCalledOnce()
    expect(await shared.listSessionPurges(10, b.clock.now(), 'daemon-b', [AGENT_A])).toEqual([])
    await stop()
    for (const local of locals) await local.close()
  }, 15_000)
})
