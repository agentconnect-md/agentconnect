import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Daemon } from '../src/daemon.js'
import { LocalStore } from '../src/store/local-store.js'
import { SqliteAsyncDatabase } from '../src/store/sqlite-async-database.js'
import { statePath } from '../src/paths.js'
import { FakeClock } from './cp/fake-clock.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'

/**
 * #1023 — on a daemon pool the session-metadata outbox is one shared table, but the
 * `event/session-sync` frame is scoped by the agent's organization, which only a member
 * serving that agent can resolve. Every member used to drain every row and defer the
 * ones it could not scope forever. A member now drains only what it owns or serves,
 * claims before it emits, and parks what it cannot scope for the member that can.
 */

const AGENT_A = '33333333-3333-4333-8333-333333333333'
const AGENT_B = '44444444-4444-4444-8444-444444444444'
const GROUP_A = '11111111-1111-4111-8111-111111111111'
const GROUP_B = '22222222-2222-4222-8222-222222222222'
const ORG = 'org-1'
const PARK_MS = 60_000
const LEASE_MS = 2 * 60_000

function scaffold(): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-metadata-pool-'))
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

type Member = Awaited<ReturnType<typeof boot>>

/** One member whose CP stub scopes exactly like the real client: the organization comes
 *  from the agent registry, which on a pool carries only the agents this member serves. */
async function boot(root: string, daemonId: string, scope: 'frame' | 'install' = 'frame') {
  const clock = new FakeClock()
  const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root, hostFactory: () => ({}) as any, clock })
  await daemon.start()
  const inner = daemon as any
  inner.cfg.daemonId = daemonId
  const warn = vi.fn<(msg: string) => void>()
  inner.log.warn = warn
  const scopeBlind = new Set<string>()
  const synced: { orgId: string; agentId: string; sessionId: string }[] = []
  const syncEventSession = vi.fn(async (event: { agentId: string; sessionId: string }) => {
    const known = scope === 'install' || inner.duties.holdsAgent(event.agentId)
    if (!known || scopeBlind.has(event.agentId)) {
      throw Object.assign(new Error('cannot resolve organization for event/session-sync'), {
        name: 'WireError',
        code: 'SCOPE_DENIED',
        retryable: false
      })
    }
    synced.push({ orgId: ORG, agentId: event.agentId, sessionId: event.sessionId })
    return 'acknowledged' as const
  })
  inner.cpClient = {
    organizationScope: () => scope,
    // Membership, not tenancy, is what makes duties enforced (daemon-groups.md §3).
    memberSet: () => (scope === 'frame' ? { setId: '9f11e5e7-0000-4000-8000-000000000001', name: 'Cloud' } : null),
    state: 'READY',
    supportsServerFeature: (feature: string) => feature === 'session-metadata-ack-v1',
    syncEventSession,
    emitSessionPurged: vi.fn(async () => 'acknowledged' as const),
    stop: async () => {},
    releaseDuties: vi.fn(async () => {}),
    reportDutiesNow: vi.fn(() => {}),
    fetchDutyAgent: vi.fn()
  }
  return { daemon, inner, clock, warn, synced, syncEventSession, scopeBlind }
}

/** Two members over ONE store, each with its own clock and its own duty leases. */
async function bootPool() {
  const root = scaffold()
  const a = await boot(root, 'daemon-a')
  const b = await boot(root, 'daemon-b')
  const locals: LocalStore[] = [a.inner.store, b.inner.store]
  const path = statePath(root)
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
  return {
    a,
    b,
    shared,
    stop: async () => {
      await Promise.all([a.daemon.stop().catch(() => {}), b.daemon.stop().catch(() => {})])
      for (const local of locals) await local.close()
    }
  }
}

const grant = (groupId: string, agentId: string) => ({
  groupId,
  orgId: ORG,
  term: '1',
  members: [{ kind: 'agent' as const, refId: agentId }]
})
const hold = (inner: any, groupId: string, agentId: string) => inner.duties.applyGrant([grant(groupId, agentId)])

/** One unacknowledged terminal milestone, stamped to the member that produced it. */
async function seedSnapshot(
  store: LocalStore,
  agentId: string,
  sessionId: string,
  queuedAt: number,
  ownerId: string
): Promise<void> {
  const event = {
    sessionId,
    agentId,
    phase: 'end',
    platform: 'slack',
    channel: 'C1',
    ts: new Date(queuedAt).toISOString()
  }
  await store.saveSessionMetadataSnapshot(agentId, sessionId, JSON.stringify(event), true, queuedAt, ownerId)
}

