/**
 * The re-read every agent-scoped mutation takes after it wins the move gate.
 *
 * Four route files had their own copy, and the copies drifted the moment one of them was
 * corrected (#1055 fixed three onto placement identity and left `agents.ts` on the column), so the
 * rule lives here once instead.
 *
 * What it fences on:
 *  - PLACEMENT IDENTITY, not the `daemonId` column. A `set` placement names no machine, so column
 *    equality both misses a re-placement onto another set and reads every set agent as unplaced.
 *  - `lastModifiedAt`, so an edit that landed between the caller's read and the lease is a conflict.
 *
 * `observed` came through an org-fenced read, so its own org scopes the refresh. null ⇒ the caller
 * answers 409 and the operator retries against fresh state.
 */
import { samePlacementRef } from '../domain/placement.js'
import type { AgentRecord, AgentRepo } from '../persistence/ports.js'

export async function refreshMutationAgent(
  agents: Pick<AgentRepo, 'get'>,
  observed: AgentRecord
): Promise<AgentRecord | null> {
  const current = await agents.get(observed.orgId, observed.id)
  if (
    !current ||
    !samePlacementRef(current, observed) ||
    current.lastModifiedAt.getTime() !== observed.lastModifiedAt.getTime()
  ) {
    return null
  }
  return current
}
