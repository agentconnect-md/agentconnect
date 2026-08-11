import {
  watchCollection,
  type K8sHttp,
  type K8sList,
  type ResourceEvent,
  type WatchMetrics
} from '@agentconnect.md/k8s-client'
import type { Backoff, Clock } from '@agentconnect.md/connection'
import { API_VERSION, GROUP, KIND, PLURAL, VERSION, type AgentConnectOrg } from './types.js'

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

  /** Merge-patch on object metadata — the finalizer add/remove path. */
  async patchMeta(name: string, metadata: AgentConnectOrg['metadata']): Promise<AgentConnectOrg> {
    return this.http.json<AgentConnectOrg>({
      method: 'PATCH',
      path: this.item(name),
      contentType: 'application/merge-patch+json',
      body: { apiVersion: API_VERSION, kind: KIND, metadata }
    })
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
