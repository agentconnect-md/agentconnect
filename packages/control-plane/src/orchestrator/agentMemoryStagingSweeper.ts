// Deletes the staged rows an abandoned `memory-append` sequence left (memory-evolution.md §3.2.1) once no live write can be building them.
// `commit` and `rm` clear their own; this Clock-driven loop takes the rest. Armed by `startBackground()`, never in tests.
import type { Clock, TimerHandle } from '../domain/clock.js'
import type { AgentMemoryFileRepo } from '../persistence/ports.js'

/** A staged row older than this is abandoned: a whole-file write is two round trips, each under 30 s. */
export const MEMORY_STAGING_MAX_AGE_MS = 60 * 60 * 1000
export const MEMORY_STAGING_SWEEP_INTERVAL_MS = 10 * 60 * 1000
/** Rows per tick — the loop is bounded so a backlog drains over ticks instead of one long delete. */
export const MEMORY_STAGING_SWEEP_LIMIT = 1000

export interface SweeperLog {
  info(obj: unknown, msg?: string): void
  error(obj: unknown, msg?: string): void
}

export class AgentMemoryStagingSweeper {
  private timer: TimerHandle | undefined
  private stopped = false

  constructor(
    private readonly repo: Pick<AgentMemoryFileRepo, 'sweepStaged'>,
    private readonly clock: Clock,
    private readonly log?: SweeperLog,
    private readonly cfg = {
      maxAgeMs: MEMORY_STAGING_MAX_AGE_MS,
      intervalMs: MEMORY_STAGING_SWEEP_INTERVAL_MS,
      limit: MEMORY_STAGING_SWEEP_LIMIT
    }
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

  /** One sweep, then re-arm; a transient DB failure is logged and never kills the loop. Exposed for tests. */
  async tick(): Promise<void> {
    if (this.timer !== undefined) {
      this.clock.clearTimeout(this.timer) // a tick called by hand must not leave the armed one to fire twice
      this.timer = undefined
    }
    try {
      const before = new Date(this.clock.now() - this.cfg.maxAgeMs)
      const swept = await this.repo.sweepStaged(before, this.cfg.limit)
      if (swept > 0)
        this.log?.info({ swept, before: before.toISOString() }, 'memory-staging-sweeper: removed abandoned staged rows')
    } catch (err) {
      this.log?.error({ err }, 'memory-staging-sweeper: sweep failed')
    } finally {
      this.arm()
    }
  }
}
