// Deletes expired computer registration rows (computer-use.md §3.6); same Clock-driven loop as OAuthReaper, armed only by startBackground().
import type { Clock, TimerHandle } from '../domain/clock.js'
import type { ComputerRepo } from '../persistence/ports.js'
import type { ReaperLog } from './cronRunReaper.js'

export const COMPUTER_REGISTRATION_REAP_INTERVAL_MS = 10 * 60_000
// A row outlives its expiry by a week, so an audit entry's registration id still resolves.
export const COMPUTER_REGISTRATION_REAP_GRACE_MS = 7 * 86_400_000

export class ComputerRegistrationReaper {
  private timer: TimerHandle | undefined
  private stopped = false

  constructor(
    private readonly computers: Pick<ComputerRepo, 'reapRegistrations'>,
    private readonly clock: Clock,
    private readonly cfg: { intervalMs: number; graceMs: number },
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
      const before = new Date(this.clock.now() - this.cfg.graceMs)
      const registrations = await this.computers.reapRegistrations(before)
      if (registrations > 0)
        this.log?.info(
          { registrations, before: before.toISOString() },
          'computer-registration-reaper: deleted expired registrations'
        )
    } catch (err) {
      this.log?.error({ err }, 'computer-registration-reaper: sweep failed')
    } finally {
      this.arm()
    }
  }
}
