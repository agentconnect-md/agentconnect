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

/** Suspend every Sandbox in the namespace; shared by teardown and spec.suspend. */
export async function suspendAllSandboxes(ctx: ReconcileContext, ns: string): Promise<void> {
  const sandboxes = await getOrNull<{ items?: Array<{ metadata?: { name?: string } }> }>(
    ctx.http,
    groupPath(SANDBOX_GROUP, ns, 'sandboxes')
  )
  for (const sandbox of sandboxes?.items ?? []) {
    if (!sandbox.metadata?.name) continue
    // Unguarded on purpose: a quiesce outranks any concurrent wake-up.
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

/** Suspend the daemon and runtime Sandboxes so nothing is mid-turn when teardown starts. */
export async function quiesceDaemon(ctx: ReconcileContext, ns: string): Promise<void> {
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
  await suspendAllSandboxes(ctx, ns)
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

/** Drop our finalizer — the API server completes the deletion after this. */
export async function removeFinalizer(ctx: ReconcileContext, org: AgentConnectOrg): Promise<void> {
  const name = org.metadata?.name
  if (!name) return
  // Conflict-safe: another controller may have added its own finalizer while cleanup ran.
  await ctx.orgApi.updateFinalizer(name, FINALIZER, 'remove')
}

/**
 * Prove the namespace is ours BEFORE any teardown write: prefix-owned AND
 * either absent (leftover cleanup) or carrying this org's claim label. A CR
 * that degraded on NamespaceClaimConflict must not damage the claimant's
 * envelope on its way out.
 */
async function teardownScope(
  ctx: ReconcileContext,
  org: AgentConnectOrg
): Promise<{ ns: string; namespaceExists: boolean } | undefined> {
  const ns = org.spec?.targetNamespace
  if (!ns || !ns.startsWith(ctx.config.orgNamespacePrefix)) return undefined
  const namespace = await getOrNull<K8sResource>(ctx.http, namespacePath(ns))
  if (!namespace) return { ns, namespaceExists: false }
  if (namespace.metadata.labels?.[NAMESPACE_CLAIM_LABEL] !== org.metadata?.name) {
    ctx.log.warn?.(`namespace ${ns} is not claimed by ${org.metadata?.name ?? 'unknown'}; skipping teardown`)
    return undefined
  }
  return { ns, namespaceExists: true }
}

/** The envelope deletion order; steps must be idempotent — deletion reconciles can repeat. */
export async function reconcileDeletion(ctx: ReconcileContext, org: AgentConnectOrg): Promise<void> {
  const scope = await teardownScope(ctx, org)
  if (scope?.namespaceExists) {
    await quiesceDaemon(ctx, scope.ns)
    await deleteWorkloads(ctx, scope.ns)
    await archiveOrg(ctx, org)
  }
  if (scope) await deleteNamespaceAndClusterBindings(ctx, scope.ns)
  await removeFinalizer(ctx, org)
}
