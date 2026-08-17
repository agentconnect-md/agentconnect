/**
 * Equivalence between the worker bridge and the main-thread pool.
 *
 * The same representative statement set — DDL, both binding forms, every rewrite rule, the
 * PRAGMA/`sqlite_master` emulation, `INSERT OR IGNORE`, and revision-bearing transcript writes —
 * runs through `PostgresSyncDatabase` and `PostgresAsyncDatabase` from two clean databases, and
 * the normalized rows and change counts must match statement for statement.
 */
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PostgresAsyncDatabase } from '../src/store/postgres-async-database.js'
import { PostgresSyncDatabase } from '../src/store/postgres-sync-database.js'

const poolDatabaseUrl = process.env.DATA_PLANE_TEST_DATABASE_URL

interface Case {
  name: string
  sql: string
  params?: unknown[]
}

// SQLite-flavored throughout: this is the SQL `LocalStore` writes for both backends.
const STATEMENTS: Case[] = [
  { name: 'journal-mode pragma', sql: 'PRAGMA journal_mode = WAL' },
  { name: 'fresh-database probe', sql: "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'" },
  { name: 'user_version assignment', sql: 'PRAGMA user_version = 7' },
  { name: 'user_version read', sql: 'PRAGMA user_version' },
  {
    name: 'transcript DDL',
    sql: 'CREATE TABLE IF NOT EXISTS transcript (id INTEGER PRIMARY KEY AUTOINCREMENT, sessionKey TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT)'
  },
  {
    name: 'notes DDL',
    sql: 'CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, createdAt INTEGER NOT NULL, body TEXT)'
  },
  { name: 'populated-database probe', sql: "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'" },
  {
    name: 'insert or ignore',
    sql: 'INSERT OR IGNORE INTO notes (id, createdAt, body) VALUES (?, ?, ?)',
    params: ['a', 1, 'hello']
  },
  {
    name: 'insert or ignore on a conflict',
    sql: 'INSERT OR IGNORE INTO notes (id, createdAt, body) VALUES (?, ?, ?)',
    params: ['a', 9, 'ignored']
  },
  {
    name: 'named insert',
    sql: 'INSERT INTO notes (id, createdAt, body) VALUES (@id, @createdAt, @body)',
    params: [{ id: 'b', createdAt: 2, body: 'second' }]
  },
  {
    name: 'named insert with a missing parameter',
    sql: 'INSERT INTO notes (id, createdAt, body) VALUES (@id, @createdAt, @body)',
    params: [{ id: 'c', createdAt: 3 }]
  },
  { name: 'is-not against a placeholder', sql: 'SELECT id FROM notes WHERE id IS NOT ? ORDER BY id', params: ['a'] },
  {
    name: 'is-not against a null placeholder',
    sql: 'SELECT id FROM notes WHERE body IS NOT ? ORDER BY id',
    params: [null]
  },
  { name: 'blob length', sql: 'SELECT length(CAST(body AS BLOB)) AS bytes FROM notes WHERE id = ?', params: ['a'] },
  {
    name: 'empty NOT IN with a sentinel LIMIT',
    sql: 'SELECT id FROM notes WHERE id NOT IN () ORDER BY id LIMIT -1 OFFSET 1'
  },
  {
    name: 'first revision-bearing insert',
    sql: 'INSERT INTO transcript (sessionKey, revision, payload) VALUES (@sessionKey, @revision, @payload)',
    params: [{ sessionKey: 's', revision: 0, payload: 'one' }]
  },
  {
    name: 'second revision-bearing insert',
    sql: 'INSERT INTO transcript (sessionKey, revision, payload) VALUES (@sessionKey, @revision, @payload)',
    params: [{ sessionKey: 's', revision: 0, payload: 'two' }]
  },
  {
    name: 'revision-bearing update',
    sql: 'UPDATE transcript SET revision = ?, payload = ? WHERE payload = ?',
    params: [0, 'one-edited', 'one']
  },
  { name: 'transcript read', sql: 'SELECT sessionKey, revision, payload FROM transcript ORDER BY revision' },
  { name: 'plain update', sql: 'UPDATE notes SET body = ? WHERE id = ?', params: ['changed', 'b'] },
  {
    name: 'insert with RETURNING',
    sql: 'INSERT INTO notes (id, createdAt, body) VALUES (?, ?, ?) RETURNING id, createdAt',
    params: ['d', 4, 'fourth']
  },
  { name: 'delete', sql: 'DELETE FROM notes WHERE id = ?', params: ['c'] },
  { name: 'final read', sql: 'SELECT id, createdAt, body FROM notes ORDER BY id' }
]

