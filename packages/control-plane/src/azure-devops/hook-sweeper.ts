// The background pass over hooked Azure DevOps bindings (azure-devops-integration.md §11.2): read-back, re-enable, rotation resume and key expiry; armed only by `startBackground()`.
import type { Clock, TimerHandle } from '../domain/clock.js'
import type { AzureDevOpsHookService } from './hook.service.js'

const FIRST_SWEEP_DELAY_MS = 2 * 60 * 1000
const SWEEP_INTERVAL_MS = 10 * 60 * 1000

export class AzureDevOpsHookSweeper {
  private timer: TimerHandle | null = null
  private stopped = false

  constructor(
    private readonly deps: {
      hooks: AzureDevOpsHookService
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
      void this.deps.hooks
        .sweep()
        .catch((err) => this.deps.log?.warn({ err }, 'azure devops hook sweep failed'))
        .finally(() => this.arm(SWEEP_INTERVAL_MS))
    }, delayMs)
  }
}
