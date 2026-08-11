import type { AgentConnectOrg } from '../crd/types.js'
import type { ReconcileContext } from './context.js'

/**
 * Runtime-image rollout over bound Sandboxes: Suspended instances get a
 * conditioned image patch, Running instances go through the
 * agentconnect.md/drain-requested annotation state machine — never a forced
 * suspend. Progress and pending/failed instances land in status.rollout.
 */
export async function reconcileRollout(ctx: ReconcileContext, org: AgentConnectOrg): Promise<void> {
  // TODO(operator): implement the drain state machine (conditioned patch for Suspended,
  // annotation handshake for Running, timeout -> pending/failed, stale-annotation sweep).
  void ctx
  void org
}
