/**
 * The store half of the pool's orphan reconciler: two members over ONE shared data-plane store,
 * where an outbox row can outlive the member that wrote it.
 */
import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { LocalStore, sessionKey, type StoreDatabase, type StoreOrphanRow } from '../src/store/local-store.js'
import {
  DEFAULT_STORE_ORPHAN_HORIZON_MS,
  STORE_ORPHAN_DELETE_ENV,
  STORE_ORPHAN_HORIZON_ENV,
  StoreOrphanReaper,
  resolveStoreOrphanReaperSettings
} from '../src/store/orphan-reaper.js'
import { openPostgresLocalStore, usingPostgresStore } from './store-postgres/backend.js'

const pg = usingPostgresStore()
const LIVE = '11111111-1111-4111-8111-111111111111'
const GONE = '22222222-2222-4222-8222-222222222222'
const AT = 1_800_000_000_000

const oneOrg = () => 'org-1'

/** Two pool members over one database — what the shared schema is during a rollout. */
function sharedMembers(first: string, second: string): [LocalStore, LocalStore] {
  if (pg)
    return [
      openPostgresLocalStore({ shared: true, ownerId: first, orgForAgent: oneOrg }),
      openPostgresLocalStore({ shared: true, ownerId: second, orgForAgent: oneOrg })
    ]
  const database = new DatabaseSync(':memory:') as unknown as StoreDatabase
  return [
    new LocalStore({ database, shared: true, ownerId: first, orgForAgent: oneOrg }),
    new LocalStore({ database, shared: true, ownerId: second, orgForAgent: oneOrg })
  ]
}

/** One row in each of the four per-member outbox tables, all stamped `at`. */
function seedOutboxes(s: LocalStore, agentId: string, tag: string, at: number, ownerDaemonId: string): void {
  const hookId = `hook-${tag}`
  s.appendInbox({
    id: hookId,
    sessionKey: sessionKey('hook', 'hook-1', hookId, agentId),
    agentId,
    msg: '{}',
    hookContext: '{}',
    enqueuedAt: String(at)
  })
  expect(s.completeHookInbox(hookId, JSON.stringify({ id: hookId }), at, ownerDaemonId)).toBe('completed')
  s.upsertSession({
    key: tag,
    agentId,
    platform: 'slack',
    channel: 'C1',
    thread: tag,
    acpSessionId: `acp-${tag}`,
    state: 'idle',
    lastDeliveredTs: null,
    updatedAt: at
  })
  s.deleteSession(tag, { reason: 'retention', at, ownerId: ownerDaemonId })
  // Written after the delete: `deleteSession` drops the session's own outbox snapshot with it.
  s.saveSessionMetadataSnapshot(agentId, `acp-${tag}`, '{"phase":"end"}', true, at, ownerDaemonId)
  s.recordWebchatMcpGrant({
    conversationId: `conv-${tag}`,
    agentId,
    authorityId: `auth-${tag}`,
    authorityGeneration: 1,
    now: at
  })
}

/** The control plane knows only `LIVE`; every call is recorded so batching is visible. */
function fakeCp() {
  const asked: string[][] = []
  return {
    asked,
    liveAgents: async (ids: string[]) => {
      asked.push([...ids].sort())
      return new Set(ids.filter((id) => id === LIVE))
    }
  }
}

function reaper(s: LocalStore, now: number, opts: { deleteEnabled?: boolean; horizonMs?: number } = {}) {
  const cp = fakeCp()
  const logs: string[] = []
  const instance = new StoreOrphanReaper({
    store: s,
    liveAgents: cp.liveAgents,
    settings: {
      horizonMs: opts.horizonMs ?? DEFAULT_STORE_ORPHAN_HORIZON_MS,
      deleteEnabled: opts.deleteEnabled ?? false
    },
    clock: { now: () => now } as never,
    log: { info: (m) => logs.push(m), warn: (m) => logs.push(m) }
  })
  return { instance, cp, logs }
}

const kinds = (rows: StoreOrphanRow[]): string[] => rows.map((row) => `${row.kind}:${row.id}`).sort()

