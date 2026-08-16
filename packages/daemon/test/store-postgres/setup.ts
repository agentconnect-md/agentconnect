/**
 * Per-worker harness for the `store-postgres` project.
 *
 * One `PostgresSyncDatabase` per Vitest pool, on that pool's own database from
 * `global-setup.ts`. The first `LocalStore` materializes the schema through the very
 * SQLite→PostgreSQL rewrite the daemon pool uses, then the advisory lock is released so
 * a suite may open its own `PostgresDataPlane` on the same database. Per-test isolation
 * is a schema-wide sweep, the way the control-plane integration project does it.
 */
import { afterAll, beforeEach, inject } from 'vitest'
import { PostgresSyncDatabase } from '../../src/store/postgres-sync-database.js'
import { armPostgresStoreBackend, openPostgresLocalStore } from './backend.js'

const poolId = Number(process.env.VITEST_POOL_ID ?? '1')
const databaseUrl = inject('storeDatabaseUrls')[poolId - 1]
if (!databaseUrl) throw new Error(`No store database provisioned for Vitest pool ${poolId}`)

// The gated pool-store suites read this; in this project they are no longer gated out.
process.env.DATA_PLANE_TEST_DATABASE_URL = databaseUrl

const database = new PostgresSyncDatabase({ version: 1, databaseUrl, maxConnections: 2 })
armPostgresStoreBackend(database)
openPostgresLocalStore().close()
database.finishSchemaInitialization()

// Empty every store table between tests and rewind the pool's revision sequence, so a
// suite sees the same blank store SQLite hands it from a fresh temporary file.
const SWEEP_SQL = `DO $sweep$
DECLARE tables text;
BEGIN
  SELECT string_agg(format('%I', c.relname), ', ') INTO tables FROM pg_class c
    WHERE c.relnamespace = 'agentconnect_cloud_store'::regnamespace AND c.relkind = 'r'
      AND c.relname <> '_local_store_schema_version';
  IF tables IS NOT NULL THEN EXECUTE format('TRUNCATE TABLE %s RESTART IDENTITY CASCADE', tables); END IF;
  PERFORM setval('_transcript_revision_seq', 1, false);
END $sweep$;`

beforeEach(() => {
  database.exec(SWEEP_SQL)
})

afterAll(() => {
  database.close()
})
