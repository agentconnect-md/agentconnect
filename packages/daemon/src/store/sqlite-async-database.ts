import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { AsyncMutex } from './async-mutex.js'
import type {
  StoreBatchResult,
  StoreBatchStatement,
  StoreDatabase,
  StoreQueryResult,
  StoreTx
} from './store-database.js'

/**
 * `node:sqlite` behind the async `StoreDatabase` contract. The work is synchronous, so every
 * method returns an already-durable result — the promises exist for the seam, not for the I/O.
 * One database-wide mutex serializes all operations: a single connection means a statement
 * issued during an open transaction would otherwise silently join it.
 */
export class SqliteAsyncDatabase implements StoreDatabase {
  private readonly mutex = new AsyncMutex()

  private constructor(private readonly database: DatabaseSync) {}

  static open(source: string): SqliteAsyncDatabase {
    return new SqliteAsyncDatabase(new DatabaseSync(source))
  }

  /** Adopt an already-open handle — the daemon's SQLite fallback opens and tunes its own. */
  static adopt(database: DatabaseSync): SqliteAsyncDatabase {
    return new SqliteAsyncDatabase(database)
  }

  exec(sql: string): Promise<void> {
    return this.mutex.run(() => this.execNow(sql))
  }

  query(sql: string, params: unknown[]): Promise<StoreQueryResult> {
    return this.mutex.run(() => this.queryNow(sql, params))
  }

  batch(statements: StoreBatchStatement[]): Promise<StoreBatchResult[]> {
    return this.mutex.run(() => this.batchNow(statements))
  }

  /** Holds the mutex across BEGIN IMMEDIATE…COMMIT so the window is never interleaved. */
  transaction<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T> {
    return this.mutex.run(async () => {
      const tx: StoreTx = {
        exec: async (sql) => this.execNow(sql),
        query: async (sql, params) => this.queryNow(sql, params),
        batch: async (list) => this.batchNow(list)
      }
      this.execNow('BEGIN IMMEDIATE')
      try {
        const value = await fn(tx)
        this.execNow('COMMIT')
        return value
      } catch (error) {
        try {
          this.execNow('ROLLBACK')
        } catch {
          // A transaction the failure already aborted has nothing to roll back.
        }
        throw error
      }
    })
  }

  close(): Promise<void> {
    return this.mutex.run(() => this.database.close())
  }

  private execNow(sql: string): void {
    this.database.exec(sql)
  }

  private queryNow(sql: string, params: unknown[]): StoreQueryResult {
    const statement = this.database.prepare(sql)
    const bound = params as SQLInputValue[]
    if (returnsRows(sql)) return { rows: statement.all(...bound), changes: 0 }
    return { rows: [], changes: Number(statement.run(...bound).changes) }
  }

  private batchNow(statements: StoreBatchStatement[]): StoreBatchResult[] {
    return statements.map(({ sql, params, kind }) => {
      const statement = this.database.prepare(sql)
      const bound = params as SQLInputValue[]
      if (kind === 'read') return { changes: 0, rows: statement.all(...bound) }
      return { changes: Number(statement.run(...bound).changes), rows: [] }
    })
  }
}

/** `all()` is the only call that yields rows, and `run()` the only one that reports `changes`,
 *  so the statement's shape decides which of the two a `query` is. */
function returnsRows(sql: string): boolean {
  const head = sql
    .replace(/^[\s(]*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/)?[\s(]*/, '')
    .slice(0, 12)
    .toUpperCase()
  if (head.startsWith('SELECT') || head.startsWith('PRAGMA') || head.startsWith('WITH') || head.startsWith('EXPLAIN'))
    return true
  return /\bRETURNING\b/i.test(sql)
}
