/**
 * The store's one retention home: the rule table and the sweep loop that runs it.
 *
 * The cases are about the ENGINE — a rule's clock, its horizon, the owner window, the
 * re-fenced delete, the control-plane proof — plus one pass over the real
 * {@link STORE_RETENTION_RULES} to prove every declared rule executes on both backends.
 * Per-table prune tests are gone with the per-table prunes.
 */
import { describe, expect, it } from 'vitest'
import { LocalStore, sessionKey } from '../src/store/local-store.js'
import {
  DEFAULT_STORE_HORIZON_MS,
  STORE_ORPHAN_DELETE_ENV,
  STORE_RETENTION_RULES,
  STORE_RETENTION_SCALE_ENV,
  StoreRetentionSweeper,
  resolveStoreRetentionSettings,
  type StoreRetentionRule
} from '../src/store/retention.js'
import { memoryStoreDatabase, openTestStore, usingPostgresStore } from './store-support.js'

const pg = usingPostgresStore()
const LIVE = '11111111-1111-4111-8111-111111111111'
const GONE = '22222222-2222-4222-8222-222222222222'
const AT = 1_800_000_000_000
const DAY = 24 * 3_600_000

const oneOrg = () => 'org-1'
const rule = (id: string): StoreRetentionRule => STORE_RETENTION_RULES.find((r) => r.id === id)!

/** Two pool members over one database — what the shared schema is during a rollout. */
async function sharedMembers(first: string, second: string): Promise<[LocalStore, LocalStore]> {
  const database = pg ? undefined : memoryStoreDatabase()
  return [
    await openTestStore({ database, shared: true, ownerId: first, orgForAgent: oneOrg }),
    await openTestStore({ database, shared: true, ownerId: second, orgForAgent: oneOrg })
  ]
}

const solo = async (): Promise<LocalStore> => await openTestStore({ database: pg ? undefined : memoryStoreDatabase() })

