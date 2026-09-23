// The console's "start this sandbox" (`POST /agents/:id/wake`), debounced per pod: one wake in flight is joined, and one settled within the window answers repeats.
import {
  SESSION_WAKE_FEATURE,
  type AgentWakeOk,
  type AgentWakeReq,
  type AgentWakeState
} from '@agentconnect.md/protocol'
import type { Clock } from '../domain/clock.js'

/** The frame a wake sends and the key it is debounced under: a session's own pod when the daemon can wake one, else the agent's, as before session wakes existed. */
export function agentWakeRequest(
  agentId: string,
  sessionId: string | undefined,
  features: readonly string[]
): { req: AgentWakeReq; key: string } {
  if (sessionId === undefined || !features.includes(SESSION_WAKE_FEATURE)) return { req: { agentId }, key: agentId }
  return { req: { agentId, sessionId }, key: `${agentId}:${sessionId}` }
}

/** How long a settled wake keeps answering repeat callers before the daemon is asked again. */
export const AGENT_WAKE_DEBOUNCE_MS = 30_000

export interface AgentWakeOutcome {
  state: AgentWakeState
  /** True when this call was answered from an earlier wake rather than a frame of its own. */
  coalesced: boolean
}

interface Settled {
  state: AgentWakeState
  at: number
}

export class AgentWakeCoordinator {
  private readonly inflight = new Map<string, Promise<AgentWakeState>>()
  private readonly settled = new Map<string, Settled>()

  constructor(
    private readonly clock: Clock,
    private readonly debounceMs = AGENT_WAKE_DEBOUNCE_MS
  ) {}

  /** Wake the pod `key` names through `send`, or answer from the wake already in flight / just settled. */
  async wake(key: string, send: () => Promise<AgentWakeOk>): Promise<AgentWakeOutcome> {
    const running = this.inflight.get(key)
    if (running) return { state: await running, coalesced: true }
    const recent = this.settled.get(key)
    if (recent && this.clock.now() - recent.at < this.debounceMs) return { state: recent.state, coalesced: true }
    const attempt = send()
      .then((ok) => {
        this.settled.set(key, { state: ok.state, at: this.clock.now() })
        return ok.state
      })
      .finally(() => this.inflight.delete(key))
    this.inflight.set(key, attempt)
    return { state: await attempt, coalesced: false }
  }
}
