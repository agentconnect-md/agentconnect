import { K8sApiError, type K8sHttp } from './http.js'
import { watchCollection, type K8sObject, type ResourceEvent, type WatchOptions } from './watch.js'

/** agent-sandbox API groups, pinned to v1beta1 — the compatibility layer is never touched. */
export const SANDBOX_GROUP = 'agents.x-k8s.io/v1beta1'
export const SANDBOX_EXTENSIONS_GROUP = 'extensions.agents.x-k8s.io/v1beta1'

export type OperatingMode = 'Running' | 'Suspended'

export interface Sandbox extends K8sObject {
  spec?: { operatingMode?: OperatingMode; podTemplate?: unknown }
  status?: { conditions?: Array<{ type?: string; status?: string }> }
}

/** The claim's status names the bound Sandbox; the Sandbox UID comes from that
 *  object's `metadata.uid`, since the claim carries no uid of its own. */
export interface SandboxClaim extends K8sObject {
  spec?: { warmPoolRef?: { name?: string }; additionalPodMetadata?: { labels?: Record<string, string> } }
  status?: { sandbox?: { name?: string } }
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

/** A guarded operating-mode write was rejected, so the decision behind it is stale:
 *  re-read the Sandbox, decide again, and write again — never force the write through.
 *  It deliberately does NOT claim what the intervening state was. The API server reports
 *  a failed JSON Patch `test` and any other patch rejection with the same 422, and any
 *  later read is a fresh snapshot rather than evidence about the failure, so inferring a
 *  cause would be a guess dressed as a fact. Callers must bound their retries: a
 *  permanently invalid patch would otherwise re-read and re-attempt forever. */
export class OperatingModeRejectedError extends Error {
  constructor(
    readonly sandbox: string,
    readonly observed: OperatingMode,
    readonly requested: OperatingMode,
    readonly cause: K8sApiError
  ) {
    super(
      `sandbox ${sandbox}: guarded write to ${requested} was rejected (observed ${observed}) — re-read and decide again`
    )
    this.name = 'OperatingModeRejectedError'
  }
}

function collectionPath(group: string, namespace: string, plural: string): string {
  return `/apis/${group}/namespaces/${namespace}/${plural}`
}

/** The daemon's Kubernetes surface, one method per granted verb: the type surface
 *  mirrors the Role, since a method it does not authorize could only fail at runtime.
 *  The Pod API is absent by design — pods are the vendor controller's to materialize. */
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

  /** Create a claim, treating an existing one as success: names are derived from the
   *  agent id, so a retry after a partial reconcile must converge rather than fail. */
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

  /** Set a bound Sandbox's operating mode — the sleep/wake path.
   *  `observed` is mandatory: between reading a Sandbox and writing it, a message can
   *  wake an instance we decided to suspend (or the reverse), so every write tests the
   *  value we saw rather than clobbering a newer decision. v1beta1 defaults the field to
   *  `Running`, so an observed value always exists.
   *  A rejected write raises {@link OperatingModeRejectedError} — re-read and re-decide.
   *
   *  Measured against a real API server (k3s v1.31.2), so the next reader need not re-derive
   *  it: a failed JSON Patch `test` returns 422 Invalid, never 409, and a merge patch
   *  carrying a stale `metadata.resourceVersion` returns 409 Conflict. The field-scoped
   *  `test` is kept deliberately — a resourceVersion precondition would guard the WHOLE
   *  object, so any unrelated status write by the vendor controller would conflict, while
   *  this only conflicts when the mode itself moved. The error means "re-read and
   *  re-decide" either way, which is the only correct caller action. */
  async setOperatingMode(name: string, mode: OperatingMode, observed: OperatingMode): Promise<Sandbox> {
    try {
      return await this.http.json<Sandbox>({
        method: 'PATCH',
        path: `${this.sandboxes()}/${name}`,
        contentType: 'application/json-patch+json',
        body: [
          { op: 'test', path: '/spec/operatingMode', value: observed },
          { op: 'replace', path: '/spec/operatingMode', value: mode }
        ]
      })
    } catch (err) {
      // The API server answers every rejected JSON Patch — a failed `test` included —
      // with 422 Invalid, and the text comes from the patch library, so it varies by
      // version. Nothing here can prove why the write was rejected: a later read is a
      // fresh snapshot, not evidence, and the mode can change away and back between the
      // two. So report the rejection as itself and let the caller re-decide.
      if (err instanceof K8sApiError && err.isUnprocessable) {
        throw new OperatingModeRejectedError(name, observed, mode, err)
      }
      throw err
    }
  }

  /** Verify a token the shim presented and learn which pod it belongs to. `audiences`
   *  is required: omitting it would accept a token minted for something else.
   *  TokenReview is cluster-scoped, hence its own ClusterRole rather than the Role. */
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
