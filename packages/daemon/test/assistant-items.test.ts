// The item ledger, which keeps an agent's getting-to-know tasks (assistant-mode.md §5.13), and the migrations that carried its follow-ups into the task store (§5.18): one contract suite, run on SQLite by default and on PostgreSQL by store-postgres.
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import pg from 'pg'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { Daemon } from '../src/daemon.js'
import {
  ASSISTANT_ITEM_OBSERVATIONS_KEPT,
  ASSISTANT_ITEM_SCHEMA,
  type AssistantPlace
} from '../src/store/assistant-items.js'
import { ASSISTANT_CHECK_SCHEMA } from '../src/store/assistant-checks.js'
import { LocalStore, SCHEMA_VERSION, sessionKey } from '../src/store/local-store.js'
import { PostgresAsyncDatabase } from '../src/store/postgres-async-database.js'
import { canonicalColumns, POOL_STORE_SCHEMA } from '../src/store/postgres-dialect.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import { openTestStore, tempStorePath, usingPostgresStore } from './store-support.js'

const AGENT = 'agent-a'
const OTHER_AGENT = 'agent-b'
const GENERAL: AssistantPlace = { platform: 'slack', channel: 'C0GENERAL', transportScope: 'T0EXAMPLE' }
const SHARED: AssistantPlace = { platform: 'slack', channel: 'C0SHARED', transportScope: 'T0EXAMPLE' }
const DM: AssistantPlace = { platform: 'slack', channel: 'D0ALICE', transportScope: 'T0EXAMPLE' }
const WEBCHAT: AssistantPlace = { platform: 'webchat', channel: 'conv-1', transportScope: null }
const ALICE = 'slack:T0EXAMPLE:U0ALICE'

let store: LocalStore | undefined
afterEach(async () => {
  await store?.close()
  store = undefined
})

async function open(): Promise<LocalStore> {
  store = await openTestStore()
  return store
}

const create = (s: LocalStore, overrides: Partial<Parameters<LocalStore['assistantItems']['create']>[0]> = {}) =>
  s.assistantItems.create({
    agentId: AGENT,
    title: 'Ship the release notes',
    origin: GENERAL,
    taskKey: `slack:C0GENERAL:subsession:check-look-${randomUUID()}:${AGENT}:T0EXAMPLE`,
    asker: ALICE,
    gettingToKnow: 'joined',
    now: 1_000,
    ...overrides
  })

/** The one follow-up a migration carried into the task store under this title. */
const migrated = async (s: LocalStore, title: string) =>
  (await s.assistantWatchTasks.list(AGENT)).find((task) => task.title === title)

describe('the item ledger: create and read', () => {
  it('round-trips a record, with an absent transport scope reading back as null', async () => {
    const s = await open()
    const item = await create(s, {
      doneWhen: 'notes are posted',
      nextCheck: 5_000,
      summary: 'Alice asked for the notes.',
      origin: WEBCHAT,
      taskKey: 'webchat:conv-1:subsession:check-look-1:agent-a',
      asker: 'user:u-1',
      shared: false,
      replyThread: '100.1'
    })
    expect(item).toEqual({
      id: expect.any(String),
      agentId: AGENT,
      title: 'Ship the release notes',
      doneWhen: 'notes are posted',
      nextCheck: 5_000,
      status: 'active',
      origin: WEBCHAT,
      taskKey: 'webchat:conv-1:subsession:check-look-1:agent-a',
      asker: 'user:u-1',
      shared: false,
      replyThread: '100.1',
      gettingToKnow: 'joined',
      summary: 'Alice asked for the notes.',
      observations: [],
      observationVersion: 0,
      subsessions: [],
      proposals: [],
      version: 1,
      createdAt: 1_000,
      updatedAt: 1_000,
      changedAt: 1_000
    })
    expect(await s.assistantItems.get(AGENT, item.id)).toEqual(item)
    expect(await s.assistantItems.byTaskKey(AGENT, item.taskKey)).toEqual(item)
    expect(await s.assistantItems.byTaskKey(OTHER_AGENT, item.taskKey)).toBeUndefined()
    expect(await s.assistantItems.byTaskKey(AGENT, '')).toBeUndefined()
  })

  it('is partitioned by agent: another agent cannot read or change the item', async () => {
    const s = await open()
    const item = await create(s)
    expect(await s.assistantItems.get(OTHER_AGENT, item.id)).toBeUndefined()
    expect(await s.assistantItems.list(OTHER_AGENT)).toEqual([])
    expect(await s.assistantItems.appendObservation(OTHER_AGENT, item.id, { text: 'nope' })).toBeUndefined()
    expect(await s.assistantItems.schedule(OTHER_AGENT, item.id, { status: 'done', nextCheck: null })).toBe(false)
    expect(await s.assistantItems.link(OTHER_AGENT, item.id, 'subsession', 'sess-1')).toBe(false)
    expect(await s.assistantItems.get(AGENT, item.id)).toEqual(item)
  })

  it('refuses malformed input before writing anything', async () => {
    const s = await open()
    await expect(create(s, { title: '  ' })).rejects.toThrow('title')
    await expect(create(s, { asker: 'U0ALICE' })).rejects.toThrow('asker')
    await expect(create(s, { taskKey: '' })).rejects.toThrow('taskKey')
    await expect(create(s, { nextCheck: -1 })).rejects.toThrow('nextCheck')
    await expect(create(s, { status: 'paused' as never })).rejects.toThrow('status')
    await expect(create(s, { title: 'x'.repeat(301) })).rejects.toThrow('300')
    expect(await s.assistantItems.list(AGENT)).toEqual([])
  })
})

