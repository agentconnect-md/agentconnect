// A background pass over organization SSO state (organization-sso.md §8): one pass at a time, re-armed after it settles.
import type { Clock, TimerHandle } from '../domain/clock.js'

export class OrgSsoSweeper {
  private timer: TimerHandle | null = null
  private stopped = false

  constructor(
    private readonly deps: {
      name: string
      sweep: () => Promise<void>
      firstDelayMs: number
      intervalMs: number
      clock: Clock
      log?: { warn(obj: object, msg: string): void }
    }
  ) {}

  start(): void {
    this.stopped = false
    this.arm(this.deps.firstDelayMs)
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== null) this.deps.clock.clearTimeout(this.timer)
    this.timer = null
  }

  private arm(delayMs: number): void {
    if (this.stopped) return
    this.timer = this.deps.clock.setTimeout(() => {
      void this.deps
        .sweep()
        .catch((err) => this.deps.log?.warn({ err }, `org sso ${this.deps.name} sweep failed`))
        .finally(() => this.arm(this.deps.intervalMs))
    }, delayMs)
  }
}
