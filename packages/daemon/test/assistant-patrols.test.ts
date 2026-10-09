// Patrol state and patrol rows of the sub-session index (assistant-mode.md §5.9): one contract suite, on SQLite and on PostgreSQL.
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import pg from 'pg'
import { afterEach, describe, expect, it } from 'vitest'
import { patrolCoordinate, subsessionCoordinate } from '../src/session/subsession-coordinate.js'
import { PATROL_MAX_FAILURES, patrolBackoffMs } from '../src/store/assistant-patrols.js'
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

async function item(s: LocalStore, agentId: string, nextCheck: number | undefined, status?: 'waiting' | 'done') {
  return await s.assistantItems.create({
    agentId,
    title: 'Watch the release',
    doneWhen: 'It is out',
    ...(nextCheck !== undefined ? { nextCheck } : {}),
    ...(status ? { status } : {}),
    origin: ORIGIN,
    now: 1
  })
}

const key = (agentId: string, id: string, thread = patrolCoordinate(id)): string =>
  sessionKey('slack', 'C0GENERAL', thread, agentId, 'T0EXAMPLE')

const row = (agentId: string, id: string, now: number, thread?: string) => ({
  agentId,
  childSessionKey: key(agentId, id, thread),
  parentSessionId: 'sid-parent-1',
  parentSessionKey: sessionKey('slack', 'C0GENERAL', 'append:1', agentId, 'T0EXAMPLE'),
  now
})

