/**
 * `RelaySweeper` (shared-bot-relay.md §5, §13) — the relay failover sweep.
 *
 * A `relay` row is bumped by `rc/heartbeat`; a relay that dies (or whose pod is
 * rolled) stops heartbeating. Every `intervalMs` this deletes rows not seen for
 * `staleMs`, then — if any were reaped — fans the shrunk roster to the daemons
 * so they drop the dead relay (in milestone B the swept relay's bots reassign).
 *
 * Clock-driven via a self-rescheduling `setTimeout` (like {@link CronRunReaper})
 * so tests advance a `FakeClock`. `start()`/`stop()` bracket the loop; armed by
 * the container's `startBackground()` after listen — never in tests.
 */
import type { Clock, TimerHandle } from '../domain/clock.js'

/** The repo slice the sweeper drives (a narrow view of `RelayRepo`). */
export interface RelaySweeperRepo {
  sweepStale(staleBefore: Date): Promise<number>
}

export interface RelaySweeperConfig {
  /** A relay not seen for this long is swept. */
  staleMs: number
  /** How often the sweep runs. */
  intervalMs: number
}

/** Optional structured log sink (the Fastify logger in prod; omitted in tests). */
export interface RelaySweeperLog {
  info(obj: unknown, msg?: string): void
  error(obj: unknown, msg?: string): void
}

export class RelaySweeper {
  private timer: TimerHandle | undefined
  private stopped = false

  constructor(
    private readonly repo: RelaySweeperRepo,
    private readonly clock: Clock,
    private readonly cfg: RelaySweeperConfig,
    /** Called (awaited) after a sweep that removed ≥1 relay — recompute + fan the roster. */
    private readonly onSwept?: () => Promise<void>,
    private readonly log?: RelaySweeperLog
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
   * One sweep: reap relays not seen since `now − staleMs`, fan the roster if any
   * dropped, then re-arm. Errors are logged and swallowed — a transient DB
   * failure must never kill the loop. Exposed for tests (call directly).
   */
  async tick(): Promise<void> {
    this.timer = undefined
    try {
      const staleBefore = new Date(this.clock.now() - this.cfg.staleMs)
      const swept = await this.repo.sweepStale(staleBefore)
      if (swept > 0) {
        this.log?.info({ swept, staleBefore: staleBefore.toISOString() }, 'relay-sweeper: reaped stale relays')
        await this.onSwept?.()
      }
    } catch (err) {
      this.log?.error({ err }, 'relay-sweeper: sweep failed')
    } finally {
      this.arm()
    }
  }
}
