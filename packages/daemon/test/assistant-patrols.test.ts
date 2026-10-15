// A follow-up's check state, its check log and its row of the sub-session index (assistant-mode.md §5.12): one contract suite, on SQLite and on PostgreSQL.
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import pg from 'pg'
import { afterEach, describe, expect, it } from 'vitest'
import { patrolCoordinate, subsessionCoordinate } from '../src/session/subsession-coordinate.js'
import { ASSISTANT_CHECKS_KEPT, PATROL_MAX_FAILURES, patrolBackoffMs } from '../src/store/assistant-patrols.js'
import { LocalStore, SCHEMA_VERSION, sessionKey } from '../src/store/local-store.js'
import { PostgresAsyncDatabase } from '../src/store/postgres-async-database.js'
import { openTestStore, tempStorePath, usingPostgresStore } from './store-support.js'

let store: LocalStore | undefined
afterEach(async () => {
  await store?.close()
  store = undefined
})

async function open(): Promise<LocalStore> {
  store = await openTestStore()
  return store
}

/** A fresh agent id per case: the pool store is shared by every suite of a worker. */
const agent = (): string => `agent-${randomUUID()}`
const ORIGIN = { platform: 'slack', channel: 'C0GENERAL', transportScope: 'T0EXAMPLE' }
const MINUTE = 60_000

const key = (agentId: string, id: string, thread = patrolCoordinate(id)): string =>
  sessionKey('slack', 'C0GENERAL', thread, agentId, 'T0EXAMPLE')

async function item(s: LocalStore, agentId: string, nextCheck: number | undefined, status?: 'waiting' | 'done') {
  return await s.assistantItems.create({
    agentId,
    title: 'Watch the release',
    doneWhen: 'It is out',
    ...(nextCheck !== undefined ? { nextCheck } : {}),
    ...(status ? { status } : {}),
    origin: ORIGIN,
    taskKey: key(agentId, randomUUID()),
    now: 1
  })
}

/** A check of the follow-up starts at `now`: scheduled for `nextCheck`, or messaged when that is null. */
const begin = (
  s: LocalStore,
  agentId: string,
  it1: { id: string; taskKey: string },
  now: number,
  over: { nextCheck?: number | null; observationVersion?: number; staleBefore?: number; exclusive?: boolean } = {}
) =>
  s.assistantPatrols.begin(agentId, it1.id, {
    key: it1.taskKey,
    nextCheck: over.nextCheck ?? null,
    observationVersion: over.observationVersion ?? 0,
    input: null,
    now,
    staleBefore: over.staleBefore ?? 0,
    exclusive: over.exclusive ?? false
  })

const row = (agentId: string, id: string, now: number, thread?: string) => ({
  agentId,
  childSessionKey: key(agentId, id, thread),
  parentSessionId: 'sid-parent-1',
  parentSessionKey: sessionKey('slack', 'C0GENERAL', 'append:1', agentId, 'T0EXAMPLE'),
  now
})

