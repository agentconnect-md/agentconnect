/**
 * `CpCronRegistry` — applies CP-owned crons onto the daemon's on-disk
 * `agent.json` files, which are the SINGLE SOURCE OF TRUTH (same model as
 * CpIntegrationRegistry). The CP pushes deltas over `cron/upsert` /
 * `cron/remove` and the full per-daemon set over the `register/ok` reconcile
 * snapshot; this writes each straight into the owning agent's `crons[]`
 * (upsert by cronId, marked `origin:"cp"`). Nothing is held in memory, so CP
 * crons survive a daemon restart with the CP down — the Scheduler registers
 * them from disk at start, and every mutation here fires `onChange` so the
 * daemon re-reconciles (diffAgents sees the crons change → Scheduler re-syncs).
 *
 * Pruning is explicit only: `cron/remove` and `register/ok.drop.crons[]` splice
 * entries out; `converge` upserts and never deletes. Hand-authored (no-origin)
 * entries are never touched.
 */
import type { CronUpsert } from '@agentconnect.md/protocol'
import { writeCronDef, removeCronDef, type WriteCronDeps } from '../agents/write-cron.js'

export class CpCronRegistry {
  constructor(
    private readonly agentsDir: string,
    private readonly deps: WriteCronDeps,
    private readonly onChange: () => void
  ) {}

  /** Add or replace one CP cron on the owning agent's disk file (cron/upsert REQ). */
  upsert(cron: CronUpsert): void {
    if (writeCronDef(this.agentsDir, cron, this.deps)) this.onChange()
  }

  /** Splice one CP cron out of whichever agent.json holds it (cron/remove REQ). */
  remove(cronId: string): void {
    if (removeCronDef(this.agentsDir, cronId)) this.onChange()
  }

  /**
   * Apply the register/ok snapshot: upsert EACH entry (identical re-applies skip
   * the write, so a reconnect with an unchanged set is a no-op). Stale ids
   * arrive separately via `drop.crons[]` → {@link remove}.
   */
  converge(crons: CronUpsert[]): void {
    let changed = false
    for (const cron of crons ?? []) {
      if (writeCronDef(this.agentsDir, cron, this.deps)) changed = true
    }
    if (changed) this.onChange()
  }
}
