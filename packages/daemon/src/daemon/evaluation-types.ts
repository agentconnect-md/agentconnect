import type { WebchatEvent } from '@agentconnect.md/protocol'
import type { EvaluationCapabilityProfile, EvaluationObserver } from '../evaluation/events.js'
import type { DaemonEvaluationEnvironment } from '../evaluation/environment.js'

export interface DaemonEvaluationOptions {
  /** Optional semantic-event tap. When absent, all instrumentation is a no-op. */
  observer?: EvaluationObserver
  /** Stable run identity shared by event, ATIF, and manifest artifacts. */
  runId?: string
  /** Add-on treatment (memory only). Production defaults to configured. Collaboration
   *  has no toggle: evaluation always runs the production tool surface and delivery. */
  capabilityProfile?: EvaluationCapabilityProfile
  /** Collaboration Arena environment (collaboration-arena.md §5): the effective
   *  integration registry projected into `agent.integrations` + the connection
   *  maps, the synthetic collaboration topology, and the peer directory. */
  environment?: DaemonEvaluationEnvironment
  /** Evaluation health sink. It is contained with the observer and cannot fail a turn. */
  onObserverError?: (error: unknown) => void
}

export interface DaemonEvaluationTurnInput {
  agentId: string
  conversationId: string
  text: string
  turnId?: string
  user?: string
}

export interface DaemonEvaluationTurnResult {
  turnId: string
  sessionId: string | null
  output: string
  events: WebchatEvent[]
  stopReason?: string
  usage?: { used?: number }
}
