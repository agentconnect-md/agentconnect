/**
 * The reference fence of a Gitea binding (gitea-integration.md §6). Every transaction that commits a
 * reference to a managed repository — a trigger, an agent workspace, an additional-repository grant —
 * locks the repository's claim SHARED and proves the binding is still live; a removal locks the same
 * row EXCLUSIVELY while it counts references and parks, so neither can slip past the other.
 */
import type { Prisma } from '../../generated/prisma/client.js'
import { GiteaBindingUnavailable } from '../errors.js'

/** The claim states under which a binding still serves (§5); anything else is gone or parked. */
const LIVE_CLAIM_STATES: ReadonlySet<string> = new Set(['provisioning', 'active'])

export async function joinGiteaBindingFence(
  tx: Prisma.TransactionClient,
  orgId: string,
  repoId: bigint
): Promise<void> {
  const rows = await tx.$queryRaw<{ state: string }[]>`
    SELECT "state" FROM "code_host_repository_claim"
     WHERE "provider" = 'gitea' AND "externalId" = ${repoId.toString()}::bigint AND "orgId" = ${orgId}
       FOR SHARE`
  const state = rows[0]?.state
  if (state === undefined || !LIVE_CLAIM_STATES.has(state)) throw new GiteaBindingUnavailable(repoId)
}
