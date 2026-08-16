/**
 * Placement primitives shared by the agent repository and the one writer that has to settle
 * placements from OUTSIDE it: retiring an install-wide pool member, where the daemon delete
 * and the settlement of every agent it hosted must land in one transaction
 * (`daemon.repo.ts#retirePoolMember`).
 *
 * Placement/delegation lock order:
 *   Agent FOR UPDATE → active WebchatMcpDelegation rows.
 * Establishment joins the same order with a compatible Agent FOR SHARE, then locks its
 * Conversation FOR UPDATE before touching Delegation. Agent is always first, so placement and
 * agent deletion cannot form an inverse cycle.
 */
import { Prisma } from '../../generated/prisma/client.js'
import type { PlacementKind } from '../../domain/placement.js'

/** Every placement column under the row lock, plus the agent's org — `daemonId` alone stopped
 *  being the placement when a set became a target that names no machine, and the org is what the
 *  set placement invariant is judged against. */
export async function lockAgentPlacement(
  tx: Prisma.TransactionClient,
  agentId: string
): Promise<LockedPlacement | null> {
  const [row] = await tx.$queryRaw<LockedPlacement[]>(
    Prisma.sql`SELECT "orgId", "placementKind", "daemonId", "setId" FROM "agent" WHERE "id" = ${agentId} FOR UPDATE`
  )
  return row ?? null
}

export interface LockedPlacement {
  orgId: string
  placementKind: PlacementKind
  daemonId: string | null
  setId: string | null
}

export async function revokeActiveWebchatMcpDelegations(
  tx: Prisma.TransactionClient,
  agentId: string,
  revokedAt: Date
): Promise<void> {
  await tx.webchatMcpDelegation.updateMany({
    where: { agentId, revokedAt: null },
    data: { revokedAt, revokedReason: 'agent_placement_changed' }
  })
}

/**
 * Finish an unplacement a daemon DELETE started. The FK sets `daemonId` null and touches
 * nothing else, so without this the agent reads `active` with nowhere to run, holding live
 * webchat delegations and compiled hook rules — which is why it belongs in the deleting
 * transaction, not after it.
 *
 * Conditional by design: a row some other writer has since placed elsewhere is not this
 * removal's to null, so it is left alone and reported as unsettled.
 */
export async function settleCascadedUnplacement(tx: Prisma.TransactionClient, agentId: string): Promise<boolean> {
  const current = await lockAgentPlacement(tx, agentId)
  // A `set` agent has no daemonId for the FK to have nulled, so it is not this removal's to
  // settle: it was never placed on the departing member, only served by it, and the ledger
  // hands its duty to another member on the next beat.
  if (!current || current.placementKind !== 'daemon' || current.daemonId !== null) return false
  await tx.agent.update({
    // No daemonId write — the cascade already did that; what is missing is everything
    // `setPlacement(unplaced)` pairs with it, including the revision the next owner compares.
    where: { id: agentId },
    data: { status: 'inactive', configRevision: { increment: 1 } }
  })
  await revokeActiveWebchatMcpDelegations(tx, agentId, new Date())
  await tx.hookDef.updateMany({ where: { agentId }, data: { dispatchRevision: { increment: 1 } } })
  return true
}
