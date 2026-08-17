import { Cron } from 'croner'
import type { MemoryDreamingPolicy } from '@agentconnect.md/protocol'

/**
 * Cron trigger for scheduled memory dreams (docs/designs/memory-dreaming.md §9,
 * D-2b). A sibling of {@link Scheduler} rather than a reuse of it, because the
 * two fire fundamentally different things: `Scheduler` synthesizes a
 * `NormalizedMessage` and runs it as a TURN (it has a platform target, a thread,
 * transcript rows, loop-guard accounting); a dream is a background job with its
 * own lifecycle and no conversation at all. Routing dreams through a synthetic
 * message would put them in the agent's transcript and inbox, which is exactly
 * what §9 rules out.
 *
 * At most one job per agent — the agent's `dreaming.schedule`. `sync` converges
 * an agent's job to its current policy (idempotent, replace-all like
 * `Scheduler.sync`), so any reconcile can call it unconditionally. A malformed
 * expression drops that agent's schedule with a warning and never throws into
 * the reconciler.
 */
export class DreamScheduler {
  private jobs = new Map<string, Cron>() // agentId → its live dream job

  constructor(
    private deps: {
      /** Fire one scheduled dream. Never rejects into the timer — the daemon's
       *  handler swallows the ordinary "already in flight"/"not enabled" cases. */
      onFire: (agentId: string) => Promise<void>
      warn?: (msg: string) => void
    }
  ) {}

  /** Converge one agent's dream job to its policy. A disabled policy, an absent
   *  policy, or one without a `schedule` leaves the agent unscheduled. */
  sync(agentId: string, policy: MemoryDreamingPolicy | undefined): void {
    this.unregister(agentId)
    if (!policy?.enabled || !policy.schedule) return
    try {
      this.jobs.set(
        agentId,
        new Cron(policy.schedule, policy.timezone ? { timezone: policy.timezone } : {}, () => this.deps.onFire(agentId))
      )
    } catch (err) {
      this.deps.warn?.(`dream scheduler: skipping schedule for agent "${agentId}": ${(err as Error).message}`)
    }
  }

  /** Stop and drop an agent's dream job (agent removed / dreaming turned off). */
  unregister(agentId: string): void {
    this.jobs.get(agentId)?.stop()
    this.jobs.delete(agentId)
  }

  /** 1 when this agent has a live dream schedule, else 0. */
  count(agentId: string): number {
    return this.jobs.has(agentId) ? 1 : 0
  }

  /** The next fire time for an agent's dream job, or null when unscheduled. */
  nextRun(agentId: string): Date | null {
    return this.jobs.get(agentId)?.nextRun() ?? null
  }

  stop(): void {
    for (const agentId of [...this.jobs.keys()]) this.unregister(agentId)
  }
}
