/**
 * The Secret half of the provisioner — the control plane is the key authority.
 *
 * The operator has ZERO Secret API access anywhere
 * (docs/designs/agentconnect-org-operator.md §1): it only names the Secret in
 * `spec.daemon.credentialSecretName` and mounts it required, so the kubelet
 * gates the daemon pod's startup on a credential the operator can never read.
 * Writing it is this module's job and nothing else's.
 */
import { K8sApiError, type K8sHttp } from '@agentconnect.md/k8s-client'
import { FIELD_MANAGER } from './crd.js'

/** The key inside the Secret; the daemon's init container installs it as its config file. */
export const CREDENTIAL_SECRET_KEY = 'config.json'

/** The three verbs the key authority uses; a seam so its logic is testable without a socket. */
export interface OrgSecretApi {
  /** Create-or-replace the org's credential Secret. Throws {@link NamespaceNotReadyError}
   *  while the operator has not created the envelope namespace yet. */
  applyCredential(namespace: string, name: string, configJson: string): Promise<void>
  delete(namespace: string, name: string): Promise<void>
}

/** The envelope namespace does not exist yet — the operator creates it from the CR. */
export class NamespaceNotReadyError extends Error {
  constructor(readonly namespace: string) {
    super(`namespace ${namespace} does not exist yet — the operator creates it once the resource is applied`)
    this.name = 'NamespaceNotReadyError'
  }
}

export class ClusterSecretApi implements OrgSecretApi {
  constructor(private readonly http: K8sHttp) {}

  private path(namespace: string, name: string): string {
    return `/api/v1/namespaces/${namespace}/secrets/${name}`
  }

  async applyCredential(namespace: string, name: string, configJson: string): Promise<void> {
    try {
      await this.http.json({
        method: 'PATCH',
        path: this.path(namespace, name),
        contentType: 'application/apply-patch+yaml',
        query: { fieldManager: FIELD_MANAGER, force: true },
        body: {
          apiVersion: 'v1',
          kind: 'Secret',
          metadata: { name, namespace },
          type: 'Opaque',
          // stringData, not data: the API server base64-encodes it, so no plaintext
          // credential is ever encoded into a log-friendly shape on this side.
          stringData: { [CREDENTIAL_SECRET_KEY]: configJson }
        }
      })
    } catch (error) {
      // A missing namespace is the ordinary "enabled a moment ago" state, not a
      // fault: the operator creates it from the CR the control plane just applied.
      if (error instanceof K8sApiError && error.isNotFound) throw new NamespaceNotReadyError(namespace)
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