describe('the check state', () => {
  it('finds open follow-ups whose next check is due, earliest first, and nothing else', async () => {
    const s = await open()
    const a = agent()
    const later = await item(s, a, 2_000)
    const first = await item(s, a, 500)
    await item(s, a, 9_000)
    await item(s, a, undefined)
    await item(s, a, 100, 'done')
    const waiting = await item(s, a, 700, 'waiting')
    const checking = await item(s, a, 600)
    await begin(s, a, checking, 1_000)
    await item(s, agent(), 100)
    expect(await s.assistantPatrols.due(a, 5_000, 10)).toEqual([
      { itemId: first.id, nextCheck: 500 },
      { itemId: waiting.id, nextCheck: 700 },
      { itemId: later.id, nextCheck: 2_000 }
    ])
    expect(await s.assistantPatrols.due(a, 5_000, 1)).toEqual([{ itemId: first.id, nextCheck: 500 }])
    // A check running since before the stale bound no longer holds its follow-up back.
    expect(await s.assistantPatrols.due(a, 5_000, 10, 1_001)).toContainEqual({ itemId: checking.id, nextCheck: 600 })
  })

  it('checks one next check once, and the next value again, in the follow-up’s one session', async () => {
    const s = await open()
    const a = agent()
    const it1 = await item(s, a, 1_000)
    expect(await begin(s, a, it1, 2_000, { nextCheck: 1_000 })).toEqual({ checkNo: 1, messages: null })
    expect(await s.assistantPatrols.byRunningKey(a, it1.taskKey)).toMatchObject({
      itemId: it1.id,
      runningNextCheck: 1_000,
      runningCheck: 1,
      runningSince: 2_000
    })
    expect(await s.assistantPatrols.succeed(a, it1.id, it1.taskKey, 3_000)).toBe(true)
    expect(await s.assistantPatrols.byRunningKey(a, it1.taskKey)).toBeUndefined()
    expect(await s.assistantPatrols.due(a, 10_000, 10)).toEqual([])
    // An overdue check is taken once however late it is.
    expect(await s.assistantPatrols.due(a, 10_000_000, 10)).toEqual([])
    await s.assistantItems.schedule(a, it1.id, { status: 'active', nextCheck: 4_000 })
    expect(await s.assistantPatrols.due(a, 10_000, 10)).toEqual([{ itemId: it1.id, nextCheck: 4_000 }])
    // A messaged check leaves the scheduled one due.
    expect(await begin(s, a, it1, 5_000)).toEqual({ checkNo: 2, messages: null })
    await s.assistantPatrols.succeed(a, it1.id, it1.taskKey, 5_500)
    expect(await s.assistantPatrols.due(a, 10_000, 10)).toEqual([{ itemId: it1.id, nextCheck: 4_000 }])
  })

  it('backs off min(60, 2ⁿ) minutes after each failure and stops at the fifth until it is messaged', async () => {
    expect([1, 2, 3, 4, 5, 6, 7].map((n) => patrolBackoffMs(n) / MINUTE)).toEqual([2, 4, 8, 16, 32, 60, 60])
    const s = await open()
    const a = agent()
    const it1 = await item(s, a, 1_000)
    let now = 2_000
    for (let n = 1; n <= PATROL_MAX_FAILURES; n++) {
      expect(await s.assistantPatrols.due(a, now, 10)).toEqual([{ itemId: it1.id, nextCheck: 1_000 }])
      await begin(s, a, it1, now, { nextCheck: 1_000 })
      const failed = await s.assistantPatrols.fail(a, it1.id, it1.taskKey, now, 1_000)
      expect(failed).toEqual({ failures: n, stopped: n === PATROL_MAX_FAILURES })
      expect(await s.assistantPatrols.due(a, now + patrolBackoffMs(n) - 1, 10)).toEqual([])
      now += patrolBackoffMs(n)
    }
    expect(await s.assistantPatrols.get(a, it1.id)).toMatchObject({ stopped: true })
    expect(await s.assistantPatrols.due(a, now + 10 * 60 * MINUTE, 10)).toEqual([])
    // A new next check does not resume it; a message's check does, with a fresh streak.
    await s.assistantItems.schedule(a, it1.id, { status: 'active', nextCheck: 3_000 })
    expect(await s.assistantPatrols.due(a, now, 10)).toEqual([])
    await begin(s, a, it1, now)
    expect(await s.assistantPatrols.get(a, it1.id)).toMatchObject({ stopped: false, failures: 0 })
  })

  it('keeps the check’s observation baseline and report in the store until it ends', async () => {
    const s = await open()
    const a = agent()
    const it1 = await item(s, a, 1_000)
    await begin(s, a, it1, 2_000, { nextCheck: 1_000, observationVersion: 3 })
    expect(await s.assistantPatrols.keepReport(a, it1.id, it1.taskKey, 'It shipped.', 2_500)).toBe(true)
    expect(await s.assistantPatrols.keepReport(a, it1.id, key(a, 'other'), 'Not this check.', 2_500)).toBe(false)
    expect(await s.assistantPatrols.byRunningKey(a, it1.taskKey)).toMatchObject({
      runningObservationVersion: 3,
      runningReport: 'It shipped.'
    })
    await s.assistantPatrols.fail(a, it1.id, it1.taskKey, 3_000, 1_000)
    expect(await s.assistantPatrols.get(a, it1.id)).toMatchObject({
      runningKey: null,
      runningObservationVersion: null,
      runningReport: null,
      runningCheck: null,
      runningSince: null
    })
    // The next check starts with no report of the last one.
    await begin(s, a, it1, 4_000, { nextCheck: 1_000, observationVersion: 4 })
    expect(await s.assistantPatrols.byRunningKey(a, it1.taskKey)).toMatchObject({
      runningObservationVersion: 4,
      runningReport: null,
      runningCheck: 2
    })
  })

  it('runs one check of a follow-up at a time, a scheduled one only while none of the agent’s runs', async () => {
    const s = await open()
    const [a, b] = [agent(), agent()]
    const it1 = await item(s, a, 1_000)
    const it2 = await item(s, a, 1_000)
    const theirs = await item(s, b, 1_000)
    expect(await begin(s, a, it1, 2_000, { nextCheck: 1_000, exclusive: true })).toBeDefined()
    expect(await begin(s, a, it1, 2_100)).toBeUndefined()
    // The agent's one scheduled check is taken; a messaged check of another follow-up still starts.
    expect(await begin(s, a, it2, 2_200, { nextCheck: 1_000, exclusive: true })).toBeUndefined()
    expect(await begin(s, b, theirs, 2_200, { nextCheck: 1_000, exclusive: true })).toBeDefined()
    expect(await begin(s, a, it2, 2_300)).toBeDefined()
    await s.assistantPatrols.release(a, it2.id, it2.taskKey, 2_400)
    // A check older than the stale bound no longer holds anything, and ends in the log as it was.
    expect(await begin(s, a, it2, 3_000, { nextCheck: 1_000, exclusive: true, staleBefore: 2_001 })).toBeDefined()
    expect(await begin(s, a, it1, 3_100, { staleBefore: 2_001 })).toEqual({ checkNo: 2, messages: null })
    expect((await s.assistantPatrols.checks(a, it1.id, 10)).map((c) => [c.checkNo, c.endedAt])).toEqual([
      [2, null],
      [1, 3_100]
    ])
  })

  it('logs each check, keeps the newest, and counts the agent’s for its budget', async () => {
    const s = await open()
    const [a, b] = [agent(), agent()]
    const it1 = await item(s, a, 1_000)
    for (let n = 1; n <= ASSISTANT_CHECKS_KEPT + 2; n++) {
      const begun = await begin(s, a, it1, n * 1_000)
      await s.assistantPatrols.endCheck(a, it1.id, begun!.checkNo, {
        observation: `seen ${n}`,
        reported: n % 2 === 0,
        now: n * 1_000 + 1
      })
      await s.assistantPatrols.succeed(a, it1.id, it1.taskKey, n * 1_000 + 1)
    }
    const checks = await s.assistantPatrols.checks(a, it1.id, 100)
    expect(checks).toHaveLength(ASSISTANT_CHECKS_KEPT)
    expect(checks[0]).toEqual({
      itemId: it1.id,
      checkNo: ASSISTANT_CHECKS_KEPT + 2,
      startedAt: (ASSISTANT_CHECKS_KEPT + 2) * 1_000,
      endedAt: (ASSISTANT_CHECKS_KEPT + 2) * 1_000 + 1,
      observation: `seen ${ASSISTANT_CHECKS_KEPT + 2}`,
      reported: true
    })
    expect(checks.at(-1)?.checkNo).toBe(3)
    await begin(s, b, await item(s, b, 1_000), 50_000)
    expect(await s.assistantPatrols.checksSince(a, 50_000)).toEqual({ count: 3, oldest: 50_000 })
    expect(await s.assistantPatrols.checksSince(a, 999_999)).toEqual({ count: 0, oldest: null })
    // A released check says nothing, and leaves the log and the budget.
    const begun = await begin(s, a, it1, 60_000)
    await s.assistantPatrols.release(a, it1.id, it1.taskKey, 60_001)
    expect((await s.assistantPatrols.checks(a, it1.id, 1))[0]?.checkNo).not.toBe(begun!.checkNo)
    expect((await s.assistantPatrols.checksSince(a, 50_000)).count).toBe(3)
  })

  it('keeps messages for the next check, which takes them all', async () => {
    const s = await open()
    const a = agent()
    const it1 = await item(s, a, undefined, 'waiting')
    const closed = await item(s, a, undefined, 'done')
    await s.assistantPatrols.setPendingMessages(a, it1.id, '["one"]', 1_000)
    await s.assistantPatrols.setPendingMessages(a, closed.id, '["gone"]', 1_000)
    expect(await s.assistantPatrols.withPendingMessages(a, 2_000, 10)).toEqual([it1.id])
    await begin(s, a, it1, 2_000)
    expect(await s.assistantPatrols.withPendingMessages(a, 2_000, 10)).toEqual([])
    await s.assistantPatrols.setPendingMessages(a, it1.id, '["two"]', 2_100)
    // Waiting while a check runs, and while it backs off after a failure.
    expect(await s.assistantPatrols.withPendingMessages(a, 2_200, 10)).toEqual([])
    await s.assistantPatrols.fail(a, it1.id, it1.taskKey, 3_000, null)
    expect(await s.assistantPatrols.withPendingMessages(a, 3_000, 10)).toEqual([])
    expect(await s.assistantPatrols.withPendingMessages(a, 3_000 + patrolBackoffMs(1), 10)).toEqual([it1.id])
    expect(await begin(s, a, it1, 9_000_000)).toEqual({ checkNo: 2, messages: '["two"]' })
    expect((await s.assistantPatrols.get(a, it1.id))?.pendingMessages).toBeNull()
  })

  it('lets only the check in flight settle the follow-up, and a release leaves the check due', async () => {
    const s = await open()
    const a = agent()
    const it1 = await item(s, a, 1_000)
    await begin(s, a, it1, 2_000, { nextCheck: 1_000 })
    expect(await s.assistantPatrols.succeed(a, it1.id, key(a, 'old'), 4_000)).toBe(false)
    expect(await s.assistantPatrols.fail(a, it1.id, key(a, 'old'), 4_000, 1_000)).toBeUndefined()
    await s.assistantPatrols.release(a, it1.id, it1.taskKey, 4_000)
    expect(await s.assistantPatrols.get(a, it1.id)).toMatchObject({ runningKey: null, failures: 0 })
    expect(await s.assistantPatrols.due(a, 5_000, 10)).toEqual([{ itemId: it1.id, nextCheck: 1_000 }])
    await s.assistantPatrols.skip(a, it1.id, 1_000, 5_000)
    expect(await s.assistantPatrols.due(a, 5_000, 10)).toEqual([])
  })
})