describe('the item ledger: list', () => {
  it('filters by status and place, newest first', async () => {
    const s = await open()
    const a = await create(s, { title: 'a', now: 1_000 })
    const b = await create(s, { title: 'b', now: 2_000, origin: DM })
    const c = await create(s, { title: 'c', now: 3_000, status: 'waiting', origin: SHARED, shared: true })
    await create(s, { agentId: OTHER_AGENT, title: 'other', now: 4_000, shared: true })
    const ids = (items: { id: string }[]) => items.map((item) => item.id)

    expect(ids(await s.assistantItems.list(AGENT))).toEqual([c.id, b.id, a.id])
    expect(ids(await s.assistantItems.list(AGENT, { status: 'active' }))).toEqual([b.id, a.id])
    expect(ids(await s.assistantItems.list(AGENT, { status: ['waiting', 'done'] }))).toEqual([c.id])
    expect(ids(await s.assistantItems.list(AGENT, { origin: GENERAL }))).toEqual([a.id])
    expect(ids(await s.assistantItems.list(AGENT, { origin: { ...GENERAL, transportScope: 'T0OTHER' } }))).toEqual([])
    expect(ids(await s.assistantItems.list(AGENT, { limit: 2 }))).toEqual([c.id, b.id])
    const [listed] = await s.assistantItems.list(AGENT, { origin: SHARED })
    expect(listed).not.toHaveProperty('observations')
    expect(listed).toMatchObject({ shared: true, asker: ALICE })
    await s.assistantItems.setShared(AGENT, c.id, false)
    expect((await s.assistantItems.get(AGENT, c.id))?.shared).toBe(false)
  })
})

