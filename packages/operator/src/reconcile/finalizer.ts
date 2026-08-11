import { NAMESPACE_CLAIM_LABEL, FINALIZER, type AgentConnectOrg } from '../crd/types.js'
import type { ReconcileContext } from './context.js'
import {
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

/** The deletion path only touches namespaces this install owns; anything else is skipped, not fixed. */
function ownedNamespace(ctx: ReconcileContext, org: AgentConnectOrg): string | undefined {
  const ns = org.spec?.targetNamespace
  if (!ns || !ns.startsWith(ctx.config.orgNamespacePrefix)) return undefined
  return ns
}

/** Suspend the daemon and runtime Sandboxes so nothing is mid-turn when teardown starts. */
export async function quiesceDaemon(ctx: ReconcileContext, org: AgentConnectOrg): Promise<void> {
  const ns = ownedNamespace(ctx, org)
  if (!ns) return
  try {
    await ctx.http.json({
      method: 'PATCH',
      path: groupPath('apps/v1', ns, 'deployments', DAEMON_NAME),
      contentType: 'application/merge-patch+json',
      body: { spec: { replicas: 0 } }
    })
  } catch {
    // Already gone or never created — teardown continues either way.
  }
  const sandboxes = await getOrNull<{ items?: Array<{ metadata?: { name?: string } }> }>(
    ctx.http,
    groupPath(SANDBOX_GROUP, ns, 'sandboxes')
  )
  for (const sandbox of sandboxes?.items ?? []) {
    if (!sandbox.metadata?.name) continue
    // Unguarded on purpose: during org deletion there is no wake-up worth losing the race to.
    try {
      await ctx.http.json({
        method: 'PATCH',
        path: groupPath(SANDBOX_GROUP, ns, 'sandboxes', sandbox.metadata.name),
        contentType: 'application/merge-patch+json',
        body: { spec: { operatingMode: 'Suspended' } }
      })
    } catch {
      // A vanished sandbox is exactly the desired direction.
    }
  }
}

/** Delete the org's workloads (Deployment, Service, PVC, sandbox stack) ahead of the namespace. */
export async function deleteWorkloads(ctx: ReconcileContext, org: AgentConnectOrg): Promise<void> {
  const ns = ownedNamespace(ctx, org)
  if (!ns) return
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
export async function deleteNamespaceAndClusterBindings(ctx: ReconcileContext, org: AgentConnectOrg): Promise<void> {
  const ns = ownedNamespace(ctx, org)
  if (!ns) return
  await deleteIgnoreMissing(ctx.http, clusterRoleBindingPath(tokenReviewBindingName(ns)))
  const namespace = await getOrNull<K8sResource>(ctx.http, namespacePath(ns))
  if (!namespace) return
  // Only a namespace carrying this org's claim label is ours to delete.
  if (namespace.metadata.labels?.[NAMESPACE_CLAIM_LABEL] !== org.metadata?.name) {
    ctx.log.warn?.(`namespace ${ns} is not claimed by ${org.metadata?.name ?? 'unknown'}; leaving it in place`)
    return
  }
  await deleteIgnoreMissing(ctx.http, namespacePath(ns))
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
  await quiesceDaemon(ctx, org)
  await deleteWorkloads(ctx, org)
  await archiveOrg(ctx, org)
  await deleteNamespaceAndClusterBindings(ctx, org)
  await removeFinalizer(ctx, org)
}
