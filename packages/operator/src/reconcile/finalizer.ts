import { K8sApiError } from '@agentconnect.md/k8s-client'
import { NAMESPACE_CLAIM_LABEL, FINALIZER, ORG_LABEL, type AgentConnectOrg } from '../crd/types.js'
import type { ReconcileContext } from './context.js'
import { namespaceFault, orgNamespace } from './namespace.js'
import {
  APP_LABEL_KEY,
  DAEMON_NAME,
  DAEMON_PVC_NAME,
  SANDBOX_EXTENSIONS_GROUP,
  SANDBOX_GROUP,
  SHIM_SERVICE_NAME,
  clusterRoleBindingPath,
  corePath,
  deleteIgnoreMissing,
  getOrNull,
  groupPath,
  namespacePath,
  tokenReviewBindingName,
  type K8sResource
} from './resources.js'

/** True when no daemon pod remains — the signal that its graceful drain has finished. */
export async function daemonPodsGone(ctx: ReconcileContext, ns: string): Promise<boolean> {
  const pods = await getOrNull<{ items?: unknown[] }>(ctx.http, corePath(ns, 'pods'), {
    labelSelector: `${APP_LABEL_KEY}=${DAEMON_NAME}`
  })
  return (pods?.items ?? []).length === 0
}

/**
 * Suspend every Sandbox in the namespace; shared by teardown and spec.suspend.
 * Callers must have proven the daemon pod is gone first — suspending deletes the
 * runtime pod, which would cut a turn the daemon was still draining. Only a 404
 * is ignorable; any other failure aborts the pass so the workqueue retries.
 */
export async function suspendAllSandboxes(ctx: ReconcileContext, ns: string): Promise<void> {
  const sandboxes = await getOrNull<{ items?: Array<{ metadata?: { name?: string } }> }>(
    ctx.http,
    groupPath(SANDBOX_GROUP, ns, 'sandboxes')
  )
  for (const sandbox of sandboxes?.items ?? []) {
    if (!sandbox.metadata?.name) continue
    try {
      await ctx.http.json({
        method: 'PATCH',
        path: groupPath(SANDBOX_GROUP, ns, 'sandboxes', sandbox.metadata.name),
        contentType: 'application/merge-patch+json',
        body: { spec: { operatingMode: 'Suspended' } }
      })
    } catch (error) {
      // A vanished sandbox is the desired direction; everything else must surface and retry.
      if (error instanceof K8sApiError && error.isNotFound) continue
      throw error
    }
  }
}

/** Scale the daemon to zero and, once its pod is actually gone, suspend the Sandboxes. */
export async function quiesceDaemon(ctx: ReconcileContext, ns: string): Promise<boolean> {
  try {
    await ctx.http.json({
      method: 'PATCH',
      path: groupPath('apps/v1', ns, 'deployments', DAEMON_NAME),
      contentType: 'application/merge-patch+json',
      body: { spec: { replicas: 0 } }
    })
  } catch (error) {
    if (!(error instanceof K8sApiError && error.isNotFound)) throw error
  }
  // The replica patch is asynchronous; the org-labeled pod deletion event re-enqueues us.
  if (!(await daemonPodsGone(ctx, ns))) {
    ctx.log.debug?.(`daemon pod in ${ns} still draining; deferring sandbox suspension`)
    return false
  }
  await suspendAllSandboxes(ctx, ns)
  return true
}

