/**
 * Idempotently ensure the fixed tenant used by no-auth installations.
 *
 * Production startup calls this only when OIDC is disabled. The explicit
 * Prisma seed reuses it for tests and maintenance commands.
 */
import type { PrismaClient } from '../generated/prisma/client.js'
import { DEFAULT_ORG_ID, DEFAULT_ORG_SLUG, DEFAULT_OWNER_EMAIL, DEFAULT_OWNER_ID } from '../config/defaults.js'

export async function ensureDefaultTenant(prisma: PrismaClient): Promise<void> {
  const org = await prisma.org.upsert({
    where: { id: DEFAULT_ORG_ID },
    // Never overwrite operator edits when no-auth startup runs again.
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
