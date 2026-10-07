// The assistant item ledger (assistant-mode.md §5.4 ①): one contract suite, run on SQLite by default and on PostgreSQL by store-postgres.
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { Daemon } from '../src/daemon.js'
import {
  ASSISTANT_ITEM_OBSERVATIONS_KEPT,
  ASSISTANT_ITEM_SCHEMA,
  type AssistantPlace,
  type AssistantTrust,
  type AssistantTrustLookup
} from '../src/store/assistant-items.js'
import { LocalStore } from '../src/store/local-store.js'
import { PostgresAsyncDatabase } from '../src/store/postgres-async-database.js'
import { canonicalColumns, POOL_STORE_SCHEMA } from '../src/store/postgres-dialect.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import { openTestStore, usingPostgresStore } from './store-support.js'

const AGENT = 'agent-a'
const OTHER_AGENT = 'agent-b'
const GENERAL: AssistantPlace = { platform: 'slack', channel: 'C0GENERAL', transportScope: 'T0EXAMPLE' }
const SHARED: AssistantPlace = { platform: 'slack', channel: 'C0SHARED', transportScope: 'T0EXAMPLE' }
const DM: AssistantPlace = { platform: 'slack', channel: 'D0ALICE', transportScope: 'T0EXAMPLE' }
const WEBCHAT: AssistantPlace = { platform: 'webchat', channel: 'conv-1', transportScope: null }
const ALICE = 'slack:T0EXAMPLE:U0ALICE'
const BOB = 'slack:T0EXAMPLE:U0BOB'

const levels = new Map<string, AssistantTrust>([
  [GENERAL.channel, 'internal'],
  [DM.channel, 'internal'],
  [WEBCHAT.channel, 'internal'],
  [SHARED.channel, 'external']
])
const trustOf: AssistantTrustLookup = (place) => levels.get(place.channel)

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
  s.assistantItems.create(
    {
      agentId: AGENT,
      title: 'Ship the release notes',
      origin: GENERAL,
      followers: [{ identity: ALICE, place: GENERAL }],
      now: 1_000,
      ...overrides
    },
    trustOf
  )

describe('assistant item ledger: create and read', () => {
  it('round-trips a record, with an absent transport scope reading back as null', async () => {
    const s = await open()
    const item = await create(s, {
      doneWhen: 'notes are posted',
      nextCheck: 5_000,
      summary: 'Alice asked for the notes.',
      origin: WEBCHAT,
      followers: [
        { identity: 'user:u-1', place: WEBCHAT },
        { identity: 'user:u-1', place: WEBCHAT }
      ]
    })
    expect(item).toEqual({
      id: expect.any(String),
      agentId: AGENT,
      title: 'Ship the release notes',
      doneWhen: 'notes are posted',
      nextCheck: 5_000,
      status: 'active',
      followers: [{ identity: 'user:u-1', place: WEBCHAT }],
      origin: WEBCHAT,
      trust: 'internal',
      summary: 'Alice asked for the notes.',
      observations: [],
      observationVersion: 0,
      subsessions: [],
      proposals: [],
      version: 1,
      createdAt: 1_000,
      updatedAt: 1_000
    })
    expect(await s.assistantItems.get(AGENT, item.id)).toEqual(item)
  })

  it('is partitioned by agent: another agent cannot read, change or delete the item', async () => {
    const s = await open()
    const item = await create(s)
    expect(await s.assistantItems.get(OTHER_AGENT, item.id)).toBeUndefined()
    expect(await s.assistantItems.list(OTHER_AGENT)).toEqual([])
    expect(
      await s.assistantItems.attachFollower(OTHER_AGENT, item.id, { identity: BOB, place: SHARED }, trustOf)
    ).toBeUndefined()
    expect(await s.assistantItems.appendObservation(OTHER_AGENT, item.id, { text: 'nope' })).toBeUndefined()
    expect(await s.assistantItems.transition(OTHER_AGENT, item.id, 1, { status: 'done' })).toEqual({
      ok: false,
      reason: 'not_found'
    })
    expect(await s.assistantItems.link(OTHER_AGENT, item.id, 'subsession', 'sess-1')).toBe(false)
    expect(await s.assistantItems.delete(OTHER_AGENT, item.id)).toBe(false)
    expect(await s.assistantItems.get(AGENT, item.id)).toEqual(item)
  })

  it('takes the lowest trust among the origin and the followers, unknown counting as external', async () => {
    const s = await open()
    expect((await create(s, { followers: [{ identity: BOB, place: SHARED }] })).trust).toBe('external')
    const unknown: AssistantPlace = { platform: 'telegram', channel: '-100123', transportScope: 'bot-1' }
    expect((await create(s, { origin: unknown, followers: [] })).trust).toBe('external')
    expect((await create(s, { followers: [] })).trust).toBe('internal')
  })

  it('refuses malformed input before writing anything', async () => {
    const s = await open()
    await expect(create(s, { title: '  ' })).rejects.toThrow('title')
    await expect(create(s, { followers: [{ identity: 'U0ALICE', place: GENERAL }] })).rejects.toThrow('identity')
    await expect(create(s, { nextCheck: -1 })).rejects.toThrow('nextCheck')
    await expect(create(s, { status: 'paused' as never })).rejects.toThrow('status')
    await expect(create(s, { title: 'x'.repeat(301) })).rejects.toThrow('300')
    expect(await s.assistantItems.list(AGENT)).toEqual([])
  })
})

