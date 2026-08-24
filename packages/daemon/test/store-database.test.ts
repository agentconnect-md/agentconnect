import { describe, expect, it } from 'vitest'
import { SqliteAsyncDatabase } from '../src/store/sqlite-async-database.js'
import type { StoreDatabase } from '../src/store/store-database.js'

/**
 * The async `StoreDatabase` contract. Awaiting replaces blocking, so every method here must
 * resolve only once its writes are durable — and, on the one-connection SQLite backend, a
 * statement issued while a transaction is open must wait for COMMIT rather than join it.
 */
function openDatabase(): StoreDatabase {
  return SqliteAsyncDatabase.open(':memory:')
}

async function rows(db: StoreDatabase, sql: string, params: unknown[] = []): Promise<unknown[]> {
  return (await db.query(sql, params)).rows
}

describe('SqliteAsyncDatabase', () => {
  it('exec and query resolve after the write is durable', async () => {
    const db = openDatabase()
    await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)')
    const inserted = await db.query('INSERT INTO t (id, name) VALUES (?, ?)', [1, 'a'])
    expect(inserted.changes).toBe(1)
    expect(inserted.rows).toEqual([])
    expect(await rows(db, 'SELECT name FROM t WHERE id = ?', [1])).toEqual([{ name: 'a' }])
    await db.close()
  })

  it('reports changes for updates that match nothing', async () => {
    const db = openDatabase()
    await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)')
    const updated = await db.query('UPDATE t SET name = ? WHERE id = ?', ['b', 99])
    expect(updated.changes).toBe(0)
    await db.close()
  })

  it('batch applies every statement in order and returns their results positionally', async () => {
    const db = openDatabase()
    await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)')
    const results = await db.batch([
      { sql: 'INSERT INTO t (id, name) VALUES (?, ?)', params: [1, 'a'], kind: 'run' },
      { sql: 'INSERT INTO t (id, name) VALUES (?, ?)', params: [2, 'b'], kind: 'run' },
      { sql: 'SELECT name FROM t ORDER BY id', params: [], kind: 'read' }
    ])
    expect(results.map((result) => result.changes)).toEqual([1, 1, 0])
    expect(results[2]!.rows).toEqual([{ name: 'a' }, { name: 'b' }])
    expect(await rows(db, 'SELECT COUNT(*) AS n FROM t')).toEqual([{ n: 2 }])
    await db.close()
  })

  it('transaction commits its writes and returns the callback value', async () => {
    const db = openDatabase()
    await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)')
    const value = await db.transaction(async (tx) => {
      await tx.query('INSERT INTO t (id, name) VALUES (?, ?)', [1, 'a'])
      await tx.batch([{ sql: 'INSERT INTO t (id, name) VALUES (?, ?)', params: [2, 'b'], kind: 'run' }])
      return 'done'
    })
    expect(value).toBe('done')
    expect(await rows(db, 'SELECT name FROM t ORDER BY id')).toEqual([{ name: 'a' }, { name: 'b' }])
    await db.close()
  })

  it('transaction rolls back every write when the callback throws, and rethrows', async () => {
    const db = openDatabase()
    await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)')
    await expect(
      db.transaction(async (tx) => {
        await tx.query('INSERT INTO t (id, name) VALUES (?, ?)', [1, 'a'])
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    expect(await rows(db, 'SELECT name FROM t')).toEqual([])
    // The rolled-back transaction left no open transaction behind.
    await db.query('INSERT INTO t (id, name) VALUES (?, ?)', [2, 'b'])
    expect(await rows(db, 'SELECT name FROM t')).toEqual([{ name: 'b' }])
    await db.close()
  })

  it('a statement issued while a transaction is open waits for COMMIT instead of joining it', async () => {
    const db = openDatabase()
    await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)')
    const order: string[] = []
    let outsideSettled = false
    let outside: Promise<unknown> | undefined

    await expect(
      db.transaction(async (tx) => {
        await tx.query('INSERT INTO t (id, name) VALUES (?, ?)', [1, 'inside'])
        outside = db.query('INSERT INTO t (id, name) VALUES (?, ?)', [2, 'outside']).then((result) => {
          outsideSettled = true
          order.push('outside')
          return result
        })
        // Give the queued statement every chance to run early; the mutex must hold it back.
        for (let tick = 0; tick < 10; tick++) await Promise.resolve()
        await new Promise((resolve) => setImmediate(resolve))
        expect(outsideSettled).toBe(false)
        order.push('rollback')
        throw new Error('rollback')
      })
    ).rejects.toThrow('rollback')

    await outside
    expect(order).toEqual(['rollback', 'outside'])
    // The outside write survives the rollback, so it never ran inside the transaction.
    expect(await rows(db, 'SELECT name FROM t')).toEqual([{ name: 'outside' }])
    await db.close()
  })

  it('serializes concurrent transactions instead of nesting them', async () => {
    const db = openDatabase()
    await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, n INTEGER)')
    await db.query('INSERT INTO t (id, n) VALUES (?, ?)', [1, 0])
    const bump = async (): Promise<void> => {
      await db.transaction(async (tx) => {
        const current = (await tx.query('SELECT n FROM t WHERE id = ?', [1])).rows[0] as { n: number }
        await new Promise((resolve) => setImmediate(resolve))
        await tx.query('UPDATE t SET n = ? WHERE id = ?', [current.n + 1, 1])
      })
    }
    await Promise.all([bump(), bump(), bump()])
    expect(await rows(db, 'SELECT n FROM t WHERE id = ?', [1])).toEqual([{ n: 3 }])
    await db.close()
  })

  it('close rejects later operations', async () => {
    const db = openDatabase()
    await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)')
    await db.close()
    await expect(db.query('SELECT 1 AS one', [])).rejects.toThrow()
  })
})