describe('a follow-up’s row of the sub-session index', () => {
  it('is idle until a check runs, and never counts toward the delegation cap', async () => {
    const s = await open()
    const a = agent()
    expect(await s.assistantSubsessions.openFollowUp(row(a, '1', 1_000))).toBe(true)
    expect(await s.assistantSubsessions.openFollowUp(row(a, '1', 2_000))).toBe(false)
    expect(await s.assistantSubsessions.get(a, key(a, '1'))).toMatchObject({ state: 'done', kind: 'patrol' })
    await s.assistantSubsessions.checking(a, key(a, '1'))
    expect(await s.assistantSubsessions.get(a, key(a, '1'))).toMatchObject({ state: 'open', createdAt: 1_000 })
    // A running check takes none of the delegations' places.
    const cap = { limit: 1, startedSince: 0 }
    const delegation = row(a, 'd1', 1_000, subsessionCoordinate('d1'))
    expect(await s.assistantSubsessions.openWithinLimit(delegation, cap)).toBe(true)
    expect(await s.assistantSubsessions.get(a, delegation.childSessionKey)).not.toHaveProperty('kind')
    expect(await s.assistantSubsessions.openWithinLimit(row(a, 'd2', 1_000, subsessionCoordinate('d2')), cap)).toBe(
      false
    )
    // A delegation's row is never turned into a check.
    await s.assistantSubsessions.finish(a, delegation.childSessionKey, 'done')
    await s.assistantSubsessions.checking(a, delegation.childSessionKey)
    expect(await s.assistantSubsessions.get(a, delegation.childSessionKey)).toMatchObject({ state: 'done' })
  })

  it('names its place’s current long session once that session takes it over', async () => {
    const s = await open()
    const a = agent()
    const mine = await item(s, a, undefined)
    const elsewhere = await s.assistantItems.create({
      agentId: a,
      title: 'Elsewhere',
      origin: { ...ORIGIN, channel: 'C0OTHER' },
      taskKey: sessionKey('slack', 'C0OTHER', patrolCoordinate('x'), a, 'T0EXAMPLE')
    })
    for (const followUp of [mine, elsewhere])
      await s.assistantSubsessions.openFollowUp({ ...row(a, 'x', 1_000), childSessionKey: followUp.taskKey })
    const owner = { sessionId: 'sid-current', key: sessionKey('slack', 'C0GENERAL', 'append:2', a, 'T0EXAMPLE') }
    await s.assistantSubsessions.adoptFollowUps(a, ORIGIN, owner)
    expect(await s.assistantSubsessions.get(a, mine.taskKey)).toMatchObject({
      parentSessionId: 'sid-current',
      parentSessionKey: owner.key
    })
    expect(await s.assistantSubsessions.get(a, elsewhere.taskKey)).toMatchObject({ parentSessionId: 'sid-parent-1' })
  })
})

