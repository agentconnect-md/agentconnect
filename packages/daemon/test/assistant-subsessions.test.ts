// The assistant-mode sub-session index (assistant-mode.md §5.6): one contract suite, run on SQLite by default and on PostgreSQL by store-postgres.
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import pg from 'pg'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { Daemon } from '../src/daemon.js'
import { subsessionCoordinate } from '../src/session/subsession-coordinate.js'
import { LocalStore, SCHEMA_VERSION, sessionKey } from '../src/store/local-store.js'
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

const childKey = (agentId: string, id: string): string =>
  sessionKey('slack', 'C0GENERAL', subsessionCoordinate(id), agentId, 'T0EXAMPLE')

const row = (agentId: string, id: string, parentSessionId = 'sid-parent-1') => ({
  agentId,
  childSessionKey: childKey(agentId, id),
  parentSessionId,
  parentSessionKey: sessionKey('slack', 'C0GENERAL', 'append:1', agentId, 'T0EXAMPLE'),
  now: 1_000
})

describe('the assistant sub-session index', () => {
  it('records a delegation once, partitioned by agent', async () => {
    const s = await open()
    const a = agent()
    expect(await s.assistantSubsessions.open(row(a, '1'))).toBe(true)
    expect(await s.assistantSubsessions.open({ ...row(a, '1', 'sid-other'), now: 2_000 })).toBe(false)
    expect(await s.assistantSubsessions.get(a, childKey(a, '1'))).toEqual({
      agentId: a,
      childSessionKey: childKey(a, '1'),
      parentSessionId: 'sid-parent-1',
      parentSessionKey: sessionKey('slack', 'C0GENERAL', 'append:1', a, 'T0EXAMPLE'),
      state: 'open',
      createdAt: 1_000
    })
    expect(await s.assistantSubsessions.get(agent(), childKey(a, '1'))).toBeUndefined()
  })

  it('drops only the removed agent’s rows', async () => {
    const s = await open()
    const [a, b] = [agent(), agent()]
    await s.assistantSubsessions.open(row(a, '1'))
    await s.assistantSubsessions.open(row(a, '2'))
    await s.assistantSubsessions.open(row(b, '1'))
    expect(await s.assistantSubsessions.deleteForAgent(a)).toBe(2)
    expect(await s.assistantSubsessions.get(a, childKey(a, '1'))).toBeUndefined()
    expect(await s.assistantSubsessions.get(b, childKey(b, '1'))).toBeDefined()
  })

  it('drops a child’s row when its session is purged, and keeps its siblings', async () => {
    const s = await open()
    const a = agent()
    await s.assistantSubsessions.open(row(a, '1'))
    await s.assistantSubsessions.open(row(a, '2'))
    for (const id of ['1', '2']) {
      await s.upsertSession({
        key: childKey(a, id),
        agentId: a,
        platform: 'slack',
        channel: 'C0GENERAL',
        thread: subsessionCoordinate(id),
        transportScope: 'T0EXAMPLE',
        acpSessionId: `acp-${id}`,
        state: 'idle',
        lastDeliveredTs: null,
        updatedAt: 1_000
      })
    }
    expect(await s.deleteSession(childKey(a, '1'))).toBe(true)
    expect(await s.assistantSubsessions.get(a, childKey(a, '1'))).toBeUndefined()
    expect(await s.assistantSubsessions.get(a, childKey(a, '2'))).toBeDefined()
  })

  it('settles an open row once, to done or failed', async () => {
    const s = await open()
    const a = agent()
    await s.assistantSubsessions.open(row(a, '1'))
    await s.assistantSubsessions.open(row(a, '2'))
    expect(await s.assistantSubsessions.finish(a, childKey(a, '1'), 'done')).toBe(true)
    expect(await s.assistantSubsessions.finish(a, childKey(a, '1'), 'failed')).toBe(false)
    expect(await s.assistantSubsessions.finish(a, childKey(a, '2'), 'failed')).toBe(true)
    expect(await s.assistantSubsessions.finish(a, childKey(a, '3'), 'done')).toBe(false)
    expect((await s.assistantSubsessions.get(a, childKey(a, '1')))?.state).toBe('done')
    expect((await s.assistantSubsessions.get(a, childKey(a, '2')))?.state).toBe('failed')
  })

  it('opens below the limit only, counting the agent’s own open rows', async () => {
    const s = await open()
    const [a, b] = [agent(), agent()]
    const cap = { limit: 2, startedSince: 0 }
    expect(await s.assistantSubsessions.openWithinLimit(row(a, '1'), cap)).toBe(true)
    expect(await s.assistantSubsessions.openWithinLimit(row(a, '2'), cap)).toBe(true)
    expect(await s.assistantSubsessions.openWithinLimit(row(a, '3'), cap)).toBe(false)
    expect(await s.assistantSubsessions.get(a, childKey(a, '3'))).toBeUndefined()
    // Another agent's sub-sessions are its own.
    expect(await s.assistantSubsessions.openWithinLimit(row(b, '1'), cap)).toBe(true)
    // A settled row frees its place.
    await s.assistantSubsessions.finish(a, childKey(a, '1'), 'failed')
    expect(await s.assistantSubsessions.openWithinLimit(row(a, '3'), cap)).toBe(true)
    expect(await s.assistantSubsessions.get(a, childKey(a, '3'))).toMatchObject({ state: 'open', createdAt: 1_000 })
  })

  it('stops counting an open row whose session never appeared, once it is past the start grace', async () => {
    const s = await open()
    const a = agent()
    await s.assistantSubsessions.open(row(a, 'lost'))
    await s.assistantSubsessions.open(row(a, 'running'))
    await s.upsertSession({
      key: childKey(a, 'running'),
      agentId: a,
      platform: 'slack',
      channel: 'C0GENERAL',
      thread: subsessionCoordinate('running'),
      transportScope: 'T0EXAMPLE',
      acpSessionId: 'acp-running',
      state: 'prompting',
      lastDeliveredTs: null,
      updatedAt: 1_000
    })
    // Both rows were opened at 1_000: within the grace both count, past it only the one with a session does.
    const next = { ...row(a, 'next'), now: 2_000 }
    expect(await s.assistantSubsessions.openWithinLimit(next, { limit: 2, startedSince: 1_000 })).toBe(false)
    expect(await s.assistantSubsessions.openWithinLimit(next, { limit: 2, startedSince: 1_001 })).toBe(true)
    // The new row, still within its grace, counts beside the running one.
    expect(await s.assistantSubsessions.openWithinLimit(row(a, 'after'), { limit: 2, startedSince: 1_001 })).toBe(false)
  })

  it('lists the agent’s open rows first, then the newest, within the limit', async () => {
    const s = await open()
    const [a, b] = [agent(), agent()]
    await s.assistantSubsessions.open({ ...row(a, 'old-open'), now: 1_000 })
    await s.assistantSubsessions.open({ ...row(a, 'done'), now: 3_000 })
    await s.assistantSubsessions.open({ ...row(a, 'new-open'), now: 2_000 })
    await s.assistantSubsessions.open({ ...row(a, 'failed'), now: 4_000 })
    await s.assistantSubsessions.open(row(b, 'other'))
    await s.assistantSubsessions.finish(a, childKey(a, 'done'), 'done')
    await s.assistantSubsessions.finish(a, childKey(a, 'failed'), 'failed')
    const listed = await s.assistantSubsessions.list(a, 10)
    expect(listed.map((r) => [r.childSessionKey, r.state])).toEqual([
      [childKey(a, 'new-open'), 'open'],
      [childKey(a, 'old-open'), 'open'],
      [childKey(a, 'failed'), 'failed'],
      [childKey(a, 'done'), 'done']
    ])
    expect((await s.assistantSubsessions.list(a, 2)).map((r) => r.state)).toEqual(['open', 'open'])
  })

  it('lists one conversation’s rows newest first and pages from a row, ties broken by key', async () => {
    const s = await open()
    const [a, b] = [agent(), agent()]
    await s.assistantSubsessions.open({ ...row(a, '1'), now: 1_000 })
    await s.assistantSubsessions.open({ ...row(a, '3'), now: 2_000 })
    await s.assistantSubsessions.open({ ...row(a, '2'), now: 2_000 })
    await s.assistantSubsessions.open({ ...row(a, '4'), now: 3_000 })
    await s.assistantSubsessions.open({ ...row(a, 'elsewhere', 'sid-parent-2'), now: 4_000 })
    await s.assistantSubsessions.open({ ...row(b, '9'), now: 5_000 })
    await s.assistantSubsessions.finish(a, childKey(a, '4'), 'done')
    const keys = (rows: { childSessionKey: string }[]) => rows.map((r) => r.childSessionKey)

    const all = await s.assistantSubsessions.listForParent(a, 'sid-parent-1', { limit: 10 })
    expect(keys(all)).toEqual([childKey(a, '4'), childKey(a, '2'), childKey(a, '3'), childKey(a, '1')])
    const first = await s.assistantSubsessions.listForParent(a, 'sid-parent-1', { limit: 2 })
    expect(keys(first)).toEqual([childKey(a, '4'), childKey(a, '2')])
    const last = first.at(-1)!
    const next = await s.assistantSubsessions.listForParent(a, 'sid-parent-1', {
      limit: 2,
      after: { createdAt: last.createdAt, childSessionKey: last.childSessionKey }
    })
    expect(keys(next)).toEqual([childKey(a, '3'), childKey(a, '1')])
    expect(await s.assistantSubsessions.listForParent(b, 'sid-parent-1', { limit: 10 })).toEqual([
      expect.objectContaining({ childSessionKey: childKey(b, '9') })
    ])
    expect(await s.assistantSubsessions.listForParent(a, 'sid-unknown', { limit: 10 })).toEqual([])
  })
})

