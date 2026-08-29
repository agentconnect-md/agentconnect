/**
 * One factory every store-touching suite opens through, plus the seam that lets those
 * suites run against either backend.
 *
 * The SQLite run leaves the backend unarmed and `openTestStore()` opens a `node:sqlite`
 * store — a temporary file, an explicit path, or a database handle the suite built. The
 * `store-postgres` project's setup file arms one per-worker `PostgresAsyncDatabase`, and
 * the same suites then open their `LocalStore` over the real pool store — the SQL text
 * the daemon pool runs.
 */
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { LocalStore, type OrgForAgent, type StoreDatabase } from '../src/store/local-store.js'
import { SqliteAsyncDatabase } from '../src/store/sqlite-async-database.js'

let poolStoreDatabase: StoreDatabase | undefined

/** Called by the `store-postgres` setup file; never by a suite. */
export function armPostgresStoreBackend(database: StoreDatabase): void {
  poolStoreDatabase = database
}

/** True only while the `store-postgres` project is driving the suites. */
export function usingPostgresStore(): boolean {
  return poolStoreDatabase !== undefined
}

/** A suite closes its store freely, so the worker-wide connection must survive that. */
function borrowed(database: StoreDatabase): StoreDatabase {
  return {
    exec: (sql) => database.exec(sql),
    query: (sql, params) => database.query(sql, params),
    batch: (statements) => database.batch(statements),
    transaction: (fn) => database.transaction(fn),
    close: async () => undefined
  }
}

/** A fresh temporary SQLite file — the default store a suite gets. */
export function tempStorePath(prefix = 'ac-store-'): string {
  return join(mkdtempSync(join(tmpdir(), prefix)), 'local.sqlite')
}

/**
 * A store on a real FILE, for the cases whose subject IS the file — a schema seeded into one and
 * reopened, or its permissions. `LocalStore.open(path)` is backed by RAM on Windows, so those cases
 * ask for a database explicitly, the way the pool does.
 */
export async function openFileStore(path: string): Promise<LocalStore> {
  mkdirSync(dirname(path), { recursive: true })
  return await LocalStore.open({ database: SqliteAsyncDatabase.open(path) })
}

/** An in-memory SQLite database behind the async seam, for suites that share one handle. */
export function memoryStoreDatabase(): StoreDatabase {
  return SqliteAsyncDatabase.adopt(new DatabaseSync(':memory:'))
}

export interface TestStoreOptions {
  /** An explicit SQLite path — a temporary file otherwise. Ignored on the pool store. */
  path?: string
  /** A database handle the suite built. Ignored on the pool store. */
  database?: StoreDatabase
  shared?: boolean
  ownerId?: string
  orgForAgent?: OrgForAgent
}

/** Open a store: this worker's pool store under the `store-postgres` project, SQLite otherwise. */
export async function openTestStore(options: TestStoreOptions | string = {}): Promise<LocalStore> {
  const { path, database, ...rest } = typeof options === 'string' ? { path: options } : options
  if (poolStoreDatabase) return await LocalStore.open({ database: borrowed(poolStoreDatabase), ...rest })
  if (database) return await LocalStore.open({ database, ...rest })
  return await LocalStore.open(path ?? tempStorePath())
}
