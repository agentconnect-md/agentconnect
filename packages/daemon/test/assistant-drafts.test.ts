// Assistant-mode drafts and grants (assistant-mode.md §5.5, §5.10): one contract suite, run on SQLite by default and on PostgreSQL by store-postgres.
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import pg from 'pg'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ASSISTANT_DRAFT_TTL_MS,
  assistantDraftHash,
  assistantGrantId,
  type AssistantDraftCreate,
  type AssistantGrantPlace
} from '../src/store/assistant-drafts.js'
import { LocalStore, SCHEMA_VERSION } from '../src/store/local-store.js'
import { PostgresAsyncDatabase } from '../src/store/postgres-async-database.js'
import { openTestStore, tempStorePath, usingPostgresStore } from './store-support.js'

const AGENT = 'agent-a'
const TARGET = { platform: 'slack', integrationId: 'int-a', channel: 'C0SUPPORT', thread: null }
const HERE: AssistantGrantPlace = { platform: 'slack', integrationId: 'int-a', channel: 'D0ALICE' }
const THERE: AssistantGrantPlace = { platform: 'slack', integrationId: 'int-a', channel: 'C0SUPPORT' }
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
    offerAlways: true,
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
      offerAlways: true,
      grantEpoch: 0,
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
    const draft = await create(s, { source: null, approver: null, offerAlways: false })
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

