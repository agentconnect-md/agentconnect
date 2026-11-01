// Daily Clock-driven sweep deleting `deferred` automatic-upgrade rows older than the retention (daemon-auto-upgrade.md §6).
import type { Clock, TimerHandle } from '../domain/clock.js'
import type { DaemonLifecycleOpRepo } from '../persistence/ports.js'
import type { ReaperLog } from '../orchestrator/cronRunReaper.js'

export const DEFERRED_OP_RETENTION_MS = 7 * 24 * 60 * 60_000
export const DEFERRED_OP_SWEEP_INTERVAL_MS = 24 * 60 * 60_000

export class DeferredLifecycleOpSweeper {
  private timer: TimerHandle | undefined
  private stopped = true

  constructor(
    private readonly repo: Pick<DaemonLifecycleOpRepo, 'deleteDeferredBefore'>,
    private readonly clock: Clock,
    private readonly cfg: { retentionMs: number; intervalMs: number } = {
      retentionMs: DEFERRED_OP_RETENTION_MS,
      intervalMs: DEFERRED_OP_SWEEP_INTERVAL_MS
    },
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

  /** One sweep, then re-arm; errors are logged so a DB blip never kills the loop. Exposed for tests. */
  async tick(): Promise<void> {
    this.timer = undefined
    try {
      const deleted = await this.repo.deleteDeferredBefore(new Date(this.clock.now() - this.cfg.retentionMs))
      if (deleted > 0) this.log?.info({ deleted }, 'deferred-lifecycle-op-sweep: deleted deferred rows')
    } catch (err) {
      this.log?.error({ err }, 'deferred-lifecycle-op-sweep: sweep failed')
    } finally {
      this.arm()
    }
  }
}