describe.skipIf(usingPostgresStore())('the v37 → v38 sub-session index on SQLite', () => {
  it('adds the table to a v37 store and stamps the current version', async () => {
    expect(SCHEMA_VERSION).toBe(41)
    const path = tempStorePath('ac-assistant-v37-')
    await (await LocalStore.open(path)).close()
    const old = new DatabaseSync(path)
    old.exec('DROP TABLE assistant_subsession; PRAGMA user_version = 37')
    old.close()

    const upgraded = await LocalStore.open(path)
    const a = agent()
    try {
      expect(await upgraded.assistantSubsessions.open(row(a, '1'))).toBe(true)
      expect((await upgraded.assistantSubsessions.get(a, childKey(a, '1')))?.state).toBe('open')
    } finally {
      await upgraded.close()
    }
    const db = new DatabaseSync(path)
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'index') AND name LIKE 'assistant_subsession%'")
      .all() as { name: string }[]
    expect(tables.map((t) => t.name).sort()).toEqual(['assistant_subsession', 'assistant_subsession_by_parent'])
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION)
    db.close()
  })
})

describe.skipIf(!usingPostgresStore())('the v37 → v38 sub-session index on PostgreSQL', () => {
  it('adds the table to a v37 store and keeps the other assistant tables', async () => {
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
      await admin.query('DROP TABLE assistant_subsession')
      await admin.query('UPDATE _local_store_schema_version SET version = 37 WHERE singleton = true')

      const database = await PostgresAsyncDatabase.open(config, () => undefined, schema)
      await database.finishSchemaInitialization()
      const upgraded = await LocalStore.open({ database, shared: true, ownerId: 'm2', orgForAgent })
      try {
        expect((await upgraded.assistantItems.get(a, item.id))?.title).toBe('Kept across the upgrade')
        expect(await upgraded.assistantSubsessions.open(row(a, '1'))).toBe(true)
        expect(await upgraded.assistantSubsessions.get(a, childKey(a, '1'))).toMatchObject({
          parentSessionId: 'sid-parent-1',
          state: 'open',
          createdAt: 1_000
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

  it('shows one member’s delegation to another member of the pool', async () => {
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
      expect(await first.assistantSubsessions.open(row(a, '1'))).toBe(true)
      expect(await second.assistantSubsessions.open(row(a, '1'))).toBe(false)
      expect((await second.assistantSubsessions.get(a, childKey(a, '1')))?.parentSessionId).toBe('sid-parent-1')
    } finally {
      for (const member of members) await member.close()
    }
  })
})

describe.skipIf(usingPostgresStore())('assistant sub-sessions on agent removal', () => {
  const dirs: string[] = []
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  })

  it('drops the agent’s index rows when the control plane removes the agent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-asub-'))
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
      await seam.store.assistantSubsessions.open(row(agentId, '1'))
      await seam.store.assistantSubsessions.open(row(other, '1'))
      await seam.cpConfigApply().applyAgentRemove(agentId)
      expect(await seam.store.assistantSubsessions.get(agentId, childKey(agentId, '1'))).toBeUndefined()
      expect(await seam.store.assistantSubsessions.get(other, childKey(other, '1'))).toBeDefined()
    } finally {
      await daemon.stop()
    }
  })
})
