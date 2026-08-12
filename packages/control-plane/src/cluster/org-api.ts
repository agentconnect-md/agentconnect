/**
 * Typed verbs over the `AgentConnectOrg` collection in one control namespace.
 *
 * The control plane writes `spec` and reads `status`; it never touches
 * `/status`, finalizers, or any envelope object — those belong to the operator.
 * Writes are server-side apply under this process's own field manager, so the
 * two writers coexist on one object without read-modify-write races.
 */
import { K8sApiError, type K8sHttp } from '@agentconnect.md/k8s-client'
import {
  API_VERSION,
  FIELD_MANAGER,
  GROUP,
  KIND,
  PLURAL,
  VERSION,
  type AgentConnectOrg,
  type AgentConnectOrgSpec
} from './crd.js'

/** The three verbs the provisioner uses; a seam so its convergence logic is testable without a socket. */
export interface OrgResourceApi {
  readonly namespace: string
  apply(name: string, spec: AgentConnectOrgSpec): Promise<AgentConnectOrg>
  get(name: string): Promise<AgentConnectOrg | null>
  delete(name: string, precondition?: { uid?: string; resourceVersion?: string }): Promise<void>
}

export class AgentConnectOrgApi implements OrgResourceApi {
  constructor(
    private readonly http: K8sHttp,
    /** The install's control namespace — where every org's CR lives. */
    readonly namespace: string
  ) {}

  private get collection(): string {
    return `/apis/${GROUP}/${VERSION}/namespaces/${this.namespace}/${PLURAL}`
  }

  private item(name: string): string {
    return `${this.collection}/${name}`
  }

  /** Create-or-converge the whole desired spec in one PATCH. */
  async apply(name: string, spec: AgentConnectOrgSpec): Promise<AgentConnectOrg> {
    return this.http.json<AgentConnectOrg>({
      method: 'PATCH',
      path: this.item(name),
      contentType: 'application/apply-patch+yaml',
      query: { fieldManager: FIELD_MANAGER, force: true },
      body: { apiVersion: API_VERSION, kind: KIND, metadata: { name, namespace: this.namespace }, spec }
    })
  }

  /** The CR, or null when the org has no envelope yet. */
  async get(name: string): Promise<AgentConnectOrg | null> {
    try {
      return await this.http.json<AgentConnectOrg>({ method: 'GET', path: this.item(name) })
    } catch (error) {
      if (error instanceof K8sApiError && error.isNotFound) return null
      throw error
    }
  }

  /**
   * Delete the CR; absence already is the desired state. The operator's
   * finalizer drains and removes the envelope from there.
   *
   * `precondition` makes the delete conditional on the exact object that was
   * read: a caller whose lease expired can still have this request in flight
   * when a re-enable applies a new generation, and an unconditional delete would
   * remove the resource that re-enable just created. The API server rejects a
   * mismatched `uid`/`resourceVersion` instead.
   */
  async delete(name: string, precondition?: { uid?: string; resourceVersion?: string }): Promise<void> {
    try {
      await this.http.json({
        method: 'DELETE',
        path: this.item(name),
        ...(precondition?.uid || precondition?.resourceVersion
          ? {
              body: {
                apiVersion: 'meta.k8s.io/v1',
                kind: 'DeleteOptions',
                preconditions: {
                  ...(precondition.uid ? { uid: precondition.uid } : {}),
                  ...(precondition.resourceVersion ? { resourceVersion: precondition.resourceVersion } : {})
                }
              }
            }
          : {})
      })
    } catch (error) {
      if (error instanceof K8sApiError && error.isNotFound) return
      throw error
    }
  }
}
