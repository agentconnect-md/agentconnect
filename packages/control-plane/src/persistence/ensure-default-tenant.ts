/**
 * Idempotently ensure the fixed tenant used by no-auth installations.
 *
 * Production startup calls this only when OIDC is disabled. The explicit
 * Prisma seed reuses it for tests and maintenance commands.
 *
 * One transaction, like every other org-creation path (preset-agents.md §3.2):
 * the org, its owner membership, and the `agentconnect` preset + its marker
 * commit together. Provisioning HERE rather than leaving the default org to the
 * boot backfill also removes a startup-ordering dependency — the backfill's
 * worklist is read once, so an org this function creates afterwards would
 * otherwise wait for the NEXT boot to get its preset.
 */
import type { PrismaClient } from '../generated/prisma/client.js'
import { DEFAULT_ORG_ID, DEFAULT_ORG_SLUG, DEFAULT_OWNER_EMAIL, DEFAULT_OWNER_ID } from '../config/defaults.js'
import { withTx } from './prisma.js'

export async function ensureDefaultTenant(prisma: PrismaClient, opts?: { presetAgents?: boolean }): Promise<void> {
  await withTx(prisma, async (tx) => {
    const org = await tx.org.upsert({
      where: { id: DEFAULT_ORG_ID },
      // Never overwrite operator edits when no-auth startup runs again.
      update: {},
      create: {
        id: DEFAULT_ORG_ID,
        name: 'Default',
        slug: DEFAULT_ORG_SLUG
      }
    })

    const owner = await tx.user.upsert({
      where: { id: DEFAULT_OWNER_ID },
      update: {},
      create: {
        id: DEFAULT_OWNER_ID,
        email: DEFAULT_OWNER_EMAIL,
        displayName: 'Owner'
      }
    })

    await tx.membership.upsert({
      where: { orgId_userId: { orgId: org.id, userId: owner.id } },
      update: { role: 'owner' },
      create: { orgId: org.id, userId: owner.id, role: 'owner' }
    })

    // Idempotent + collision-aware: this runs on EVERY no-auth boot, against an
    // org that may already hold a preset row or a user agent on the reserved
    // slug. A system write — the default tenant has no acting user.
    //
    // LAZY import on purpose. The preset seam reaches `PgAgentRepo`, which imports
    // `@agentconnect.md/protocol`; a static import would drag that whole graph into
    // every consumer of this module — including `prisma/seed.ts`, which runs as a
    // bare `tsx` process with no `development` export condition and so would need
    // protocol's `dist/` built just to create an Org row. Loading it only when
    // presets are actually enabled keeps the seed's import graph at Prisma + config.
    if (opts?.presetAgents !== false) {
      const { ensurePresetAgentsProvisioned } = await import('./preset-agents.js')
      await ensurePresetAgentsProvisioned(tx, org.id)
    }
  })
}
