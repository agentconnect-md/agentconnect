// Per-test DB harness for the `integration` project (design §5.2).
// Each Vitest pool gets a `PrismaClient` on its own cloned database from `global-setup.ts`.
// `beforeEach` empties every app table and re-seeds the default Org/User as the FK anchor.
// Cleaning only before the next test avoids a redundant second sweep after every test.
// A `setupFiles` entry (NOT a global), so hooks register per test file while pools stay isolated.
import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, inject } from 'vitest'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../src/generated/prisma/client.js'
import { seed } from '../prisma/seed.js'

const poolId = Number(process.env.VITEST_POOL_ID ?? '1')
const databaseUrls = inject('databaseUrls')
const connectionString = databaseUrls[poolId - 1]
if (!connectionString) {
  throw new Error(`No integration database provisioned for Vitest pool ${poolId}`)
}
process.env.DATABASE_URL = connectionString

/**
 * The pool-local client every repo/integration test in this worker uses.
 *
 * Prisma's interactive-transaction defaults (`timeout` 5s, `maxWait` 2s) are the
 * second timing wall under this suite, and the one no test can reach: repository
 * methods open their own `$transaction` internally, so a test that calls
 * `setPlacement`/`establish` on this root client inherits that 5s budget with no
 * way to widen it. Under `integrationWorkers` workers sharing one Dockerized
 * Postgres, a stall long enough to cross it says nothing about the code under
 * test. Tests that deliberately hold a row or advisory lock open pass their own
 * explicit `{ timeout: 20_000 }`, which still wins over this default; matching
 * that number keeps one budget to reason about.
 */
export const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString }),
  transactionOptions: { timeout: 20_000, maxWait: 10_000 }
})

// One server-side sweep of every app table, resolved from the catalog instead of a hand-kept list.
// Per-table `TRUNCATE` pays relfilenode + catalog + WAL work whether or not the table holds anything,
// and the ~70-table CASCADE closure of `org` was ~60ms of that on EVERY test. `DELETE` skips the
// relfilenode churn, and the `SELECT 1 … LIMIT 1` probe means only the handful of tables a test
// actually wrote get touched — measured 60ms → 2ms on an idle database, 76ms → 11ms after a test
// that wrote an org plus two daemons.
//
// Reading the table list from `pg_class` also closes a real isolation hole: the old list named 22
// tables and leaned on CASCADE for the rest, which left `waitlist_entry`, `slack_platform_install`,
// `feishu_app_registration`, `github_install_state`, `pending_key_shred`, `shared_thread_agent`, and
// `shared_thread_participant` — 7 of 78 — surviving between tests. `_prisma_migrations` stays out so
// the schema stays applied.
//
// `session_replication_role = replica` suspends FK triggers for the statement's transaction only, so
// the sweep needs no dependency order; every table is emptied anyway. No `RESTART IDENTITY`: the one
// sequence in the schema is `audit_event.id`, and every assertion over it is relative (`orderBy id`).
const SWEEP_SQL = `DO $sweep$
DECLARE t text; found int;
BEGIN
  PERFORM set_config('session_replication_role', 'replica', true);
  FOR t IN SELECT c.relname FROM pg_class c
           WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relname <> '_prisma_migrations'
  LOOP
    EXECUTE format('SELECT 1 FROM %I LIMIT 1', t) INTO found;
    IF found IS NOT NULL THEN EXECUTE format('DELETE FROM %I', t); END IF;
  END LOOP;
END $sweep$;`

/** Postgres deadlock_detected — the sweep lost the tie-break, not a schema fault. */
const DEADLOCK_DETECTED = '40P01'
const SWEEP_ATTEMPTS = 5

/** Prisma reports the raw-query failure as P2010 and carries the driver's SQLSTATE underneath. */
function isDeadlock(error: unknown): boolean {
  const cause = (
    error as { meta?: { driverAdapterError?: { cause?: { originalCode?: string; code?: string } } } } | null
  )?.meta?.driverAdapterError?.cause
  // `originalCode` is always set; `code` only while the adapter leaves 40P01 unmapped.
  if (cause?.originalCode === DEADLOCK_DETECTED || cause?.code === DEADLOCK_DETECTED) return true
  // Shape of `meta` is not part of Prisma's public contract; the message is the fallback.
  return error instanceof Error && error.message.includes('deadlock detected')
}

/** A leftover in-flight writer and this sweep can want each other's row locks, so retry when we lose. */
async function sweepAll(): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await prisma.$executeRawUnsafe(SWEEP_SQL)
      return
    } catch (error) {
      if (!isDeadlock(error) || attempt === SWEEP_ATTEMPTS) throw error
      await new Promise((resolve) => setTimeout(resolve, 50 * attempt))
    }
  }
}

// The install-wide pool set is created by the MIGRATION, not by the seed, and the sweep empties it
// along with everything else. Restoring it leaves every test on the migrated shape, where the pool is
// a row and eligibility is a membership lookup (docs/designs/daemon-groups.md §8).
async function restorePoolSet(): Promise<void> {
  await prisma.memberSet.create({ data: { id: randomUUID(), orgId: null, name: 'AgentConnect Cloud' } })
}

beforeEach(async () => {
  // Clean slate, then re-seed the tenancy anchor.
  await sweepAll()
  await seed(prisma)
  await restorePoolSet()
})

afterAll(async () => {
  await prisma.$disconnect()
})