describe('assistant drafts: "always allow from here to there"', () => {
  it('is keyed by the pair of places and never covers another source or target', async () => {
    const s = await open()
    expect(await s.assistantDrafts.granted(AGENT, HERE, THERE)).toBe(false)
    expect(await s.assistantDrafts.grant(AGENT, HERE, THERE, BY.id, 0, 1_000)).toBe(true)
    expect(await s.assistantDrafts.grant(AGENT, HERE, THERE, BY.id, 0, 2_000)).toBe(false)
    expect(await s.assistantDrafts.granted(AGENT, HERE, THERE)).toBe(true)
    expect(await s.assistantDrafts.granted(AGENT, { ...HERE, channel: 'D0BOB' }, THERE)).toBe(false)
    expect(await s.assistantDrafts.granted(AGENT, HERE, { ...THERE, channel: 'C0OTHER' })).toBe(false)
    expect(await s.assistantDrafts.granted(AGENT, THERE, HERE)).toBe(false)
    expect(await s.assistantDrafts.granted('agent-b', HERE, THERE)).toBe(false)
    const webchat = { platform: 'webchat', integrationId: null, channel: 'conv-1' }
    await s.assistantDrafts.grant(AGENT, webchat, THERE, null, 0, 1_000)
    expect(await s.assistantDrafts.granted(AGENT, webchat, THERE)).toBe(true)
  })

  it('ends with every mode switch, and goes with the agent and its drafts', async () => {
    const s = await open()
    await s.assistantDrafts.grant(AGENT, HERE, THERE, BY.id, 0, 1_000)
    await s.assistantDrafts.grant('agent-b', HERE, THERE, BY.id, 0, 1_000)
    expect(await s.assistantDrafts.resetGrants(AGENT)).toBe(1)
    expect(await s.assistantDrafts.granted(AGENT, HERE, THERE)).toBe(false)
    expect(await s.assistantDrafts.granted('agent-b', HERE, THERE)).toBe(true)
    const draft = await create(s, { agentId: 'agent-b' })
    expect(await s.assistantDrafts.deleteForAgent('agent-b')).toBe(1)
    expect(await s.assistantDrafts.get(draft.id)).toBeUndefined()
    expect(await s.assistantDrafts.granted('agent-b', HERE, THERE)).toBe(false)
  })

  it('never lets a card from before a reset grant, even one written while the reset ran', async () => {
    const s = await open()
    const old = await create(s)
    expect(old.grantEpoch).toBe(0)
    await s.assistantDrafts.resetGrants(AGENT)
    expect(await s.assistantDrafts.grantEpoch(AGENT)).toBe(1)
    expect(await s.assistantDrafts.grant(AGENT, HERE, THERE, BY.id, old.grantEpoch, 2_000)).toBe(false)
    expect(await s.assistantDrafts.granted(AGENT, HERE, THERE)).toBe(false)

    // A grant that slipped in under the old generation, after the reset's delete, is still not honored.
    await s.assistantDrafts['db'].query(
      `INSERT INTO assistant_post_grant (agentId, sourcePlatform, sourceIntegrationId, sourceChannel, targetPlatform,
         targetIntegrationId, targetChannel, grantedBy, grantedAt, grantEpoch) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [AGENT, 'slack', 'int-a', 'D0ALICE', 'slack', 'int-a', 'C0SUPPORT', BY.id, 2_000, 0]
    )
    expect(await s.assistantDrafts.granted(AGENT, HERE, THERE)).toBe(false)

    // A card of the current generation grants, replacing the stale row.
    const fresh = await create(s)
    expect(fresh.grantEpoch).toBe(1)
    expect(await s.assistantDrafts.grant(AGENT, HERE, THERE, BY.id, fresh.grantEpoch, 3_000)).toBe(true)
    expect(await s.assistantDrafts.granted(AGENT, HERE, THERE)).toBe(true)
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

  it('lists the current generation’s grants by a stable id, and revokes exactly the one named', async () => {
    const s = await open()
    const elsewhere = { ...THERE, channel: 'C0RELEASES' }
    await s.assistantDrafts.grant(AGENT, HERE, THERE, BY.id, 0, 1_000)
    await s.assistantDrafts.grant(AGENT, HERE, elsewhere, null, 0, 2_000)
    await s.assistantDrafts.grant('agent-b', HERE, THERE, BY.id, 0, 1_000)
    const grants = await s.assistantDrafts.listGrants(AGENT, 10)
    expect(grants).toEqual([
      { id: assistantGrantId(HERE, elsewhere), source: HERE, target: elsewhere, grantedBy: null, grantedAt: 2_000 },
      { id: assistantGrantId(HERE, THERE), source: HERE, target: THERE, grantedBy: BY.id, grantedAt: 1_000 }
    ])
    expect(grants[0]!.id).toMatch(/^[0-9a-f]{32}$/)
    expect(assistantGrantId(HERE, THERE)).not.toBe(assistantGrantId(THERE, HERE))

    // Another agent's id, or one that names nothing, revokes nothing.
    expect(await s.assistantDrafts.revokeGrant('agent-b', grants[0]!.id)).toBe(false)
    expect(await s.assistantDrafts.revokeGrant(AGENT, '0'.repeat(32))).toBe(false)
    expect(await s.assistantDrafts.revokeGrant(AGENT, assistantGrantId(HERE, THERE))).toBe(true)
    expect(await s.assistantDrafts.granted(AGENT, HERE, THERE)).toBe(false)
    expect(await s.assistantDrafts.granted(AGENT, HERE, elsewhere)).toBe(true)
    expect(await s.assistantDrafts.granted('agent-b', HERE, THERE)).toBe(true)
    expect(await s.assistantDrafts.revokeGrant(AGENT, assistantGrantId(HERE, THERE))).toBe(false)

    // A webchat source has no integration, and a reset hides what it ended.
    const webchat = { platform: 'webchat', integrationId: null, channel: 'conv-1' }
    await s.assistantDrafts.grant(AGENT, webchat, THERE, null, 0, 3_000)
    expect((await s.assistantDrafts.listGrants(AGENT, 1))[0]).toMatchObject({ source: webchat, grantedAt: 3_000 })
    await s.assistantDrafts.resetGrants(AGENT)
    expect(await s.assistantDrafts.listGrants(AGENT, 10)).toEqual([])
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

  it('adds both tables to a v36 store and stamps the current version', async () => {
    expect(SCHEMA_VERSION).toBe(41)
    const path = tempStorePath('ac-assistant-v36-')
    await (await LocalStore.open(path)).close()
    const old = new DatabaseSync(path)
    old.exec(
      'DROP TABLE assistant_draft; DROP TABLE assistant_post_grant; DROP TABLE assistant_grant_epoch; PRAGMA user_version = 36'
    )
    old.close()
    expect(tables(path)).not.toContain('assistant_draft')

    const upgraded = await LocalStore.open(path)
    try {
      expect((await create(upgraded)).status).toBe('awaiting_review')
      expect(await upgraded.assistantDrafts.grant(AGENT, HERE, THERE, null, 0, 1)).toBe(true)
    } finally {
      await upgraded.close()
    }
    expect(tables(path)).toEqual(
      expect.arrayContaining(['assistant_draft', 'assistant_grant_epoch', 'assistant_item', 'assistant_post_grant'])
    )
    const db = new DatabaseSync(path)
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION)
    db.close()
  })
})

describe.skipIf(!usingPostgresStore())('the v36 → v37 draft tables on PostgreSQL', () => {
  it('adds both tables to a v36 store and keeps its items', async () => {
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
      await admin.query('DROP TABLE assistant_post_grant')
      await admin.query('DROP TABLE assistant_grant_epoch')
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
        await upgraded.assistantDrafts.resetGrants(AGENT)
        expect(await upgraded.assistantDrafts.grant(AGENT, HERE, THERE, null, 1, 1)).toBe(true)
        expect(await upgraded.assistantDrafts.granted(AGENT, HERE, THERE)).toBe(true)
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
