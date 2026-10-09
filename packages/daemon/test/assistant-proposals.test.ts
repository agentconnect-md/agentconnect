// A patrol's proposed task on the approval record (assistant-mode.md §5.10): one contract suite, run on SQLite by default and on PostgreSQL by store-postgres.
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import pg from 'pg'
import { afterEach, describe, expect, it } from 'vitest'
import { patrolCoordinate, subsessionCoordinate, taskCoordinate } from '../src/session/subsession-coordinate.js'
import { ASSISTANT_DRAFT_TTL_MS, assistantTaskHash, type AssistantTaskCreate } from '../src/store/assistant-drafts.js'
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
const SCOPE = 'T0EXAMPLE'
const PLACE = { platform: 'slack', integrationId: 'int-a', channel: 'C0GENERAL', thread: null }
const TASK = 'Rebase PR #12 onto main and push.'
const BY = { id: 'user:usr-1', name: 'Grace' }
const patrolKey = (agentId: string, run = '1'): string =>
  sessionKey('slack', 'C0GENERAL', patrolCoordinate(run), agentId, SCOPE)
const taskKey = (agentId: string, run = '1'): string =>
  sessionKey('slack', 'C0GENERAL', taskCoordinate(run), agentId, SCOPE)

const propose = (s: LocalStore, agentId: string, over: Partial<AssistantTaskCreate> = {}) =>
  s.assistantDrafts.createTask({
    agentId,
    target: PLACE,
    destination: { name: 'general' },
    task: TASK,
    sentence: 'I want to rebase PR #12 because it conflicts with main.',
    why: 'The check found a merge conflict.',
    itemId: 'item-1',
    itemVersion: 3,
    source: {
      platform: 'slack',
      integrationId: 'int-a',
      channel: 'C0GENERAL',
      thread: patrolCoordinate('1'),
      transportScope: SCOPE,
      sessionKey: patrolKey(agentId),
      sessionId: 'sid-patrol-1',
      place: false
    },
    now: 1_000,
    ...over
  })

const subsessionRow = (agentId: string, key: string) => ({
  agentId,
  childSessionKey: key,
  parentSessionId: 'sid-parent-1',
  parentSessionKey: sessionKey('slack', 'C0GENERAL', 'append:1', agentId, SCOPE),
  now: 2_000
})

