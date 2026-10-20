// Deletes expired, abandoned and orphaned Computer screenshots, objects first (computer-use.md §9); armed only by startBackground().
import type { Clock, TimerHandle } from '../domain/clock.js'
import type { ComputerScreenshots } from '../registry/computerScreenshots.js'
import type { ReaperLog } from './cronRunReaper.js'

export const COMPUTER_SCREENSHOT_REAP_INTERVAL_MS = 10 * 60_000

export class ComputerScreenshotReaper {
  private timer: TimerHandle | undefined
  private stopped = false

  constructor(
    private readonly screenshots: Pick<ComputerScreenshots, 'reap'>,
    private readonly clock: Clock,
    private readonly cfg: { intervalMs: number },
    private readonly log?: ReaperLog
  ) {}

  start(): void {
    this.stopped = false
    this.arm()
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== undefined) {
      this.clock.clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  private arm(): void {
    if (this.stopped) return
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer)
    this.timer = this.clock.setTimeout(() => void this.tick(), this.cfg.intervalMs)
  }

  // One sweep, then re-arm; a failed sweep is logged and retried on the next tick.
  async tick(): Promise<void> {
    this.timer = undefined
    try {
      const screenshots = await this.screenshots.reap()
      if (screenshots > 0) this.log?.info({ screenshots }, 'computer-screenshot-reaper: deleted screenshots')
    } catch (err) {
      this.log?.error({ err }, 'computer-screenshot-reaper: sweep failed')
    } finally {
      this.arm()
    }
  }
}