const deferred = (member: Member) =>
  member.warn.mock.calls.filter(([message]) => String(message).includes('snapshot deferred'))

describe('session-metadata outbox ownership on a daemon pool (#1023)', () => {
  it("a member drains its own rows and never a peer's", async () => {
    const { a, b, shared, stop } = await bootPool()
    hold(a.inner, GROUP_A, AGENT_A)
    hold(b.inner, GROUP_B, AGENT_B)
    await seedSnapshot(shared, AGENT_A, 'acp-a-1', 1, 'daemon-a')
    await seedSnapshot(shared, AGENT_B, 'acp-b-1', 2, 'daemon-b')

    await b.inner.sessionMetadataOutbox.drainSessionMetadataSnapshots()
    expect(b.synced).toEqual([{ orgId: ORG, agentId: AGENT_B, sessionId: 'acp-b-1' }])
    // A's row is untouched: still pending, still unfailed, still A's to report.
    expect(await shared.pendingSessionMetadataSnapshot(AGENT_A, 'acp-a-1')).toMatchObject({
      revision: 1,
      failedAttempts: 0
    })
    expect(deferred(b)).toEqual([])

    await a.inner.sessionMetadataOutbox.drainSessionMetadataSnapshots()
    expect(a.synced).toEqual([{ orgId: ORG, agentId: AGENT_A, sessionId: 'acp-a-1' }])
    expect(await shared.hasPendingSessionMetadata()).toBe(false)
    await stop()
  })

  it('parks a row for an agent no member here serves instead of counting a failure', async () => {
    const { a, b, shared, stop } = await bootPool()
    // The duty for AGENT_A moved off this member after it wrote the snapshot.
    hold(b.inner, GROUP_B, AGENT_B)
    await seedSnapshot(shared, AGENT_A, 'acp-moved', 1, 'daemon-a')

    await a.inner.sessionMetadataOutbox.drainSessionMetadataSnapshots()
    expect(a.syncEventSession).not.toHaveBeenCalled()
    // Claim released, body and failure count intact, backoff only keeps it out of this pass.
    expect(await shared.pendingSessionMetadataSnapshot(AGENT_A, 'acp-moved')).toMatchObject({
      revision: 1,
      failedAttempts: 0,
      nextAttemptAt: PARK_MS
    })
    expect(deferred(a)).toEqual([])
    // The peer does not serve AGENT_A either, so it leaves the parked row alone.
    await b.inner.sessionMetadataOutbox.drainSessionMetadataSnapshots()
    expect(b.syncEventSession).not.toHaveBeenCalled()
    expect(await shared.pendingSessionMetadataSnapshot(AGENT_A, 'acp-moved')).toBeDefined()
    await stop()
  })

  it('gaining the duty replays the parked row exactly once, scoped to the agent org', async () => {
    const { a, b, shared, stop } = await bootPool()
    await seedSnapshot(shared, AGENT_A, 'acp-moved', 1, 'daemon-a')
    await a.inner.sessionMetadataOutbox.drainSessionMetadataSnapshots()
    expect((await shared.pendingSessionMetadataSnapshot(AGENT_A, 'acp-moved'))?.nextAttemptAt).toBe(PARK_MS)

    // The grant lands on B well before the parked backoff would have expired.
    b.inner.dutyCoordinator.settleDutyChange(b.inner.duties.applyGrant([grant(GROUP_A, AGENT_A)]))
    await vi.waitFor(() => expect(b.syncEventSession).toHaveBeenCalledOnce())
    expect(b.synced).toEqual([{ orgId: ORG, agentId: AGENT_A, sessionId: 'acp-moved' }])
    expect(await shared.hasPendingSessionMetadata()).toBe(false)
    await b.inner.sessionMetadataOutbox.drainSessionMetadataSnapshots()
    expect(b.syncEventSession).toHaveBeenCalledOnce()
    await stop()
  })

  it('parks a served row whose organization is not resolvable yet, and drains it once it is', async () => {
    const { a, shared, stop } = await bootPool()
    hold(a.inner, GROUP_A, AGENT_A)
    a.scopeBlind.add(AGENT_A)
    await seedSnapshot(shared, AGENT_A, 'acp-cold', 1, 'daemon-a')

    await a.inner.sessionMetadataOutbox.drainSessionMetadataSnapshots()
    expect(a.syncEventSession).toHaveBeenCalledOnce()
    // A local SCOPE_DENIED is not a rejection of the snapshot: no failure, no defer warning.
    expect(await shared.pendingSessionMetadataSnapshot(AGENT_A, 'acp-cold')).toMatchObject({
      failedAttempts: 0,
      nextAttemptAt: PARK_MS
    })
    expect(deferred(a)).toEqual([])

    a.scopeBlind.clear()
    a.clock.advance(PARK_MS + 1)
    await a.inner.sessionMetadataOutbox.drainSessionMetadataSnapshots()
    expect(a.synced).toEqual([{ orgId: ORG, agentId: AGENT_A, sessionId: 'acp-cold' }])
    expect(await shared.hasPendingSessionMetadata()).toBe(false)
    await stop()
  })

  it('takes over a claim the departed holder never released when the duty is gained', async () => {
    const { a, b, shared, stop } = await bootPool()
    // A wrote the snapshot, then released the duty on a graceful shutdown before parking it:
    // the row still names A with a fresh claim, so nothing in the pool could touch it.
    hold(a.inner, GROUP_A, AGENT_A)
    await seedSnapshot(shared, AGENT_A, 'acp-handoff', 1, 'daemon-a')

    b.inner.dutyCoordinator.settleDutyChange(b.inner.duties.applyGrant([grant(GROUP_A, AGENT_A)]))
    await vi.waitFor(() => expect(b.syncEventSession).toHaveBeenCalledOnce())
    expect(b.synced).toEqual([{ orgId: ORG, agentId: AGENT_A, sessionId: 'acp-handoff' }])
    expect(await shared.hasPendingSessionMetadata()).toBe(false)
    await stop()
  })

  it("arms a wake at the lease expiry of a peer's claim on a served agent", async () => {
    const { a, b, stop } = await bootPool()
    // Both members read the duty as theirs — the takeover already happened, but no duty change
    // fires here, so only the armed wake can outlast A's claim.
    hold(a.inner, GROUP_A, AGENT_A)
    hold(b.inner, GROUP_A, AGENT_A)
    await seedSnapshot(a.inner.store, AGENT_A, 'acp-lease', 1, 'daemon-a')

    await b.inner.sessionMetadataOutbox.drainSessionMetadataSnapshots()
    expect(b.syncEventSession).not.toHaveBeenCalled()
    expect(b.clock.pending()).toContain(1 + LEASE_MS)

    b.clock.advance(1 + LEASE_MS)
    await vi.waitFor(() => expect(b.syncEventSession).toHaveBeenCalledOnce())
    expect(b.synced).toEqual([{ orgId: ORG, agentId: AGENT_A, sessionId: 'acp-lease' }])
    await stop()
  })

  it('releases the claims it still holds when it stops, so a successor drains at once', async () => {
    const { a, b, stop } = await bootPool()
    hold(a.inner, GROUP_A, AGENT_A)
    hold(b.inner, GROUP_A, AGENT_A)
    // Asserted through B's handle: stopping A closes the store handle A opened.
    const survivor: LocalStore = b.inner.store
    await seedSnapshot(survivor, AGENT_A, 'acp-exit', 1, 'daemon-a')

    await b.inner.sessionMetadataOutbox.drainSessionMetadataSnapshots()
    expect(b.syncEventSession).not.toHaveBeenCalled()

    await a.daemon.stop()
    await b.inner.sessionMetadataOutbox.drainSessionMetadataSnapshots()
    expect(b.synced).toEqual([{ orgId: ORG, agentId: AGENT_A, sessionId: 'acp-exit' }])
    expect(await survivor.hasPendingSessionMetadata()).toBe(false)
    await stop()
  })

  it('a single daemon on its own store drains every row unfenced', async () => {
    const root = scaffold()
    const solo = await boot(root, 'daemon-solo', 'install')
    const store: LocalStore = solo.inner.store
    await seedSnapshot(store, AGENT_A, 'acp-1', 1, 'daemon-solo')
    await seedSnapshot(store, AGENT_B, 'acp-2', 2, 'daemon-solo')

    await solo.inner.sessionMetadataOutbox.drainSessionMetadataSnapshots()
    expect(solo.synced.map((entry) => entry.sessionId)).toEqual(['acp-1', 'acp-2'])
    expect(await store.hasPendingSessionMetadata()).toBe(false)
    await solo.daemon.stop()
  })
})