describe('a proposal on the approval record', () => {
  it('records a task bound to its task, its agent and the item’s version, awaiting review for a day', async () => {
    const s = await open()
    const a = agent()
    const proposal = await propose(s, a)
    expect(proposal).toMatchObject({
      agentId: a,
      action: 'task',
      kind: 'task',
      text: TASK,
      target: PLACE,
      destination: { name: 'general' },
      proposal: {
        sentence: 'I want to rebase PR #12 because it conflicts with main.',
        why: 'The check found a merge conflict.',
        itemId: 'item-1',
        itemVersion: 3
      },
      offerAlways: false,
      status: 'awaiting_review',
      subsessionKey: null,
      createdAt: 1_000,
      expiresAt: 1_000 + ASSISTANT_DRAFT_TTL_MS
    })
    expect(proposal.hash).toBe(assistantTaskHash(a, 'item-1', 3, TASK))
    expect(proposal.hash).not.toBe(assistantTaskHash(a, 'item-1', 4, TASK))
    expect(proposal.hash).not.toBe(assistantTaskHash(agent(), 'item-1', 3, TASK))
    // A place with no integration (webchat) still runs it.
    const webchat = await propose(s, a, {
      target: { platform: 'webchat', integrationId: '', channel: 'conv-1', thread: null }
    })
    expect(webchat.target).toEqual({ platform: 'webchat', integrationId: '', channel: 'conv-1', thread: null })
    await expect(propose(s, a, { sentence: ' ' })).rejects.toThrow(/needs its sentence/)
    await expect(propose(s, a, { task: '' })).rejects.toThrow(/needs its task/)
    await expect(propose(s, a, { task: 'x'.repeat(8_001) })).rejects.toThrow(/exceeds 8000/)
  })

  it('starts once, with its sub-session recorded in the same statement, and never through the post path', async () => {
    const s = await open()
    const a = agent()
    const proposal = await propose(s, a)
    expect(await s.assistantDrafts.begin(proposal.id, BY, 2_000)).toBe(false)
    const results = await Promise.all([
      s.assistantDrafts.beginTask(proposal.id, BY, taskKey(a, '1'), 2_000),
      s.assistantDrafts.beginTask(proposal.id, BY, taskKey(a, '2'), 2_000)
    ])
    expect(results.filter(Boolean)).toHaveLength(1)
    const started = await s.assistantDrafts.get(proposal.id)
    expect(started).toMatchObject({ status: 'executing', decidedBy: BY.id, decidedByName: 'Grace', decidedAt: 2_000 })
    expect([taskKey(a, '1'), taskKey(a, '2')]).toContain(started?.subsessionKey)
    expect(await s.assistantDrafts.deny(proposal.id, BY, 2_000)).toBe(false)

    const late = await propose(s, a)
    expect(await s.assistantDrafts.beginTask(late.id, BY, taskKey(a, '3'), late.expiresAt)).toBe(false)
    expect((await s.assistantDrafts.get(late.id))?.subsessionKey).toBeNull()
  })

  it('fails a task that cannot start, and keeps the first outcome of one that ran', async () => {
    const s = await open()
    const a = agent()
    const blocked = await propose(s, a)
    expect(await s.assistantDrafts.failTask(blocked.id, BY, 'its item is done', 2_000)).toBe(true)
    expect(await s.assistantDrafts.failTask(blocked.id, BY, 'again', 2_000)).toBe(false)
    expect(await s.assistantDrafts.beginTask(blocked.id, BY, taskKey(a), 2_000)).toBe(false)
    expect(await s.assistantDrafts.get(blocked.id)).toMatchObject({ status: 'failed', failure: 'its item is done' })

    const ran = await propose(s, a)
    await s.assistantDrafts.beginTask(ran.id, BY, taskKey(a), 2_000)
    expect(await s.assistantDrafts.failTask(ran.id, BY, 'late', 2_000)).toBe(false)
    expect((await s.assistantDrafts.taskBySubsession(a, taskKey(a)))?.id).toBe(ran.id)
    expect(await s.assistantDrafts.settleTask(a, taskKey(a), 'succeeded', null, 3_000)).toMatchObject({
      id: ran.id,
      status: 'succeeded',
      settledAt: 3_000
    })
    expect(await s.assistantDrafts.settleTask(a, taskKey(a), 'outcome_unknown', 'cut', 4_000)).toBeUndefined()
    expect((await s.assistantDrafts.get(ran.id))?.status).toBe('succeeded')
    expect(await s.assistantDrafts.taskBySubsession(agent(), taskKey(a))).toBeUndefined()
  })

  it('is listed only when asked for, and left alone by the posts’ recovery', async () => {
    const s = await open()
    const a = agent()
    const waiting = await propose(s, a)
    const running = await propose(s, a)
    await s.assistantDrafts.beginTask(running.id, BY, taskKey(a), 2_000)
    expect(await s.assistantDrafts.listPending(a, 10, 2_000)).toEqual([])
    expect((await s.assistantDrafts.listPending(a, 10, 2_000, { tasks: true })).map((d) => d.id)).toEqual([waiting.id])
    expect(await s.assistantDrafts.recoverExecuting([a], 3_000)).toEqual([])
    expect((await s.assistantDrafts.get(running.id))?.status).toBe('executing')
    expect((await s.assistantDrafts.executingTasks([a])).map((d) => d.id)).toEqual([running.id])
    expect(await s.assistantDrafts.executingTasks([])).toEqual([])
  })

  it('knows whether a patrol run already proposed', async () => {
    const s = await open()
    const a = agent()
    expect(await s.assistantDrafts.proposedFrom(a, patrolKey(a))).toBe(false)
    await propose(s, a)
    expect(await s.assistantDrafts.proposedFrom(a, patrolKey(a))).toBe(true)
    expect(await s.assistantDrafts.proposedFrom(a, patrolKey(a, '2'))).toBe(false)
  })
})

