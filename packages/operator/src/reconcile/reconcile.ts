import { K8sApiError } from '@agentconnect.md/k8s-client'
import { FINALIZER, type AgentConnectOrg } from '../crd/types.js'
import type { ReconcileContext } from './context.js'
import { reconcileEnvelope } from './envelope.js'
import { reconcileDeletion } from './finalizer.js'
import { renderGatewayPolicies } from './gateway-limits.js'
import { reconcileRollout } from './rollout.js'
import { writeStatus } from './status.js'

/** One level-triggered pass for one org: read live state, dispatch, publish status. */
export async function reconcile(ctx: ReconcileContext, name: string): Promise<void> {
  let org: AgentConnectOrg
  try {
    org = await ctx.orgApi.get(name)
  } catch (error) {
    if (error instanceof K8sApiError && error.isNotFound) return
    throw error
  }
  if (org.metadata?.deletionTimestamp) {
    await reconcileDeletion(ctx, org)
    return
  }
  if (!(org.metadata?.finalizers ?? []).includes(FINALIZER)) {
    org = await ctx.orgApi.patchMeta(name, { finalizers: [...(org.metadata?.finalizers ?? []), FINALIZER] })
  }
  await reconcileEnvelope(ctx, org)
  await reconcileRollout(ctx, org)
  await renderGatewayPolicies(ctx, org)
  await writeStatus(ctx, org)
}
