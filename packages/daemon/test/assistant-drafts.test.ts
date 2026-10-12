// Drafts (assistant-mode.md §5.5, §5.10): one contract suite, run on SQLite by default and on PostgreSQL by store-postgres.
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import pg from 'pg'
import { afterEach, describe, expect, it } from 'vitest'
import { ASSISTANT_DRAFT_TTL_MS, assistantDraftHash, type AssistantDraftCreate } from '../src/store/assistant-drafts.js'
import { LocalStore, SCHEMA_VERSION } from '../src/store/local-store.js'
import { PostgresAsyncDatabase } from '../src/store/postgres-async-database.js'
import { openTestStore, tempStorePath, usingPostgresStore } from './store-support.js'

const AGENT = 'agent-a'
const TARGET = { platform: 'slack', integrationId: 'int-a', channel: 'C0SUPPORT', thread: null }
const BY = { id: 'T0EXAMPLE:U0ALICE', name: 'alice' }

let store: LocalStore | undefined
afterEach(async () => {
  await store?.close()
  store = undefined
})

async function open(): Promise<LocalStore> {
  store = await openTestStore()
  return store
}

const create = (s: LocalStore, over: Partial<AssistantDraftCreate> = {}) =>
  s.assistantDrafts.create({
    agentId: AGENT,
    kind: 'elsewhere',
    target: TARGET,
    text: 'The release is out.',
    source: {
      platform: 'slack',
      integrationId: 'int-a',
      channel: 'D0ALICE',
      thread: 'append:1',
      transportScope: 'T0EXAMPLE',
      sessionKey: 'k-1',
      sessionId: 's-1',
      place: true
    },
    destination: { name: 'support', threadLink: 'https://example.slack.test/archives/C0SUPPORT' },
    approver: {
      kind: 'member',
      integrationId: 'int-a',
      channel: 'D0ALICE',
      userId: 'U0ALICE',
      teamId: 'T0EXAMPLE',
      consoleUserId: null
    },
    now: 1_000,
    ...over
  })