describe('starting a task claims its sub-session in the same transaction', () => {
  it('opens the sub-session and starts the task together', async () => {
    const s = await open()
    const a = agent()
    const proposal = await propose(s, a)
    const claimed = await s.assistantSubsessions.openWithinLimitClaiming(
      subsessionRow(a, taskKey(a)),
      { limit: 1, startedSince: 0 },
      (tx) => s.assistantDrafts.beginTask(proposal.id, BY, taskKey(a), 2_000, tx)
    )
    expect(claimed).toBe('opened')
    expect(await s.assistantSubsessions.get(a, taskKey(a))).toMatchObject({ state: 'open' })
    expect(await s.assistantDrafts.get(proposal.id)).toMatchObject({ status: 'executing', subsessionKey: taskKey(a) })
  })

  it('writes neither when the limit is reached, and the proposal keeps waiting', async () => {
    const s = await open()
    const a = agent()
    const delegation = sessionKey('slack', 'C0GENERAL', subsessionCoordinate('d'), a, SCOPE)
    expect(await s.assistantSubsessions.open(subsessionRow(a, delegation))).toBe(true)
    const proposal = await propose(s, a)
    const claimed = await s.assistantSubsessions.openWithinLimitClaiming(
      subsessionRow(a, taskKey(a)),
      { limit: 1, startedSince: 0 },
      (tx) => s.assistantDrafts.beginTask(proposal.id, BY, taskKey(a), 2_000, tx)
    )
    expect(claimed).toBe('limit')
    expect(await s.assistantSubsessions.get(a, taskKey(a))).toBeUndefined()
    expect(await s.assistantDrafts.get(proposal.id)).toMatchObject({ status: 'awaiting_review', subsessionKey: null })
  })

  it('rolls the sub-session back when another decision won the record', async () => {
    const s = await open()
    const a = agent()
    const proposal = await propose(s, a)
    await s.assistantDrafts.deny(proposal.id, BY, 1_500)
    const claimed = await s.assistantSubsessions.openWithinLimitClaiming(
      subsessionRow(a, taskKey(a)),
      { limit: 3, startedSince: 0 },
      (tx) => s.assistantDrafts.beginTask(proposal.id, BY, taskKey(a), 2_000, tx)
    )
    expect(claimed).toBe('refused')
    expect(await s.assistantSubsessions.get(a, taskKey(a))).toBeUndefined()
    expect((await s.assistantDrafts.get(proposal.id))?.status).toBe('denied')
  })
})

describe('recovering a task settles it from its sub-session’s end, in one transaction', () => {
  /** An executing task whose sub-session row stands in `state`, or has none. */
  async function executing(s: LocalStore, a: string, state?: 'open' | 'done' | 'failed') {
    const proposal = await propose(s, a)
    if (state) {
      expect(await s.assistantSubsessions.open(subsessionRow(a, taskKey(a)))).toBe(true)
      if (state !== 'open') await s.assistantSubsessions.finish(a, taskKey(a), state)
    }
    expect(await s.assistantDrafts.beginTask(proposal.id, BY, taskKey(a), 2_000)).toBe(true)
    return proposal
  }
  const settle = (s: LocalStore, a: string) =>
    s.assistantSubsessions.finishClaiming(a, taskKey(a), (tx, how) =>
      s.assistantDrafts.settleTaskIn(
        tx,
        a,
        taskKey(a),
        how === 'done' ? 'succeeded' : how === 'failed' ? 'failed' : 'outcome_unknown',
        null,
        3_000
      )
    )

  it.each([
    ['open', 'cut', 'failed', 'outcome_unknown'],
    ['done', 'done', 'done', 'succeeded'],
    ['failed', 'failed', 'failed', 'failed']
  ] as const)('reads an %s row as %s', async (state, ended, rowAfter, status) => {
    const s = await open()
    const a = agent()
    const proposal = await executing(s, a, state)
    expect(await settle(s, a)).toBe(ended)
    expect((await s.assistantSubsessions.get(a, taskKey(a)))?.state).toBe(rowAfter)
    expect((await s.assistantDrafts.get(proposal.id))?.status).toBe(status)
  })

  it('reads a missing row as missing', async () => {
    const s = await open()
    const a = agent()
    const proposal = await executing(s, a)
    expect(await settle(s, a)).toBe('missing')
    expect((await s.assistantDrafts.get(proposal.id))?.status).toBe('outcome_unknown')
  })

  it('changes nothing when the task already settled, so only one of a racing end and a recovery reports', async () => {
    const s = await open()
    const a = agent()
    const proposal = await executing(s, a, 'open')
    expect(await s.assistantDrafts.settleTask(a, taskKey(a), 'succeeded', null, 2_500)).toBeTruthy()
    expect(await settle(s, a)).toBeUndefined()
    expect((await s.assistantSubsessions.get(a, taskKey(a)))?.state).toBe('open')
    expect((await s.assistantDrafts.get(proposal.id))?.status).toBe('succeeded')
  })
})

