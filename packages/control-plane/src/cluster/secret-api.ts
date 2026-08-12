/**
 * The Secret half of the provisioner — the control plane is the key authority.
 *
 * The operator has ZERO Secret API access anywhere
 * (docs/designs/agentconnect-org-operator.md §1): it only names the Secret in
 * `spec.daemon.credentialSecretName` and mounts it required, so the kubelet
 * gates the daemon pod's startup on a credential the operator can never read.
 * Writing it is this module's job and nothing else's.
 *
 * The rotation token in the database cannot fence a request that is ALREADY in
 * flight to the API server, so ordering has to be enforced cluster-side too: the
 * published Secret carries the rotation sequence that wrote it, a publish
 * refuses to overwrite a higher one, and the write itself is guarded by
 * `resourceVersion` so a concurrent writer cannot slip in between the read and
 * the replace. Together those make a stalled request unable to restore a
 * credential its successor already replaced.
 */
import { K8sApiError, type K8sHttp } from '@agentconnect.md/k8s-client'

/** The key inside the Secret; the daemon's init container installs it as its config file. */
export const CREDENTIAL_SECRET_KEY = 'config.json'

/** Records which rotation published the Secret's current contents. */
export const CREDENTIAL_SEQ_ANNOTATION = 'agentconnect.md/credential-seq'

/** Bounded retries for the read-modify-write publish. */
const PUBLISH_ATTEMPTS = 5

/** The three verbs the key authority uses; a seam so its logic is testable without a socket. */
export interface OrgSecretApi {
  /** Publish the org's credential Secret for rotation `seq`. Throws
   *  {@link NamespaceNotReadyError} before the operator has created the
   *  namespace, and {@link StaleCredentialWriteError} when a later rotation has
   *  already published. */
  publishCredential(namespace: string, name: string, seq: number, configJson: string): Promise<void>
  /** The rotation sequence the Secret currently carries; 0 when it does not
   *  exist. Used to settle an AMBIGUOUS publish — a write whose response was
   *  lost may still have committed, and revoking that key would leave the pod
   *  holding a dead credential. */
  publishedSeq(namespace: string, name: string): Promise<number>
  delete(namespace: string, name: string): Promise<void>
}

/** The envelope namespace is not usable yet — the operator creates it, and publishes its name, from the CR. */
export class NamespaceNotReadyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NamespaceNotReadyError'
  }

  /** The namespace the CR names has not been created yet. */
  static missing(namespace: string): NamespaceNotReadyError {
    return new NamespaceNotReadyError(
      `namespace ${namespace} does not exist yet — the operator creates it once the resource is applied`
    )
  }

  /** The operator has not derived and published `status.namespace` yet, so nothing names a namespace. */
  static unpublished(resourceName: string): NamespaceNotReadyError {
    return new NamespaceNotReadyError(
      `AgentConnectOrg ${resourceName} has no status.namespace yet — the operator publishes it once the envelope namespace is claimed`
    )
  }
}

/** A newer rotation already published; this one must abandon rather than overwrite it. */
export class StaleCredentialWriteError extends Error {
  constructor(
    readonly seq: number,
    readonly publishedSeq: number
  ) {
    super(`credential rotation ${seq} is behind the published rotation ${publishedSeq}`)
    this.name = 'StaleCredentialWriteError'
  }
}

interface SecretResource {
  metadata?: { resourceVersion?: string; annotations?: Record<string, string> }
}

export class ClusterSecretApi implements OrgSecretApi {
  constructor(private readonly http: K8sHttp) {}

  private collection(namespace: string): string {
    return `/api/v1/namespaces/${namespace}/secrets`
  }

  private path(namespace: string, name: string): string {
    return `${this.collection(namespace)}/${name}`
  }

  async publishCredential(namespace: string, name: string, seq: number, configJson: string): Promise<void> {
    for (let attempt = 0; attempt < PUBLISH_ATTEMPTS; attempt += 1) {
      const existing = await this.read(namespace, name)
      const published = Number(existing?.metadata?.annotations?.[CREDENTIAL_SEQ_ANNOTATION] ?? 0)
      // Not `>=`: a retry of the SAME rotation must still be able to finish.
      if (published > seq) throw new StaleCredentialWriteError(seq, published)

      const body = {
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: {
          name,
          namespace,
          annotations: { [CREDENTIAL_SEQ_ANNOTATION]: String(seq) },
          // Present ⇒ the API server rejects the write if anyone changed the
          // Secret since the read above. Absent ⇒ this is a create.
          ...(existing?.metadata?.resourceVersion ? { resourceVersion: existing.metadata.resourceVersion } : {})
        },
        type: 'Opaque',
        // stringData, not data: the API server base64-encodes it, so no plaintext
        // credential is ever encoded into a log-friendly shape on this side.
        stringData: { [CREDENTIAL_SECRET_KEY]: configJson }
      }
      try {
        await this.http.json(
          existing
            ? { method: 'PUT', path: this.path(namespace, name), body }
            : { method: 'POST', path: this.collection(namespace), body }
        )
        return
      } catch (error) {
        if (!(error instanceof K8sApiError)) throw error
        if (error.isNotFound) throw NamespaceNotReadyError.missing(namespace)
        // Lost the race (409 Conflict on the resourceVersion, or AlreadyExists on
        // a create): re-read and re-decide, which is where a newer seq is caught.
        if (error.isConflict && attempt < PUBLISH_ATTEMPTS - 1) continue
        throw error
      }
    }
    throw new Error(`publishing the credential Secret ${namespace}/${name} lost ${PUBLISH_ATTEMPTS} races`)
  }

  async publishedSeq(namespace: string, name: string): Promise<number> {
    const existing = await this.read(namespace, name)
    return Number(existing?.metadata?.annotations?.[CREDENTIAL_SEQ_ANNOTATION] ?? 0)
  }

  private async read(namespace: string, name: string): Promise<SecretResource | null> {
    try {
      return await this.http.json<SecretResource>({ method: 'GET', path: this.path(namespace, name) })
    } catch (error) {
      // A missing SECRET is the ordinary first-issue state. A missing NAMESPACE
      // is the ordinary "enabled a moment ago" state — the operator creates it
      // from the CR the control plane just applied — and both read as 404 here,
      // so they are told apart on the write below.
      if (error instanceof K8sApiError && error.isNotFound) return null
      throw error
    }
  }

  async delete(namespace: string, name: string): Promise<void> {
    try {
      await this.http.json({ method: 'DELETE', path: this.path(namespace, name) })
    } catch (error) {
      if (error instanceof K8sApiError && error.isNotFound) return
      throw error
    }
  }
}