describe('assistant item ledger: list', () => {
  it('filters by status, follower identity, follower place and origin, newest first', async () => {
    const s = await open()
    const a = await create(s, { title: 'a', now: 1_000 })
    const b = await create(s, { title: 'b', now: 2_000, origin: DM, followers: [{ identity: BOB, place: DM }] })
    const c = await create(s, {
      title: 'c',
      now: 3_000,
      status: 'waiting',
      followers: [{ identity: BOB, place: SHARED }]
    })
    await s.assistantItems.create({ agentId: OTHER_AGENT, title: 'other', origin: GENERAL, now: 4_000 }, trustOf)
    const ids = (items: { id: string }[]) => items.map((item) => item.id)

    expect(ids(await s.assistantItems.list(AGENT))).toEqual([c.id, b.id, a.id])
    expect(ids(await s.assistantItems.list(AGENT, { status: 'active' }))).toEqual([b.id, a.id])
    expect(ids(await s.assistantItems.list(AGENT, { status: ['waiting', 'done'] }))).toEqual([c.id])
    expect(ids(await s.assistantItems.list(AGENT, { followerIdentity: BOB }))).toEqual([c.id, b.id])
    expect(ids(await s.assistantItems.list(AGENT, { place: SHARED }))).toEqual([c.id])
    expect(ids(await s.assistantItems.list(AGENT, { place: { ...SHARED, transportScope: 'T0OTHER' } }))).toEqual([])
    expect(ids(await s.assistantItems.list(AGENT, { origin: GENERAL }))).toEqual([c.id, a.id])
    expect(ids(await s.assistantItems.list(AGENT, { followerIdentity: BOB, origin: GENERAL }))).toEqual([c.id])
    expect(ids(await s.assistantItems.list(AGENT, { limit: 2 }))).toEqual([c.id, b.id])
    const [listed] = await s.assistantItems.list(AGENT, { place: SHARED })
    expect(listed).not.toHaveProperty('observations')
    expect(listed).toMatchObject({ followers: [{ identity: BOB, place: SHARED }], trust: 'external' })
  })
})