/** The approval record as v37–v39 wrote it: a post was its only action. */
const V39_DRAFT_TABLE = `
  CREATE TABLE assistant_draft (
    id TEXT PRIMARY KEY,
    agentId TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('post')),
    kind TEXT NOT NULL CHECK (kind IN ('reply', 'elsewhere')),
    targetPlatform TEXT NOT NULL,
    targetIntegrationId TEXT NOT NULL,
    targetChannel TEXT NOT NULL,
    targetThread TEXT,
    targetExternal INTEGER NOT NULL DEFAULT 0,
    targetDm INTEGER NOT NULL DEFAULT 0,
    targetName TEXT,
    targetUser TEXT,
    targetLink TEXT,
    text TEXT NOT NULL,
    sourcePlatform TEXT,
    sourceIntegrationId TEXT,
    sourceChannel TEXT,
    sourceThread TEXT,
    sourceTransportScope TEXT,
    sourceSessionKey TEXT,
    sourceSessionId TEXT,
    sourcePlace INTEGER NOT NULL DEFAULT 0,
    approverKind TEXT,
    approverIntegrationId TEXT,
    approverChannel TEXT,
    approverUserId TEXT,
    approverTeamId TEXT,
    approverConsoleUserId TEXT,
    cardTs TEXT,
    offerAlways INTEGER NOT NULL DEFAULT 0,
    grantEpoch INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL CHECK (status IN ('awaiting_review', 'executing', 'succeeded', 'failed',
      'outcome_unknown', 'denied', 'expired')),
    hash TEXT NOT NULL,
    createdAt INTEGER NOT NULL,
    expiresAt INTEGER NOT NULL,
    decidedAt INTEGER,
    decidedBy TEXT,
    decidedByName TEXT,
    settledAt INTEGER,
    messageId TEXT,
    failure TEXT
  );
  CREATE INDEX assistant_draft_by_status ON assistant_draft (agentId, status, expiresAt);`

const post = (s: LocalStore, agentId: string) =>
  s.assistantDrafts.create({
    agentId,
    kind: 'elsewhere',
    target: PLACE,
    text: 'The release is out.',
    approver: {
      kind: 'conversation',
      integrationId: 'int-a',
      channel: 'C0FALLBACK',
      userId: null,
      teamId: null,
      consoleUserId: null
    },
    now: 1_000
  })

