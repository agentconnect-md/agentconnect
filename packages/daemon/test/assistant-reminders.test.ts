// Assistant-mode reminders in the store (assistant-mode.md §5.9): one contract suite, run on SQLite by default and on PostgreSQL by store-postgres.
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import pg from 'pg'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { Daemon } from '../src/daemon.js'
import type { AssistantPlace } from '../src/store/assistant-items.js'
import { ASSISTANT_REMINDER_PENDING_MAX, type AssistantReminderCreate } from '../src/store/assistant-reminders.js'
import { LocalStore, SCHEMA_VERSION } from '../src/store/local-store.js'
import { PostgresAsyncDatabase } from '../src/store/postgres-async-database.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
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

const GENERAL: AssistantPlace = { platform: 'slack', channel: 'C0GENERAL', transportScope: 'T0EXAMPLE' }
const DM: AssistantPlace = { platform: 'slack', channel: 'D0ALICE', transportScope: 'T0EXAMPLE' }

const reminder = (agentId: string, over: Partial<AssistantReminderCreate> = {}): AssistantReminderCreate => ({
  id: randomUUID(),
  agentId,
  place: GENERAL,
  integrationId: 'int-1',
  thread: 'append:1',
  targetThread: '1700000000.000100',
  targetDm: false,
  message: 'Send the weekly report.',
  dueAt: 5_000,
  requesterId: 'U0ALICE',
  now: 1_000,
  ...over
})