describe('the place a follow-up belongs to', () => {
  it('is the append session in force, else the place’s only session', async () => {
    const s = await open()
    const a = agent()
    const session = (channel: string, thread: string) => ({
      key: sessionKey('slack', channel, thread, a, 'T0EXAMPLE'),
      agentId: a,
      platform: 'slack',
      channel,
      thread,
      transportScope: 'T0EXAMPLE',
      acpSessionId: null,
      state: 'idle' as const,
      lastDeliveredTs: null,
      updatedAt: 1
    })
    const coordinate = await s.resolveAppendCoordinate(a, 'C1', 'T0EXAMPLE', 1)
    expect(await s.placeSession(a, 'slack', 'C1', 'T0EXAMPLE')).toBeUndefined()
    await s.upsertSession(session('C1', coordinate))
    await s.upsertSession(session('C1', '100.1'))
    expect((await s.placeSession(a, 'slack', 'C1', 'T0EXAMPLE'))?.thread).toBe(coordinate)
    // No append session: one session is the place's, several threads are not one conversation.
    await s.upsertSession(session('D1', 'webchat:D1'))
    await s.upsertSession(session('D1', patrolCoordinate('1')))
    expect((await s.placeSession(a, 'slack', 'D1', 'T0EXAMPLE'))?.thread).toBe('webchat:D1')
    await s.upsertSession(session('C2', '100.1'))
    await s.upsertSession(session('C2', '100.2'))
    expect(await s.placeSession(a, 'slack', 'C2', 'T0EXAMPLE')).toBeUndefined()
    expect(await s.placeSession(a, 'slack', 'C3', 'T0EXAMPLE')).toBeUndefined()
  })
})

