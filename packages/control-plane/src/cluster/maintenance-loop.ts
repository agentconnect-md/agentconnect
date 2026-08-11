/**
 * The periodic half of the provisioner's cleanup — the backstop for the two
 * things it can owe the world after a request has already returned.
 *
 * Deleting an organization records its `AgentConnectOrg` for removal inside the
 * delete transaction, and retiring a daemon key records the revocation before
 * attempting it. Both paths run inline first for latency; this loop covers what
 * inline cannot — an unreachable cluster, a process that crashed between the
 * record and the act, or a deployment that had cluster execution switched off
 * when the organization was deleted and turned it on later.
 */
import type { Clock, TimerHandle } from '../domain/clock.js'

export interface ClusterMaintenanceLog {
  info(obj: Record<string, unknown>, msg: string): void
  warn(obj: Record<string, unknown>, msg: string): void
}

export interface ClusterMaintenanceWork {
  drainTeardowns(): Promise<number>
  drainKeyRevocations(): Promise<number>
}

export class ClusterMaintenanceLoop {
  private timer: TimerHandle | undefined
  private stopped = false

  constructor(
    /** Absent ⇒ cluster execution is off and there is nothing to sweep. */
    private readonly work: ClusterMaintenanceWork | undefined,
    private readonly clock: Clock,
    private readonly intervalMs: number,
    private readonly log?: ClusterMaintenanceLog
  ) {}

  /** Arm the loop. Idempotent — a second call re-arms from now. */
  start(): void {
    if (!this.work) return
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

  /**
   * One pass over both queues. Each is attempted independently, so a cluster
   * that refuses deletions still lets owed revocations through; errors are
   * logged and swallowed, and every record survives for the next pass. Exposed
   * for tests.
   */
  async tick(): Promise<void> {
    this.timer = undefined
    try {
      if (!this.work) return
      await this.step(
        () => this.work!.drainTeardowns(),
        'cluster-execution: retired deleted organizations’ envelopes',
        'cluster-execution: envelope teardown drain failed'
      )
      await this.step(
        () => this.work!.drainKeyRevocations(),
        'cluster-execution: revoked superseded daemon keys',
        'cluster-execution: daemon key revocation drain failed'
      )
    } finally {
      this.arm()
    }
  }

  private async step(run: () => Promise<number>, done: string, failed: string): Promise<void> {
    try {
      const count = await run()
      if (count > 0) this.log?.info({ count }, done)
    } catch (err) {
      this.log?.warn({ err }, failed)
    }
  }
}