describe('the patrol state', () => {
  it('finds open items whose next check is due, earliest first, and nothing else', async () => {
    const s = await open()
    const a = agent()
    const later = await item(s, a, 2_000)
    const first = await item(s, a, 500)
    await item(s, a, 9_000)
    await item(s, a, undefined)
    await item(s, a, 100, 'done')
    const waiting = await item(s, a, 700, 'waiting')
    await item(s, agent(), 100)
    expect(await s.assistantPatrols.due(a, 5_000, 10)).toEqual([
      { itemId: first.id, nextCheck: 500 },
      { itemId: waiting.id, nextCheck: 700 },
      { itemId: later.id, nextCheck: 2_000 }
    ])
    expect(await s.assistantPatrols.due(a, 5_000, 1)).toEqual([{ itemId: first.id, nextCheck: 500 }])
  })

  it('patrols one next check once, and the next value again', async () => {
    const s = await open()
    const a = agent()
    const it1 = await item(s, a, 1_000)
    await s.assistantPatrols.begin(a, it1.id, { key: key(a, '1'), nextCheck: 1_000, observationVersion: 0, now: 2_000 })
    expect(await s.assistantPatrols.byRunningKey(a, key(a, '1'))).toMatchObject({
      itemId: it1.id,
      runningNextCheck: 1_000
    })
    expect(await s.assistantPatrols.succeed(a, it1.id, key(a, '1'), 3_000)).toBe(true)
    expect(await s.assistantPatrols.byRunningKey(a, key(a, '1'))).toBeUndefined()
    expect(await s.assistantPatrols.due(a, 10_000, 10)).toEqual([])
    // An overdue check is patrolled once however late it is.
    expect(await s.assistantPatrols.due(a, 10_000_000, 10)).toEqual([])
    await s.assistantItems.transition(a, it1.id, 1, { nextCheck: 4_000 })
    expect(await s.assistantPatrols.due(a, 10_000, 10)).toEqual([{ itemId: it1.id, nextCheck: 4_000 }])
  })

  it('backs off min(60, 2ⁿ) minutes after each failure and stops at the fifth until the next check moves', async () => {
    expect([1, 2, 3, 4, 5, 6, 7].map((n) => patrolBackoffMs(n) / MINUTE)).toEqual([2, 4, 8, 16, 32, 60, 60])
    const s = await open()
    const a = agent()
    const it1 = await item(s, a, 1_000)
    let now = 2_000
    for (let n = 1; n <= PATROL_MAX_FAILURES; n++) {
      expect(await s.assistantPatrols.due(a, now, 10)).toEqual([{ itemId: it1.id, nextCheck: 1_000 }])
      await s.assistantPatrols.begin(a, it1.id, {
        key: key(a, String(n)),
        nextCheck: 1_000,
        observationVersion: 0,
        now
      })
      const failed = await s.assistantPatrols.fail(a, it1.id, key(a, String(n)), now, 1_000)
      expect(failed).toEqual({ failures: n, stopped: n === PATROL_MAX_FAILURES })
      expect(await s.assistantPatrols.due(a, now + patrolBackoffMs(n) - 1, 10)).toEqual([])
      now += patrolBackoffMs(n)
    }
    expect(await s.assistantPatrols.get(a, it1.id)).toMatchObject({ stopped: true, stoppedNextCheck: 1_000 })
    expect(await s.assistantPatrols.due(a, now + 10 * 60 * MINUTE, 10)).toEqual([])
    // A new next check resumes patrols, with a fresh streak.
    await s.assistantItems.transition(a, it1.id, 1, { nextCheck: 3_000 })
    expect(await s.assistantPatrols.due(a, now, 10)).toEqual([{ itemId: it1.id, nextCheck: 3_000 }])
    await s.assistantPatrols.begin(a, it1.id, { key: key(a, 'resumed'), nextCheck: 3_000, observationVersion: 0, now })
    expect(await s.assistantPatrols.get(a, it1.id)).toMatchObject({ stopped: false, failures: 0 })
  })

  it('keeps the run’s observation baseline and report in the store until the run ends', async () => {
    const s = await open()
    const a = agent()
    const it1 = await item(s, a, 1_000)
    await s.assistantPatrols.begin(a, it1.id, { key: key(a, '1'), nextCheck: 1_000, observationVersion: 3, now: 2_000 })
    expect(await s.assistantPatrols.keepReport(a, it1.id, key(a, '1'), 'It shipped.', 2_500)).toBe(true)
    expect(await s.assistantPatrols.keepReport(a, it1.id, key(a, 'other'), 'Not this run.', 2_500)).toBe(false)
    expect(await s.assistantPatrols.byRunningKey(a, key(a, '1'))).toMatchObject({
      runningObservationVersion: 3,
      runningReport: 'It shipped.'
    })
    await s.assistantPatrols.fail(a, it1.id, key(a, '1'), 3_000, 1_000)
    expect(await s.assistantPatrols.get(a, it1.id)).toMatchObject({
      runningKey: null,
      runningObservationVersion: null,
      runningReport: null
    })
    // A new run starts with no report of the last one.
    await s.assistantPatrols.begin(a, it1.id, { key: key(a, '2'), nextCheck: 1_000, observationVersion: 4, now: 4_000 })
    expect(await s.assistantPatrols.byRunningKey(a, key(a, '2'))).toMatchObject({
      runningObservationVersion: 4,
      runningReport: null
    })
  })

  it('lets only the run in flight settle the item, and a release leaves the check due', async () => {
    const s = await open()
    const a = agent()
    const it1 = await item(s, a, 1_000)
    await s.assistantPatrols.begin(a, it1.id, {
      key: key(a, 'old'),
      nextCheck: 1_000,
      observationVersion: 0,
      now: 2_000
    })
    await s.assistantPatrols.begin(a, it1.id, {
      key: key(a, 'new'),
      nextCheck: 1_000,
      observationVersion: 0,
      now: 3_000
    })
    expect(await s.assistantPatrols.succeed(a, it1.id, key(a, 'old'), 4_000)).toBe(false)
    expect(await s.assistantPatrols.fail(a, it1.id, key(a, 'old'), 4_000, 1_000)).toBeUndefined()
    await s.assistantPatrols.release(a, it1.id, key(a, 'new'), 4_000)
    expect(await s.assistantPatrols.get(a, it1.id)).toMatchObject({ runningKey: null, failures: 0 })
    expect(await s.assistantPatrols.due(a, 5_000, 10)).toEqual([{ itemId: it1.id, nextCheck: 1_000 }])
    await s.assistantPatrols.skip(a, it1.id, 1_000, 5_000)
    expect(await s.assistantPatrols.due(a, 5_000, 10)).toEqual([])
  })

  it('goes with its item', async () => {
    const s = await open()
    const a = agent()
    const it1 = await item(s, a, 1_000)
    await s.assistantPatrols.begin(a, it1.id, { key: key(a, '1'), nextCheck: 1_000, observationVersion: 0, now: 2_000 })
    expect(await s.assistantItems.delete(a, it1.id)).toBe(true)
    expect(await s.assistantPatrols.get(a, it1.id)).toBeUndefined()
    const it2 = await item(s, a, 1_000)
    await s.assistantPatrols.skip(a, it2.id, 1_000, 2_000)
    await s.assistantItems.deleteForAgent(a)
    expect(await s.assistantPatrols.get(a, it2.id)).toBeUndefined()
  })
})