describe('the assistant reminder ledger', () => {
  it('records a reminder in its conversation and reads it back', async () => {
    const s = await open()
    const a = agent()
    const input = reminder(a, { place: { ...DM, transportScope: null }, targetThread: null, targetDm: true })
    const created = await s.assistantReminders.create(input)
    expect(created).toEqual({
      id: input.id,
      agentId: a,
      place: { platform: 'slack', channel: 'D0ALICE', transportScope: null },
      integrationId: 'int-1',
      thread: 'append:1',
      targetThread: null,
      targetDm: true,
      message: 'Send the weekly report.',
      dueAt: 5_000,
      status: 'pending',
      attempts: 0,
      requesterId: 'U0ALICE',
      messageId: null,
      draftId: null,
      failure: null,
      createdAt: 1_000,
      updatedAt: 1_000,
      settledAt: null
    })
    expect(await s.assistantReminders.get(agent(), input.id)).toBeUndefined()
  })

  it('holds at most the cap of open reminders per agent', async () => {
    const s = await open()
    const [a, b] = [agent(), agent()]
    expect(await s.assistantReminders.create(reminder(a), 2)).toBeDefined()
    const second = await s.assistantReminders.create(reminder(a, { place: DM }), 2)
    expect(second).toBeDefined()
    expect(await s.assistantReminders.create(reminder(a), 2)).toBeUndefined()
    // Another agent has its own cap, and a reminder that left the open set frees a place.
    expect(await s.assistantReminders.create(reminder(b), 2)).toBeDefined()
    await s.assistantReminders.cancel(a, second!.id, DM, 2_000)
    expect(await s.assistantReminders.create(reminder(a), 2)).toBeDefined()
    expect(ASSISTANT_REMINDER_PENDING_MAX).toBe(100)
  })

  it('lists and cancels only within the conversation it was set in', async () => {
    const s = await open()
    const a = agent()
    const late = await s.assistantReminders.create(reminder(a, { dueAt: 9_000 }))
    const soon = await s.assistantReminders.create(reminder(a, { dueAt: 6_000 }))
    const inDm = await s.assistantReminders.create(reminder(a, { place: DM }))
    expect((await s.assistantReminders.listOpen(a, GENERAL)).map((r) => r.id)).toEqual([soon!.id, late!.id])
    expect((await s.assistantReminders.listOpen(a, DM)).map((r) => r.id)).toEqual([inDm!.id])
    expect(await s.assistantReminders.listOpen(a, { ...GENERAL, transportScope: 'T0OTHER' })).toEqual([])
    // Another conversation reads as if there were no such reminder, and changes nothing.
    expect(await s.assistantReminders.cancel(a, inDm!.id, GENERAL, 2_000)).toBeUndefined()
    expect((await s.assistantReminders.get(a, inDm!.id))?.status).toBe('pending')
    expect(await s.assistantReminders.cancel(a, soon!.id, GENERAL, 2_000)).toMatchObject({
      status: 'cancelled',
      settledAt: 2_000
    })
    expect((await s.assistantReminders.listOpen(a, GENERAL)).map((r) => r.id)).toEqual([late!.id])
  })

  it('claims a due reminder once, and settles only a claimed one', async () => {
    const s = await open()
    const a = agent()
    const r = (await s.assistantReminders.create(reminder(a)))!
    expect(await s.assistantReminders.due(a, 4_999, 10)).toEqual([])
    expect((await s.assistantReminders.due(a, 5_000, 10)).map((d) => d.id)).toEqual([r.id])
    const claims = await Promise.all([1, 2, 3].map(() => s.assistantReminders.claim(a, r.id, 5_000)))
    expect(claims.filter((c) => c !== undefined)).toEqual([1])
    expect(await s.assistantReminders.due(a, 6_000, 10)).toEqual([])
    // A claimed reminder can no longer be cancelled.
    expect(await s.assistantReminders.cancel(a, r.id, GENERAL, 5_001)).toMatchObject({ status: 'delivering' })
    expect(await s.assistantReminders.settle(a, r.id, { status: 'delivered', messageId: 'ts-1' }, 5_002)).toBe(true)
    expect(await s.assistantReminders.settle(a, r.id, { status: 'failed', failure: 'late' }, 5_003)).toBe(false)
    expect(await s.assistantReminders.get(a, r.id)).toMatchObject({
      status: 'delivered',
      attempts: 1,
      messageId: 'ts-1',
      settledAt: 5_002
    })
    expect(await s.assistantReminders.claim(a, r.id, 6_000)).toBeUndefined()
  })

  it('releases a claim after a platform error and counts the attempt', async () => {
    const s = await open()
    const a = agent()
    const r = (await s.assistantReminders.create(reminder(a)))!
    expect(await s.assistantReminders.claim(a, r.id, 5_000)).toBe(1)
    expect(await s.assistantReminders.release(a, r.id, 'ratelimited', 5_001)).toBe(true)
    expect(await s.assistantReminders.get(a, r.id)).toMatchObject({
      status: 'pending',
      attempts: 1,
      failure: 'ratelimited'
    })
    expect(await s.assistantReminders.claim(a, r.id, 6_000)).toBe(2)
    expect(await s.assistantReminders.settle(a, r.id, { status: 'drafted', draftId: 'draft-1' }, 6_001)).toBe(true)
    expect(await s.assistantReminders.get(a, r.id)).toMatchObject({
      status: 'drafted',
      attempts: 2,
      draftId: 'draft-1'
    })
  })

  it('expires the long overdue and fails a stale claim, never handing either out again', async () => {
    const s = await open()
    const a = agent()
    const old = (await s.assistantReminders.create(reminder(a, { dueAt: 1_000 })))!
    const recent = (await s.assistantReminders.create(reminder(a, { dueAt: 3_000 })))!
    const cut = (await s.assistantReminders.create(reminder(a, { dueAt: 2_500 })))!
    const fresh = (await s.assistantReminders.create(reminder(a, { dueAt: 2_600 })))!
    expect(await s.assistantReminders.claim(a, cut.id, 2_500)).toBe(1)
    expect(await s.assistantReminders.claim(a, fresh.id, 4_000)).toBe(1)
    expect(await s.assistantReminders.expireOverdue(a, 2_000, 5_000)).toBe(1)
    expect(await s.assistantReminders.failStaleClaims(a, 3_000, 5_000)).toEqual([cut.id])
    expect((await s.assistantReminders.get(a, old.id))?.status).toBe('expired')
    expect(await s.assistantReminders.get(a, cut.id)).toMatchObject({ status: 'failed', failure: expect.any(String) })
    expect((await s.assistantReminders.get(a, fresh.id))?.status).toBe('delivering')
    expect((await s.assistantReminders.due(a, 10_000, 10)).map((d) => d.id)).toEqual([recent.id])
  })

  it('drops only the removed agent’s reminders', async () => {
    const s = await open()
    const [a, b] = [agent(), agent()]
    await s.assistantReminders.create(reminder(a))
    await s.assistantReminders.create(reminder(a, { place: DM }))
    const kept = await s.assistantReminders.create(reminder(b))
    expect(await s.assistantReminders.deleteForAgent(a)).toBe(2)
    expect(await s.assistantReminders.listOpen(a, GENERAL)).toEqual([])
    expect(await s.assistantReminders.get(b, kept!.id)).toBeDefined()
  })
})

