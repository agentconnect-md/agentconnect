import { K8sApiError, type K8sHttp } from './http.js'
import { watchCollection, type K8sObject, type ResourceEvent, type WatchOptions } from './watch.js'

/** agent-sandbox API groups, pinned to v1beta1 — the compatibility layer is never touched. */
export const SANDBOX_GROUP = 'agents.x-k8s.io/v1beta1'
export const SANDBOX_EXTENSIONS_GROUP = 'extensions.agents.x-k8s.io/v1beta1'

export type OperatingMode = 'Running' | 'Suspended'

export interface Sandbox extends K8sObject {
  spec?: { operatingMode?: OperatingMode; podTemplate?: unknown }
  status?: { conditions?: Array<{ type?: string; status?: string }>; podIPs?: Array<{ ip?: string }> }
}

export interface SandboxClaim extends K8sObject {
  spec?: { warmPoolRef?: { name?: string }; additionalPodMetadata?: { labels?: Record<string, string> } }
  status?: { sandbox?: { name?: string; uid?: string } }
}

export interface TokenReviewResult {
  authenticated: boolean
  /** The pod the presented token was issued to, from the bound-object extras. */
  podName?: string
  podUid?: string
  username?: string
  error?: string
}

const POD_NAME_EXTRA = 'authentication.kubernetes.io/pod-name'
const POD_UID_EXTRA = 'authentication.kubernetes.io/pod-uid'

function collectionPath(group: string, namespace: string, plural: string): string {
  return `/apis/${group}/namespaces/${namespace}/${plural}`
}

/**
 * The daemon's complete Kubernetes surface, one method per granted verb.
 *
 * It is intentionally not a generic CRD client: the RBAC this runs under grants
 * SandboxClaim create/delete/get/list/watch, Sandbox get/watch/patch (restricted
 * to `spec.operatingMode` by an admission policy), and cluster-scoped TokenReview
 * create. A method here that the Role does not authorize would only fail at
 * runtime, so the type surface mirrors the Role exactly.
 *
 * The Pod API is deliberately absent — pods are materialized by the vendor
 * controller and the daemon never addresses them directly.
 */
export class SandboxApi {
  constructor(
    private http: K8sHttp,
    private namespace: string
  ) {}

  private claims(): string {
    return collectionPath(SANDBOX_EXTENSIONS_GROUP, this.namespace, 'sandboxclaims')
  }

  private sandboxes(): string {
    return collectionPath(SANDBOX_GROUP, this.namespace, 'sandboxes')
  }

  /**
   * Create a claim, treating an existing one as success: claim names are derived
   * from the agent id, so a retry after a partial reconcile must converge rather
   * than fail.
   */
  async ensureClaim(claim: SandboxClaim & { metadata: { name: string } }): Promise<SandboxClaim> {
    try {
      return await this.http.json<SandboxClaim>({
        method: 'POST',
        path: this.claims(),
        body: { apiVersion: SANDBOX_EXTENSIONS_GROUP, kind: 'SandboxClaim', ...claim }
      })
    } catch (err) {
      if (err instanceof K8sApiError && err.isAlreadyExists) return this.getClaim(claim.metadata.name)
      throw err
    }
  }

  getClaim(name: string): Promise<SandboxClaim> {
    return this.http.json<SandboxClaim>({ method: 'GET', path: `${this.claims()}/${name}` })
  }

  /** Delete a claim; an already-absent claim is success (agent deletion is idempotent). */
  async deleteClaim(name: string): Promise<void> {
    try {
      await this.http.json({ method: 'DELETE', path: `${this.claims()}/${name}` })
    } catch (err) {
      if (err instanceof K8sApiError && err.isNotFound) return
      throw err
    }
  }

  watchClaims(options: Omit<WatchOptions, 'path'> = {}): AsyncGenerator<ResourceEvent<SandboxClaim>> {
    return watchCollection<SandboxClaim>(this.http, { ...options, path: this.claims() })
  }

  getSandbox(name: string): Promise<Sandbox> {
    return this.http.json<Sandbox>({ method: 'GET', path: `${this.sandboxes()}/${name}` })
  }

  watchSandboxes(options: Omit<WatchOptions, 'path'> = {}): AsyncGenerator<ResourceEvent<Sandbox>> {
    return watchCollection<Sandbox>(this.http, { ...options, path: this.sandboxes() })
  }

  /**
   * Set a bound Sandbox's operating mode — the sleep/wake path.
   *
   * JSON Patch with a `test` guard rather than a bare replace: between reading a
   * Sandbox and writing it, a message can wake an instance we decided to suspend
   * (or vice versa). The `test` makes the write fail with a conflict instead of
   * silently overriding the newer decision, and `expected` names what we believed.
   * Pass `expected: null` to require the field to be currently unset.
   */
  async setOperatingMode(name: string, mode: OperatingMode, expected?: OperatingMode | null): Promise<Sandbox> {
    const patch: Array<Record<string, unknown>> = []
    if (expected !== undefined) {
      patch.push({ op: 'test', path: '/spec/operatingMode', value: expected })
    }
    patch.push({ op: 'replace', path: '/spec/operatingMode', value: mode })
    return this.http.json<Sandbox>({
      method: 'PATCH',
      path: `${this.sandboxes()}/${name}`,
      contentType: 'application/json-patch+json',
      body: patch
    })
  }

  /**
   * Verify a token the in-sandbox shim presented, and learn which pod it belongs
   * to. `audiences` is not optional in practice: a token minted for a different
   * audience must be rejected, and omitting the field would accept it.
   *
   * TokenReview is cluster-scoped, which is why this needs its own ClusterRole
   * rather than the per-namespace Role that covers everything else here.
   */
  async reviewToken(token: string, audiences: string[]): Promise<TokenReviewResult> {
    const review = await this.http.json<{
      status?: {
        authenticated?: boolean
        error?: string
        user?: { username?: string; extra?: Record<string, string[]> }
      }
    }>({
      method: 'POST',
      path: '/apis/authentication.k8s.io/v1/tokenreviews',
      body: { apiVersion: 'authentication.k8s.io/v1', kind: 'TokenReview', spec: { token, audiences } }
    })
    const status = review.status ?? {}
    const extra = status.user?.extra ?? {}
    return {
      authenticated: status.authenticated === true,
      ...(extra[POD_NAME_EXTRA]?.[0] ? { podName: extra[POD_NAME_EXTRA][0] } : {}),
      ...(extra[POD_UID_EXTRA]?.[0] ? { podUid: extra[POD_UID_EXTRA][0] } : {}),
      ...(status.user?.username ? { username: status.user.username } : {}),
      ...(status.error ? { error: status.error } : {})
    }
  }
}

/** Whether a Sandbox reports Ready, the signal that its pod is up. */
export function isSandboxReady(sandbox: Sandbox): boolean {
  return (sandbox.status?.conditions ?? []).some(
    (condition) => condition.type === 'Ready' && condition.status === 'True'
  )
}