describe.skipIf(usingPostgresStore())('the v38 → v39 patrol schema on SQLite', () => {
  it('marks the existing sub-sessions as delegations and adds the patrol state', async () => {
    expect(SCHEMA_VERSION).toBe(53)
    const path = tempStorePath('ac-assistant-v38-')
    await (await LocalStore.open(path)).close()
    const a = agent()
    const old = new DatabaseSync(path)
    old.exec('ALTER TABLE assistant_subsession DROP COLUMN kind; DROP TABLE assistant_patrol; PRAGMA user_version = 38')
    old
      .prepare(
        `INSERT INTO assistant_subsession (agentId, childSessionKey, parentSessionId, parentSessionKey, state, createdAt)
         VALUES (?, ?, 'sid-parent-1', 'parent', 'open', 1000)`
      )
      .run(a, key(a, 'd', subsessionCoordinate('d')))
    old.close()

    const upgraded = await LocalStore.open(path)
    try {
      const delegation = await upgraded.assistantSubsessions.get(a, key(a, 'd', subsessionCoordinate('d')))
      expect(delegation).toMatchObject({ state: 'open' })
      expect(delegation).not.toHaveProperty('kind')
      // The old row still counts toward the cap, and no patrol is in its way.
      expect(
        await upgraded.assistantSubsessions.openWithinLimit(row(a, 'd2', 1_000, subsessionCoordinate('d2')), {
          limit: 1,
          startedSince: 0
        })
      ).toBe(false)
      expect(await upgraded.assistantSubsessions.openFollowUp(row(a, 'p', 1_000))).toBe(true)
      const it1 = await item(upgraded, a, 500)
      expect(await upgraded.assistantPatrols.due(a, 1_000, 10)).toEqual([{ itemId: it1.id, nextCheck: 500 }])
      await begin(upgraded, a, it1, 1_000, { nextCheck: 500 })
      expect(await upgraded.assistantPatrols.keepReport(a, it1.id, it1.taskKey, 'It shipped.', 1_000)).toBe(true)
      expect(await upgraded.assistantPatrols.byRunningKey(a, it1.taskKey)).toMatchObject({
        runningObservationVersion: 0,
        runningReport: 'It shipped.'
      })
    } finally {
      await upgraded.close()
    }
    const db = new DatabaseSync(path)
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION)
    db.close()
  })

  it('adds the column to a store that skipped v38 straight to the current schema', async () => {
    const path = tempStorePath('ac-assistant-v37p-')
    await (await LocalStore.open(path)).close()
    const old = new DatabaseSync(path)
    old.exec('DROP TABLE assistant_subsession; DROP TABLE assistant_patrol; PRAGMA user_version = 37')
    old.close()
    const upgraded = await LocalStore.open(path)
    const a = agent()
    try {
      expect(await upgraded.assistantSubsessions.openFollowUp(row(a, 'p', 1_000))).toBe(true)
      expect(await upgraded.assistantSubsessions.get(a, key(a, 'p'))).toMatchObject({ kind: 'patrol' })
    } finally {
      await upgraded.close()
    }
  })
})

