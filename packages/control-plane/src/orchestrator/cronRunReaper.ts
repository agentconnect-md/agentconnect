/**
 * `CronRunReaper` (design §3.14) — the reconciler for orphaned schedule runs.
 *
 * A `cron_run` row opens `running` on the daemon's FIRE report and closes on the
 * COMPLETION report (outcome + duration + the ACP session to deep-link).
 * Completion reports are best-effort: dropped when the daemon↔CP link is not
 * live, and never emitted at all when the fire hits a draining daemon (dispatch
 * returns null, so neither the success nor the failure report is sent). Nothing
 * else reconciles them — so a lost completion leaves the row `running` forever,
 * surfaced as a permanently-"Running" run in the console.
 *
 * This Clock-driven sweep closes that gap: every `intervalMs` it fails any
 * `running` row older than `ttlMs`. The daemon stays authoritative — a genuinely
 * long turn whose completion arrives late still overwrites the reaped `failed`
 * with its real outcome (the run-row upsert is last-writer-wins), so a
 * conservative TTL only ever risks a brief running→failed→(real) flicker, never
 * a lost outcome.
 *
 * Clock-driven via a self-rescheduling `setTimeout` (like {@link Watchdog}) so
 * tests advance a `FakeClock` instead of waiting on the wall clock. `start()` /
 * `stop()` bracket the loop; `stop()` on shutdown so no timer outlives the
 * process. Armed by the container's `startBackground()` after listen — never in
 * tests, which build the same graph but drive time deterministically.
 */
import type { Clock, TimerHandle } from '../domain/clock.js'

/** The repo slice the reaper drives (a narrow view of `CronRepo`). */
export interface CronRunReaperRepo {
  reapStaleRuns(staleBefore: Date): Promise<number>
}

export interface CronRunReaperConfig {
  /** A `running` row older than this (no completion report) is reaped → failed. */
  ttlMs: number
  /** How often the sweep runs. */
  intervalMs: number
  /** Log label — the reaper is reused verbatim for hook runs (same two-report
   *  lifecycle, same orphan semantics); default keeps the historical name. */
  label?: string
}

/** Optional structured log sink (the Fastify logger in prod; omitted in tests). */
export interface ReaperLog {
  info(obj: unknown, msg?: string): void
  error(obj: unknown, msg?: string): void
}

export class CronRunReaper {
  private timer: TimerHandle | undefined
  private stopped = false

  constructor(
    private readonly repo: CronRunReaperRepo,
    private readonly clock: Clock,
    private readonly cfg: CronRunReaperConfig,
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
   * One sweep: reap rows older than `now − ttl`, then re-arm. Errors are logged
   * and swallowed — a transient DB failure must never kill the loop. Exposed for
   * tests (call directly instead of advancing the clock).
   */
  async tick(): Promise<void> {
    this.timer = undefined
    try {
      const staleBefore = new Date(this.clock.now() - this.cfg.ttlMs)
      const reaped = await this.repo.reapStaleRuns(staleBefore)
      if (reaped > 0)
        this.log?.info(
          { reaped, staleBefore: staleBefore.toISOString() },
          `${this.cfg.label ?? 'cron-run-reaper'}: closed orphaned running rows`
        )
    } catch (err) {
      this.log?.error({ err }, `${this.cfg.label ?? 'cron-run-reaper'}: sweep failed`)
    } finally {
      this.arm()
    }
  }
}