describe('store orphan reaper', () => {
  it('counts what it would collect and deletes nothing while dry run is on', async () => {
    const [a, b] = sharedMembers('member-a', 'member-b')
    seedOutboxes(a, LIVE, 'live', AT, 'member-a')
    seedOutboxes(a, GONE, 'gone', AT, 'member-a')

    const { instance, cp, logs } = reaper(b, AT + 1_000)
    const summary = await instance.sweep()

    expect(cp.asked).toEqual([[LIVE, GONE]]) // one batched question for the whole sweep
    expect(summary).toMatchObject({ candidates: 8, orphaned: 4, deleted: 0, skippedLive: 4, agentGone: 4, horizon: 0 })
    expect(summary!.byKind).toEqual({
      'hook-report': 1,
      'session-metadata': 1,
      'session-purge': 1,
      'webchat-grant': 1
    })
    expect(logs.at(-1)).toContain('orphaned=4 deleted=0 skipped-live=4 failed=0 agent-gone=4 horizon=0')
    expect(logs.at(-1)).toContain('(dry run)')
    expect(b.listStoreOrphanCandidates()).toHaveLength(8)
    a.close() // one database backs the pair
  })

  it("collects the rows of an agent the control plane forgot and leaves a live agent's alone", async () => {
    const [a, b] = sharedMembers('member-a', 'member-b')
    seedOutboxes(a, LIVE, 'live', AT, 'member-a')
    seedOutboxes(a, GONE, 'gone', AT, 'member-a')

    const { instance, logs } = reaper(b, AT + 1_000, { deleteEnabled: true })
    const summary = await instance.sweep()

    expect(summary).toMatchObject({ orphaned: 4, deleted: 4, failed: 0, agentGone: 4 })
    expect(logs.at(-1)).not.toContain('(dry run)')
    // Only the forgotten agent's rows are gone; the live agent's four survive untouched.
    expect(kinds(b.listStoreOrphanCandidates())).toEqual([
      'hook-report:hook-live',
      'session-metadata:acp-live',
      'session-purge:acp-live',
      'webchat-grant:conv-live'
    ])
    a.close() // one database backs the pair
  })

  it('collects a live agent’s row only once nothing has touched it for the horizon', async () => {
    const [a, b] = sharedMembers('member-a', 'member-b')
    seedOutboxes(a, LIVE, 'stale', AT, 'member-a')

    // One millisecond short of the horizon: its owner could still come back for it.
    const early = await reaper(b, AT + DEFAULT_STORE_ORPHAN_HORIZON_MS - 1, { deleteEnabled: true }).instance.sweep()
    expect(early).toMatchObject({ orphaned: 0, deleted: 0, skippedLive: 4 })
    expect(b.listStoreOrphanCandidates()).toHaveLength(4)

    const late = await reaper(b, AT + DEFAULT_STORE_ORPHAN_HORIZON_MS, { deleteEnabled: true }).instance.sweep()
    expect(late).toMatchObject({ orphaned: 4, deleted: 4, agentGone: 0, horizon: 4 })
    expect(b.listStoreOrphanCandidates()).toEqual([])
    a.close() // one database backs the pair
  })

  it('leaves a row its owner claimed between the read and the delete', async () => {
    const [a, b] = sharedMembers('member-a', 'member-b')
    seedOutboxes(a, GONE, 'gone', AT, 'member-a')
    const stale = b.listStoreOrphanCandidates().find((row) => row.kind === 'session-purge')!

    // The owner renews its claim after the reaper listed the row: the CAS on the clock misses.
    expect(a.claimSessionPurges(GONE, ['acp-gone'], 'member-a', AT + 5_000)).toEqual(['acp-gone'])

    expect(b.deleteStoreOrphan(stale)).toBe(false)
    expect(b.listSessionPurges(10, AT + 5_000, 'member-a')).toHaveLength(1)
    a.close() // one database backs the pair
  })

  it('sweeps nothing on a local single-daemon store — its rows are its own', async () => {
    const solo = pg ? openPostgresLocalStore() : new LocalStore({ database: new DatabaseSync(':memory:') as never })
    seedOutboxes(solo, GONE, 'gone', AT, 'member-a')

    const { instance, cp, logs } = reaper(solo, AT + DEFAULT_STORE_ORPHAN_HORIZON_MS * 2, { deleteEnabled: true })
    const summary = await instance.sweep()

    expect(summary).toMatchObject({ candidates: 0, orphaned: 0, deleted: 0 })
    expect(cp.asked).toEqual([]) // the control plane is never even asked
    expect(logs.at(-1)).toContain('not a shared pool store')
    expect(solo.listStoreOrphanCandidates()).toHaveLength(4)
    solo.close()
  })

  it('fails the sweep rather than reading an unanswerable question as "these agents are gone"', async () => {
    const [a, b] = sharedMembers('member-a', 'member-b')
    seedOutboxes(a, GONE, 'gone', AT, 'member-a')

    const instance = new StoreOrphanReaper({
      store: b,
      liveAgents: async () => {
        throw new Error('control-plane connection closed')
      },
      settings: { horizonMs: DEFAULT_STORE_ORPHAN_HORIZON_MS, deleteEnabled: true },
      log: { info: () => undefined, warn: () => undefined }
    })

    expect(await instance.sweep()).toBeUndefined()
    expect(b.listStoreOrphanCandidates()).toHaveLength(4)
    a.close() // one database backs the pair
  })

  it('reads the horizon and the deletion switch from the deployment env', () => {
    expect(resolveStoreOrphanReaperSettings({})).toEqual({
      horizonMs: DEFAULT_STORE_ORPHAN_HORIZON_MS,
      deleteEnabled: false
    })
    expect(
      resolveStoreOrphanReaperSettings({ [STORE_ORPHAN_HORIZON_ENV]: '60000', [STORE_ORPHAN_DELETE_ENV]: 'TRUE' })
    ).toEqual({ horizonMs: 60_000, deleteEnabled: true })
    expect(() => resolveStoreOrphanReaperSettings({ [STORE_ORPHAN_HORIZON_ENV]: '-1' })).toThrow(
      STORE_ORPHAN_HORIZON_ENV
    )
  })
})