describe.skipIf(!usingPostgresStore())('the v38 → v39 patrol schema on PostgreSQL', () => {
  it('marks the existing sub-sessions as delegations and adds the patrol state', async () => {
    const databaseUrl = process.env.DATA_PLANE_TEST_DATABASE_URL!
    const schema = `mig_${randomUUID().replace(/-/g, '')}`
    const config = { version: 1 as const, databaseUrl, maxConnections: 2 }
    const orgForAgent = (): string => 'org-a'
    const admin = new pg.Client({ connectionString: databaseUrl })
    await admin.connect()
    const a = agent()
    try {
      const fresh = await PostgresAsyncDatabase.open(config, () => undefined, schema)
      await fresh.finishSchemaInitialization()
      const first = await LocalStore.open({ database: fresh, shared: true, ownerId: 'm1', orgForAgent })
      await first.close()

      await admin.query(`SET search_path TO ${schema}`)
      await admin.query('ALTER TABLE assistant_subsession DROP COLUMN kind')
      await admin.query('DROP TABLE assistant_patrol')
      await admin.query(
        `INSERT INTO assistant_subsession (agentId, childSessionKey, parentSessionId, parentSessionKey, state, createdAt)
         VALUES ($1, $2, 'sid-parent-1', 'parent', 'open', 1000)`,
        [a, key(a, 'd', subsessionCoordinate('d'))]
      )
      await admin.query('UPDATE _local_store_schema_version SET version = 38 WHERE singleton = true')

      const database = await PostgresAsyncDatabase.open(config, () => undefined, schema)
      await database.finishSchemaInitialization()
      const upgraded = await LocalStore.open({ database, shared: true, ownerId: 'm2', orgForAgent })
      try {
        expect(await upgraded.assistantSubsessions.get(a, key(a, 'd', subsessionCoordinate('d')))).not.toHaveProperty(
          'kind'
        )
        expect(
          await upgraded.assistantSubsessions.openWithinLimit(row(a, 'd2', 1_000, subsessionCoordinate('d2')), {
            limit: 1,
            startedSince: 0
          })
        ).toBe(false)
        expect(await upgraded.assistantSubsessions.openFollowUp(row(a, 'p', 1_000))).toBe(true)
        const it1 = await item(upgraded, a, 500)
        await begin(upgraded, a, it1, 1_000, { nextCheck: 500 })
        expect(await upgraded.assistantPatrols.keepReport(a, it1.id, it1.taskKey, 'It shipped.', 1_000)).toBe(true)
        expect(await upgraded.assistantPatrols.byRunningKey(a, it1.taskKey)).toMatchObject({
          itemId: it1.id,
          runningNextCheck: 500,
          runningObservationVersion: 0,
          runningReport: 'It shipped.'
        })
      } finally {
        await upgraded.close()
      }
      const version = await admin.query('SELECT version FROM _local_store_schema_version')
      expect(Number(version.rows[0].version)).toBe(SCHEMA_VERSION)
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined)
      await admin.end()
    }
  })
})
