/**
 * The periodic half of the provisioner — the backstop for what it can owe the
 * world after a request has already returned.
 *
 * Deleting an organization records its `AgentConnectOrg` for removal inside the
 * delete transaction, and the delete route retires it immediately; this loop
 * covers what inline cannot — an unreachable cluster, a process that crashed
 * between the record and the act, or a deployment that had cluster execution
 * switched off when the organization was deleted and turned it on later.
 *
 * It also re-applies the enabled envelopes, because part of the spec comes from
 * control-plane configuration and not from the org's row: an envelope written
 * before that configuration changed is owed a write that no settings edit will
 * ever make. Same reason as above — work owed after every request has returned.
 */
import type { Clock, TimerHandle } from '../domain/clock.js'
import type { EnvelopeResyncOutcome } from './service.js'

export interface ClusterMaintenanceLog {
  info(obj: Record<string, unknown>, msg: string): void
  warn(obj: Record<string, unknown>, msg: string): void
  error(obj: Record<string, unknown>, msg: string): void
}

export interface ClusterMaintenanceWork {
  drainTeardowns(): Promise<number>
  resyncEnvelopes(): Promise<EnvelopeResyncOutcome>
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
   * One pass: retire what deletion left owed, then re-apply a slice of the live
   * envelopes. Errors are logged and swallowed, and everything either pass could
   * not finish survives for the next one. Exposed for tests.
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
      await this.resync()
    } finally {
      this.arm()
    }
  }

  /**
   * Re-apply pass. A converged envelope logs nothing — the steady state is every
   * pass doing nothing visible, and saying so 288 times a day would bury the case
   * that matters. Each envelope it could NOT apply is reported on its own, at
   * error: it is stuck on whatever spec it already has, it will stay stuck until
   * someone acts, and repeating that every pass is the only signal an operator
   * gets. The stale spec this loop exists to fix went unnoticed precisely because
   * the one line describing it was informational.
   */
  private async resync(): Promise<void> {
    try {
      const { converged, failures } = await this.work!.resyncEnvelopes()
      for (const failure of failures) {
        // The pass totals ride along, so one bad envelope reads differently from
        // an API server that is refusing everything.
        this.log?.error(
          { orgId: failure.orgId, converged, failed: failures.length, err: failure.error },
          'cluster-execution: envelope re-apply failed'
        )
      }
    } catch (err) {
      // The listing itself failed, so no envelope was even selected: one line.
      this.log?.warn({ err }, 'cluster-execution: envelope re-apply pass failed')
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
