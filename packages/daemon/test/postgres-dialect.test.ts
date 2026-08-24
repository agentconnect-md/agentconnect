/**
 * The dialect layer came out of the retired worker bridge unchanged, so these cases pin its
 * exact output — every rewrite rule, both binding forms, revision-slot detection, and the
 * PRAGMA / `sqlite_master` emulation `LocalStore` depends on.
 */
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { LocalStore } from '../src/store/local-store.js'
import { tempStorePath } from './store-support.js'
import {
  bind,
  changesOf,
  columnNames,
  emulate,
  isRevisionBearingWrite,
  rowsOf,
  rewrite,
  schemaBootstrapStatements
} from '../src/store/postgres-dialect.js'

describe('rewrite', () => {
  it('drops IMMEDIATE from a BEGIN', () => {
    expect(rewrite('BEGIN IMMEDIATE')).toBe('BEGIN')
    expect(rewrite('begin   immediate')).toBe('BEGIN')
  })

  it('maps an autoincrementing key onto a generated identity', () => {
    expect(rewrite('CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, n INTEGER NOT NULL)')).toBe(
      'CREATE TABLE t (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, n BIGINT NOT NULL)'
    )
  })

  it('widens every remaining INTEGER to BIGINT', () => {
    expect(rewrite('ALTER TABLE t ADD COLUMN n integer')).toBe('ALTER TABLE t ADD COLUMN n BIGINT')
  })

  it('maps a blob-length probe onto octet_length', () => {
    expect(rewrite('SELECT length(CAST(payload AS BLOB)) AS bytes FROM t')).toBe(
      'SELECT octet_length(payload::text) AS bytes FROM t'
    )
  })

  it('turns an empty NOT IN list into TRUE', () => {
    expect(rewrite('SELECT * FROM t WHERE t.id NOT IN ()')).toBe('SELECT * FROM t WHERE TRUE')
  })

  it('drops the SQLite sentinel LIMIT before an OFFSET', () => {
    expect(rewrite('SELECT * FROM t LIMIT -1 OFFSET 5')).toBe('SELECT * FROM t OFFSET 5')
  })

  it('maps IS NOT against a placeholder onto IS DISTINCT FROM', () => {
    expect(rewrite('SELECT * FROM t WHERE a IS NOT $1')).toBe('SELECT * FROM t WHERE a IS DISTINCT FROM $1')
  })

  it('turns INSERT OR IGNORE into a do-nothing conflict clause', () => {
    expect(rewrite('INSERT OR IGNORE INTO t (a) VALUES ($1)')).toBe(
      'INSERT INTO t (a) VALUES ($1) ON CONFLICT DO NOTHING'
    )
    expect(rewrite('  insert or ignore INTO t (a) VALUES ($1);  ')).toBe(
      'INSERT INTO t (a) VALUES ($1) ON CONFLICT DO NOTHING'
    )
  })

  it('leaves a plain INSERT alone', () => {
    expect(rewrite('INSERT INTO t (a) VALUES ($1)')).toBe('INSERT INTO t (a) VALUES ($1)')
  })
})

describe('bind', () => {
  it('returns the rewritten statement and no values when there are no parameters', () => {
    expect(bind('SELECT 1 FROM t LIMIT -1 OFFSET 2', [])).toEqual({
      sql: 'SELECT 1 FROM t OFFSET 2',
      values: [],
      revisionSlot: undefined
    })
  })

  it('numbers positional parameters in order', () => {
    expect(bind('INSERT INTO t (a, b) VALUES (?, ?)', ['x', 2])).toEqual({
      sql: 'INSERT INTO t (a, b) VALUES ($1, $2)',
      values: ['x', 2],
      revisionSlot: undefined
    })
  })

  it('substitutes null for an undefined positional parameter', () => {
    expect(bind('INSERT INTO t (a) VALUES (?)', [undefined]).values).toEqual([null])
  })

  it('reuses one slot per named parameter', () => {
    expect(bind('UPDATE t SET a = @a, b = @b WHERE a = @a', [{ a: 'x', b: 'y' }])).toEqual({
      sql: 'UPDATE t SET a = $1, b = $2 WHERE a = $1',
      values: ['x', 'y'],
      revisionSlot: undefined
    })
  })

  it('substitutes null for a missing named parameter', () => {
    expect(bind('INSERT INTO t (a) VALUES (@a)', [{}]).values).toEqual([null])
  })

  it('treats a lone array parameter as positional, not named', () => {
    expect(bind('SELECT * FROM t WHERE a = ?', [['x']]).values).toEqual([['x']])
  })

  it('finds the revision slot in a named binding', () => {
    const bound = bind('INSERT INTO transcript (sessionKey, revision) VALUES (@sessionKey, @revision)', [
      { sessionKey: 's', revision: 0 }
    ])
    expect(bound.revisionSlot).toBe(2)
    expect(isRevisionBearingWrite(bound)).toBe(true)
  })

  it('finds the revision slot in a positional assignment', () => {
    const bound = bind('UPDATE transcript SET revision = ? WHERE id = ?', [0, 7])
    expect(bound.revisionSlot).toBe(1)
    expect(isRevisionBearingWrite(bound)).toBe(true)
  })

  it('leaves a non-transcript revision write off the revision path', () => {
    const bound = bind('UPDATE session SET revision = ? WHERE id = ?', [0, 7])
    expect(bound.revisionSlot).toBe(1)
    expect(isRevisionBearingWrite(bound)).toBe(false)
  })

  it('leaves a transcript read off the revision path', () => {
    const bound = bind('SELECT revision FROM transcript WHERE revision = ?', [3])
    expect(isRevisionBearingWrite(bound)).toBe(false)
  })
})

