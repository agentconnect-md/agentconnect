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

// Re-export the single-tenant anchors (defined in `src/config/defaults.ts` so
// production code can reference them without importing from `prisma/`). Fixtures
// and tests import these constants from here.
export { DEFAULT_ORG_ID, DEFAULT_OWNER_ID, DEFAULT_ORG_SLUG, DEFAULT_OWNER_EMAIL }

export async function seed(prisma: PrismaClient): Promise<void> {
  const org = await prisma.org.upsert({
    where: { id: DEFAULT_ORG_ID },
    // NEVER update an existing row: an owner may have renamed the default org
    // (its slug included — `/-/…` then just acts as the generic entry point),
    // and a re-seed must not clobber that. The v1 clear-install baseline starts
    // with `-`, so there is no legacy slug convergence step.
    update: {},
    create: {
      id: DEFAULT_ORG_ID,
      name: 'Default',
      slug: DEFAULT_ORG_SLUG
    }
  })

  const owner = await prisma.user.upsert({
    where: { id: DEFAULT_OWNER_ID },
    update: {},
    create: {
      id: DEFAULT_OWNER_ID,
      email: DEFAULT_OWNER_EMAIL,
      displayName: 'Owner'
    }
  })

  await prisma.membership.upsert({
    where: { orgId_userId: { orgId: org.id, userId: owner.id } },
    update: { role: 'owner' },
    create: { orgId: org.id, userId: owner.id, role: 'owner' }
  })
}

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
