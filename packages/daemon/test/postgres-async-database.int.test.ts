/**
 * The dialect contract `PostgresAsyncDatabase` inherited from the retired worker bridge.
 *
 * A representative statement set — DDL, both binding forms, every rewrite rule, the
 * PRAGMA/`sqlite_master` emulation, `INSERT OR IGNORE`, and revision-bearing transcript writes —
 * runs from a clean database against expectations captured from the bridge before it was
 * deleted, so a dialect regression fails here rather than on a cluster.
 */
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PostgresAsyncDatabase } from '../src/store/postgres-async-database.js'

const poolDatabaseUrl = process.env.DATA_PLANE_TEST_DATABASE_URL

interface Case {
  name: string
  sql: string
  params?: unknown[]
  /** Normalized rows + change count, frozen from the worker bridge this database replaced. */
  expected: string
}

// SQLite-flavored throughout: this is the SQL `LocalStore` writes for both backends.
const STATEMENTS: Case[] = [
  { name: 'journal-mode pragma', sql: 'PRAGMA journal_mode = WAL', expected: '{"changes":0,"rows":[]}' },
  {
    name: 'fresh-database probe',
    sql: "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'",
    expected: '{"changes":1,"rows":[{"n":0}]}'
  },
  { name: 'user_version assignment', sql: 'PRAGMA user_version = 7', expected: '{"changes":0,"rows":[]}' },
  { name: 'user_version read', sql: 'PRAGMA user_version', expected: '{"changes":1,"rows":[{"user_version":7}]}' },
  {
    name: 'transcript DDL',
    sql: 'CREATE TABLE IF NOT EXISTS transcript (id INTEGER PRIMARY KEY AUTOINCREMENT, sessionKey TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT)',
    expected: '{"changes":0,"rows":[]}'
  },
  {
    name: 'notes DDL',
    sql: 'CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, createdAt INTEGER NOT NULL, body TEXT)',
    expected: '{"changes":0,"rows":[]}'
  },
  {
    name: 'populated-database probe',
    sql: "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'",
    expected: '{"changes":1,"rows":[{"n":2}]}'
  },
  {
    name: 'insert or ignore',
    sql: 'INSERT OR IGNORE INTO notes (id, createdAt, body) VALUES (?, ?, ?)',
    params: ['a', 1, 'hello'],
    expected: '{"changes":1,"rows":[]}'
  },
  {
    name: 'insert or ignore on a conflict',
    sql: 'INSERT OR IGNORE INTO notes (id, createdAt, body) VALUES (?, ?, ?)',
    params: ['a', 9, 'ignored'],
    expected: '{"changes":0,"rows":[]}'
  },
  {
    name: 'named insert',
    sql: 'INSERT INTO notes (id, createdAt, body) VALUES (@id, @createdAt, @body)',
    params: [{ id: 'b', createdAt: 2, body: 'second' }],
    expected: '{"changes":1,"rows":[]}'
  },
  {
    name: 'named insert with a missing parameter',
    sql: 'INSERT INTO notes (id, createdAt, body) VALUES (@id, @createdAt, @body)',
    params: [{ id: 'c', createdAt: 3 }],
    expected: '{"changes":1,"rows":[]}'
  },
  {
    name: 'is-not against a placeholder',
    sql: 'SELECT id FROM notes WHERE id IS NOT ? ORDER BY id',
    params: ['a'],
    expected: '{"changes":2,"rows":[{"id":"b"},{"id":"c"}]}'
  },
  {
    name: 'is-not against a null placeholder',
    sql: 'SELECT id FROM notes WHERE body IS NOT ? ORDER BY id',
    params: [null],
    expected: '{"changes":2,"rows":[{"id":"a"},{"id":"b"}]}'
  },
  {
    name: 'blob length',
    sql: 'SELECT length(CAST(body AS BLOB)) AS bytes FROM notes WHERE id = ?',
    params: ['a'],
    expected: '{"changes":1,"rows":[{"bytes":5}]}'
  },
  {
    name: 'empty NOT IN with a sentinel LIMIT',
    sql: 'SELECT id FROM notes WHERE id NOT IN () ORDER BY id LIMIT -1 OFFSET 1',
    expected: '{"changes":2,"rows":[{"id":"b"},{"id":"c"}]}'
  },
  {
    name: 'first revision-bearing insert',
    sql: 'INSERT INTO transcript (sessionKey, revision, payload) VALUES (@sessionKey, @revision, @payload)',
    params: [{ sessionKey: 's', revision: 0, payload: 'one' }],
    expected: '{"changes":1,"rows":[]}'
  },
  {
    name: 'second revision-bearing insert',
    sql: 'INSERT INTO transcript (sessionKey, revision, payload) VALUES (@sessionKey, @revision, @payload)',
    params: [{ sessionKey: 's', revision: 0, payload: 'two' }],
    expected: '{"changes":1,"rows":[]}'
  },
  {
    name: 'revision-bearing update',
    sql: 'UPDATE transcript SET revision = ?, payload = ? WHERE payload = ?',
    params: [0, 'one-edited', 'one'],
    expected: '{"changes":1,"rows":[]}'
  },
  {
    name: 'transcript read',
    sql: 'SELECT sessionKey, revision, payload FROM transcript ORDER BY revision',
    expected:
      '{"changes":2,"rows":[{"payload":"two","revision":2,"sessionKey":"s"},{"payload":"one-edited","revision":3,"sessionKey":"s"}]}'
  },
  {
    name: 'plain update',
    sql: 'UPDATE notes SET body = ? WHERE id = ?',
    params: ['changed', 'b'],
    expected: '{"changes":1,"rows":[]}'
  },
  {
    name: 'insert with RETURNING',
    sql: 'INSERT INTO notes (id, createdAt, body) VALUES (?, ?, ?) RETURNING id, createdAt',
    params: ['d', 4, 'fourth'],
    expected: '{"changes":1,"rows":[{"createdAt":4,"id":"d"}]}'
  },
  { name: 'delete', sql: 'DELETE FROM notes WHERE id = ?', params: ['c'], expected: '{"changes":1,"rows":[]}' },
  {
    name: 'final read',
    sql: 'SELECT id, createdAt, body FROM notes ORDER BY id',
    expected:
      '{"changes":3,"rows":[{"body":"hello","createdAt":1,"id":"a"},{"body":"changed","createdAt":2,"id":"b"},{"body":"fourth","createdAt":4,"id":"d"}]}'
  }
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

describe.skipIf(!poolDatabaseUrl)('PostgresAsyncDatabase dialect contract', () => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
  let async: PostgresAsyncDatabase
  let asyncUrl: string

  beforeAll(async () => {
    asyncUrl = await createDatabase(poolDatabaseUrl!, `dialect_${suffix}`)
    async = await PostgresAsyncDatabase.open({ version: 1, databaseUrl: asyncUrl, maxConnections: 4 })
  })

  afterAll(async () => {
    await async?.close()
  })

  it('produces the frozen rows and change counts for the representative statement set', async () => {
    for (const statement of STATEMENTS) {
      const actual = normalize(await async.query(statement.sql, statement.params ?? []))
      expect(actual, statement.name).toBe(statement.expected)
    }
  })

  it('produces the frozen batch results', async () => {
    const batch = [
      {
        sql: 'INSERT INTO notes (id, createdAt, body) VALUES (?, ?, ?)',
        params: ['e', 5, 'fifth'],
        kind: 'run' as const
      },
      { sql: 'SELECT id, createdAt FROM notes WHERE id = ?', params: ['e'], kind: 'read' as const },
      { sql: 'UPDATE notes SET body = ? WHERE id = ?', params: ['batched', 'e'], kind: 'run' as const }
    ]
    const actual = (await async.batch(batch)).map((result) => normalize(result))
    expect(actual).toEqual([
      '{"changes":1,"rows":[]}',
      '{"changes":1,"rows":[{"createdAt":5,"id":"e"}]}',
      '{"changes":1,"rows":[]}'
    ])
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