describe('assistant drafts: the approval record', () => {
  it('round-trips a record that expires a day after it was written, bound to its target and text', async () => {
    const s = await open()
    const draft = await create(s)
    expect(draft).toMatchObject({
      agentId: AGENT,
      action: 'post',
      kind: 'elsewhere',
      target: TARGET,
      targetExternal: false,
      targetDm: false,
      text: 'The release is out.',
      destination: { name: 'support', userId: null, threadLink: 'https://example.slack.test/archives/C0SUPPORT' },
      source: {
        platform: 'slack',
        integrationId: 'int-a',
        channel: 'D0ALICE',
        thread: 'append:1',
        transportScope: 'T0EXAMPLE',
        sessionKey: 'k-1',
        sessionId: 's-1',
        place: true
      },
      approver: { kind: 'member', userId: 'U0ALICE', teamId: 'T0EXAMPLE', consoleUserId: null },
      cardTs: null,
      status: 'awaiting_review',
      createdAt: 1_000,
      expiresAt: 1_000 + ASSISTANT_DRAFT_TTL_MS
    })
    expect(draft.hash).toBe(assistantDraftHash(TARGET, 'The release is out.'))
    expect(draft.hash).not.toBe(assistantDraftHash(TARGET, 'The release is out!'))
    expect(draft.hash).not.toBe(assistantDraftHash({ ...TARGET, thread: '1.1' }, 'The release is out.'))
    expect(await s.assistantDrafts.setCard(draft.id, '111.222')).toBe(true)
    expect((await s.assistantDrafts.get(draft.id))?.cardTs).toBe('111.222')
  })

  it('keeps a placeless draft placeless, and refuses an empty text or an incomplete target', async () => {
    const s = await open()
    const draft = await create(s, { source: null, approver: null })
    expect(draft.source).toBeNull()
    expect(draft.approver).toBeNull()
    await expect(create(s, { text: '  ' })).rejects.toThrow(/must not be empty/)
    await expect(create(s, { target: { ...TARGET, channel: '' } })).rejects.toThrow(/needs a platform/)
  })

  it('lets exactly one approval begin, and no decision once the record expired', async () => {
    const s = await open()
    const draft = await create(s)
    const results = await Promise.all([
      s.assistantDrafts.begin(draft.id, BY, 2_000),
      s.assistantDrafts.begin(draft.id, BY, 2_000)
    ])
    expect(results.filter(Boolean)).toHaveLength(1)
    expect(await s.assistantDrafts.deny(draft.id, BY, 2_000)).toBe(false)
    expect((await s.assistantDrafts.get(draft.id))?.status).toBe('executing')

    const late = await create(s)
    expect(await s.assistantDrafts.begin(late.id, BY, late.expiresAt)).toBe(false)
    expect(await s.assistantDrafts.deny(late.id, BY, late.expiresAt)).toBe(false)
    expect(await s.assistantDrafts.expire(late.id, late.expiresAt)).toBe(true)
    expect(await s.assistantDrafts.begin(late.id, BY, late.expiresAt - 1)).toBe(false)
    expect((await s.assistantDrafts.get(late.id))?.status).toBe('expired')
  })

  it('settles only an executing record, so a discarded one never runs', async () => {
    const s = await open()
    const discarded = await create(s)
    expect(await s.assistantDrafts.deny(discarded.id, BY, 2_000)).toBe(true)
    expect(await s.assistantDrafts.begin(discarded.id, BY, 2_000)).toBe(false)
    expect(await s.assistantDrafts.settle(discarded.id, 'succeeded', { messageId: 'm' }, 2_000)).toBe(false)
    expect(await s.assistantDrafts.get(discarded.id)).toMatchObject({
      status: 'denied',
      decidedBy: BY.id,
      decidedByName: 'alice',
      messageId: null
    })

    const posted = await create(s)
    await s.assistantDrafts.begin(posted.id, BY, 2_000)
    expect(await s.assistantDrafts.settle(posted.id, 'succeeded', { messageId: '1700.1' }, 3_000)).toBe(true)
    expect(await s.assistantDrafts.settle(posted.id, 'failed', {}, 3_000)).toBe(false)
    expect(await s.assistantDrafts.get(posted.id)).toMatchObject({
      status: 'succeeded',
      messageId: '1700.1',
      settledAt: 3_000
    })
  })

  it('expires only due drafts awaiting review, for the agents asked', async () => {
    const s = await open()
    const due = await create(s, { now: 1_000 })
    const fresh = await create(s, { now: 5_000 })
    const deciding = await create(s, { now: 1_000 })
    await s.assistantDrafts.begin(deciding.id, BY, 2_000)
    const other = await create(s, { agentId: 'agent-b', now: 1_000 })
    const now = 1_000 + ASSISTANT_DRAFT_TTL_MS
    expect((await s.assistantDrafts.expireDue([AGENT], now)).map((d) => d.id)).toEqual([due.id])
    expect((await s.assistantDrafts.get(fresh.id))?.status).toBe('awaiting_review')
    expect((await s.assistantDrafts.get(deciding.id))?.status).toBe('executing')
    expect((await s.assistantDrafts.get(other.id))?.status).toBe('awaiting_review')
    expect(await s.assistantDrafts.expireDue([], now)).toEqual([])
  })

  it('marks an execution cut short outcome_unknown, which nothing settles or runs again', async () => {
    const s = await open()
    const cut = await create(s)
    await s.assistantDrafts.begin(cut.id, BY, 2_000)
    const waiting = await create(s)
    expect((await s.assistantDrafts.recoverExecuting([AGENT], 3_000)).map((d) => d.id)).toEqual([cut.id])
    expect(await s.assistantDrafts.get(cut.id)).toMatchObject({ status: 'outcome_unknown', failure: 'interrupted' })
    expect(await s.assistantDrafts.settle(cut.id, 'succeeded', { messageId: 'm' }, 4_000)).toBe(false)
    expect(await s.assistantDrafts.begin(cut.id, BY, 4_000)).toBe(false)
    expect((await s.assistantDrafts.get(waiting.id))?.status).toBe('awaiting_review')
  })
})

describe('assistant drafts: the card and its approver', () => {
  const PLACE = {
    kind: 'place' as const,
    integrationId: 'int-a',
    channel: 'C0GENERAL',
    userId: null,
    teamId: null,
    consoleUserId: null
  }

  it('round-trips an approver in the proposal’s own place, and reroutes only a card nobody posted', async () => {
    const s = await open()
    const draft = await create(s, { approver: PLACE })
    expect(draft.approver).toEqual(PLACE)
    expect(draft.cardShows).toBeNull()
    const fallback = { ...PLACE, kind: 'conversation' as const, channel: 'C0FALLBACK' }
    expect(await s.assistantDrafts.reroute(draft.id, fallback)).toBe(true)
    expect((await s.assistantDrafts.get(draft.id))?.approver).toEqual(fallback)
    await s.assistantDrafts.setCard(draft.id, '111.222')
    expect(await s.assistantDrafts.reroute(draft.id, PLACE)).toBe(false)
    const decided = await create(s, { approver: PLACE })
    await s.assistantDrafts.deny(decided.id, BY, 2_000)
    expect(await s.assistantDrafts.reroute(decided.id, fallback)).toBe(false)
  })

  it('lists a decided draft whose card still shows less, until a rewrite is recorded', async () => {
    const s = await open()
    const denied = await create(s, { approver: PLACE })
    await s.assistantDrafts.setCard(denied.id, '111.1')
    expect((await s.assistantDrafts.get(denied.id))?.cardShows).toBe('awaiting_review')
    await s.assistantDrafts.deny(denied.id, BY, 2_000)
    const posting = await create(s, { approver: PLACE })
    await s.assistantDrafts.setCard(posting.id, '111.2')
    await s.assistantDrafts.begin(posting.id, BY, 2_000)
    const waiting = await create(s, { approver: PLACE })
    await s.assistantDrafts.setCard(waiting.id, '111.3')
    // A card from before the status was recorded is never swept.
    const legacy = await create(s, { approver: PLACE })
    await s.assistantDrafts.setCard(legacy.id, '111.4')
    await s.assistantDrafts['db'].query('UPDATE assistant_draft SET cardShows = NULL WHERE id = ?', [legacy.id])
    await s.assistantDrafts.deny(legacy.id, BY, 2_000)

    expect((await s.assistantDrafts.staleCards('int-a')).map((d) => d.id)).toEqual([denied.id])
    expect(await s.assistantDrafts.staleCards('int-b')).toEqual([])
    await s.assistantDrafts.markCard(denied.id, 'denied')
    expect(await s.assistantDrafts.staleCards('int-a')).toEqual([])
  })
})