/** Compare on the shape the store consumes: row objects and a change count, order preserved. */
function normalize(result: { rows: unknown[]; changes: number }): string {
  return JSON.stringify({
    changes: result.changes,
    rows: result.rows.map((row) => {
      const entries = Object.entries(row as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      return Object.fromEntries(entries.map(([key, value]) => [key, typeof value === 'bigint' ? Number(value) : value]))
    })
  })
}

async function createDatabase(baseUrl: string, name: string): Promise<string> {
  const admin = new pg.Client({ connectionString: baseUrl })
  await admin.connect()
  try {
    await admin.query(`CREATE DATABASE "${name}"`)
  } finally {
    await admin.end()
  }
  const url = new URL(baseUrl)
  url.pathname = `/${name}`
  return url.toString()
}

describe.skipIf(!poolDatabaseUrl)('PostgresAsyncDatabase equivalence', () => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
  let sync: PostgresSyncDatabase
  let async: PostgresAsyncDatabase
  let asyncUrl: string

  beforeAll(async () => {
    const syncUrl = await createDatabase(poolDatabaseUrl!, `equiv_sync_${suffix}`)
    asyncUrl = await createDatabase(poolDatabaseUrl!, `equiv_async_${suffix}`)
    sync = new PostgresSyncDatabase({ version: 1, databaseUrl: syncUrl, maxConnections: 2 })
    async = await PostgresAsyncDatabase.open({ version: 1, databaseUrl: asyncUrl, maxConnections: 4 })
  })

  afterAll(async () => {
    sync?.close()
    await async?.close()
  })

  it('produces identical rows and change counts for the representative statement set', async () => {
    for (const statement of STATEMENTS) {
      const params = statement.params ?? []
      const expected = normalize(sync.query(statement.sql, params))
      const actual = normalize(await async.query(statement.sql, params))
      expect(actual, statement.name).toBe(expected)
    }
  })

  it('produces identical batch results', async () => {
    const batch = [
      {
        sql: 'INSERT INTO notes (id, createdAt, body) VALUES (?, ?, ?)',
        params: ['e', 5, 'fifth'],
        kind: 'run' as const
      },
      { sql: 'SELECT id, createdAt FROM notes WHERE id = ?', params: ['e'], kind: 'read' as const },
      { sql: 'UPDATE notes SET body = ? WHERE id = ?', params: ['batched', 'e'], kind: 'run' as const }
    ]
    const expected = sync.batch(batch).map((result) => normalize(result))
    const actual = (await async.batch(batch)).map((result) => normalize(result))
    expect(actual).toEqual(expected)
  })

  it('holds the schema advisory lock until finishSchemaInitialization', async () => {
    const probe = new pg.Client({ connectionString: asyncUrl })
    await probe.connect()
    try {
      const blocked = await probe.query(
        "SELECT pg_try_advisory_lock(hashtext('agentconnect-cloud-store-schema')) AS got"
      )
      expect(blocked.rows[0].got).toBe(false)
      await async.finishSchemaInitialization()
      const free = await probe.query("SELECT pg_try_advisory_lock(hashtext('agentconnect-cloud-store-schema')) AS got")
      expect(free.rows[0].got).toBe(true)
    } finally {
      await probe.end()
    }
  })

  it('commits a transaction and rolls one back', async () => {
    await async.transaction(async (tx) => {
      await tx.query('INSERT INTO notes (id, createdAt, body) VALUES (?, ?, ?)', ['tx-ok', 6, 'committed'])
    })
    await expect(
      async.transaction(async (tx) => {
        await tx.query('INSERT INTO notes (id, createdAt, body) VALUES (?, ?, ?)', ['tx-bad', 7, 'rolled back'])
        throw new Error('abort')
      })
    ).rejects.toThrow('abort')
    const rows = await async.query('SELECT id FROM notes WHERE id IN (?, ?) ORDER BY id', ['tx-ok', 'tx-bad'])
    expect(rows.rows).toEqual([{ id: 'tx-ok' }])
  })

  it('keeps transcript revisions monotonic for a write inside a transaction', async () => {
    await async.transaction(async (tx) => {
      await tx.query(
        'INSERT INTO transcript (sessionKey, revision, payload) VALUES (@sessionKey, @revision, @payload)',
        [{ sessionKey: 's', revision: 0, payload: 'in-transaction' }]
      )
    })
    const rows = await async.query('SELECT revision FROM transcript ORDER BY revision', [])
    const revisions = rows.rows.map((row) => (row as { revision: number }).revision)
    expect(revisions).toEqual([...revisions].sort((a, b) => a - b))
    expect(new Set(revisions).size).toBe(revisions.length)
  })
})
