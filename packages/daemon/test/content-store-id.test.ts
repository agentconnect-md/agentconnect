import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { LocalStore } from '../src/store/local-store.js'
import { SqliteAsyncDatabase } from '../src/store/sqlite-async-database.js'

// A private store reports no content store: no peer can read its rows, so the Control Plane never lets another
// member serve its sessions. The shared (PostgreSQL) case is in postgres-pool-store.int.test.ts.
describe('LocalStore.contentStoreId', () => {
  it('is undefined for a private SQLite store', async () => {
    const store = await LocalStore.open({ database: SqliteAsyncDatabase.adopt(new DatabaseSync(':memory:')) })
    expect(await store.contentStoreId()).toBeUndefined()
  })
})
