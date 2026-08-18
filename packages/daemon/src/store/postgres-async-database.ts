import pg from 'pg'
import type { DataPlaneConfig } from './postgres-config.js'
import {
  bind,
  changesOf,
  emulate,
  isRevisionBearingWrite,
  POOL_STORE_SCHEMA,
  rowsOf,
  SCHEMA_LOCK_KEY,
  schemaBootstrapStatements,
  TRANSCRIPT_REVISION_LOCK_KEY
} from './postgres-dialect.js'
import type {
  StoreBatchResult,
  StoreBatchStatement,
  StoreDatabase,
  StoreQueryResult,
  StoreTx
} from './store-database.js'

/** Anything a statement can run on: the pool itself, or one client pinned for a transaction. */
type Queryable = Pick<pg.PoolClient, 'query'>

/**
 * `LocalStore` over an awaited main-thread `pg.Pool` — the same SQLite-flavored SQL, the same
 * dialect layer as the worker bridge, no blocking hand-off. Every method resolves only once its
 * writes are durable, so the commit-before-return contract survives the move to promises.
 */
export class PostgresAsyncDatabase implements StoreDatabase {
  private closed = false

  private constructor(
    private readonly pool: pg.Pool,
    private readonly schema: string,
    /** Holds the schema advisory lock until `finishSchemaInitialization()`; dedicated non-pool client so a max-1 pool keeps its slot. */
    private schemaClient: pg.Client | undefined,
    private readonly onFailure: (error: Error) => void
  ) {}

  /** Open the pool and bootstrap the schema, holding the advisory lock so peers wait it out. */
  static async open(
    config: DataPlaneConfig,
    onFailure: (error: Error) => void = () => undefined,
    schema: string = POOL_STORE_SCHEMA
  ): Promise<PostgresAsyncDatabase> {
    pg.types.setTypeParser(20, Number)
    const pool = new pg.Pool({
      connectionString: config.databaseUrl,
      max: config.maxConnections,
      application_name: 'agentconnect-cloud-store',
      // Every pooled connection needs the store's search_path, not just the bootstrap one.
      options: `-c search_path=${schema},pg_catalog`
    })
    // A dedicated client holds the advisory lock: parking it in the pool would deadlock a
    // maxConnections: 1 configuration the moment LocalStore.open asks for a second slot.
    const client = new pg.Client({
      connectionString: config.databaseUrl,
      application_name: 'agentconnect-cloud-store',
      options: `-c search_path=${schema},pg_catalog`
    })
    try {
      await client.connect()
      await client.query('SELECT pg_advisory_lock(hashtext($1))', [SCHEMA_LOCK_KEY])
      for (const statement of schemaBootstrapStatements(schema)) await client.query(statement)
    } catch (error) {
      await client.end().catch(() => undefined)
      await pool.end()
      throw error
    }
    return new PostgresAsyncDatabase(pool, schema, client, onFailure)
  }

  async exec(sql: string): Promise<void> {
    await this.query(sql, [])
  }

  async query(sql: string, params: unknown[]): Promise<StoreQueryResult> {
    return this.withClient((client) => this.runStatement(client, sql, params, false))
  }

  /** One client for the whole list, each statement still on its own commit: a failure names the
   *  statement that failed and abandons the rest, exactly as separate calls would have left it. */
  async batch(statements: StoreBatchStatement[]): Promise<StoreBatchResult[]> {
    if (statements.length === 0) return []
    return this.withClient(async (client) => {
      const results: StoreBatchResult[] = []
      for (let index = 0; index < statements.length; index++) {
        const statement = statements[index]!
        try {
          results.push(await this.runStatement(client, statement.sql, statement.params, false))
        } catch (error) {
          const detail = error instanceof Error && error.stack ? error.stack : String(error)
          throw new Error(`batch statement ${index + 1} of ${statements.length} failed: ${detail}`)
        }
      }
      return results
    })
  }

  /** Pin one pooled client for the callback; the rest of the pool keeps serving other work. */
  async transaction<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T> {
    return this.withClient(async (client) => {
      const tx: StoreTx = {
        exec: async (sql) => void (await this.runStatement(client, sql, [], true)),
        query: (sql, params) => this.runStatement(client, sql, params, true),
        batch: async (list) => {
          const results: StoreBatchResult[] = []
          for (const statement of list)
            results.push(await this.runStatement(client, statement.sql, statement.params, true))
          return results
        }
      }
      await client.query('BEGIN')
      try {
        const value = await fn(tx)
        await client.query('COMMIT')
        return value
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      }
    })
  }

  /** Release the schema advisory lock; a peer blocked on the bootstrap may then proceed. */
  async finishSchemaInitialization(): Promise<void> {
    const client = this.schemaClient
    if (!client) return
    this.schemaClient = undefined
    try {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [SCHEMA_LOCK_KEY])
    } finally {
      await client.end().catch(() => undefined)
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.schemaClient?.end().catch(() => undefined)
    this.schemaClient = undefined
    await this.pool.end()
  }

  private async withClient<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    if (this.closed) throw new Error('PostgreSQL pool store is closed')
    const client = await this.pool.connect()
    try {
      return await fn(client)
    } catch (error) {
      this.onFailure(error instanceof Error ? error : new Error(String(error)))
      throw error
    } finally {
      client.release()
    }
  }

  private async runStatement(
    client: Queryable,
    sql: string,
    params: unknown[],
    inTransaction: boolean
  ): Promise<StoreQueryResult> {
    const emulated = emulate(sql, this.schema)
    if (emulated) {
      if (emulated.kind === 'noop') return { rows: [], changes: 0 }
      const result = await client.query(emulated.sql, emulated.values)
      if (emulated.kind === 'run') return { rows: [], changes: 0 }
      return { rows: rowsOf(result), changes: changesOf(result) }
    }
    const bound = bind(sql, params)
    if (isRevisionBearingWrite(bound)) return this.runRevisionBearing(client, bound, inTransaction)
    const result = bound.values.length ? await client.query(bound.sql, bound.values) : await client.query(bound.sql)
    return { rows: rowsOf(result), changes: changesOf(result) }
  }

  /** The revision comes from the sequence under a transaction-scoped advisory lock, so two writers
   *  cannot interleave a revision between reading it and writing the row. */
  private async runRevisionBearing(
    client: Queryable,
    bound: ReturnType<typeof bind>,
    inTransaction: boolean
  ): Promise<StoreQueryResult> {
    if (!inTransaction) await client.query('BEGIN')
    try {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [TRANSCRIPT_REVISION_LOCK_KEY])
      const revision = await client.query("SELECT nextval('_transcript_revision_seq')::bigint AS revision")
      bound.values[bound.revisionSlot! - 1] = (revision.rows[0] as { revision: number }).revision
      const result = await client.query(bound.sql, bound.values)
      if (!inTransaction) await client.query('COMMIT')
      return { rows: rowsOf(result), changes: changesOf(result) }
    } catch (error) {
      if (!inTransaction) await client.query('ROLLBACK').catch(() => undefined)
      throw error
    }
  }
}
