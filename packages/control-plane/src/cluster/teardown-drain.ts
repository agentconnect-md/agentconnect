/**
 * The periodic half of envelope teardown. Deleting an organization records its
 * `AgentConnectOrg` for removal inside the delete transaction; the delete route
 * then retires it inline for latency. This loop is the backstop for everything
 * that path cannot cover — an unreachable cluster, a process that crashed
 * between the two, or a deployment that had cluster execution switched off when
 * the organization was deleted and turned it on later.
 */
import type { Clock, TimerHandle } from '../domain/clock.js'

export interface TeardownDrainLog {
  info(obj: Record<string, unknown>, msg: string): void
  warn(obj: Record<string, unknown>, msg: string): void
}

export class EnvelopeTeardownDrain {
  private timer: TimerHandle | undefined
  private stopped = false

  constructor(
    /** Absent ⇒ cluster execution is off; the loop still runs and is a no-op. */
    private readonly drain: (() => Promise<number>) | undefined,
    private readonly clock: Clock,
    private readonly intervalMs: number,
    private readonly log?: TeardownDrainLog
  ) {}

  /** Arm the loop. Idempotent — a second call re-arms from now. */
  start(): void {
    if (!this.drain) return
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
    this.timer = this.clock.setTimeout(() => void this.tick(), this.intervalMs)
  }

  /** One pass. Errors are logged and swallowed — a cluster outage must not kill
   *  the loop, and every tombstone survives for the next one. Exposed for tests. */
  async tick(): Promise<void> {
    this.timer = undefined
    try {
      const retired = (await this.drain?.()) ?? 0
      if (retired > 0) this.log?.info({ retired }, 'cluster-execution: retired deleted organizations’ envelopes')
    } catch (err) {
      this.log?.warn({ err }, 'cluster-execution: envelope teardown drain failed')
    } finally {
      this.arm()
    }
  }
}
