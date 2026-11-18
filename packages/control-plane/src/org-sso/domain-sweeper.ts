// The background pass over organization SSO domains (organization-sso.md §8): the daily re-check and the removal of lapsed claims.
import type { Clock, TimerHandle } from '../domain/clock.js'
import type { OrgSsoDomainService } from './domains.js'

const FIRST_SWEEP_DELAY_MS = 5 * 60 * 1000
const SWEEP_INTERVAL_MS = 60 * 60 * 1000

export class OrgDomainSweeper {
  private timer: TimerHandle | null = null
  private stopped = false

  constructor(
    private readonly deps: {
      domains: OrgSsoDomainService
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
      void this.deps.domains
        .sweep()
        .catch((err) => this.deps.log?.warn({ err }, 'org sso domain sweep failed'))
        .finally(() => this.arm(SWEEP_INTERVAL_MS))
    }, delayMs)
  }
}
