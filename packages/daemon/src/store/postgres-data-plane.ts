import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { LocalStore, type OrgForAgent } from './local-store.js'
import { readDataPlaneConfig, type DataPlaneConfig } from './postgres-config.js'
import { PostgresAsyncDatabase } from './postgres-async-database.js'
import { migrateDataPlaneSchema } from './postgres-migrations.js'

/**
 * A pool member's durable state: one shared LocalStore over PostgreSQL, plus the pg pool
 * that keeps the install-wide `agentconnect_data_plane` schema migrated. That schema holds
 * no tables of its own any more — its transcript pair was constructed and never read or
 * written, and the fence it carried now lives on the store's own rows (#1041 item 7) — but
 * its migration list must keep running so an installed data plane drops what it still has.
 */
export class PostgresDataPlane {
  readonly store: LocalStore
  /** The org this daemon runs for, as the mount named it — what a pool member's control
   *  socket declares, since its Kubernetes identity names no org. */
  readonly orgId?: string

  private constructor(
    private readonly pool: Pool,
    store: LocalStore
  ) {
    this.store = store
  }

  static async open(
    config: DataPlaneConfig,
    orgForAgent: OrgForAgent,
    onFailure?: (error: Error) => void
  ): Promise<PostgresDataPlane> {
    const pool = new Pool({
      connectionString: config.databaseUrl,
      max: config.maxConnections,
      application_name: 'agentconnect-daemon',
      connectionTimeoutMillis: 10_000
    })
    pool.on('error', (error) => onFailure?.(error))
    try {
      const client = await pool.connect()
      try {
        await migrateDataPlaneSchema(client)
      } finally {
        client.release()
      }
    } catch (error) {
      await pool.end().catch(() => undefined)
      throw error
    }
    const database = await PostgresAsyncDatabase.open(config, onFailure)
    try {
      const store = await LocalStore.open({ database, shared: true, ownerId: randomUUID(), orgForAgent })
      await database.finishSchemaInitialization()
      return new PostgresDataPlane(pool, store)
    } catch (error) {
      await database.close()
      await pool.end().catch(() => undefined)
      throw error
    }
  }

  async close(): Promise<void> {
    await this.store.close()
    await this.pool.end()
  }
}

export async function openMountedPostgresDataPlane(
  orgForAgent: OrgForAgent,
  onFailure?: (error: Error) => void
): Promise<PostgresDataPlane> {
  return PostgresDataPlane.open(readDataPlaneConfig(), orgForAgent, onFailure)
}