describe('the item ledger: observations', () => {
  it('appends without a version check and keeps only the newest entries', async () => {
    const s = await open()
    const item = await create(s)
    const total = ASSISTANT_ITEM_OBSERVATIONS_KEPT + 3
    for (let i = 1; i <= total; i += 1) {
      const appended = await s.assistantItems.appendObservation(AGENT, item.id, {
        text: `check ${i}`,
        author: i === total ? 'check' : undefined,
        now: 1_000 + i
      })
      expect(appended?.version).toBe(i)
    }
    const after = await s.assistantItems.get(AGENT, item.id)
    expect(after?.observationVersion).toBe(total)
    expect(after?.version).toBe(1)
    expect(after?.observations).toHaveLength(ASSISTANT_ITEM_OBSERVATIONS_KEPT)
    expect(after?.observations[0]).toEqual({ version: 4, text: 'check 4', author: null, at: 1_004 })
    expect(after?.observations.at(-1)).toEqual({
      version: total,
      text: `check ${total}`,
      author: 'check',
      at: 1_000 + total
    })
    expect(await s.assistantItems.appendObservation(AGENT, 'missing', { text: 'x' })).toBeUndefined()
    await expect(s.assistantItems.appendObservation(AGENT, item.id, { text: '' })).rejects.toThrow('observation')
  })

  it('hands concurrent appends distinct versions', async () => {
    const s = await open()
    const item = await create(s)
    const versions = await Promise.all(
      Array.from({ length: 8 }, (_, i) => s.assistantItems.appendObservation(AGENT, item.id, { text: `o${i}` }))
    )
    expect(versions.map((v) => v?.version).sort((x, y) => x! - y!)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })
})

describe('the item ledger: schedule', () => {
  it('sets an open item’s next check or ends it, and never reopens an ended one', async () => {
    const s = await open()
    const item = await create(s, { nextCheck: 9_000 })
    expect(await s.assistantItems.schedule(AGENT, item.id, { status: 'waiting', nextCheck: null }, 2_000)).toBe(true)
    expect(await s.assistantItems.get(AGENT, item.id)).toMatchObject({
      status: 'waiting',
      nextCheck: null,
      version: 2,
      updatedAt: 2_000
    })
    expect(await s.assistantItems.schedule(AGENT, item.id, { status: 'active', nextCheck: 12_000 }, 3_000)).toBe(true)
    expect(await s.assistantItems.schedule(AGENT, item.id, { status: 'dropped', nextCheck: null }, 4_000)).toBe(true)
    expect(await s.assistantItems.schedule(AGENT, item.id, { status: 'active', nextCheck: 15_000 }, 5_000)).toBe(false)
    expect(await s.assistantItems.get(AGENT, item.id)).toMatchObject({ status: 'dropped', nextCheck: null, version: 4 })
    expect(await s.assistantItems.schedule(AGENT, 'missing', { status: 'done', nextCheck: null })).toBe(false)
  })
})

describe('the item ledger: links and removal', () => {
  it('links and unlinks sub-session and proposal ids idempotently', async () => {
    const s = await open()
    const item = await create(s)
    const items = s.assistantItems
    expect(await items.link(AGENT, item.id, 'subsession', 'sess-1', 2_000)).toBe(true)
    expect(await items.link(AGENT, item.id, 'subsession', 'sess-1', 2_500)).toBe(false)
    expect(await items.link(AGENT, item.id, 'subsession', 'sess-2', 3_000)).toBe(true)
    expect(await items.link(AGENT, item.id, 'proposal', 'prop-1', 4_000)).toBe(true)
    expect(await items.get(AGENT, item.id)).toMatchObject({
      subsessions: ['sess-1', 'sess-2'],
      proposals: ['prop-1'],
      version: 1,
      updatedAt: 4_000
    })
    expect(await items.unlink(AGENT, item.id, 'subsession', 'sess-1', 5_000)).toBe(true)
    expect(await items.unlink(AGENT, item.id, 'subsession', 'sess-1', 6_000)).toBe(false)
    expect(await items.get(AGENT, item.id)).toMatchObject({ subsessions: ['sess-2'], updatedAt: 5_000 })
    expect(await items.link(AGENT, 'missing', 'proposal', 'prop-1')).toBe(false)
  })

  it('removes every item of a deleted agent, with its checks', async () => {
    const s = await open()
    const doomed = await create(s)
    const elsewhere = await create(s, { agentId: OTHER_AGENT, title: 'other' })
    await s.assistantItems.appendObservation(AGENT, doomed.id, { text: 'seen' })
    await s.assistantChecks.begin(AGENT, doomed.taskKey, {
      key: doomed.taskKey,
      nextCheck: null,
      observationVersion: 0,
      input: null,
      now: 1_000,
      staleBefore: 0,
      exclusive: false
    })
    expect(await s.assistantItems.deleteForAgent(AGENT)).toBe(1)
    expect(await s.assistantItems.list(AGENT)).toEqual([])
    expect(await s.assistantChecks.get(AGENT, doomed.taskKey)).toBeUndefined()
    expect(await s.assistantChecks.checks(AGENT, doomed.taskKey, 10)).toEqual([])
    expect(await s.assistantItems.get(OTHER_AGENT, elsewhere.id)).toMatchObject({ title: 'other' })
  })
})

describe('the item ledger schema', () => {
  it('lists every camelCase column in canonicalColumns', () => {
    const names = new Set(
      [...`${ASSISTANT_ITEM_SCHEMA}${ASSISTANT_CHECK_SCHEMA}`.matchAll(/\b[a-z]+[A-Z][A-Za-z]*\b/g)].map((m) => m[0])
    )
    const canonical = new Set<string>(canonicalColumns)
    expect([...names].filter((name) => !canonical.has(name))).toEqual([])
    expect(names.size).toBeGreaterThan(10)
  })
})

// v36 drops the trust column a v35 daemon wrote (assistant-mode.md §5.3, fifth revision).
const V35_ITEM_TABLE = `
  CREATE TABLE assistant_item (
    id TEXT PRIMARY KEY,
    agentId TEXT NOT NULL,
    title TEXT NOT NULL,
    doneWhen TEXT,
    nextCheck INTEGER,
    status TEXT NOT NULL CHECK (status IN ('active', 'waiting', 'done', 'dropped')),
    originPlatform TEXT NOT NULL,
    originChannel TEXT NOT NULL,
    originTransportScope TEXT NOT NULL DEFAULT '',
    trust TEXT NOT NULL CHECK (trust IN ('internal', 'external')),
    summary TEXT NOT NULL DEFAULT '',
    observationVersion INTEGER NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 1,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL
  )`
const V35_ITEM_ROW = `INSERT INTO assistant_item (id, agentId, title, status, originPlatform, originChannel, trust, createdAt, updatedAt)
  VALUES ('item-old', 'agent-a', 'Kept across the upgrade', 'waiting', 'slack', 'C0GENERAL', 'external', 1000, 2000)`

const sqliteColumns = (path: string, table: string): string[] => {
  const db = new DatabaseSync(path)
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  db.close()
  return rows.map((row) => row.name)
}
const userVersion = (path: string): number => {
  const db = new DatabaseSync(path)
  const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
  db.close()
  return version
}

describe.skipIf(usingPostgresStore())('the v35 → v36 item trust removal on SQLite', () => {
  it('drops the trust column and keeps every open item, as a follow-up and then a watch task', async () => {
    const path = tempStorePath('ac-assistant-v35-')
    await (await LocalStore.open(path)).close()
    const old = new DatabaseSync(path)
    old.exec(`DROP TABLE assistant_item; ${V35_ITEM_TABLE}; ${V35_ITEM_ROW}; PRAGMA user_version = 35`)
    old.close()
    expect(sqliteColumns(path, 'assistant_item')).toContain('trust')

    const upgraded = await LocalStore.open(path)
    try {
      expect(await upgraded.assistantItems.get(AGENT, 'item-old')).toBeUndefined()
      const kept = await migrated(upgraded, 'Kept across the upgrade')
      expect(kept).toMatchObject({
        status: 'waiting',
        origin: { platform: 'slack', channel: 'C0GENERAL', transportScope: null },
        updatedAt: 2_000
      })
      expect(kept!.taskKey).toMatch(/^slack:C0GENERAL:subsession:check-[^:]+:agent-a$/)
      expect((await create(upgraded, { title: 'new' })).title).toBe('new')
    } finally {
      await upgraded.close()
    }
    expect(sqliteColumns(path, 'assistant_item')).not.toContain('trust')
    expect(userVersion(path)).toBe(SCHEMA_VERSION)
  })

  it('creates the follow-up tables on a v35 store that never had them', async () => {
    const path = tempStorePath('ac-assistant-v35-bare-')
    await (await LocalStore.open(path)).close()
    const old = new DatabaseSync(path)
    old.exec('DROP TABLE assistant_item; PRAGMA user_version = 35')
    old.close()
    const upgraded = await LocalStore.open(path)
    try {
      expect((await create(upgraded, { title: 'first', origin: DM })).gettingToKnow).toBe('joined')
    } finally {
      await upgraded.close()
    }
    expect(sqliteColumns(path, 'assistant_item')).not.toContain('trust')
    expect(userVersion(path)).toBe(SCHEMA_VERSION)
  })
})

// The item ledger as a v52 daemon left it: followers, no task key, no check log.
const V52_ITEM_TABLES = `
  CREATE TABLE assistant_item (
    id TEXT PRIMARY KEY,
    agentId TEXT NOT NULL,
    title TEXT NOT NULL,
    doneWhen TEXT,
    nextCheck INTEGER,
    status TEXT NOT NULL CHECK (status IN ('active', 'waiting', 'done', 'dropped')),
    originPlatform TEXT NOT NULL,
    originChannel TEXT NOT NULL,
    originTransportScope TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL DEFAULT '',
    observationVersion INTEGER NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 1,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL
  );
  CREATE TABLE assistant_item_follower (
    itemId TEXT NOT NULL,
    agentId TEXT NOT NULL,
    identity TEXT NOT NULL,
    platform TEXT NOT NULL,
    channel TEXT NOT NULL,
    transportScope TEXT NOT NULL DEFAULT '',
    addedAt INTEGER NOT NULL,
    PRIMARY KEY (itemId, identity, platform, channel, transportScope)
  );
  CREATE TABLE assistant_patrol (
    agentId TEXT NOT NULL,
    itemId TEXT NOT NULL,
    patrolledNextCheck INTEGER,
    failures INTEGER NOT NULL DEFAULT 0,
    retryAt INTEGER,
    stopped INTEGER NOT NULL DEFAULT 0,
    stoppedNextCheck INTEGER,
    runningKey TEXT,
    runningNextCheck INTEGER,
    runningObservationVersion INTEGER,
    runningReport TEXT,
    updatedAt INTEGER NOT NULL,
    PRIMARY KEY (agentId, itemId)
  )`

// The task index told its rows apart by kind until v74.
const V52_TASK_KIND = "ALTER TABLE assistant_subsession ADD COLUMN kind TEXT NOT NULL DEFAULT 'delegation'"

const OLD_PATROL = (run: string) => sessionKey('slack', 'C0GENERAL', `subsession:patrol-${run}`, AGENT, 'T0EXAMPLE')
const MIGRATED = (run: string) => sessionKey('slack', 'C0GENERAL', `subsession:check-${run}`, AGENT, 'T0EXAMPLE')
const PLACE_KEY = sessionKey('slack', 'C0GENERAL', 'append:1', AGENT, 'T0EXAMPLE')
const V52_ITEM_ROW = `INSERT INTO assistant_item (id, agentId, title, doneWhen, nextCheck, status, originPlatform,
    originChannel, originTransportScope, summary, observationVersion, version, createdAt, updatedAt)
  VALUES (?, ?, ?, ?, ?, ?, 'slack', 'C0GENERAL', 'T0EXAMPLE', ?, ?, 1, 1000, 2000)`

/** What a v52 daemon left: an open item with three followers, one in flight, one done, and finished patrols. */
const V52_ROWS: [string, unknown[]][] = [
  [V52_ITEM_ROW, ['item-open', AGENT, 'Watch the release', 'It is out', 90_000, 'active', 'Alice asked.', 3]],
  [V52_ITEM_ROW, ['item-running', AGENT, 'Watch the build', null, 50_000, 'waiting', '', 1]],
  [V52_ITEM_ROW, ['item-done', AGENT, 'Rotate the key', null, null, 'done', '', 0]],
  ...[
    ['U0BOB', 'C0SUPPORT', 2_000],
    ['U0ALICE', 'C0GENERAL', 1_000],
    ['U0CAROL', 'C0GENERAL', 3_000]
  ].map(([user, channel, at]): [string, unknown[]] => [
    `INSERT INTO assistant_item_follower (itemId, agentId, identity, platform, channel, transportScope, addedAt)
     VALUES ('item-open', ?, ?, 'slack', ?, 'T0EXAMPLE', ?)`,
    [AGENT, `slack:T0EXAMPLE:${user}`, channel, at]
  ]),
  ...[1, 2, 3].map((v): [string, unknown[]] => [
    `INSERT INTO assistant_item_observation (itemId, agentId, observationVersion, text, author, observedAt)
     VALUES ('item-open', ?, ?, ?, 'patrol', ?)`,
    [AGENT, v, `seen ${v}`, v * 1_000]
  ]),
  [
    `INSERT INTO assistant_patrol (agentId, itemId, failures, stopped, runningKey, runningNextCheck,
       runningObservationVersion, updatedAt) VALUES (?, 'item-running', 0, 0, ?, 50000, 1, 40000)`,
    [AGENT, OLD_PATROL('running')]
  ],
  ...[
    [OLD_PATROL('running'), 'open', 40_000],
    [OLD_PATROL('finished'), 'done', 30_000]
  ].map(([key, state, at]): [string, unknown[]] => [
    `INSERT INTO assistant_subsession (agentId, childSessionKey, parentSessionId, parentSessionKey, state, createdAt, kind)
     VALUES (?, ?, 'sid-place', ?, ?, ?, 'patrol')`,
    [AGENT, key, PLACE_KEY, state, at]
  ]),
  [
    `INSERT INTO append_reservation (agentId, channel, transportScope, coordinate, updatedAt)
     VALUES (?, 'C0GENERAL', 'T0EXAMPLE', 'append:1', 1)`,
    [AGENT]
  ],
  [
    `INSERT INTO sessions (key, agentId, platform, channel, thread, transportScope, sessionId, state, updatedAt)
     VALUES (?, ?, 'slack', 'C0GENERAL', 'append:1', 'T0EXAMPLE', 'sid-place', 'idle', 1)`,
    [PLACE_KEY, AGENT]
  ]
]

/** After the v53, v57 and v74 steps: open items are watch tasks of their place, the in-flight patrol is a check, nothing else is carried. */
async function expectFollowUps(s: LocalStore): Promise<void> {
  // The item ledger keeps getting-to-know tasks alone; a done item was never carried.
  expect(await s.assistantItems.list(AGENT)).toEqual([])
  expect(await migrated(s, 'Rotate the key')).toBeUndefined()
  const listed = await migrated(s, 'Watch the release')
  const open = listed && (await s.assistantWatchTasks.get(AGENT, listed.taskKey))
  expect(open).toMatchObject({
    doneWhen: 'It is out',
    nextAt: 90_000,
    status: 'active',
    background: 'Alice asked.',
    asker: 'slack:T0EXAMPLE:U0ALICE',
    shared: false,
    // A migrated follow-up knows no thread it was taken in, so it reports where its place last replied.
    replyThread: null,
    // Its summary is its last check's result.
    summary: 'seen 3'
  })
  // Only the latest observation is the handover.
  expect(open!.observations.map((o) => o.text)).toEqual(['seen 3'])
  expect(open!.taskKey).toMatch(/^slack:C0GENERAL:subsession:check-[^:]+:agent-a:T0EXAMPLE$/)
  expect(await s.assistantSubsessions.get(AGENT, open!.taskKey)).toMatchObject({
    mode: 'watch',
    state: 'done',
    parentSessionId: 'sid-place',
    parentSessionKey: PLACE_KEY
  })
  // The patrol in flight becomes that follow-up's check, in its own session, keyed by its task key.
  expect(await s.assistantWatchTasks.get(AGENT, MIGRATED('running'))).toMatchObject({
    title: 'Watch the build',
    asker: null,
    status: 'waiting',
    running: true
  })
  expect(await s.assistantChecks.byRunningKey(AGENT, MIGRATED('running'))).toMatchObject({
    taskKey: MIGRATED('running'),
    runningCheck: 1,
    runningSince: 40_000
  })
  expect(await s.assistantChecks.checks(AGENT, MIGRATED('running'), 10)).toEqual([
    {
      taskKey: MIGRATED('running'),
      checkNo: 1,
      startedAt: 40_000,
      endedAt: null,
      observation: null,
      reported: false,
      startedBy: null,
      events: []
    }
  ])
  expect(await s.assistantSubsessions.get(AGENT, MIGRATED('running'))).toMatchObject({
    state: 'open',
    mode: 'watch'
  })
  expect(await s.assistantSubsessions.get(AGENT, MIGRATED('finished'))).toBeUndefined()
}

describe.skipIf(usingPostgresStore())('the v52 → v53 follow-up migration on SQLite', () => {
  it('makes each open item a follow-up of its place and drops followers and closed items', async () => {
    const path = tempStorePath('ac-assistant-v52-')
    await (await LocalStore.open(path)).close()
    const old = new DatabaseSync(path)
    old.exec(
      'DROP TABLE assistant_item; DROP TABLE assistant_check_state; DROP TABLE assistant_check; ' +
        `${V52_ITEM_TABLES}; ${V52_TASK_KIND}; PRAGMA user_version = 52`
    )
    for (const [sql, params] of V52_ROWS) old.prepare(sql).run(...(params as never[]))
    old.close()

    const upgraded = await LocalStore.open(path)
    try {
      await expectFollowUps(upgraded)
    } finally {
      await upgraded.close()
    }
    const db = new DatabaseSync(path)
    const followers = db.prepare("SELECT name FROM sqlite_master WHERE name = 'assistant_item_follower'").all()
    db.close()
    expect(followers).toEqual([])
    expect(sqliteColumns(path, 'assistant_check_state')).toEqual(
      expect.arrayContaining(['runningCheck', 'pendingMessages'])
    )
    expect(userVersion(path)).toBe(SCHEMA_VERSION)
  })
})

/** Run a migration case on its own PostgreSQL schema, with an admin client to reshape it. */
async function onPostgres(test: (admin: pg.Client, reopen: () => Promise<LocalStore>) => Promise<void>) {
  const databaseUrl = process.env.DATA_PLANE_TEST_DATABASE_URL!
  const schema = `mig_${randomUUID().replace(/-/g, '')}`
  const config = { version: 1 as const, databaseUrl, maxConnections: 2 }
  const orgForAgent = (): string => 'org-a'
  const admin = new pg.Client({ connectionString: databaseUrl })
  await admin.connect()
  try {
    const fresh = await PostgresAsyncDatabase.open(config, () => undefined, schema)
    await fresh.finishSchemaInitialization()
    await (await LocalStore.open({ database: fresh, shared: true, ownerId: 'm1', orgForAgent })).close()
    await admin.query(`SET search_path TO ${schema}`)
    await test(admin, async () => {
      const database = await PostgresAsyncDatabase.open(config, () => undefined, schema)
      await database.finishSchemaInitialization()
      return await LocalStore.open({ database, shared: true, ownerId: 'm2', orgForAgent })
    })
    const version = await admin.query('SELECT version FROM _local_store_schema_version')
    expect(Number(version.rows[0].version)).toBe(SCHEMA_VERSION)
  } finally {
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined)
    await admin.end()
  }
}

