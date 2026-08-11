/**
 * Per-test DB harness for the `integration` project (design §5.2).
 *
 * - Each Vitest pool gets a `PrismaClient` pointed at its own cloned Postgres
 *   database from `global-setup.ts`; files on different pools cannot collide.
 * - `beforeEach` re-seeds the default Org/User so every test has a stable
 *   tenancy anchor for FKs after truncating every app table. Cleaning only
 *   before the next test avoids a redundant second truncate after every test.
 *
 * Imported as a `setupFiles` entry (NOT a global), so the hooks register per
 * test file while every concurrently active pool stays on its own database.
 */
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

/**
 * All app tables, in no particular order — `TRUNCATE … CASCADE` resolves FK
 * order for us. `_prisma_migrations` is intentionally excluded so the schema
 * stays applied between tests.
 */
const TABLES = [
  // FK-less deployment singleton; its secret side rows cascade from it.
  'deployment_config',
  'audit_event',
  'cron_def',
  'secret_lease',
  'agent_launch',
  'session_meta',
  'assignment',
  // R1/R2a history/outbox deliberately has no HookDef/Agent/Org FK so GitHub
  // cleanup can survive owner deletion; truncate it explicitly between tests.
  'hook_run',
  'hook_review_projection',
  'agent',
  'runtime_profile',
  'daemon',
  // FK-less pending-state table — CASCADE from org/agent never reaches it, so it
  // must be truncated explicitly or its rows leak across tests.
  'slack_install',
  // FK-less deployment infra (no org/daemon column) — same leak risk as slack_install.
  'relay',
  // FK-less OAuth AS protocol state (userId/orgId/clientId are plain strings, no
  // relations) — CASCADE from org/user never reaches these, so truncate explicitly.
  'oauth_client',
  'oauth_code',
  'oauth_grant',
  // Keyed by OIDC subject, no FK to app_user (the row it describes is GONE) — so
  // CASCADE never reaches it and a cutoff would otherwise outlive its test and
  // reject the next test that reuses the subject.
  'deleted_identity_cutoff',
  'membership',
  'app_user',
  'org'
] as const

/** Postgres deadlock_detected — the truncate lost the tie-break, not a schema fault. */
const DEADLOCK_DETECTED = '40P01'
const TRUNCATE_ATTEMPTS = 5

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

/** A leftover in-flight reader and this TRUNCATE can want each other's table locks, so retry when we lose. */
async function truncateAll(): Promise<void> {
  const list = TABLES.map((t) => `"${t}"`).join(', ')
  for (let attempt = 1; ; attempt += 1) {
    try {
      await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE;`)
      return
    } catch (error) {
      if (!isDeadlock(error) || attempt === TRUNCATE_ATTEMPTS) throw error
      await new Promise((resolve) => setTimeout(resolve, 50 * attempt))
    }
  }
}

beforeEach(async () => {
  // Clean slate, then re-seed the tenancy anchor.
  await truncateAll()
  await seed(prisma)
})

afterAll(async () => {
  await prisma.$disconnect()
})
