/**
 * `SlackInstallReaper` (docs/designs/slack-install-smoothing.md §Tier B) — sweeps
 * abandoned Slack auto-install sessions.
 *
 * A `slack_install` row is created when the config-token funnel starts and is
 * DELETED when `finalize` mints the real integration. A funnel the operator never
 * finishes (closed the Allow tab, never pasted the app-level token) would leave
 * the row — holding a client secret + a bot token — forever. This Clock-driven
 * sweep deletes any row older than `ttlMs` every `intervalMs`, bounding how long
 * that credential material lingers.
 *
 * Same shape as {@link CronRunReaper}: a self-rescheduling `setTimeout` on the
 * injected Clock so tests advance a FakeClock instead of the wall clock; armed by
 * the container's `startBackground()` after listen, never in tests.
 */
import type { Clock, TimerHandle } from '../domain/clock.js'

/** The repo slice the reaper drives (a narrow view of `SlackInstallStore`). */
export interface SlackInstallReaperRepo {
  reapExpired(staleBefore: Date): Promise<number>
}

export interface SlackInstallReaperConfig {
  /** A pending row older than this (funnel never finished) is deleted. */
  ttlMs: number
  /** How often the sweep runs. */
  intervalMs: number
}

/** Optional structured log sink (the Fastify logger in prod; omitted in tests). */
export interface ReaperLog {
  info(obj: unknown, msg?: string): void
  error(obj: unknown, msg?: string): void
}

export class SlackInstallReaper {
  private timer: TimerHandle | undefined
  private stopped = false

  constructor(
    private readonly repo: SlackInstallReaperRepo,
    private readonly clock: Clock,
    private readonly cfg: SlackInstallReaperConfig,
    private readonly log?: ReaperLog
  ) {}

  /** Arm the periodic sweep. Idempotent — a second call re-arms from now. */
  start(): void {
    this.stopped = false
    this.arm()
  }

  /** Cancel the loop — call on shutdown so no timer outlives the process. */
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

  /**
   * One sweep: delete rows older than `now − ttl`, then re-arm. Errors are logged
   * and swallowed — a transient DB failure must never kill the loop. Exposed for
   * tests (call directly instead of advancing the clock).
   */
  async tick(): Promise<void> {
    this.timer = undefined
    try {
      const staleBefore = new Date(this.clock.now() - this.cfg.ttlMs)
      const reaped = await this.repo.reapExpired(staleBefore)
      if (reaped > 0)
        this.log?.info(
          { reaped, staleBefore: staleBefore.toISOString() },
          'slack-install-reaper: deleted abandoned pending installs'
        )
    } catch (err) {
      this.log?.error({ err }, 'slack-install-reaper: sweep failed')
    } finally {
      this.arm()
    }
  }
}
