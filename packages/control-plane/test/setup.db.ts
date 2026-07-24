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

/** The pool-local client every repo/integration test in this worker uses. */
export const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString })
})

/**
 * All app tables, in no particular order — `TRUNCATE … CASCADE` resolves FK
 * order for us. `_prisma_migrations` is intentionally excluded so the schema
 * stays applied between tests.
 */
const TABLES = [
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
  'membership',
  'app_user',
  'org'
] as const

async function truncateAll(): Promise<void> {
  const list = TABLES.map((t) => `"${t}"`).join(', ')
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE;`)
}

beforeEach(async () => {
  // Clean slate, then re-seed the tenancy anchor.
  await truncateAll()
  await seed(prisma)
})

afterAll(async () => {
  await prisma.$disconnect()
})
