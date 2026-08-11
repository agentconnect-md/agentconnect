import type { K8sHttp } from '@agentconnect.md/k8s-client'
import type { OperatorConfig } from '../config.js'
import type { AgentConnectOrgApi } from '../crd/api.js'

/** Everything a reconcile pass may touch; constructed once per controller term. */
export interface ReconcileContext {
  http: K8sHttp
  orgApi: AgentConnectOrgApi
  config: OperatorConfig
  log: { debug?: (message: string) => void; warn?: (message: string) => void }
}
