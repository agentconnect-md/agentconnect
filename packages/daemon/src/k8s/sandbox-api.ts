import { K8sApiError, type K8sHttp, type K8sList, type K8sObject } from '@agentconnect.md/k8s-client'

/** agent-sandbox API groups, pinned to v1beta1 — the compatibility layer is never touched. */
export const SANDBOX_GROUP = 'agents.x-k8s.io/v1beta1'
export const SANDBOX_EXTENSIONS_GROUP = 'extensions.agents.x-k8s.io/v1beta1'

export type OperatingMode = 'Running' | 'Suspended'

interface SandboxContainer {
  name?: string
  image?: string
}

interface SandboxPodTemplate {
  metadata?: { labels?: Record<string, string> }
  spec?: { containers?: SandboxContainer[] }
}

export interface Sandbox extends K8sObject {
  spec?: { operatingMode?: OperatingMode; podTemplate?: SandboxPodTemplate }
  status?: {
    conditions?: Array<{ type?: string; status?: string }>
    podIPs?: Array<string | { ip?: string }>
  }
}

/** Claim status names the bound Sandbox; its UID comes from that object's metadata. */
export interface SandboxClaim extends K8sObject {
  metadata?: NonNullable<K8sObject['metadata']> & {
    labels?: Record<string, string>
  }
  spec?: { warmPoolRef?: { name?: string }; additionalPodMetadata?: { labels?: Record<string, string> } }
  status?: { sandbox?: { name?: string } }
}

export interface SandboxWarmPool extends K8sObject {
  spec?: { sandboxTemplateRef?: { name?: string } }
}

export interface SandboxTemplate extends K8sObject {
  spec?: { podTemplate?: SandboxPodTemplate }
}

export interface TokenReviewResult {
  authenticated: boolean
  /** The pod the presented token was issued to, from the bound-object extras. */
  podName?: string
  podUid?: string
  username?: string
  error?: string
}