describe('assistant item ledger: followers and trust', () => {
  it('attaches idempotently on (identity, place) and lowers trust without touching the CAS version', async () => {
    const s = await open()
    const item = await create(s)
    const items = s.assistantItems
    expect(await items.attachFollower(AGENT, item.id, { identity: ALICE, place: GENERAL }, trustOf, 2_000)).toEqual({
      added: false,
      trust: 'internal'
    })
    expect(await items.attachFollower(AGENT, item.id, { identity: ALICE, place: DM }, trustOf, 3_000)).toEqual({
      added: true,
      trust: 'internal'
    })
    expect(await items.attachFollower(AGENT, item.id, { identity: BOB, place: SHARED }, trustOf, 4_000)).toEqual({
      added: true,
      trust: 'external'
    })
    const after = await items.get(AGENT, item.id)
    expect(after?.followers).toEqual([
      { identity: ALICE, place: GENERAL },
      { identity: ALICE, place: DM },
      { identity: BOB, place: SHARED }
    ])
    expect(after).toMatchObject({ trust: 'external', version: 1, updatedAt: 4_000 })
    expect(await items.attachFollower(AGENT, 'missing', { identity: BOB, place: DM }, trustOf)).toBeUndefined()
  })

  it('re-derives trust when a place is downgraded', async () => {
    const s = await open()
    const item = await create(s, { followers: [{ identity: ALICE, place: DM }] })
    expect(await s.assistantItems.recomputeTrust(AGENT, item.id, trustOf)).toBe('internal')
    const downgraded: AssistantTrustLookup = (place) => (place.channel === DM.channel ? 'external' : trustOf(place))
    expect(await s.assistantItems.recomputeTrust(AGENT, item.id, downgraded)).toBe('external')
    expect((await s.assistantItems.get(AGENT, item.id))?.trust).toBe('external')
    expect(await s.assistantItems.recomputeTrust(AGENT, 'missing', trustOf)).toBeUndefined()
  })
})