/** One row in every table the rule table names, all stamped `at`. */
async function seedEveryTable(s: LocalStore, agentId: string, tag: string, at: number, owner: string): Promise<void> {
  const hookId = `hook-${tag}`
  await s.appendInbox({
    id: hookId,
    sessionKey: sessionKey('hook', 'hook-1', hookId, agentId),
    agentId,
    msg: '{}',
    hookContext: '{}',
    enqueuedAt: String(at)
  })
  expect(await s.completeHookInbox(hookId, JSON.stringify({ id: hookId }), at, owner)).toBe('completed')
  // A born-completed inbox row: the dedup RECEIPT proving a provider delivery was already
  // served. It carries no terminal report, so it ages under its own rule rather than the
  // hook-report one — and nothing else ever drains it.
  await s.appendInbox({
    id: `served-${tag}`,
    sessionKey: sessionKey('linear', 'issue-1', `session-${tag}`, agentId),
    agentId,
    msg: '{}',
    completedAt: at,
    loopGuardCounted: 1,
    enqueuedAt: String(at)
  })
  await s.upsertSession({
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
  await s.deleteSession(tag, { reason: 'retention', at, ownerId: owner })
  // An outward id minted for a key that never becomes a session — the pool's internal dream /
  // memory / commit work, which is exactly what this table's rule ages out.
  await s.ensureOutwardSessionId(`internal:memory:${tag}`, agentId, at)
  // Written after the delete: `deleteSession` drops the session's own outbox snapshot with it.
  await s.saveSessionMetadataSnapshot(agentId, `acp-${tag}`, '{"phase":"end"}', true, at, owner)
  await s.recordWebchatMcpGrant({
    conversationId: `conv-${tag}`,
    agentId,
    authorityId: `auth-${tag}`,
    authorityGeneration: 1,
    now: at
  })
  await s.appendMemoryCapture({
    operationId: `op-${tag}`,
    turnId: `turn-${tag}`,
    agentId,
    connectionId: `conn-${tag}`,
    connectionRevision: 1,
    pluginId: 'mem0',
    config: '{}',
    scopeKey: 'scope',
    input: '',
    output: '',
    payloadHash: 'h',
    payloadBytes: 0,
    idempotency: 'none',
    state: 'completed',
    attempts: 1,
    nextAttemptAt: at,
    createdAt: at,
    updatedAt: at
  })
  await s.claimActivationObservation(
    `act-${tag}`,
    { agentCallDeliveryId: `delivery-${tag}`, platformMessageId: 'm-1', transcriptCoordinates: '{}' },
    at
  )
  // Drive the real lifecycle to a terminal record: an envelope-less claim expires transcript-only.
  expect((await s.expireActivations(at)).transcriptOnly.map((row) => row.activationKey)).toContain(`act-${tag}`)
  await s.recordRuntimeCatalogMeta({ runtimeId: `runtime-${tag}`, fingerprint: 'fp', source: 'acp', observedAt: at })
  await s.upsertRuntimeModelCap({
    runtimeId: `runtime-${tag}`,
    modelId: `model-${tag}`,
    fingerprint: 'fp',
    caps: {},
    observedAt: at
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

function sweeper(
  s: LocalStore,
  now: number,
  opts: {
    rules?: StoreRetentionRule[]
    deleteOrphans?: boolean
    scale?: number
    ownerId?: string
    liveAgents?: (ids: string[]) => Promise<Set<string>>
  } = {}
) {
  const logs: string[] = []
  const instance = new StoreRetentionSweeper({
    store: s,
    ...(opts.rules ? { rules: opts.rules } : {}),
    ...(opts.liveAgents ? { liveAgents: opts.liveAgents } : {}),
    ...(opts.ownerId !== undefined ? { ownerId: opts.ownerId } : {}),
    settings: { scale: opts.scale ?? 1, deleteOrphans: opts.deleteOrphans ?? false },
    clock: { now: () => now } as never,
    log: { info: (m) => logs.push(m), warn: (m) => logs.push(m) }
  })
  return { instance, logs }
}

const remaining = async (s: LocalStore, id: string): Promise<number> =>
  (await s.listRetentionCandidates(rule(id))).length

describe('store retention rule table', () => {
  it('runs every declared rule against the real schema, on either backend', async () => {
    // The point of the table is that a rule is data: this proves each one's clock, key and
    // filter are valid SQL here, and that nothing fresh is collected.
    const s = await solo()
    await seedEveryTable(s, LIVE, 'fresh', AT, 'member-a')

    const { instance } = sweeper(s, AT + 1_000)
    const summary = await instance.sweep()

    expect(summary).toMatchObject({ collected: 0, deleted: 0, failed: 0 })
    expect(summary!.candidates).toBeGreaterThanOrEqual(STORE_RETENTION_RULES.length)
    for (const declared of STORE_RETENTION_RULES) expect(summary!.byRule[declared.id]).toBe(0)
    await s.close()
  })

  it('collects every rule’s row once its own horizon has passed, and reports them per rule', async () => {
    const s = await solo()
    await seedEveryTable(s, LIVE, 'old', AT, 'member-a')

    // Past the 7-day default but short of the 30-day session-purge and catalog windows.
    const { instance, logs } = sweeper(s, AT + DEFAULT_STORE_HORIZON_MS)
    const summary = await instance.sweep()

    expect(summary!.byRule).toMatchObject({
      'hook-report': 1,
      'delivery-receipt': 1,
      'session-metadata': 1,
      'outward-id': 1,
      'webchat-grant': 1,
      'memory-capture': 1,
      activation: 1,
      'session-purge': 0,
      'catalog-meta': 0,
      'catalog-models': 0
    })
    expect(summary).toMatchObject({ horizon: 7, agentGone: 0, deleted: 7, failed: 0 })
    expect(logs.at(-1)).toContain('collected=7 deleted=7')
    expect(await remaining(s, 'hook-report')).toBe(0)
    expect(await remaining(s, 'session-purge')).toBe(1)

    // The 30-day rules follow on their own schedule, from the same table.
    const late = await sweeper(s, AT + 30 * DAY).instance.sweep()
    expect(late!.byRule).toMatchObject({ 'session-purge': 1, 'catalog-meta': 1, 'catalog-models': 1 })
    expect(await remaining(s, 'session-purge')).toBe(0)
    expect(await remaining(s, 'catalog-meta')).toBe(0)
    await s.close()
  })

  it('keeps a row one millisecond short of its horizon, and scales every horizon at once', async () => {
    const s = await solo()
    await seedEveryTable(s, LIVE, 'edge', AT, 'member-a')

    const edge = { rules: [rule('hook-report')] }
    expect(await sweeper(s, AT + DEFAULT_STORE_HORIZON_MS - 1, edge).instance.sweep()).toMatchObject({ collected: 0 })
    expect(await sweeper(s, AT + DEFAULT_STORE_HORIZON_MS, edge).instance.sweep()).toMatchObject({ collected: 1 })

    // scale halves every window, so the 30-day rules come due at 15 days too.
    const scaled = await sweeper(s, AT + 15 * DAY, { scale: 0.5 }).instance.sweep()
    expect(scaled!.byRule).toMatchObject({ 'session-purge': 1, 'catalog-meta': 1 })
    await s.close()
  })

  it('reclaims a departed writer’s cache on the shorter window and keeps its own on the long one', async () => {
    // The only rules with a foreign window: an ownerId dies with the process that minted it.
    const s = await solo()
    await seedEveryTable(s, LIVE, 'mine', AT, 'member-a')

    const own = await sweeper(s, AT + 10 * DAY, { ownerId: s.cacheOwner }).instance.sweep()
    expect(own!.byRule).toMatchObject({ 'catalog-meta': 0, 'catalog-models': 0 })

    const peer = await sweeper(s, AT + 10 * DAY, { ownerId: 'someone-else' }).instance.sweep()
    expect(peer!.byRule).toMatchObject({ 'catalog-meta': 1, 'catalog-models': 1 })
    await s.close()
  })

  it('keeps a refreshed catalog whole, the models discovery found included', async () => {
    // Staleness is per catalog, not per row: a phase-1 refresh re-stamps the meta row and the
    // seed model only, so a row-by-row clock would strip the older model rows while leaving
    // complete/modelsHash standing — a closed gate over a permanently partial matrix.
    const s = await solo()
    await s.recordRuntimeCatalogMeta({ runtimeId: 'claude', fingerprint: 'fp-1', source: 'acp', observedAt: AT })
    await s.upsertRuntimeModelCap({
      runtimeId: 'claude',
      modelId: 'opus',
      fingerprint: 'fp-1',
      caps: {},
      observedAt: AT
    })
    await s.upsertRuntimeModelCap({
      runtimeId: 'claude',
      modelId: 'sonnet',
      fingerprint: 'fp-1',
      caps: {},
      observedAt: AT
    })
    await s.markRuntimeCatalogComplete('claude', 'fp-1', 'hash-1', AT)
    // Only the meta row and the seed model are re-stamped, 20 days later.
    await s.recordRuntimeCatalogMeta({
      runtimeId: 'claude',
      fingerprint: 'fp-1',
      source: 'acp',
      observedAt: AT + 20 * DAY
    })
    await s.upsertRuntimeModelCap({
      runtimeId: 'claude',
      modelId: 'opus',
      fingerprint: 'fp-1',
      caps: {},
      observedAt: AT + 20 * DAY
    })

    // A sweep 31 days after the ORIGINAL write: the untouched `sonnet` row is 31 days old,
    // but its catalog is not, so nothing goes.
    const summary = await sweeper(s, AT + 31 * DAY).instance.sweep()
    expect(summary!.byRule).toMatchObject({ 'catalog-meta': 0, 'catalog-models': 0 })
    expect(await s.getRuntimeCatalogMeta('claude')).toMatchObject({ complete: true, modelsHash: 'hash-1' })
    expect((await s.listRuntimeModelCaps('claude')).map((c) => c.modelId)).toEqual(['opus', 'sonnet'])
    await s.close()
  })

  it('reclaims a departed member’s catalog without touching a live peer’s', async () => {
    const [live, gone] = await sharedMembers('member-live', 'member-gone')
    for (const [member, model] of [
      [live, 'opus'],
      [gone, 'sonnet']
    ] as const) {
      await member.recordRuntimeCatalogMeta({ runtimeId: 'claude', fingerprint: 'fp', source: 'acp', observedAt: AT })
      await member.upsertRuntimeModelCap({
        runtimeId: 'claude',
        modelId: model,
        fingerprint: 'fp',
        caps: {},
        observedAt: AT
      })
    }

    // The live member's own sweep, 10 days on: its rows keep the 30-day window, the peer's do not.
    const summary = await sweeper(live, AT + 10 * DAY, { ownerId: live.cacheOwner }).instance.sweep()

    expect(summary!.byRule).toMatchObject({ 'catalog-meta': 1, 'catalog-models': 1 })
    expect(await live.getRuntimeCatalogMeta('claude')).toMatchObject({ fingerprint: 'fp' })
    expect((await live.listRuntimeModelCaps('claude')).map((c) => c.modelId)).toEqual(['opus'])
    expect(await gone.getRuntimeCatalogMeta('claude')).toBeUndefined()
    expect(await gone.listRuntimeModelCaps()).toEqual([])
    await live.close()
  })

  it('collects a forgotten agent’s rows on the control plane’s answer, in one batched read', async () => {
    const [a, b] = await sharedMembers('member-a', 'member-b')
    await seedEveryTable(a, LIVE, 'live', AT, 'member-a')
    await seedEveryTable(a, GONE, 'gone', AT, 'member-a')
    const cp = fakeCp()

    const { instance, logs } = sweeper(b, AT + 1_000, { liveAgents: cp.liveAgents, deleteOrphans: true })
    const summary = await instance.sweep()

    expect(cp.asked).toEqual([[LIVE, GONE]])
    expect(summary).toMatchObject({ agentGone: 7, horizon: 0, deleted: 7, failed: 0 })
    // Only the rules that name an agent; the agent-free ones are untouched by this proof.
    expect(summary!.byRule).toMatchObject({
      'hook-report': 1,
      'session-metadata': 1,
      'session-purge': 1,
      'webchat-grant': 1,
      'memory-capture': 1,
      activation: 0,
      'catalog-meta': 0
    })
    expect(logs.at(-1)).not.toContain('(orphan dry run)')
    expect(await remaining(b, 'hook-report')).toBe(1) // the live agent's
    await a.close() // one database backs the pair
  })

  it('counts the agent-gone proof without deleting until the deployment turns it on', async () => {
    const [a, b] = await sharedMembers('member-a', 'member-b')
    await seedEveryTable(a, GONE, 'gone', AT, 'member-a')

    const { instance, logs } = sweeper(b, AT + 1_000, { liveAgents: fakeCp().liveAgents })
    const summary = await instance.sweep()

    expect(summary).toMatchObject({ agentGone: 7, collected: 7, deleted: 0 })
    expect(logs.at(-1)).toContain('(orphan dry run)')
    expect(await remaining(b, 'hook-report')).toBe(1)
    await a.close()
  })

  it('sweeps age only when nobody can be asked, so a local store still gets its retention', async () => {
    const s = await solo()
    await seedEveryTable(s, GONE, 'gone', AT, 'member-a')

    // No `liveAgents`: the agent is long deleted, but this sweeper cannot know that.
    const fresh = await sweeper(s, AT + 1_000).instance.sweep()
    expect(fresh).toMatchObject({ agentGone: 0, collected: 0 })

    const aged = await sweeper(s, AT + DEFAULT_STORE_HORIZON_MS).instance.sweep()
    expect(aged).toMatchObject({ agentGone: 0, horizon: 7, deleted: 7 })
    await s.close()
  })

  it('leaves a row whose obligation was renewed between the read and the delete', async () => {
    // The clock rides the DELETE, so a rule whose clock moves on new work is fenced by it:
    // a fresh snapshot re-stamps queuedAt and the stale candidate no longer matches.
    const [a, b] = await sharedMembers('member-a', 'member-b')
    await seedEveryTable(a, LIVE, 'renewed', AT, 'member-a')
    const stale = (await b.listRetentionCandidates(rule('session-metadata')))[0]!

    await a.saveSessionMetadataSnapshot(LIVE, 'acp-renewed', '{"phase":"end"}', true, AT + 5_000, 'member-a')

    expect(await b.deleteRetentionRow(rule('session-metadata'), stale)).toBe(false)
    expect(await b.listRetentionCandidates(rule('session-metadata'))).toHaveLength(1)
    await a.close()
  })

  it('leaves a hook report the owner acknowledged between the read and the delete', async () => {
    // An immutable clock cannot fence, so the rule's own `where` is what does: an ACK nulls
    // the body and the row stops being an outbox entry at all.
    const [a, b] = await sharedMembers('member-a', 'member-b')
    await seedEveryTable(a, LIVE, 'acked', AT, 'member-a')
    const stale = (await b.listRetentionCandidates(rule('hook-report')))[0]!

    expect(await a.acknowledgeHookInbox('hook-acked', { ownerId: 'member-a' })).toBe(true)

    expect(await b.deleteRetentionRow(rule('hook-report'), stale)).toBe(false)
    await a.close()
  })

  it('fails the sweep rather than reading an unanswerable question as "these agents are gone"', async () => {
    const [a, b] = await sharedMembers('member-a', 'member-b')
    await seedEveryTable(a, GONE, 'gone', AT, 'member-a')

    const instance = new StoreRetentionSweeper({
      store: b,
      liveAgents: async () => {
        throw new Error('control-plane connection closed')
      },
      settings: { scale: 1, deleteOrphans: true },
      log: { info: () => undefined, warn: () => undefined }
    })

    expect(await instance.sweep()).toBeUndefined()
    expect(await remaining(b, 'hook-report')).toBe(1)
    await a.close()
  })

  it('counts a failing delete instead of throwing, so one bad rule cannot hide the rest', async () => {
    const s = await solo()
    await seedEveryTable(s, LIVE, 'old', AT, 'member-a')
    const broken = { ...rule('hook-report'), id: 'broken', where: 'no_such_column IS NOT NULL' }

    const { instance } = sweeper(s, AT + DEFAULT_STORE_HORIZON_MS, {
      rules: [{ ...rule('hook-report') }, broken]
    })
    const summary = await instance.sweep()

    // The broken rule's own SELECT throws, which fails the whole sweep — a rule table that
    // cannot be read is a bug to surface, not a partial result to report.
    expect(summary).toBeUndefined()
    await s.close()
  })

  it('ages the work, not the attempt, so a row nobody will ever accept still goes', async () => {
    // A receipt no control plane accepts is re-claimed on EVERY drain. Aging it on the lease
    // would refresh it forever and make exactly the rows retention exists for immortal.
    const [a, b] = await sharedMembers('member-a', 'member-b')
    await seedEveryTable(a, LIVE, 'stuck', AT, 'member-a')

    // 30 days of failed attempts, the last one moments ago.
    await a.claimSessionPurges(LIVE, ['acp-stuck'], 'member-a', AT + 30 * DAY - 1)
    expect(await a.claimHookTerminalReport('hook-stuck', 'member-a', AT + 30 * DAY - 1)).toBe(true)

    const summary = await sweeper(b, AT + 30 * DAY).instance.sweep()

    expect(summary!.byRule).toMatchObject({ 'session-purge': 1, 'hook-report': 1 })
    expect(await remaining(b, 'session-purge')).toBe(0)
    expect(await remaining(b, 'hook-report')).toBe(0)
    await a.close() // one database backs the pair
  })

  it('re-arms a session-metadata row when a NEW snapshot replaces it, because that is new work', async () => {
    const s = await solo()
    await seedEveryTable(s, LIVE, 'live', AT, 'member-a')
    // A fresh snapshot for the same session re-stamps queuedAt: the obligation is new.
    await s.saveSessionMetadataSnapshot(LIVE, 'acp-live', '{"phase":"end"}', true, AT + 6 * DAY, 'member-a')

    const early = { rules: [rule('session-metadata')] }
    expect(await sweeper(s, AT + 7 * DAY, early).instance.sweep()).toMatchObject({ collected: 0 })
    expect(await sweeper(s, AT + 13 * DAY, early).instance.sweep()).toMatchObject({ collected: 1 })
    await s.close()
  })

  it('sweeps synchronously when nobody is asked, which is what startup needs', async () => {
    const s = await solo()
    await seedEveryTable(s, LIVE, 'old', AT, 'member-a')

    const { instance } = sweeper(s, AT + 30 * DAY)
    const summary = await instance.sweepAgeOnly()

    expect(summary).toMatchObject({ agentGone: 0, horizon: 10, deleted: 10, failed: 0 })
    expect(await remaining(s, 'catalog-meta')).toBe(0)
    await s.close()
  })

  it('reads the horizon scale and the orphan switch from the deployment env', async () => {
    expect(resolveStoreRetentionSettings({})).toEqual({ scale: 1, deleteOrphans: false })
    expect(
      resolveStoreRetentionSettings({ [STORE_RETENTION_SCALE_ENV]: '0.5', [STORE_ORPHAN_DELETE_ENV]: 'TRUE' })
    ).toEqual({ scale: 0.5, deleteOrphans: true })
    expect(() => resolveStoreRetentionSettings({ [STORE_RETENTION_SCALE_ENV]: '-1' })).toThrow(
      STORE_RETENTION_SCALE_ENV
    )
  })
})