/** `?` placeholders as PostgreSQL's numbered ones. */
const numbered = (sql: string): string => {
  let n = 0
  return sql.replace(/\?/g, () => `$${++n}`)
}

describe.skipIf(!usingPostgresStore())('the item migrations on PostgreSQL', () => {
  it('drops the trust column and keeps every open item, as a follow-up and then a watch task', async () => {
    await onPostgres(async (admin, reopen) => {
      await admin.query(`DROP TABLE assistant_item`)
      await admin.query(V35_ITEM_TABLE.replace(/\bINTEGER\b/g, 'BIGINT'))
      await admin.query(V35_ITEM_ROW)
      await admin.query('UPDATE _local_store_schema_version SET version = 35 WHERE singleton = true')
      const upgraded = await reopen()
      try {
        expect(await migrated(upgraded, 'Kept across the upgrade')).toMatchObject({
          status: 'waiting',
          updatedAt: 2_000
        })
        expect((await create(upgraded, { title: 'new' })).title).toBe('new')
      } finally {
        await upgraded.close()
      }
      const left = await admin.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'assistant_item'`
      )
      expect(left.rows.map((row: { column_name: string }) => row.column_name)).not.toContain('trust')
    })
  })

  it('makes each open item a follow-up of its place and drops followers and closed items', async () => {
    await onPostgres(async (admin, reopen) => {
      await admin.query('DROP TABLE assistant_item; DROP TABLE assistant_check_state; DROP TABLE assistant_check')
      await admin.query(V52_ITEM_TABLES.replace(/\bINTEGER\b/g, 'BIGINT'))
      await admin.query(V52_TASK_KIND)
      for (const [sql, params] of V52_ROWS) await admin.query(numbered(sql), params)
      await admin.query('UPDATE _local_store_schema_version SET version = 52 WHERE singleton = true')
      const upgraded = await reopen()
      try {
        await expectFollowUps(upgraded)
      } finally {
        await upgraded.close()
      }
      const followers = await admin.query(
        `SELECT 1 FROM information_schema.tables
          WHERE table_schema = current_schema() AND table_name = 'assistant_item_follower'`
      )
      expect(followers.rows).toEqual([])
    })
  })
})

// Two pool members on their own connections, plus a raw client holding the item's row lock.
describe.skipIf(!usingPostgresStore())('follow-ups across PostgreSQL pool members', () => {
  const databaseUrl = process.env.DATA_PLANE_TEST_DATABASE_URL!
  const opened: LocalStore[] = []
  const raw: pg.Client[] = []

  afterEach(async () => {
    for (const client of raw.splice(0)) await client.end().catch(() => undefined)
    for (const member of opened.splice(0)) await member.close()
  })

  async function member(): Promise<LocalStore> {
    const database = await PostgresAsyncDatabase.open({ version: 1, databaseUrl, maxConnections: 4 })
    try {
      const opening = await LocalStore.open({
        database,
        shared: true,
        ownerId: randomUUID(),
        orgForAgent: () => 'org-a'
      })
      opened.push(opening)
      return opening
    } finally {
      await database.finishSchemaInitialization()
    }
  }

  async function lockedItem(itemId: string): Promise<pg.Client> {
    const client = new pg.Client({ connectionString: databaseUrl, options: `-c search_path=${POOL_STORE_SCHEMA}` })
    await client.connect()
    raw.push(client)
    await client.query('BEGIN')
    await client.query('SELECT id FROM assistant_item WHERE id = $1 FOR UPDATE', [itemId])
    return client
  }

  const settledWithin = async (promise: Promise<unknown>, ms: number): Promise<boolean> => {
    let settled = false
    void promise.then(
      () => (settled = true),
      () => (settled = true)
    )
    await new Promise((resolve) => setTimeout(resolve, ms))
    return settled
  }

  it('reads the same follow-up from either member and ends it once', async () => {
    const a = await member()
    const b = await member()
    const item = await create(a)
    expect(await b.assistantItems.get(AGENT, item.id)).toEqual(item)
    const versions = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        (i % 2 ? a : b).assistantItems.appendObservation(AGENT, item.id, { text: `o${i}` })
      )
    )
    expect(versions.map((v) => v?.version).sort((x, y) => x! - y!)).toEqual([1, 2, 3, 4, 5, 6])
    const results = await Promise.all([
      a.assistantItems.schedule(AGENT, item.id, { status: 'done', nextCheck: null }),
      b.assistantItems.schedule(AGENT, item.id, { status: 'dropped', nextCheck: null })
    ])
    expect(results.filter(Boolean)).toHaveLength(1)
  })

  it('waits on a link held under the follow-up’s row lock', async () => {
    const a = await member()
    const b = await member()
    const item = await create(a)
    const holder = await lockedItem(item.id)
    const linking = b.assistantItems.link(AGENT, item.id, 'subsession', 'sess-1')
    expect(await settledWithin(linking, 300)).toBe(false)
    await holder.query('COMMIT')
    expect(await linking).toBe(true)
  })
})

describe.skipIf(usingPostgresStore())('follow-ups on agent removal', () => {
  const dirs: string[] = []
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  })

  it('drops the agent’s follow-ups when the control plane removes the agent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-assistant-items-'))
    dirs.push(root)
    writeFileSync(
      join(root, 'config.json'),
      JSON.stringify({
        version: 1,
        controlPlane: { enabled: false },
        runtimes: { claude: { command: 'node', args: [] } }
      })
    )
    const agentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
    const agentDir = join(root, 'agents', agentId)
    mkdirSync(agentDir, { recursive: true })
    writeFileSync(
      join(agentDir, 'agent.json'),
      JSON.stringify({
        id: agentId,
        name: 'bot-a',
        status: 'active',
        runtime: 'claude',
        workspace: { mode: 'from-scratch', path: join(agentDir, 'ws') },
        integrations: [],
        output: { mode: 'medium' }
      })
    )
    const idleHost = (agent: { id: string }) =>
      ({
        id: agent.id,
        start: vi.fn().mockResolvedValue(undefined),
        newSession: vi.fn(),
        prompt: vi.fn(),
        cancel: vi.fn(),
        stop: vi.fn().mockResolvedValue(undefined)
      }) as never
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root, hostFactory: idleHost })
    await daemon.start()
    try {
      const seam = daemon as unknown as {
        store: LocalStore
        cpConfigApply(): { applyAgentRemove(id: string): Promise<void> }
      }
      const mine = await create(seam.store, { agentId, title: 'mine' })
      const theirs = await create(seam.store, { agentId: OTHER_AGENT, title: 'theirs' })
      await seam.cpConfigApply().applyAgentRemove(agentId)
      expect(await seam.store.assistantItems.get(agentId, mine.id)).toBeUndefined()
      expect(await seam.store.assistantItems.get(OTHER_AGENT, theirs.id)).toBeDefined()
    } finally {
      await daemon.stop()
    }
  })
})