describe('assistant item ledger: observations', () => {
  it('appends without a version check and keeps only the newest entries', async () => {
    const s = await open()
    const item = await create(s)
    const total = ASSISTANT_ITEM_OBSERVATIONS_KEPT + 3
    for (let i = 1; i <= total; i += 1) {
      const appended = await s.assistantItems.appendObservation(AGENT, item.id, {
        text: `check ${i}`,
        author: i === total ? 'patrol' : undefined,
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
      author: 'patrol',
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

describe('assistant item ledger: transitions', () => {
  it('applies a patch on the expected version and reports a stale one as a conflict', async () => {
    const s = await open()
    const item = await create(s, { nextCheck: 9_000 })
    const moved = await s.assistantItems.transition(AGENT, item.id, 1, { status: 'waiting', nextCheck: 12_000 }, 2_000)
    expect(moved).toMatchObject({
      ok: true,
      item: { status: 'waiting', nextCheck: 12_000, version: 2, updatedAt: 2_000 }
    })
    const stale = await s.assistantItems.transition(AGENT, item.id, 1, { status: 'done' }, 3_000)
    expect(stale).toMatchObject({ ok: false, reason: 'conflict', current: { status: 'waiting', version: 2 } })
    const edited = await s.assistantItems.transition(
      AGENT,
      item.id,
      2,
      { status: 'done', nextCheck: null, doneWhen: null, title: 'Release notes', summary: 'Posted.' },
      4_000
    )
    expect(edited).toMatchObject({
      ok: true,
      item: { status: 'done', nextCheck: null, doneWhen: null, title: 'Release notes', summary: 'Posted.', version: 3 }
    })
    expect(await s.assistantItems.transition(AGENT, 'missing', 1, { status: 'done' })).toEqual({
      ok: false,
      reason: 'not_found'
    })
    await expect(s.assistantItems.transition(AGENT, item.id, 3, {})).rejects.toThrow('at least one field')
  })

  it('lets exactly one of two racing transitions on one version win', async () => {
    const s = await open()
    const item = await create(s)
    const results = await Promise.all([
      s.assistantItems.transition(AGENT, item.id, 1, { status: 'done' }),
      s.assistantItems.transition(AGENT, item.id, 1, { status: 'dropped' })
    ])
    expect(results.filter((result) => result.ok)).toHaveLength(1)
    expect(results.filter((result) => !result.ok && result.reason === 'conflict')).toHaveLength(1)
    expect((await s.assistantItems.get(AGENT, item.id))?.version).toBe(2)
  })
})

describe('assistant item ledger: links and deletion', () => {
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
    expect(await items.get(AGENT, item.id)).toMatchObject({
      subsessions: ['sess-2'],
      proposals: ['prop-1'],
      updatedAt: 5_000
    })
    expect(await items.link(AGENT, 'missing', 'proposal', 'prop-1')).toBe(false)
  })

  it('deletes one item with its children, and every item of a deleted agent', async () => {
    const s = await open()
    const doomed = await create(s)
    const kept = await create(s)
    const elsewhere = await s.assistantItems.create(
      { agentId: OTHER_AGENT, title: 'other', origin: GENERAL, followers: [{ identity: ALICE, place: GENERAL }] },
      trustOf
    )
    await s.assistantItems.appendObservation(AGENT, doomed.id, { text: 'seen' })
    await s.assistantItems.link(AGENT, doomed.id, 'proposal', 'prop-1')
    expect(await s.assistantItems.delete(AGENT, doomed.id)).toBe(true)
    expect(await s.assistantItems.delete(AGENT, doomed.id)).toBe(false)
    expect(await s.assistantItems.get(AGENT, doomed.id)).toBeUndefined()
    expect((await s.assistantItems.list(AGENT)).map((item) => item.id)).toEqual([kept.id])

    expect(await s.assistantItems.deleteForAgent(AGENT)).toBe(1)
    expect(await s.assistantItems.list(AGENT)).toEqual([])
    expect(await s.assistantItems.get(OTHER_AGENT, elsewhere.id)).toMatchObject({ followers: [{ identity: ALICE }] })
  })
})

describe('assistant item ledger schema', () => {
  it('lists every camelCase column in canonicalColumns', () => {
    const names = new Set([...ASSISTANT_ITEM_SCHEMA.matchAll(/\b[a-z]+[A-Z][A-Za-z]*\b/g)].map((m) => m[0]))
    const canonical = new Set<string>(canonicalColumns)
    expect([...names].filter((name) => !canonical.has(name))).toEqual([])
    expect(names.size).toBeGreaterThan(10)
  })
})

// Two pool members on their own connections, plus a raw client holding the item's row lock.
describe.skipIf(!usingPostgresStore())('assistant item ledger across PostgreSQL pool members', () => {
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

  it('keeps the lower trust when two members attach followers at once', async () => {
    const a = await member()
    const b = await member()
    const item = await create(a)
    const holder = await lockedItem(item.id)
    const external = a.assistantItems.attachFollower(AGENT, item.id, { identity: BOB, place: SHARED }, trustOf)
    const internal = b.assistantItems.attachFollower(AGENT, item.id, { identity: ALICE, place: DM }, trustOf)
    expect(await settledWithin(Promise.race([external, internal]), 300)).toBe(false)
    await holder.query('COMMIT')
    await Promise.all([external, internal])
    expect(await b.assistantItems.get(AGENT, item.id)).toMatchObject({ trust: 'external' })
    expect((await a.assistantItems.get(AGENT, item.id))?.followers).toHaveLength(3)
  })

  it('reads the same item from either member and lets one CAS win', async () => {
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
      a.assistantItems.transition(AGENT, item.id, 1, { status: 'done' }),
      b.assistantItems.transition(AGENT, item.id, 1, { status: 'dropped' })
    ])
    expect(results.filter((result) => result.ok)).toHaveLength(1)
  })

  it('leaves no orphaned children when a link races a delete', async () => {
    const a = await member()
    const b = await member()
    const item = await create(a)
    const holder = await lockedItem(item.id)
    const deleting = a.assistantItems.delete(AGENT, item.id)
    const linking = b.assistantItems.link(AGENT, item.id, 'subsession', 'sess-1')
    expect(await settledWithin(Promise.race([deleting, linking]), 300)).toBe(false)
    await holder.query('COMMIT')
    expect(await deleting).toBe(true)
    await linking
    const orphans = await holder.query('SELECT COUNT(*)::int AS n FROM assistant_item_link WHERE itemid = $1', [
      item.id
    ])
    expect(orphans.rows[0].n).toBe(0)
  })
})

describe.skipIf(usingPostgresStore())('assistant items on agent removal', () => {
  const dirs: string[] = []
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  })

  it('drops the agent’s items when the control plane removes the agent', async () => {
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
      const mine = await seam.store.assistantItems.create({ agentId, title: 'mine', origin: GENERAL }, trustOf)
      const theirs = await seam.store.assistantItems.create(
        { agentId: OTHER_AGENT, title: 'theirs', origin: GENERAL },
        trustOf
      )
      await seam.cpConfigApply().applyAgentRemove(agentId)
      expect(await seam.store.assistantItems.get(agentId, mine.id)).toBeUndefined()
      expect(await seam.store.assistantItems.get(OTHER_AGENT, theirs.id)).toBeDefined()
    } finally {
      await daemon.stop()
    }
  })
})
