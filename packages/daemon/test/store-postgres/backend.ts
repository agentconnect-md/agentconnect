/**
 * The seam that lets one store suite run against either backend.
 *
 * The SQLite run leaves this module unarmed and the suites build their own
 * `node:sqlite` stores exactly as before. The `store-postgres` project's setup file
 * arms it with one per-worker `PostgresSyncDatabase`, and the same suites then open
 * their `LocalStore` over the real pool store — the SQL text the daemon pool runs.
 */
import { LocalStore, type OrgForAgent, type StoreDatabase } from '../../src/store/local-store.js'

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
  return { exec: (sql) => database.exec(sql), prepare: (sql) => database.prepare(sql), close: () => undefined }
}

export interface PostgresLocalStoreOptions {
  shared?: boolean
  ownerId?: string
  orgForAgent?: OrgForAgent
}

/** Open a `LocalStore` over this worker's pool store. Solo by default, mirroring a local daemon. */
export function openPostgresLocalStore(options: PostgresLocalStoreOptions = {}): LocalStore {
  if (!poolStoreDatabase) throw new Error('the PostgreSQL store backend is not armed — run the store-postgres project')
  return new LocalStore({ database: borrowed(poolStoreDatabase), ...options })
}