describe('emulate', () => {
  it('drops a journal-mode pragma', () => {
    expect(emulate('PRAGMA journal_mode = WAL', 'store')).toEqual({ kind: 'noop' })
  })

  it('writes a user_version assignment into the version table', () => {
    expect(emulate('PRAGMA user_version = 42', 'store')).toEqual({
      kind: 'run',
      sql:
        'INSERT INTO _local_store_schema_version (singleton, version) VALUES (true, $1) ' +
        'ON CONFLICT (singleton) DO UPDATE SET version = excluded.version',
      values: [42]
    })
  })

  it('reads user_version back out of the version table', () => {
    expect(emulate('PRAGMA user_version', 'store')).toEqual({
      kind: 'read',
      sql: 'SELECT COALESCE(MAX(version), 0)::bigint AS user_version FROM _local_store_schema_version',
      values: []
    })
  })

  it('answers a sqlite_master probe from information_schema, minus the version table', () => {
    expect(emulate("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'", 'store')).toEqual({
      kind: 'read',
      sql: "SELECT COUNT(*)::bigint AS n FROM information_schema.tables WHERE table_schema = $1 AND table_name <> '_local_store_schema_version'",
      values: ['store']
    })
  })

  it('leaves an ordinary statement to the dialect', () => {
    expect(emulate('SELECT 1', 'store')).toBeUndefined()
  })
})

describe('result shaping', () => {
  it('restores the canonical column case', () => {
    expect(rowsOf({ rows: [{ sessionkey: 's', acpsessionid: 'a', unknown_column: 1 }] })).toEqual([
      { sessionKey: 's', acpSessionId: 'a', unknown_column: 1 }
    ])
  })

  it('reads the last statement of a multi-statement result', () => {
    const result = [
      { rows: [{ n: 1 }], rowCount: 1 },
      { rows: [{ orgid: 'o' }], rowCount: 3 }
    ]
    expect(rowsOf(result)).toEqual([{ orgId: 'o' }])
    expect(changesOf(result)).toBe(3)
  })

  it('reports zero changes when the driver reports none', () => {
    expect(changesOf({ rows: [], rowCount: null })).toBe(0)
    expect(rowsOf({})).toEqual([])
  })

  it('maps every canonical column back from its folded spelling', () => {
    expect(columnNames['transcriptcoordinates']).toBe('transcriptCoordinates')
  })
})

describe('canonical column coverage', () => {
  // The list is what restores a folded name, so a camelCase column missing from it reads back as
  // undefined on PostgreSQL only — the store's row shapes silently lose that field. Enumerate the
  // real schema and require every one of them, instead of trusting the list to be maintained.
  it('names every camelCase column the store schema declares', async () => {
    const path = tempStorePath('ac-dialect-')
    await (await LocalStore.open(path)).close()
    const db = new DatabaseSync(path)
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>
    const unregistered: string[] = []
    for (const { name } of tables) {
      const columns = db.prepare(`PRAGMA table_info("${name}")`).all() as Array<{ name: string }>
      for (const column of columns) {
        if (!/[A-Z]/.test(column.name)) continue
        if (columnNames[column.name.toLowerCase()] !== column.name) unregistered.push(`${name}.${column.name}`)
      }
    }
    db.close()
    expect(tables.length).toBeGreaterThan(0)
    expect(unregistered).toEqual([])
  })
})

describe('schemaBootstrapStatements', () => {
  it('creates the schema, its search_path, the revision sequence, and the version table', () => {
    expect(schemaBootstrapStatements('store')).toEqual([
      'CREATE SCHEMA IF NOT EXISTS store',
      'SET search_path TO store, pg_catalog',
      'CREATE SEQUENCE IF NOT EXISTS _transcript_revision_seq',
      'CREATE TABLE IF NOT EXISTS _local_store_schema_version (' +
        'singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton), version BIGINT NOT NULL)'
    ])
  })
})