/** An ensure result: the claim, plus whether this call is the one that created it. */
export interface EnsuredClaim {
  claim: SandboxClaim
  created: boolean
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

export class GuardedResumeRejectedError extends Error {
  constructor(
    readonly sandbox: string,
    readonly cause: K8sApiError
  ) {
    super(`sandbox ${sandbox}: guarded mode/image resume patch was rejected`)
    this.name = 'GuardedResumeRejectedError'
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

  private warmPools(): string {
    return collectionPath(SANDBOX_EXTENSIONS_GROUP, this.namespace, 'sandboxwarmpools')
  }

  private sandboxTemplates(): string {
    return collectionPath(SANDBOX_EXTENSIONS_GROUP, this.namespace, 'sandboxtemplates')
  }

  /** Create a claim, treating an existing one as success: names are derived from the
   *  agent id, so a retry after a partial reconcile must converge rather than fail. */
  // Reports whether it CREATED the claim, because that is the only trustworthy cold-start
  // signal: a first claim is the launch that pays PVC provisioning and an image pull, and the
  // AlreadyExists branch is exactly the case that does not.
  //
  // That branch WRITES rather than merely reading: the caller's annotations are merged onto the
  // claim it found, so every admission of an existing claim leaves a new resourceVersion behind.
  // A reader that fenced a delete on the version it listed then loses to an admission that
  // followed its snapshot, which is the property the orphan sweep depends on.
  async ensureClaim(claim: SandboxClaim & { metadata: { name: string } }): Promise<EnsuredClaim> {
    try {
      const created = await this.http.json<SandboxClaim>({
        method: 'POST',
        path: this.claims(),
        body: { apiVersion: SANDBOX_EXTENSIONS_GROUP, kind: 'SandboxClaim', ...claim }
      })
      return { claim: created, created: true }
    } catch (err) {
      if (err instanceof K8sApiError && err.isAlreadyExists) {
        return {
          claim: await this.mergeClaimAnnotations(claim.metadata.name, claim.metadata.annotations),
          created: false
        }
      }
      throw err
    }
  }

  /** Merge annotations onto an existing claim and return it; with none to merge it is a plain read. */
  private async mergeClaimAnnotations(
    name: string,
    annotations: Record<string, string> | undefined
  ): Promise<SandboxClaim> {
    if (!annotations || Object.keys(annotations).length === 0) return await this.getClaim(name)
    return await this.http.json<SandboxClaim>({
      method: 'PATCH',
      path: `${this.claims()}/${name}`,
      contentType: 'application/merge-patch+json',
      body: { metadata: { annotations } }
    })
  }

  getClaim(name: string): Promise<SandboxClaim> {
    return this.http.json<SandboxClaim>({ method: 'GET', path: `${this.claims()}/${name}` })
  }

  async listClaims(labelSelector?: string): Promise<SandboxClaim[]> {
    const list = await this.http.json<K8sList<SandboxClaim>>({
      method: 'GET',
      path: this.claims(),
      query: { ...(labelSelector ? { labelSelector } : {}) }
    })
    return list.items ?? []
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

  /** Delete only the listed claim incarnation; false means the name now belongs to a replacement. */
  async deleteClaimIfCurrent(name: string, preconditions: { uid: string; resourceVersion?: string }): Promise<boolean> {
    return this.deleteIfCurrent(`${this.claims()}/${name}`, preconditions)
  }

  private async deleteIfCurrent(
    path: string,
    preconditions: { uid: string; resourceVersion?: string }
  ): Promise<boolean> {
    try {
      await this.http.json({
        method: 'DELETE',
        path,
        body: {
          apiVersion: 'v1',
          kind: 'DeleteOptions',
          preconditions: {
            uid: preconditions.uid,
            ...(preconditions.resourceVersion ? { resourceVersion: preconditions.resourceVersion } : {})
          }
        }
      })
      return true
    } catch (err) {
      if (err instanceof K8sApiError && err.isNotFound) return true
      if (err instanceof K8sApiError && err.isConflict) return false
      throw err
    }
  }

  async listSandboxes(labelSelector?: string): Promise<Sandbox[]> {
    const list = await this.http.json<K8sList<Sandbox>>({
      method: 'GET',
      path: this.sandboxes(),
      query: { ...(labelSelector ? { labelSelector } : {}) }
    })
    return list.items ?? []
  }

  /** Delete only the listed Sandbox incarnation; false means the name now belongs to a replacement. */
  async deleteSandboxIfCurrent(
    name: string,
    preconditions: { uid: string; resourceVersion?: string }
  ): Promise<boolean> {
    return this.deleteIfCurrent(`${this.sandboxes()}/${name}`, preconditions)
  }

  /** `signal` bounds the read: a caller on a deadline must not be pinned by an API server that
   *  accepted the connection and never answered. Same seam a watch aborts through. */
  getSandbox(name: string, opts: { signal?: AbortSignal } = {}): Promise<Sandbox> {
    return this.http.json<Sandbox>({
      method: 'GET',
      path: `${this.sandboxes()}/${name}`,
      ...(opts.signal ? { signal: opts.signal } : {})
    })
  }

  getWarmPool(name: string): Promise<SandboxWarmPool> {
    return this.http.json<SandboxWarmPool>({ method: 'GET', path: `${this.warmPools()}/${name}` })
  }

  getSandboxTemplate(name: string): Promise<SandboxTemplate> {
    return this.http.json<SandboxTemplate>({ method: 'GET', path: `${this.sandboxTemplates()}/${name}` })
  }

  async resumeWithRuntimeImage(
    name: string,
    image: { containerIndex: number; observedName: string; observedImage: string; targetImage: string }
  ): Promise<Sandbox> {
    const containerPath = `/spec/podTemplate/spec/containers/${image.containerIndex}`
    const body: Array<{ op: 'test' | 'replace'; path: string; value: string }> = [
      { op: 'test', path: '/spec/operatingMode', value: 'Suspended' },
      { op: 'test', path: `${containerPath}/name`, value: image.observedName },
      { op: 'test', path: `${containerPath}/image`, value: image.observedImage }
    ]
    if (image.observedImage !== image.targetImage) {
      body.push({ op: 'replace', path: `${containerPath}/image`, value: image.targetImage })
    }
    body.push({ op: 'replace', path: '/spec/operatingMode', value: 'Running' })
    try {
      return await this.http.json<Sandbox>({
        method: 'PATCH',
        path: `${this.sandboxes()}/${name}`,
        contentType: 'application/json-patch+json',
        body
      })
    } catch (err) {
      if (err instanceof K8sApiError && err.isUnprocessable) throw new GuardedResumeRejectedError(name, err)
      throw err
    }
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
