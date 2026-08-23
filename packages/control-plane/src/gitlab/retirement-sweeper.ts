/**
 * Background retirement sweep (gitlab-com-integration.md §19.4): re-reads the
 * accounts whose GitLab deletion was accepted but not yet observable and closes
 * each one out on positive evidence of absence.
 *
 * GitLab deletes a user ASYNCHRONOUSLY, so the run that asked for the deletion
 * cannot see it land; without this loop those rows would sit in
 * `cleanup_pending` forever with nothing revisiting them. Built in the graph,
 * armed only by `startBackground()` — never in tests, which drive
 * `sweepPendingRetirements` directly.
 */
import type { Clock, TimerHandle } from '../domain/clock.js'
import type { GitlabAccountService } from './account.service.js'

/** Leave a row alone this long after its last write, so a sweep never races the
 *  run that recorded it and GitLab gets a moment to finish. */
export const RETIREMENT_QUIET_MS = 60 * 1000
const FIRST_SWEEP_DELAY_MS = 60 * 1000
const SWEEP_INTERVAL_MS = 5 * 60 * 1000

export class GitlabRetirementSweeper {
  private timer: TimerHandle | null = null
  private stopped = false

  constructor(
    private readonly deps: {
      accounts: GitlabAccountService
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
      void this.deps.accounts
        .sweepPendingRetirements(RETIREMENT_QUIET_MS)
        .catch((err) => this.deps.log?.warn({ err }, 'gitlab retirement sweep failed'))
        .finally(() => this.arm(SWEEP_INTERVAL_MS))
    }, delayMs)
  }
}