/** Delete the org's workloads (Deployment, Service, PVC, sandbox stack) ahead of the namespace. */
export async function deleteWorkloads(ctx: ReconcileContext, ns: string): Promise<void> {
  await deleteIgnoreMissing(ctx.http, groupPath('apps/v1', ns, 'deployments', DAEMON_NAME))
  await deleteIgnoreMissing(ctx.http, corePath(ns, 'services', SHIM_SERVICE_NAME))
  await deleteIgnoreMissing(ctx.http, corePath(ns, 'persistentvolumeclaims', DAEMON_PVC_NAME))
  // Collection deletes: claims release bound sandboxes, pools stop replacing them.
  await deleteIgnoreMissing(ctx.http, groupPath(SANDBOX_EXTENSIONS_GROUP, ns, 'sandboxclaims'))
  await deleteIgnoreMissing(ctx.http, groupPath(SANDBOX_EXTENSIONS_GROUP, ns, 'sandboxwarmpools'))
  await deleteIgnoreMissing(ctx.http, groupPath(SANDBOX_EXTENSIONS_GROUP, ns, 'sandboxtemplates'))
}

/** Reserved for a future Archive deletionPolicy; v1alpha1 only admits Delete. */
export async function archiveOrg(ctx: ReconcileContext, org: AgentConnectOrg): Promise<void> {
  // TODO(future): export workspace/transcript data before the cascade removes the PVCs.
  void ctx
  void org
}

/** Delete the org namespace and the cluster-scoped bindings no ownerReference covers. */
export async function deleteNamespaceAndClusterBindings(ctx: ReconcileContext, ns: string): Promise<void> {
  await deleteIgnoreMissing(ctx.http, clusterRoleBindingPath(tokenReviewBindingName(ns)))
  await deleteIgnoreMissing(ctx.http, namespacePath(ns))
}

/** Delete the org's TokenReview CRB only when its org label proves it is ours. */
export async function deleteOwnedTokenReviewBinding(
  ctx: ReconcileContext,
  org: AgentConnectOrg,
  ns: string
): Promise<void> {
  const path = clusterRoleBindingPath(tokenReviewBindingName(ns))
  const crb = await getOrNull<K8sResource>(ctx.http, path)
  if (!crb) return
  if (crb.metadata.labels?.[ORG_LABEL] !== org.metadata?.name) return
  await deleteIgnoreMissing(ctx.http, path)
}

/** Drop our finalizer — the API server completes the deletion after this. */
export async function removeFinalizer(ctx: ReconcileContext, org: AgentConnectOrg): Promise<void> {
  const name = org.metadata?.name
  if (!name) return
  // Conflict-safe: another controller may have added its own finalizer while cleanup ran.
  await ctx.orgApi.updateFinalizer(name, FINALIZER, 'remove')
}

/** The envelope deletion order; steps must be idempotent — deletion reconciles can repeat. */
export async function reconcileDeletion(ctx: ReconcileContext, org: AgentConnectOrg): Promise<void> {
  const orgName = org.metadata?.name
  const ns = orgName ? orgNamespace(ctx.config.orgNamespacePrefix, orgName, org.spec?.targetNamespace) : undefined
  // Outside our prefix, or no legal namespace at all, nothing was ever provisioned: only the finalizer is ours.
  if (!ns || namespaceFault(ctx.config.orgNamespacePrefix, ns)) {
    await removeFinalizer(ctx, org)
    return
  }
  const namespace = await getOrNull<K8sResource>(ctx.http, namespacePath(ns))
  // A claim mismatch fences ALL namespaced teardown — the claimant's envelope stays untouched —
  // but a CRB whose org label proves it ours is still cleaned up, not leaked.
  if (namespace && namespace.metadata.labels?.[NAMESPACE_CLAIM_LABEL] !== org.metadata?.name) {
    ctx.log.warn?.(`namespace ${ns} is not claimed by ${org.metadata?.name ?? 'unknown'}; skipping teardown`)
    await deleteOwnedTokenReviewBinding(ctx, org, ns)
    await removeFinalizer(ctx, org)
    return
  }
  if (namespace) {
    // Defer (without dropping the finalizer) until the daemon pod has drained.
    if (!(await quiesceDaemon(ctx, ns))) return
    await deleteWorkloads(ctx, ns)
    await archiveOrg(ctx, org)
  }
  await deleteNamespaceAndClusterBindings(ctx, ns)
  await removeFinalizer(ctx, org)
}
