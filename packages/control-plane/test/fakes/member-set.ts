/**
 * Pool-membership helpers for tests that mint org-less daemon rows directly.
 *
 * Eligibility is a MEMBERSHIP lookup now (docs/designs/daemon-groups.md §3), not a scope string
 * the caller asserts — so a test whose claimant is a pool member has to be one: the daemon row
 * plus its `member_set_member` row, exactly what `upsertOnAuth` writes in production. The pool set
 * itself is created by the migration, so it survives the per-test truncate.
 */
import type { PrismaClient } from '../../src/generated/prisma/client.js'

/** The install-wide pool: the one org-less `member_set` row the migration mints. */
export async function poolSetId(prisma: PrismaClient): Promise<string> {
  const row = await prisma.memberSet.findFirstOrThrow({ where: { orgId: null }, select: { id: true } })
  return row.id
}

/** Enroll org-less daemon rows in the pool, the way `upsertOnAuth` does on a real connection. */
export async function joinPool(prisma: PrismaClient, ...daemonIds: string[]): Promise<string> {
  const setId = await poolSetId(prisma)
  await prisma.memberSetMember.createMany({ data: daemonIds.map((daemonId) => ({ setId, daemonId })) })
  return setId
}