describe('patrol rows of the sub-session index', () => {
  it('holds one patrol slot per agent and leaves the delegation cap alone', async () => {
    const s = await open()
    const [a, b] = [agent(), agent()]
    const slot = { startedSince: 0, staleBefore: 0 }
    expect(await s.assistantSubsessions.openPatrol(row(a, '1', 1_000), slot)).toBe(true)
    expect(await s.assistantSubsessions.openPatrol(row(a, '2', 1_000), slot)).toBe(false)
    expect(await s.assistantSubsessions.openPatrol(row(b, '1', 1_000), slot)).toBe(true)
    expect(await s.assistantSubsessions.get(a, key(a, '1'))).toMatchObject({ state: 'open', kind: 'patrol' })
    // A running patrol takes none of the delegations' places.
    const cap = { limit: 1, startedSince: 0 }
    const delegation = row(a, 'd1', 1_000, subsessionCoordinate('d1'))
    expect(await s.assistantSubsessions.openWithinLimit(delegation, cap)).toBe(true)
    expect(await s.assistantSubsessions.get(a, delegation.childSessionKey)).not.toHaveProperty('kind')
    expect(await s.assistantSubsessions.openWithinLimit(row(a, 'd2', 1_000, subsessionCoordinate('d2')), cap)).toBe(
      false
    )
    // And a delegation at its cap does not hold back a patrol.
    await s.assistantSubsessions.finish(a, key(a, '1'), 'done')
    expect(await s.assistantSubsessions.openPatrol(row(a, '3', 1_000), slot)).toBe(true)
  })

  it('frees the slot once the patrol is stale, or its session never appeared', async () => {
    const s = await open()
    const a = agent()
    await s.assistantSubsessions.openPatrol(row(a, 'lost', 1_000), { startedSince: 0, staleBefore: 0 })
    expect(await s.assistantSubsessions.openPatrol(row(a, 'x', 2_000), { startedSince: 1_000, staleBefore: 0 })).toBe(
      false
    )
    expect(await s.assistantSubsessions.openPatrol(row(a, 'y', 2_000), { startedSince: 1_001, staleBefore: 0 })).toBe(
      true
    )
    await s.upsertSession({
      key: key(a, 'y'),
      agentId: a,
      platform: 'slack',
      channel: 'C0GENERAL',
      thread: patrolCoordinate('y'),
      transportScope: 'T0EXAMPLE',
      acpSessionId: 'acp-y',
      state: 'prompting',
      lastDeliveredTs: null,
      updatedAt: 2_000
    })
    expect(await s.assistantSubsessions.openPatrol(row(a, 'z', 9_000), { startedSince: 8_000, staleBefore: 0 })).toBe(
      false
    )
    expect(
      await s.assistantSubsessions.openPatrol(row(a, 'z', 9_000), { startedSince: 8_000, staleBefore: 2_001 })
    ).toBe(true)
  })

  it('counts the agent’s patrols since a time, for its budget', async () => {
    const s = await open()
    const [a, b] = [agent(), agent()]
    const slot = { startedSince: Number.MAX_SAFE_INTEGER, staleBefore: Number.MAX_SAFE_INTEGER }
    for (const [id, at] of [
      ['1', 1_000],
      ['2', 2_000],
      ['3', 3_000]
    ] as const)
      await s.assistantSubsessions.openPatrol(row(a, id, at), slot)
    await s.assistantSubsessions.openPatrol(row(b, '1', 3_000), slot)
    await s.assistantSubsessions.openWithinLimit(row(a, 'd', 3_000, subsessionCoordinate('d')), {
      limit: 5,
      startedSince: 0
    })
    expect(await s.assistantSubsessions.countPatrolsSince(a, 2_000)).toBe(2)
    expect(await s.assistantSubsessions.countPatrolsSince(a, 0)).toBe(3)
  })
})

describe('the place a patrol reports into', () => {
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
    expect(SCHEMA_VERSION).toBe(40)
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
      expect(
        await upgraded.assistantSubsessions.openPatrol(row(a, 'p', 1_000), { startedSince: 0, staleBefore: 0 })
      ).toBe(true)
      const it1 = await item(upgraded, a, 500)
      expect(await upgraded.assistantPatrols.due(a, 1_000, 10)).toEqual([{ itemId: it1.id, nextCheck: 500 }])
      await upgraded.assistantPatrols.begin(a, it1.id, {
        key: key(a, 'p'),
        nextCheck: 500,
        observationVersion: 0,
        now: 1_000
      })
      expect(await upgraded.assistantPatrols.keepReport(a, it1.id, key(a, 'p'), 'It shipped.', 1_000)).toBe(true)
      expect(await upgraded.assistantPatrols.byRunningKey(a, key(a, 'p'))).toMatchObject({
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
      expect(
        await upgraded.assistantSubsessions.openPatrol(row(a, 'p', 1_000), { startedSince: 0, staleBefore: 0 })
      ).toBe(true)
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
        expect(
          await upgraded.assistantSubsessions.openPatrol(row(a, 'p', 1_000), { startedSince: 0, staleBefore: 0 })
        ).toBe(true)
        const it1 = await item(upgraded, a, 500)
        await upgraded.assistantPatrols.begin(a, it1.id, {
          key: key(a, 'p'),
          nextCheck: 500,
          observationVersion: 0,
          now: 1_000
        })
        expect(await upgraded.assistantPatrols.keepReport(a, it1.id, key(a, 'p'), 'It shipped.', 1_000)).toBe(true)
        expect(await upgraded.assistantPatrols.byRunningKey(a, key(a, 'p'))).toMatchObject({
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
