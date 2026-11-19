// Deletes the snapshots of sessions whose content is purged or gone, objects first (agent-authored-attachments.md §4.1).
import type { Clock, TimerHandle } from '../domain/clock.js'
import type { SessionFileService } from '../file-transfer/session-file.js'
import type { ReaperLog } from './cronRunReaper.js'

export const SESSION_FILE_REAP_INTERVAL_MS = 10 * 60_000

export class SessionFileReaper {
  private timer: TimerHandle | undefined
  private stopped = false

  constructor(
    private readonly files: Pick<SessionFileService, 'reap'>,
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
      const snapshots = await this.files.reap()
      if (snapshots > 0) this.log?.info({ snapshots }, 'session-file-reaper: released snapshots')
    } catch (err) {
      this.log?.error({ err }, 'session-file-reaper: sweep failed')
    } finally {
      this.arm()
    }
  }
}
