import type { AgentConnectOrg, AgentConnectOrgStatus, Condition } from '../crd/types.js'
import type { ReconcileContext } from './context.js'

/** Upsert a condition, advancing lastTransitionTime only when the status flips. */
export function setCondition(conditions: Condition[], next: Condition, nowIso: string): Condition[] {
  const existing = conditions.find((condition) => condition.type === next.type)
  const lastTransitionTime = existing && existing.status === next.status ? existing.lastTransitionTime : nowIso
  const updated: Condition = { ...next, lastTransitionTime }
  return [...conditions.filter((condition) => condition.type !== next.type), updated]
}

/** Build the full status from this pass's observations; the operator is the only status writer. */
export function buildStatus(ctx: ReconcileContext, org: AgentConnectOrg): AgentConnectOrgStatus {
  // TODO(operator): derive NamespaceReady/CredentialReady/Ready from live reads and pod
  // state, fill daemon/sandboxes/pools summaries, and carry appliedLimits as the
  // policy-API observation record (Unknown when the API offers no acknowledgement).
  void ctx
  return { observedGeneration: org.metadata?.generation }
}

/** Publish status; namespace + NamespaceReady must land in the same update (see the operator design doc). */
export async function writeStatus(ctx: ReconcileContext, org: AgentConnectOrg): Promise<void> {
  const name = org.metadata?.name
  if (!name) return
  await ctx.orgApi.patchStatus(name, buildStatus(ctx, org))
}
