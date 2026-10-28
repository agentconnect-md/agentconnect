// The daemon's "nothing would be cut short" signal (daemon-auto-upgrade.md §5.3), read by the AutoUpgrader.
import type { Clock } from '@agentconnect.md/connection'

/** Exactly the live-work reads the signal needs from the Daemon. */
export interface QuiescenceSource {
  /** In-flight turns, including ones parked on a permission or elicitation answer. */
  inFlightTurns(): number
  /** A live background-task lease or an SDK session in `running`. */
  liveBackgroundWork(): boolean
  lifecycleInFlight(): boolean
  draining(): boolean
}

export interface Quiescence {
  /** Why the daemon is busy right now, or undefined; `ignoreLifecycle` discounts a reservation the caller holds. */
  busyReason(ignoreLifecycle?: boolean): string | undefined
  /** Milliseconds since the last turn ended or background lease changed. */
  quietForMs(): number
  /** Subscribe to turn-end / lease-change edges; returns the unsubscribe. */
  onChange(listener: () => void): () => void
}

export class QuiescenceSignal implements Quiescence {
  // Starts at construction so a fresh process waits out the quiet period before restarting itself.
  private lastActivityAt: number
  private readonly listeners = new Set<() => void>()

  constructor(
    private readonly source: QuiescenceSource,
    private readonly clock: () => Clock
  ) {
    this.lastActivityAt = clock().now()
  }

  /** A turn ended or a background lease changed: restart the quiet period and wake subscribers. */
  notify(): void {
    this.lastActivityAt = this.clock().now()
    for (const listener of this.listeners) listener()
  }

  busyReason(ignoreLifecycle = false): string | undefined {
    const turns = this.source.inFlightTurns()
    if (turns > 0) return `${turns} turn(s) in flight`
    if (this.source.liveBackgroundWork()) return 'background work is running'
    if (!ignoreLifecycle && this.source.lifecycleInFlight()) return 'a lifecycle operation is in flight'
    if (this.source.draining()) return 'draining'
    return undefined
  }

  quietForMs(): number {
    return Math.max(0, this.clock().now() - this.lastActivityAt)
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
