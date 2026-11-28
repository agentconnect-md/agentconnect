// Expires old and unfinished revisions, then sweeps deleted objects and drops each record after its last sweep (artifacts.md §5.6, §10.1).
import type { ArtifactService } from '../artifacts/service.js'
import type { Clock, TimerHandle } from '../domain/clock.js'
import type { ReaperLog } from './cronRunReaper.js'

export const ARTIFACT_DELETION_REAP_INTERVAL_MS = 5 * 60_000

export class ArtifactDeletionReaper {
  private timer: TimerHandle | undefined
  private stopped = false

  constructor(
    private readonly artifacts: Pick<ArtifactService, 'reap' | 'prune' | 'removeUnfinished'>,
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

  // One retention pass, one unfinished-revision pass and one sweep, then re-arm; a failure is logged and retried next tick.
  async tick(): Promise<void> {
    this.timer = undefined
    try {
      const expired = await this.artifacts.prune()
      if (expired > 0) this.log?.info({ expired }, 'artifact-deletion-reaper: expired old revisions')
    } catch (err) {
      this.log?.error({ err }, 'artifact-deletion-reaper: retention pass failed')
    }
    try {
      const unfinished = await this.artifacts.removeUnfinished()
      if (unfinished > 0) this.log?.info({ unfinished }, 'artifact-deletion-reaper: removed unfinished revisions')
    } catch (err) {
      this.log?.error({ err }, 'artifact-deletion-reaper: unfinished revision pass failed')
    }
    try {
      const deletions = await this.artifacts.reap()
      if (deletions > 0) this.log?.info({ deletions }, 'artifact-deletion-reaper: finished deletions')
    } catch (err) {
      this.log?.error({ err }, 'artifact-deletion-reaper: sweep failed')
    } finally {
      this.arm()
    }
  }
}
