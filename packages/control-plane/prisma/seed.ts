/**
 * Prisma seed (design §3.13) — run via `prisma db seed` (configured in
 * package.json#prisma.seed → `tsx prisma/seed.ts`).
 *
 * Single-tenant installs and the test harness need one default `Org` and an
 * owner `User` so every `orgId`/`actorUserId` FK has something to hang off.
 * Idempotent: re-running upserts the same rows.
 *
 * These ids are stable and exported so fixtures/tests can reference the seeded
 * tenancy without re-querying.
 */
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../src/generated/prisma/client.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID, DEFAULT_ORG_SLUG, DEFAULT_OWNER_EMAIL } from '../src/config/defaults.js'
import { ensureDefaultTenant } from '../src/persistence/ensure-default-tenant.js'

// Re-export the single-tenant anchors (defined in `src/config/defaults.ts` so
// production code can reference them without importing from `prisma/`). Fixtures
// and tests import these constants from here.
export { DEFAULT_ORG_ID, DEFAULT_OWNER_ID, DEFAULT_ORG_SLUG, DEFAULT_OWNER_EMAIL }

/**
 * Seed the default tenancy WITHOUT the `agentconnect` preset agent.
 *
 * Production's no-auth boot (`src/index.ts`) calls `ensureDefaultTenant` with
 * presets ON — that is the org-creation seam. This entry point is the test/
 * maintenance fixture, and every suite that lists the default org's agents
 * asserts against a known-empty baseline; provisioning here would silently add
 * an agent to all of them. Suites that WANT the preset provision it explicitly
 * (`provisionPresetAgents`, the backfill, or `ensureDefaultTenant` itself — see
 * `test/integration/preset-agents.test.ts`). A no-auth deployment seeded from
 * this CLI still converges on its next boot, which runs the real seam.
 */
export const seed = (prisma: PrismaClient): Promise<void> => ensureDefaultTenant(prisma, { presetAgents: false })

// Allow `tsx prisma/seed.ts` to run the seed against DATABASE_URL directly.
// Guarded so importing the constants/`seed` from tests does not open a client.
const isDirectRun = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`

if (isDirectRun) {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL })
  const prisma = new PrismaClient({ adapter })
  seed(prisma)
    .then(() => prisma.$disconnect())
    .catch(async (err) => {
      console.error(err)
      await prisma.$disconnect()
      process.exit(1)
    })
}
