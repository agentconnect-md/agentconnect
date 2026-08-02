/**
 * `CpAgentRegistry` — applies CP-owned agent specs onto the daemon's on-disk
 * `agent.json` files, which are the SINGLE SOURCE OF TRUTH. The CP pushes deltas
 * over `agent/upsert` / `agent/remove` and the full set over the `register/ok`
 * reconcile roster; this writes each straight to disk (create-or-merge) keyed by
 * `agentId`. No spec is held in memory or in SQLite.
 *
 * `converge` create-or-merges every roster entry. Reconnect pruning is explicit
 * through `register/ok.drop.agents`, after the CP has compared the daemon's
 * reported replica ownership with its authoritative placement.
 *
 * Every mutation fires `onChange` so the daemon re-reconciles (re-loads agents
 * from disk; the reconciler is idempotent and only restarts a host on a real
 * config change).
 */
import type { AgentSpec } from '@agentconnect.md/protocol'
import {
  writeAgentSpec,
  removeAgent,
  archiveAgent,
  restoreArchivedAgent,
  pruneMovedAgentDependents,
  findAgentFileById,
  syncAgentReplica,
  type WriteAgentDeps
} from '../agents/write-agent.js'

export class CpAgentRegistry {
  constructor(
    private readonly agentsDir: string,
    private readonly deps: WriteAgentDeps,
    private readonly onChange: () => void
  ) {}

  /** Add or merge one agent's spec onto disk (agent/upsert EVT). */
  upsert(agentId: string, spec: AgentSpec): void {
    writeAgentSpec(this.agentsDir, agentId, spec, this.deps)
    this.onChange()
  }

  /** Delete one agent's on-disk dir (agent/remove EVT). Unconditional. */
  remove(agentId: string): void {
    removeAgent(this.agentsDir, agentId)
    this.onChange()
  }

  /** Non-destructively move an agent root out of the active discovery tree. */
  detach(agentId: string): 'archived' | 'already-detached' | 'missing' {
    const result = archiveAgent(this.agentsDir, agentId)
    if (result !== 'missing') this.onChange()
    return result
  }

  /**
   * Exact-prune locally persisted CP dependents while an external lifecycle
   * gate still keeps the agent dark. Used by move activation and by removal-
   * tombstone re-add so stale platform credentials can never revive.
   */
  exactDependents(agentId: string, desired: { integrationIds: string[]; cronIds: string[] }): boolean {
    const changed = pruneMovedAgentDependents(this.agentsDir, agentId, desired)
    syncAgentReplica(this.agentsDir, agentId)
    return changed
  }

  /** Restore a detached root in place. Idempotent while already active. */
  activate(
    agentId: string,
    desired: { integrationIds: string[]; cronIds: string[] }
  ): 'restored' | 'already-active' | 'missing' {
    const alreadyActive = !!findAgentFileById(this.agentsDir, agentId)
    if (!alreadyActive && !restoreArchivedAgent(this.agentsDir, agentId)) return 'missing'
    const pruned = this.exactDependents(agentId, desired)
    if (!alreadyActive || pruned) this.onChange()
    return alreadyActive ? 'already-active' : 'restored'
  }

  /**
   * Apply the register/ok reconcile roster: create-or-merge EACH entry and
   * NOTHING else. The caller applies the separately-authorized drop list first;
   * roster absence alone is never enough to prune a hand-authored local agent.
   */
  converge(roster: Array<AgentSpec & { agentId: string }>): void {
    for (const { agentId, ...spec } of roster) {
      writeAgentSpec(this.agentsDir, agentId, spec, this.deps)
    }
    this.onChange()
  }
}