describe.skipIf(usingPostgresStore())('the v41 → v42 reminder table on SQLite', () => {
  it('adds the table to a v41 store and stamps the current version', async () => {
    expect(SCHEMA_VERSION).toBe(42)
    const path = tempStorePath('ac-assistant-v41-')
    await (await LocalStore.open(path)).close()
    const old = new DatabaseSync(path)
    old.exec('DROP TABLE assistant_reminder; PRAGMA user_version = 41')
    old.close()

    const upgraded = await LocalStore.open(path)
    const a = agent()
    try {
      const r = await upgraded.assistantReminders.create(reminder(a))
      expect((await upgraded.assistantReminders.get(a, r!.id))?.status).toBe('pending')
    } finally {
      await upgraded.close()
    }
    const db = new DatabaseSync(path)
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'index') AND name LIKE 'assistant_reminder%'")
      .all() as { name: string }[]
    expect(tables.map((t) => t.name).sort()).toEqual([
      'assistant_reminder',
      'assistant_reminder_by_place',
      'assistant_reminder_due'
    ])
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION)
    db.close()
  })

  it('survives reopening the store', async () => {
    const path = tempStorePath('ac-assistant-reminders-')
    const a = agent()
    const first = await LocalStore.open(path)
    const r = await first.assistantReminders.create(reminder(a))
    await first.close()
    const reopened = await LocalStore.open(path)
    try {
      expect((await reopened.assistantReminders.get(a, r!.id))?.message).toBe('Send the weekly report.')
    } finally {
      await reopened.close()
    }
  })
})

describe.skipIf(!usingPostgresStore())('the v41 → v42 reminder table on PostgreSQL', () => {
  it('adds the table to a v41 store and keeps the other assistant tables', async () => {
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
      const item = await first.assistantItems.create({
        agentId: a,
        title: 'Kept across the upgrade',
        origin: { platform: 'slack', channel: 'C0GENERAL', transportScope: null }
      })
      await first.close()

      await admin.query(`SET search_path TO ${schema}`)
      await admin.query('DROP TABLE assistant_reminder')
      await admin.query('UPDATE _local_store_schema_version SET version = 41 WHERE singleton = true')

      const database = await PostgresAsyncDatabase.open(config, () => undefined, schema)
      await database.finishSchemaInitialization()
      const upgraded = await LocalStore.open({ database, shared: true, ownerId: 'm2', orgForAgent })
      try {
        expect((await upgraded.assistantItems.get(a, item.id))?.title).toBe('Kept across the upgrade')
        const r = await upgraded.assistantReminders.create(reminder(a, { dueAt: Date.now() + 60_000 }))
        expect(await upgraded.assistantReminders.get(a, r!.id)).toMatchObject({
          status: 'pending',
          targetThread: '1700000000.000100',
          requesterId: 'U0ALICE'
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

  it('lets one pool member claim a reminder another member sees due, once', async () => {
    const databaseUrl = process.env.DATA_PLANE_TEST_DATABASE_URL!
    const members: LocalStore[] = []
    const a = agent()
    try {
      for (let i = 0; i < 2; i++) {
        const database = await PostgresAsyncDatabase.open({ version: 1, databaseUrl, maxConnections: 4 })
        members.push(
          await LocalStore.open({ database, shared: true, ownerId: randomUUID(), orgForAgent: () => 'org-a' })
        )
        await database.finishSchemaInitialization()
      }
      const [first, second] = members as [LocalStore, LocalStore]
      const r = (await first.assistantReminders.create(reminder(a)))!
      expect((await second.assistantReminders.due(a, 5_000, 10)).map((d) => d.id)).toEqual([r.id])
      const claims = await Promise.all([first, second].map((m) => m.assistantReminders.claim(a, r.id, 5_000)))
      expect(claims.filter((c) => c !== undefined)).toEqual([1])
    } finally {
      for (const member of members) await member.close()
    }
  })
})

describe.skipIf(usingPostgresStore())('assistant reminders on agent removal', () => {
  const dirs: string[] = []
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  })

  it('drops the agent’s reminders when the control plane removes the agent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-arem-'))
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
        output: { mode: 'medium' },
        assistantMode: { enabled: true, responsibleUserId: 'user-1' }
      })
    )
    const idleHost = (a: { id: string }) =>
      ({
        id: a.id,
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
      const other = agent()
      const removed = (await seam.store.assistantReminders.create(reminder(agentId)))!
      const kept = (await seam.store.assistantReminders.create(reminder(other)))!
      await seam.cpConfigApply().applyAgentRemove(agentId)
      expect(await seam.store.assistantReminders.get(agentId, removed.id)).toBeUndefined()
      expect(await seam.store.assistantReminders.get(other, kept.id)).toBeDefined()
    } finally {
      await daemon.stop()
    }
  })
})
