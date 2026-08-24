/**
 * Background convergence sweep (gitlab-com-integration.md §10.2): re-drives the
 * bindings a contended pass still owes work.
 *
 * A convergence that loses a lease fence writes no state — a race is not a
 * verdict about the binding — so there is no degraded row to rediscover it by,
 * and the in-process follow-up it arms does not survive a restart. The neutral
 * obligation on the binding is what does, and this is what reads it. Built in
 * the graph, armed only by `startBackground()` — never in tests, which drive
 * `sweepOwedConvergences` directly.
 */
import type { Clock, TimerHandle } from '../domain/clock.js'
import type { GitlabProvisioner } from './provisioner.js'

/** Leave an obligation alone this long, so the sweep never races the follow-up
 *  the same process already armed for it. */
export const CONVERGE_OWED_QUIET_MS = 2 * 60 * 1000
const FIRST_SWEEP_DELAY_MS = 90 * 1000
const SWEEP_INTERVAL_MS = 5 * 60 * 1000

export class GitlabConvergeSweeper {
  private timer: TimerHandle | null = null
  private stopped = false

  constructor(
    private readonly deps: {
      provisioner: GitlabProvisioner
      clock: Clock
      log?: { warn(obj: object, msg: string): void }
    }
  ) {}

  start(): void {
    this.stopped = false
    this.arm(FIRST_SWEEP_DELAY_MS)
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== null) this.deps.clock.clearTimeout(this.timer)
    this.timer = null
  }

  private arm(delayMs: number): void {
    if (this.stopped) return
    this.timer = this.deps.clock.setTimeout(() => {
      void this.deps.provisioner
        .sweepOwedConvergences(CONVERGE_OWED_QUIET_MS)
        .catch((err) => this.deps.log?.warn({ err }, 'gitlab convergence sweep failed'))
        .finally(() => this.arm(SWEEP_INTERVAL_MS))
    }, delayMs)
  }
}
