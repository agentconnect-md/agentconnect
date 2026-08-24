/**
 * Background PAT-rotation loop (gitlab-com-integration.md §7.4): sweeps
 * credentials approaching their provider expiry and rotates each through the
 * account service's create-before-revoke path. Built in the graph, armed only by
 * `startBackground()` — never in tests, which drive `rotateDueCredentials`
 * directly.
 */
import type { Clock, TimerHandle } from '../domain/clock.js'
import type { GitlabAccountService } from './account.service.js'

/** Rotate while this much lifetime remains — two weeks of admin-outage slack. */
export const ROTATION_HORIZON_MS = 14 * 24 * 60 * 60 * 1000
const FIRST_SWEEP_DELAY_MS = 5 * 60 * 1000
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000

export class GitlabCredentialRotator {
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
        .rotateDueCredentials(ROTATION_HORIZON_MS)
        .catch((err) => this.deps.log?.warn({ err }, 'gitlab credential rotation sweep failed'))
        .finally(() => this.arm(SWEEP_INTERVAL_MS))
    }, delayMs)
  }
}
