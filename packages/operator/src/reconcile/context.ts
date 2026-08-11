import type { Clock } from '@agentconnect.md/connection'
import type { K8sHttp } from '@agentconnect.md/k8s-client'
import type { OperatorConfig } from '../config.js'
import type { AgentConnectOrgApi } from '../crd/api.js'
import type { AgentConnectOrgStatus } from '../crd/types.js'

/** Everything a reconcile pass may touch; constructed once per controller term. */
export interface ReconcileContext {
  http: K8sHttp
  orgApi: AgentConnectOrgApi
  config: OperatorConfig
  /** The install's control namespace — master templates live here, CRs are watched here. */
  controlNamespace: string
  /** Time source for deadlines a pass measures (drain timeouts); system clock when omitted. */
  clock?: Clock
  log: { debug?: (message: string) => void; warn?: (message: string) => void }
}

/** What one pass observed; envelope steps write into it, buildStatus reads it. */
export interface Observations {
  /** Namespace exists and carries our claim label — set atomically with `namespace`. */
  namespaceReady: boolean
  namespace?: string
  /** First blocking fault of the pass; envelope work stops when namespace-level. */
  degraded?: { reason: string; message: string }
  /** Non-blocking faults (e.g. a tier whose master template is missing). */
  warnings: string[]
  daemon?: { ready: boolean; image?: string }
  /** Deployment has not converged to its desired replica count yet. */
  progressing: boolean
  credential?: { status: 'True' | 'False' | 'Unknown'; reason: string; message?: string }
  /** This pass read a provisional state; ask the queue for one more look after this delay. */
  recheckAfterMs?: number
  sandboxes?: { total: number; running: number; suspended: number }
  pools?: AgentConnectOrgStatus['pools']
  rollout?: AgentConnectOrgStatus['rollout']
}

export function newObservations(): Observations {
  return { namespaceReady: false, progressing: false, warnings: [] }
}
