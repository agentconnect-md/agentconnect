import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { LocalStore, type OrgForAgent } from './local-store.js'
import { readDataPlaneConfig, type DataPlaneConfig } from './postgres-config.js'
import { PostgresAsyncDatabase } from './postgres-async-database.js'
import { DATA_PLANE_SCHEMA, migrateDataPlaneSchema } from './postgres-migrations.js'

/**
 * A pool member's durable state: one shared LocalStore over PostgreSQL, plus the pg pool
 * that keeps the install-wide `agentconnect_data_plane` schema migrated. That schema's one
 * table is the store's identity; its transcript pair was constructed and never read or
 * written, and the fence it carried now lives on the store's own rows (#1041 item 7).
 */
export class PostgresDataPlane {
  readonly store: LocalStore
  /** The org this daemon runs for, as the mount named it — what a pool member's control
   *  socket declares, since its Kubernetes identity names no org. */
  readonly orgId?: string

  private constructor(
    private readonly pool: Pool,
    store: LocalStore,
    /** The database's `store_identity` id, the same for every daemon on this store. */
    readonly storeId: string
  ) {
    this.store = store
  }

  static async open(
    config: DataPlaneConfig,
    orgForAgent: OrgForAgent,
    onFailure?: (error: Error) => void
  ): Promise<PostgresDataPlane> {
    // One connection: this pool only runs the schema migrations. `maxConnections` sizes the
    // store's own pool, and spending it twice would double what a member holds on the cluster.
    const pool = new Pool({
      connectionString: config.databaseUrl,
      max: 1,
      application_name: 'agentconnect-daemon',
      connectionTimeoutMillis: 10_000
    })
    pool.on('error', (error) => onFailure?.(error))
    let storeId: string
    try {
      const client = await pool.connect()
      try {
        await migrateDataPlaneSchema(client)
        const identity = await client.query<{ id: string }>(`SELECT id FROM ${DATA_PLANE_SCHEMA}.store_identity`)
        storeId = identity.rows[0]!.id
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
      return new PostgresDataPlane(pool, store, storeId)
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

/** The shared store a credentials file names — the pool's mount by default, or a self-hosted `postgres` store's file (#2188). */
export async function openPostgresDataPlane(
  orgForAgent: OrgForAgent,
  onFailure?: (error: Error) => void,
  configPath?: string
): Promise<PostgresDataPlane> {
  return PostgresDataPlane.open(readDataPlaneConfig(configPath), orgForAgent, onFailure)
}
