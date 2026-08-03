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
 * Every apply passes the monotonic `configRevision` fence first
 * (organization-secrets-and-variables.md §7): `env`/`secrets` are full resolved
 * maps, so an out-of-order snapshot would reinstate a rotated or deleted value.
 * A stale snapshot is acknowledged without ever reaching `writeAgentSpec`.
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
  findReplicaFileById,
  syncAgentReplica,
  type WriteAgentDeps
} from '../agents/write-agent.js'
import {
  agentSpecDigest,
  compareConfigRevision,
  parseConfigRevision,
  readAppliedConfigRevision,
  writeAppliedConfigRevision,
  type ConfigRevisionDecision
} from '../agents/config-revision.js'

/** What one apply did. `stale`/`idempotent` wrote nothing; `conflict` refused. */
export type AgentSpecApplyResult = ConfigRevisionDecision

export class CpAgentRegistry {
  constructor(
    private readonly agentsDir: string,
    private readonly deps: WriteAgentDeps,
    private readonly onChange: () => void,
    private readonly warn?: (msg: string) => void
  ) {}

  /**
   * Add or merge one agent's spec onto disk (agent/upsert EVT), under the
   * revision fence. Returns what the fence decided so the caller can ACK a stale
   * snapshot as a no-op and refuse an equal-revision digest mismatch.
   */
  upsert(agentId: string, spec: AgentSpec): AgentSpecApplyResult {
    const decision = this.apply(agentId, spec)
    if (decision === 'apply') this.onChange()
    return decision
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
   *
   * Returns the ids actually written. A stale or refused entry is skipped
   * INDIVIDUALLY — one bad revision must never fail the whole handshake — so the
   * caller must not treat roster membership as proof that a replica was rewritten
   * (e.g. before clearing a removal tombstone).
   */
  converge(roster: Array<AgentSpec & { agentId: string }>): string[] {
    const applied: string[] = []
    for (const { agentId, ...spec } of roster) {
      if (this.apply(agentId, spec) === 'apply') applied.push(agentId)
    }
    this.onChange()
    return applied
  }

  /** The fenced write shared by `upsert` and `converge`. */
  private apply(agentId: string, spec: AgentSpec): AgentSpecApplyResult {
    const revision = parseConfigRevision(spec)
    const digest = agentSpecDigest(spec)
    // Includes a cold-move archive: writeAgentSpec restores one before merging CP
    // fields, so a stale fan-out that arrives after a move-away must not be able
    // to both un-archive the root and downgrade its configuration.
    const existingFile = findReplicaFileById(this.agentsDir, agentId)
    // No local replica at all ⇒ nothing to compare against and nothing to reinstate.
    const decision = existingFile
      ? compareConfigRevision(readAppliedConfigRevision(existingFile), { revision, digest })
      : 'apply'
    if (decision === 'stale') {
      this.warn?.(`cp: agent "${agentId}" spec revision ${spec.configRevision} is older than the applied one; ignoring`)
      return decision
    }
    if (decision === 'conflict') {
      this.warn?.(
        `cp: agent "${agentId}" spec revision ${spec.configRevision} arrived with different content than the one already applied; refusing`
      )
      return decision
    }
    if (decision === 'idempotent') return decision
    writeAgentSpec(this.agentsDir, agentId, spec, this.deps)
    // AFTER the content: a crash in between re-applies on retry, whereas the
    // reverse order would make an equal-revision retry look already-done.
    const written = findAgentFileById(this.agentsDir, agentId)
    if (written) writeAppliedConfigRevision(written, revision, digest)
    return decision
  }
}
