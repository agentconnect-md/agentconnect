import { K8sApiError, type K8sHttp } from '@agentconnect.md/k8s-client'

/** Server-side-apply field manager; one manager, force=true — the operator owns what it stamps. */
export const FIELD_MANAGER = 'agentconnect-operator'

// Envelope object names are fixed per-namespace constants: the namespace is per-org,
// so names never collide and stay greppable across every org envelope.
export const DAEMON_NAME = 'ac-daemon'
export const RUNTIME_SA_NAME = 'ac-runtime'
export const SHIM_SERVICE_NAME = 'ac-daemon-shim'
export const DAEMON_PVC_NAME = 'ac-daemon-state'
export const QUOTA_NAME = 'ac-quota'
export const LIMIT_RANGE_NAME = 'ac-limits'
export const DAEMON_EGRESS_POLICY_NAME = 'ac-daemon-egress'
export const DAEMON_INGRESS_POLICY_NAME = 'ac-daemon-ingress'
/** Org-side SandboxTemplate/SandboxWarmPool name per tier: `ac-runtime-<tier>`. */
export const RUNTIME_TIER_PREFIX = 'ac-runtime-'
export const SHIM_PORT = 8085
export const APP_LABEL_KEY = 'app'

/** agent-sandbox API groups, pinned to v1beta1 (mirrors the daemon's SandboxApi). */
export const SANDBOX_GROUP = 'agents.x-k8s.io/v1beta1'
export const SANDBOX_EXTENSIONS_GROUP = 'extensions.agents.x-k8s.io/v1beta1'

/** The per-org ClusterRoleBinding name; unique because namespaces are prefix-disjoint per install. */
export function tokenReviewBindingName(targetNamespace: string): string {
  return `ac-tokenreview-${targetNamespace}`
}

export function runtimeTierName(tier: string): string {
  return `${RUNTIME_TIER_PREFIX}${tier}`
}

/** Loose object shape for SSA writes and reads; specs stay structural per call site. */
export interface K8sResource {
  apiVersion: string
  kind: string
  metadata: {
    name: string
    namespace?: string
    labels?: Record<string, string>
    annotations?: Record<string, string | null>
  }
  [key: string]: unknown
}

export function corePath(namespace: string, plural: string, name?: string): string {
  return `/api/v1/namespaces/${namespace}/${plural}${name ? `/${name}` : ''}`
}

export function namespacePath(name?: string): string {
  return `/api/v1/namespaces${name ? `/${name}` : ''}`
}

export function groupPath(groupVersion: string, namespace: string, plural: string, name?: string): string {
  return `/apis/${groupVersion}/namespaces/${namespace}/${plural}${name ? `/${name}` : ''}`
}

export function clusterRoleBindingPath(name?: string): string {
  return `/apis/rbac.authorization.k8s.io/v1/clusterrolebindings${name ? `/${name}` : ''}`
}

/** Server-side apply: create-or-converge the full desired object in one PATCH. */
export async function applyObject<T = K8sResource>(http: K8sHttp, path: string, obj: K8sResource): Promise<T> {
  return http.json<T>({
    method: 'PATCH',
    path,
    contentType: 'application/apply-patch+yaml',
    query: { fieldManager: FIELD_MANAGER, force: true },
    body: obj
  })
}

/** GET that reads 404 as null — the reconcile "does it exist" primitive. */
export async function getOrNull<T>(http: K8sHttp, path: string): Promise<T | null> {
  try {
    return await http.json<T>({ method: 'GET', path })
  } catch (error) {
    if (error instanceof K8sApiError && error.isNotFound) return null
    throw error
  }
}

/** DELETE where absence already is the desired state. */
export async function deleteIgnoreMissing(http: K8sHttp, path: string): Promise<void> {
  try {
    await http.json({ method: 'DELETE', path })
  } catch (error) {
    if (error instanceof K8sApiError && error.isNotFound) return
    throw error
  }
}
