/**
 * `Watchdog` (design §4.9, protocol §2.2) — missed-heartbeat → freeze →
 * reassign-grace → rebalance, all `Clock`-driven so it is deterministic in tests
 * (advance the `FakeClock` to fire freeze, then grace).
 *
 * Two-phase, never a single step:
 *   1. After `MISSED_BEATS × HEARTBEAT_SEC` with no heartbeat/pong, the daemon is
 *      marked unreachable and its routing is **frozen** — surfaced, but NOT
 *      reassigned (a daemon in local-autonomy may still be serving).
 *   2. Only after a further `REASSIGN_GRACE_SEC`, if it is still gone, its
 *      sessions are rebalanced onto other daemons under a fresh epoch.
 *
 * Combined with `sessionEpoch` fencing this guarantees no two daemons serve one
 * session across the gap (the split-brain guard).
 */
import type { Clock, TimerHandle } from '../domain/clock.js'
import type { ConnectionRegistry } from '../ws/registry.js'
import { DaemonId } from '../domain/ids.js'

/** The slice of the orchestrator the watchdog drives. */
export interface WatchdogOrchestrator {
  /** Freeze the daemon's routing (phase 1) — no reassignment yet. */
  onDaemonUnreachable(daemonId: DaemonId): void
  /** Rebalance the daemon's sessions onto others (phase 2, after grace). */
  rebalanceFrom(daemonId: DaemonId): Promise<void>
}

/** Config slice the watchdog reads. */
export interface WatchdogConfig {
  HEARTBEAT_SEC: number
  MISSED_BEATS: number
  REASSIGN_GRACE_SEC: number
}

export class Watchdog {
  private readonly missTimers = new Map<string, TimerHandle>()
  private readonly graceTimers = new Map<string, TimerHandle>()

  constructor(
    private readonly registry: ConnectionRegistry,
    private readonly clock: Clock,
    private readonly orch: WatchdogOrchestrator,
    private readonly cfg: WatchdogConfig
  ) {}

  /** Begin (or restart) watching a daemon — called on `auth/ok`. */
  track(daemonId: string): void {
    this.arm(daemonId)
  }

  /** A heartbeat/pong arrived — refresh liveness and re-arm the miss timer. */
  beat(daemonId: string): void {
    const c = this.registry.get(daemonId)
    if (c) {
      c.lastBeatAt = this.clock.now()
      c.reachable = true
    }
    // A beat after the grace timer started cancels the pending rebalance.
    const g = this.graceTimers.get(daemonId)
    if (g !== undefined) {
      this.clock.clearTimeout(g)
      this.graceTimers.delete(daemonId)
    }
    this.arm(daemonId)
  }

  /** Stop watching a daemon (socket closed / removed). */
  untrack(daemonId: string): void {
    const m = this.missTimers.get(daemonId)
    if (m !== undefined) this.clock.clearTimeout(m)
    this.missTimers.delete(daemonId)
    const g = this.graceTimers.get(daemonId)
    if (g !== undefined) this.clock.clearTimeout(g)
    this.graceTimers.delete(daemonId)
  }

  private arm(daemonId: string): void {
    const prev = this.missTimers.get(daemonId)
    if (prev !== undefined) this.clock.clearTimeout(prev)
    const missMs = this.cfg.HEARTBEAT_SEC * this.cfg.MISSED_BEATS * 1000
    this.missTimers.set(
      daemonId,
      this.clock.setTimeout(() => this.onMiss(daemonId), missMs)
    )
  }

  /** Phase 1: freeze, then schedule the phase-2 rebalance after the grace. */
  private onMiss(daemonId: string): void {
    this.missTimers.delete(daemonId)
    const c = this.registry.get(daemonId)
    if (!c) return
    c.reachable = false
    this.orch.onDaemonUnreachable(DaemonId(daemonId)) // FREEZE — do not reassign yet

    const graceMs = this.cfg.REASSIGN_GRACE_SEC * 1000
    this.graceTimers.set(
      daemonId,
      this.clock.setTimeout(() => {
        this.graceTimers.delete(daemonId)
        // Still gone after the grace → rebalance its sessions onto others.
        if (this.registry.get(daemonId)?.reachable === false) {
          void this.orch.rebalanceFrom(DaemonId(daemonId))
        }
      }, graceMs)
    )
  }
}