describe.skipIf(usingPostgresStore())('the v39 → v40 approval record on SQLite', () => {
  it('widens the record to tasks and keeps every draft', async () => {
    expect(SCHEMA_VERSION).toBe(40)
    const path = tempStorePath('ac-assistant-v39-')
    await (await LocalStore.open(path)).close()
    const old = new DatabaseSync(path)
    old.exec(`DROP TABLE assistant_draft; ${V39_DRAFT_TABLE} PRAGMA user_version = 39`)
    old
      .prepare(
        `INSERT INTO assistant_draft (id, agentId, action, kind, targetPlatform, targetIntegrationId, targetChannel, text,
           approverKind, approverIntegrationId, approverChannel, cardTs, status, hash, createdAt, expiresAt)
         VALUES ('draft-old', 'agent-old', 'post', 'elsewhere', 'slack', 'int-a', 'C0GENERAL', 'Kept.', 'conversation',
           'int-a', 'C0FALLBACK', '1700.1', 'awaiting_review', 'h', 1000, 2000)`
      )
      .run()
    expect(() =>
      old
        .prepare(
          `INSERT INTO assistant_draft (id, agentId, action, kind, targetPlatform, targetIntegrationId, targetChannel,
             text, status, hash, createdAt, expiresAt)
           VALUES ('t', 'a', 'task', 'task', 'slack', 'int-a', 'C0', 'x', 'awaiting_review', 'h', 1, 2)`
        )
        .run()
    ).toThrow()
    old.close()

    const upgraded = await LocalStore.open(path)
    const a = agent()
    try {
      expect(await upgraded.assistantDrafts.get('draft-old')).toMatchObject({
        action: 'post',
        kind: 'elsewhere',
        text: 'Kept.',
        cardTs: '1700.1',
        approver: { kind: 'conversation', channel: 'C0FALLBACK' },
        proposal: null,
        subsessionKey: null
      })
      const proposal = await propose(upgraded, a)
      expect(await upgraded.assistantDrafts.beginTask(proposal.id, BY, taskKey(a), 2_000)).toBe(true)
      expect((await upgraded.assistantDrafts.taskBySubsession(a, taskKey(a)))?.id).toBe(proposal.id)
    } finally {
      await upgraded.close()
    }
    const db = new DatabaseSync(path)
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION)
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'assistant_draft'")
      .all()
    expect(indexes.map((row) => (row as { name: string }).name)).toEqual(
      expect.arrayContaining(['assistant_draft_by_status', 'assistant_draft_by_subsession'])
    )
    db.close()
  })
})

describe.skipIf(!usingPostgresStore())('the v39 → v40 approval record on PostgreSQL', () => {
  it('widens the record to tasks and keeps every draft', async () => {
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
      const kept = await post(first, a)
      await first.close()

      await admin.query(`SET search_path TO ${schema}`)
      // Back to the v39 record: the constraints it was created with, and none of the proposal's columns.
      await admin.query('ALTER TABLE assistant_draft DROP CONSTRAINT assistant_draft_action_check')
      await admin.query('ALTER TABLE assistant_draft DROP CONSTRAINT assistant_draft_kind_check')
      await admin.query(
        `ALTER TABLE assistant_draft ADD CONSTRAINT assistant_draft_action_check CHECK (action IN ('post'))`
      )
      await admin.query(
        `ALTER TABLE assistant_draft ADD CONSTRAINT assistant_draft_kind_check CHECK (kind IN ('reply', 'elsewhere'))`
      )
      for (const column of ['sentence', 'why', 'itemId', 'itemVersion', 'subsessionKey'])
        await admin.query(`ALTER TABLE assistant_draft DROP COLUMN ${column}`)
      await admin.query('DROP INDEX IF EXISTS assistant_draft_by_subsession')
      await admin.query('UPDATE _local_store_schema_version SET version = 39 WHERE singleton = true')

      const database = await PostgresAsyncDatabase.open(config, () => undefined, schema)
      await database.finishSchemaInitialization()
      const upgraded = await LocalStore.open({ database, shared: true, ownerId: 'm2', orgForAgent })
      try {
        expect(await upgraded.assistantDrafts.get(kept.id)).toMatchObject({
          action: 'post',
          text: 'The release is out.',
          proposal: null,
          subsessionKey: null
        })
        const proposal = await propose(upgraded, a)
        expect(await upgraded.assistantDrafts.beginTask(proposal.id, BY, taskKey(a), 2_000)).toBe(true)
        expect(await upgraded.assistantDrafts.taskBySubsession(a, taskKey(a))).toMatchObject({
          id: proposal.id,
          proposal: { itemId: 'item-1', itemVersion: 3 },
          subsessionKey: taskKey(a)
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
