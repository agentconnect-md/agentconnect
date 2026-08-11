import { FINALIZER, type AgentConnectOrg } from '../crd/types.js'
import type { ReconcileContext } from './context.js'

/** Suspend the daemon and drain sandboxes so nothing is mid-turn when teardown starts. */
export async function quiesceDaemon(ctx: ReconcileContext, org: AgentConnectOrg): Promise<void> {
  // TODO(operator): scale the daemon to zero and suspend runtime Sandboxes via the drain handshake.
  void ctx
  void org
}

/** Delete the org's workloads (Deployment, Sandboxes/Claims) ahead of the namespace. */
export async function deleteWorkloads(ctx: ReconcileContext, org: AgentConnectOrg): Promise<void> {
  // TODO(operator): explicit deletes — namespace cascade alone leaves cluster-scoped leftovers.
  void ctx
  void org
}

/** Reserved for a future Archive deletionPolicy; v1alpha1 only admits Delete. */
export async function archiveOrg(ctx: ReconcileContext, org: AgentConnectOrg): Promise<void> {
  // TODO(future): export workspace/transcript data before the cascade removes the PVCs.
  void ctx
  void org
}

/** Delete the org namespace and the cluster-scoped bindings no ownerReference covers. */
export async function deleteNamespaceAndClusterBindings(ctx: ReconcileContext, org: AgentConnectOrg): Promise<void> {
  // TODO(operator): namespace delete cascades the namespaced envelope; the tokenreview CRB needs an explicit delete.
  void ctx
  void org
}

/** Drop the finalizer — the API server completes the deletion after this. */
export async function removeFinalizer(ctx: ReconcileContext, org: AgentConnectOrg): Promise<void> {
  const name = org.metadata?.name
  if (!name) return
  const remaining = (org.metadata?.finalizers ?? []).filter((finalizer) => finalizer !== FINALIZER)
  await ctx.orgApi.patchMeta(name, { finalizers: remaining })
}

/** The envelope deletion order; steps must be idempotent — deletion reconciles can repeat. */
export async function reconcileDeletion(ctx: ReconcileContext, org: AgentConnectOrg): Promise<void> {
  await quiesceDaemon(ctx, org)
  await deleteWorkloads(ctx, org)
  await archiveOrg(ctx, org)
  await deleteNamespaceAndClusterBindings(ctx, org)
  await removeFinalizer(ctx, org)
}
