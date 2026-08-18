import type { SandboxReadiness } from './driver.js'

/** How long a pod that is UP may go without a shim channel before the launch counts as lost. */
export const DEFAULT_REBIND_GRACE_MS = 20_000

/** One agent's pending loss decision: why the channel dropped, and how long the pod may take. */
interface LossWatch {
  reason: string
  timer?: NodeJS.Timeout
  /** Set once the pod has been observed coming up, so its arrival restarts the grace window. */
  podWasStarting: boolean
  /** When an unbound channel becomes a loss whatever the pod is doing. */
  ceiling: number
}

export interface ChannelLossWatcherDeps {
  /** Whether the pod that should hold this agent's channel is up. */
  sandboxReadiness: (agentId: string, opts: { signal?: AbortSignal }) => Promise<SandboxReadiness>
  /** Live shim channels for the agent — a non-empty list means a replacement has bound. */
  connectionsFor: (agentId: string) => readonly unknown[]
  /** Ceiling contribution: how long a pod may take to come up at all. Read per watch, because the
   *  driver exposes it as a getter and the plane builds this watcher before the driver exists. */
  podUpTimeoutMs: () => number
  /** How long a pod that is up may go without a shim channel before the launch counts as lost. */
  rebindGraceMs?: number
  onChannelLost: (agentId: string, reason: string) => void
  now?: () => number
  log?: { info: (m: string) => void; warn: (m: string) => void; debug?: (m: string) => void }
}

/**
 * The grace window between a shim socket closing and its launch being declared lost.
 *
 * A closed socket is not a lost launch; renewals reconnect underneath the logical session. Loss is
 * reported only if no replacement binds for the same launch within the window — and the window is
 * measured from the right event: time spent waiting for a pod that is still coming up is waited
 * out rather than counted, with `podUpTimeoutMs` as the ceiling that decides in the end.
 */
export class ChannelLossWatcher {
  private readonly watches = new Map<string, LossWatch>()
  private readonly graceMs: number
  /** How often to re-read a pod that is still coming up. Deliberately well under the grace: this
   *  is a wait for an event, not a window being spent, and the pod's arrival restarts the window. */
  private readonly podUpPollMs: number

  constructor(private readonly deps: ChannelLossWatcherDeps) {
    this.graceMs = deps.rebindGraceMs ?? DEFAULT_REBIND_GRACE_MS
    this.podUpPollMs = Math.max(1, Math.min(2_000, Math.floor(this.graceMs / 4)))
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /**
   * Start the grace window for a channel that dropped, measured from the right event.
   *
   * The window is for a pod that IS up and whose shim has not come back. While the pod is still
   * coming up nothing can dial it at all — a cold start pays PVC provisioning and an image pull —
   * so that time is waited out rather than counted, and the window restarts once the pod is Ready.
   */
  schedule(agentId: string, reason: string): void {
    this.cancel(agentId)
    const watch: LossWatch = {
      reason,
      podWasStarting: false,
      ceiling: this.now() + this.deps.podUpTimeoutMs() + this.graceMs
    }
    this.watches.set(agentId, watch)
    this.arm(agentId, watch, this.graceMs)
  }

  cancel(agentId: string): void {
    const watch = this.watches.get(agentId)
    if (!watch) return
    clearTimeout(watch.timer)
    this.watches.delete(agentId)
  }

  /** Drop every pending decision — nobody waits on a loss once the plane is going down. */
  cancelAll(): void {
    for (const agentId of [...this.watches.keys()]) this.cancel(agentId)
  }

  private arm(agentId: string, watch: LossWatch, delayMs: number): void {
    watch.timer = setTimeout(() => void this.run(agentId, watch), delayMs)
    watch.timer.unref?.()
  }

  /** True while this watch is still the current one and nothing has rebound underneath it. */
  private stillOpen(agentId: string, watch: LossWatch): boolean {
    if (this.watches.get(agentId) !== watch) return false
    if (this.deps.connectionsFor(agentId).length === 0) return true
    this.cancel(agentId)
    return false
  }

  private async run(agentId: string, watch: LossWatch): Promise<void> {
    if (!this.stillOpen(agentId, watch)) return
    // The read itself is bounded by what is LEFT of the ceiling, and by nothing else. The API
    // server has no request deadline of its own, so a read that is accepted and never answered
    // would hold this decision open forever — the launch stuck, its host dead, and nothing to
    // rebuild it: the outcome this whole window exists to remove.
    const remainingMs = watch.ceiling - this.now()
    const readiness =
      remainingMs <= 0
        ? ('absent' as const)
        : await this.deps
            .sandboxReadiness(agentId, { signal: AbortSignal.timeout(remainingMs) })
            .catch((err: unknown) => {
              // An unreadable Sandbox proves nothing about the pod, so it counts as still coming
              // up — and the ceiling below, which the abort cannot outlive, decides in the end.
              this.deps.log?.warn(`k8s: could not read the sandbox for agent ${agentId} — ${(err as Error).message}`)
              return 'starting' as const
            })
    // Re-checked after the round trip: a replacement may have bound, or the agent gone away.
    if (!this.stillOpen(agentId, watch)) return
    if (this.now() < watch.ceiling) {
      if (readiness === 'starting') {
        watch.podWasStarting = true
        this.deps.log?.debug?.(`k8s: agent ${agentId} has no shim channel yet — its sandbox pod is still coming up`)
        this.arm(agentId, watch, this.podUpPollMs)
        return
      }
      // The pod has just come up, so its shim gets the whole grace window to dial in — the clock
      // starts here rather than at a socket that dropped while there was no pod to dial at all.
      if (readiness === 'ready' && watch.podWasStarting) {
        watch.podWasStarting = false
        this.arm(agentId, watch, this.graceMs)
        return
      }
    }
    this.watches.delete(agentId)
    this.deps.log?.warn(
      `k8s: no shim channel for agent ${agentId} after ${this.graceMs}ms with its pod ${readiness} — reporting loss`
    )
    this.deps.onChannelLost(agentId, watch.reason)
  }
}
