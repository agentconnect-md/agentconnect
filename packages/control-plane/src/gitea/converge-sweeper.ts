/**
 * Background convergence sweep for Gitea bindings (gitea-integration.md §6, the §10.2 obligation):
 * re-drives the bindings a contended pass still owes work — the half that survives a restart.
 * Built in the graph, armed only by `startBackground()`; tests drive `sweepOwedConvergences`.
 */
import type { Clock, TimerHandle } from '../domain/clock.js'
import type { GiteaProvisioner } from './provisioner.js'

/** Leave an obligation alone this long, so the sweep never races the follow-up the same process armed. */
export const GITEA_CONVERGE_OWED_QUIET_MS = 2 * 60 * 1000
const FIRST_SWEEP_DELAY_MS = 90 * 1000
const SWEEP_INTERVAL_MS = 5 * 60 * 1000

export class GiteaConvergeSweeper {
  private timer: TimerHandle | null = null
  private stopped = false

  constructor(
    private readonly deps: {
      provisioner: GiteaProvisioner
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
        .sweepOwedConvergences(GITEA_CONVERGE_OWED_QUIET_MS)
        .catch((err) => this.deps.log?.warn({ err }, 'gitea convergence sweep failed'))
        .finally(() => this.arm(SWEEP_INTERVAL_MS))
    }, delayMs)
  }
}
