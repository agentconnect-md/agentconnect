import type { Observations, ReconcileContext } from './context.js'
import type { EnvelopeInputs } from './envelope.js'

/**
 * Render spec.llmLimits / spec.llmDeny / spec.suspend into the egress gateway's
 * policy resources in the control namespace. The concrete resource kinds are
 * pinned by the gateway-selection spike; status.appliedLimits records only what
 * the policy API acknowledges (Unknown when it acknowledges nothing).
 */
export async function renderGatewayPolicies(
  ctx: ReconcileContext,
  input: EnvelopeInputs,
  obs: Observations
): Promise<void> {
  // TODO(operator): render the three limit tiers and deny rules once the gateway kinds are final.
  void ctx
  void input
  void obs
}
