/**
 * Per-user serialization of `ensurePersonalOrg` (the personal-org seam).
 *
 * The seam's first statement locks the `app_user` row FOR UPDATE, so callers
 * that otherwise lock DISJOINT rows still serialize on the user. The regression
 * this pins down: an ALREADY-activated, org-less user (the external admin app's
 * activation-repair case) being provisioned concurrently by two transactions —
 * e.g. a waitlist redeem (which locks only the `waitlist_entry` row and skips
 * `user.update` for an activated user) racing an admin-side activation. Without
 * the lock both observe "no owner membership" and each mint a personal org +
 * preset; with it, exactly one org/membership/preset survives.
 */
import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '../setup.db.js'
import { ensurePersonalOrg } from '../../src/persistence/repositories/user.repo.js'

describe('ensurePersonalOrg per-user serialization', () => {
  it('concurrent calls for one already-activated user mint exactly one org + preset', async () => {
    const user = await prisma.user.create({
      data: {
        email: `cross-${randomUUID()}@example.test`,
        oidcSubject: `sub-${randomUUID()}`,
        displayName: 'Cross Race',
        activatedAt: new Date() // already activated ⇒ no caller takes a user.update lock
      }
    })

    // Each call opens its OWN transaction (root-client PrismaLike), modelling
    // independent callers over the shared database. Same-name slugs force the
    // colliding candidate chain.
    await Promise.all(Array.from({ length: 6 }, () => ensurePersonalOrg(prisma, user.id, 'Cross', user.email)))

    const memberships = await prisma.membership.findMany({ where: { userId: user.id } })
    expect(memberships).toHaveLength(1)
    expect(memberships[0]!.role).toBe('owner')

    const presets = await prisma.presetAgent.findMany({ where: { orgId: memberships[0]!.orgId } })
    expect(presets).toHaveLength(1)
    expect(presets[0]!.status).toBe('created')

    // No orphaned second org slipped through under a suffixed slug.
    const orgs = await prisma.org.findMany({ where: { slug: { startsWith: 'cross' } } })
    expect(orgs).toHaveLength(1)
  })
})
