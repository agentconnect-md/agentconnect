import {
  K8sApiError,
  watchCollection,
  type K8sHttp,
  type K8sList,
  type ResourceEvent,
  type WatchMetrics
} from '@agentconnect.md/k8s-client'
import type { Backoff, Clock } from '@agentconnect.md/connection'
import { API_VERSION, GROUP, KIND, PLURAL, VERSION, type AgentConnectOrg } from './types.js'

/** Bounded retries for the read-modify-write finalizer path. */
const FINALIZER_WRITE_ATTEMPTS = 5

/** Typed verb surface over the AgentConnectOrg collection in one control namespace. */
export class AgentConnectOrgApi {
  constructor(
    private readonly http: K8sHttp,
    /** The control namespace — the only namespace this operator watches. */
    readonly namespace: string
  ) {}

  private get collection(): string {
    return `/apis/${GROUP}/${VERSION}/namespaces/${this.namespace}/${PLURAL}`
  }

  private item(name: string): string {
    return `${this.collection}/${name}`
  }

  async get(name: string): Promise<AgentConnectOrg> {
    return this.http.json<AgentConnectOrg>({ method: 'GET', path: this.item(name) })
  }

  async list(): Promise<AgentConnectOrg[]> {
    const result = await this.http.json<K8sList<AgentConnectOrg>>({ method: 'GET', path: this.collection })
    return result.items ?? []
  }

  /** Level-triggered list-then-watch over the control namespace's CRs. */
  watch(options?: {
    signal?: AbortSignal
    timeoutSeconds?: number
    clock?: Clock
    backoff?: Backoff
    metrics?: WatchMetrics
  }): AsyncGenerator<ResourceEvent<AgentConnectOrg>> {
    return watchCollection<AgentConnectOrg>(this.http, { path: this.collection, ...options })
  }

  /** Merge-patch on object metadata; pass a resourceVersion to make the write conditional. */
  async patchMeta(name: string, metadata: AgentConnectOrg['metadata']): Promise<AgentConnectOrg> {
    return this.http.json<AgentConnectOrg>({
      method: 'PATCH',
      path: this.item(name),
      contentType: 'application/merge-patch+json',
      body: { apiVersion: API_VERSION, kind: KIND, metadata }
    })
  }

  /**
   * Add or remove exactly our finalizer under optimistic concurrency: the whole
   * list is replaced, so a blind write would drop a finalizer another controller
   * added while we worked. Re-reads and retries on conflict.
   */
  async updateFinalizer(name: string, finalizer: string, action: 'add' | 'remove'): Promise<AgentConnectOrg> {
    for (let attempt = 0; attempt < FINALIZER_WRITE_ATTEMPTS; attempt += 1) {
      const current = await this.get(name)
      const finalizers = current.metadata?.finalizers ?? []
      const present = finalizers.includes(finalizer)
      if (action === 'add' ? present : !present) return current
      const next = action === 'add' ? [...finalizers, finalizer] : finalizers.filter((entry) => entry !== finalizer)
      try {
        return await this.patchMeta(name, { resourceVersion: current.metadata?.resourceVersion, finalizers: next })
      } catch (error) {
        // 409 means the object moved under us — re-read and reapply to the new list.
        if (error instanceof K8sApiError && error.isConflict && attempt < FINALIZER_WRITE_ATTEMPTS - 1) continue
        throw error
      }
    }
    throw new Error(`finalizer ${action} on ${name} lost ${FINALIZER_WRITE_ATTEMPTS} optimistic-concurrency races`)
  }

  /** Merge-patch against the /status subresource; the operator is its only writer. */
  async patchStatus(name: string, status: AgentConnectOrg['status']): Promise<AgentConnectOrg> {
    return this.http.json<AgentConnectOrg>({
      method: 'PATCH',
      path: `${this.item(name)}/status`,
      contentType: 'application/merge-patch+json',
      body: { apiVersion: API_VERSION, kind: KIND, status }
    })
  }
}
