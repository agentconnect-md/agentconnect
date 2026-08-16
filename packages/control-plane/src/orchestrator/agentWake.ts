// The console's "start this agent's sandbox" (`POST /agents/:id/wake`), debounced per agent: one wake
// in flight is joined by every caller, and a wake settled within the debounce window is answered from
// its result rather than re-sent — a Files and a Memory tab opened together cost the daemon one frame.
import type { AgentWakeOk, AgentWakeState } from '@agentconnect.md/protocol'
import type { Clock } from '../domain/clock.js'

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

  /** Wake `agentId` through `send`, or answer from the wake already in flight / just settled. */
  async wake(agentId: string, send: () => Promise<AgentWakeOk>): Promise<AgentWakeOutcome> {
    const running = this.inflight.get(agentId)
    if (running) return { state: await running, coalesced: true }
    const recent = this.settled.get(agentId)
    if (recent && this.clock.now() - recent.at < this.debounceMs) return { state: recent.state, coalesced: true }
    const attempt = send()
      .then((ok) => {
        this.settled.set(agentId, { state: ok.state, at: this.clock.now() })
        return ok.state
      })
      .finally(() => this.inflight.delete(agentId))
    this.inflight.set(agentId, attempt)
    return { state: await attempt, coalesced: false }
  }
}