describe('assistant drafts: what the Activity view lists', () => {
  it('lists only the agent’s drafts still awaiting review, the soonest to lapse first', async () => {
    const s = await open()
    const later = await create(s, { now: 5_000 })
    const sooner = await create(s, { now: 1_000 })
    const decided = await create(s, { now: 1_000 })
    await s.assistantDrafts.deny(decided.id, BY, 2_000)
    const lapsed = await create(s, { now: 2_000 - ASSISTANT_DRAFT_TTL_MS })
    await create(s, { agentId: 'agent-b', now: 1_000 })
    const pending = await s.assistantDrafts.listPending(AGENT, 10, 3_000)
    expect(pending.map((d) => d.id)).toEqual([sooner.id, later.id])
    expect(pending.map((d) => d.id)).not.toContain(lapsed.id)
    expect((await s.assistantDrafts.listPending(AGENT, 1, 3_000)).map((d) => d.id)).toEqual([sooner.id])
  })
})

describe.skipIf(usingPostgresStore())('the v36 → v37 draft tables on SQLite', () => {
  const tables = (path: string): string[] => {
    const db = new DatabaseSync(path)
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'assistant_%' ORDER BY name")
      .all() as { name: string }[]
    db.close()
    return rows.map((row) => row.name)
  }

  it('adds the draft table to a v36 store and stamps the current version', async () => {
    expect(SCHEMA_VERSION).toBe(47)
    const path = tempStorePath('ac-assistant-v36-')
    await (await LocalStore.open(path)).close()
    const old = new DatabaseSync(path)
    old.exec('DROP TABLE assistant_draft; PRAGMA user_version = 36')
    old.close()
    expect(tables(path)).not.toContain('assistant_draft')

    const upgraded = await LocalStore.open(path)
    try {
      expect((await create(upgraded)).status).toBe('awaiting_review')
    } finally {
      await upgraded.close()
    }
    expect(tables(path)).toEqual(expect.arrayContaining(['assistant_draft', 'assistant_item']))
    // Post grants are gone: a fresh store no longer creates their tables.
    expect(tables(path)).not.toContain('assistant_post_grant')
    const db = new DatabaseSync(path)
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION)
    db.close()
  })
})

describe.skipIf(usingPostgresStore())('the v45 → v46 card status on SQLite', () => {
  it('adds the column and leaves the cards already settled alone', async () => {
    const path = tempStorePath('ac-assistant-v45-')
    const first = await LocalStore.open(path)
    const kept = await create(first)
    await first.assistantDrafts.setCard(kept.id, '111.222')
    await first.assistantDrafts.deny(kept.id, BY, 2_000)
    await first.close()
    const old = new DatabaseSync(path)
    old.exec('ALTER TABLE assistant_draft DROP COLUMN cardShows; PRAGMA user_version = 45')
    old.close()

    const upgraded = await LocalStore.open(path)
    try {
      expect(await upgraded.assistantDrafts.get(kept.id)).toMatchObject({
        status: 'denied',
        cardTs: '111.222',
        cardShows: null
      })
      expect(await upgraded.assistantDrafts.staleCards('int-a')).toEqual([])
      const draft = await create(upgraded)
      await upgraded.assistantDrafts.setCard(draft.id, '111.333')
      expect((await upgraded.assistantDrafts.get(draft.id))?.cardShows).toBe('awaiting_review')
    } finally {
      await upgraded.close()
    }
    const db = new DatabaseSync(path)
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION)
    db.close()
  })
})

describe.skipIf(!usingPostgresStore())('the v45 → v46 card status on PostgreSQL', () => {
  it('adds the column and leaves the cards already settled alone', async () => {
    const databaseUrl = process.env.DATA_PLANE_TEST_DATABASE_URL!
    const schema = `mig_${randomUUID().replace(/-/g, '')}`
    const config = { version: 1 as const, databaseUrl, maxConnections: 2 }
    const orgForAgent = (): string => 'org-a'
    const admin = new pg.Client({ connectionString: databaseUrl })
    await admin.connect()
    try {
      const fresh = await PostgresAsyncDatabase.open(config, () => undefined, schema)
      await fresh.finishSchemaInitialization()
      const first = await LocalStore.open({ database: fresh, shared: true, ownerId: 'm1', orgForAgent })
      const kept = await create(first)
      await first.assistantDrafts.setCard(kept.id, '111.222')
      await first.assistantDrafts.deny(kept.id, BY, 2_000)
      await first.close()

      await admin.query(`SET search_path TO ${schema}`)
      await admin.query('ALTER TABLE assistant_draft DROP COLUMN cardShows')
      await admin.query('UPDATE _local_store_schema_version SET version = 45 WHERE singleton = true')

      const database = await PostgresAsyncDatabase.open(config, () => undefined, schema)
      await database.finishSchemaInitialization()
      const upgraded = await LocalStore.open({ database, shared: true, ownerId: 'm2', orgForAgent })
      try {
        expect(await upgraded.assistantDrafts.get(kept.id)).toMatchObject({ status: 'denied', cardShows: null })
        expect(await upgraded.assistantDrafts.staleCards('int-a')).toEqual([])
        const draft = await create(upgraded)
        await upgraded.assistantDrafts.setCard(draft.id, '111.333')
        expect((await upgraded.assistantDrafts.get(draft.id))?.cardShows).toBe('awaiting_review')
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

describe.skipIf(!usingPostgresStore())('the v36 → v37 draft tables on PostgreSQL', () => {
  it('adds the draft table to a v36 store and keeps its items', async () => {
    const databaseUrl = process.env.DATA_PLANE_TEST_DATABASE_URL!
    const schema = `mig_${randomUUID().replace(/-/g, '')}`
    const config = { version: 1 as const, databaseUrl, maxConnections: 2 }
    const orgForAgent = (): string => 'org-a'
    const admin = new pg.Client({ connectionString: databaseUrl })
    await admin.connect()
    try {
      const fresh = await PostgresAsyncDatabase.open(config, () => undefined, schema)
      await fresh.finishSchemaInitialization()
      const first = await LocalStore.open({ database: fresh, shared: true, ownerId: 'm1', orgForAgent })
      const item = await first.assistantItems.create({
        agentId: AGENT,
        title: 'Kept across the upgrade',
        origin: { platform: 'slack', channel: 'C0GENERAL', transportScope: null }
      })
      await first.close()

      await admin.query(`SET search_path TO ${schema}`)
      await admin.query('DROP TABLE assistant_draft')
      await admin.query('UPDATE _local_store_schema_version SET version = 36 WHERE singleton = true')

      const database = await PostgresAsyncDatabase.open(config, () => undefined, schema)
      await database.finishSchemaInitialization()
      const upgraded = await LocalStore.open({ database, shared: true, ownerId: 'm2', orgForAgent })
      try {
        expect((await upgraded.assistantItems.get(AGENT, item.id))?.title).toBe('Kept across the upgrade')
        const draft = await create(upgraded)
        expect(await upgraded.assistantDrafts.get(draft.id)).toMatchObject({
          status: 'awaiting_review',
          target: TARGET,
          approver: { kind: 'member', userId: 'U0ALICE' }
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

  it('lets one of two pool members begin the same approval', async () => {
    const databaseUrl = process.env.DATA_PLANE_TEST_DATABASE_URL!
    const members: LocalStore[] = []
    try {
      for (let i = 0; i < 2; i++) {
        const database = await PostgresAsyncDatabase.open({ version: 1, databaseUrl, maxConnections: 4 })
        members.push(
          await LocalStore.open({ database, shared: true, ownerId: randomUUID(), orgForAgent: () => 'org-a' })
        )
        await database.finishSchemaInitialization()
      }
      const [a, b] = members as [LocalStore, LocalStore]
      const draft = await create(a)
      expect((await b.assistantDrafts.get(draft.id))?.text).toBe('The release is out.')
      const results = await Promise.all([
        a.assistantDrafts.begin(draft.id, BY, 2_000),
        b.assistantDrafts.begin(draft.id, BY, 2_000)
      ])
      expect(results.filter(Boolean)).toHaveLength(1)
    } finally {
      for (const member of members) await member.close()
    }
  })
})
