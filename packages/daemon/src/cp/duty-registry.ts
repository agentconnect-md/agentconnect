// The daemon's view of the duty leases it holds (docs/designs — duty ledger).
// Pure state: the heartbeat reads its digest, `duty/grant` and `duty/revoke`
// mutate it, and the agent/bot projections drive what this daemon serves.
// Never authoritative — the CP's ledger is, and every reconnect re-confirms
// terms against this digest.
import type { DutyGrantEntry, DutyRevoke, HeartbeatDuties } from '@agentconnect.md/protocol'

export interface HeldDuty {
  groupId: string
  orgId: string
  /** The CP-minted fencing term, as the decimal string the wire carries. */
  term: string
  agentIds: string[]
  botIds: string[]
}

export interface DutyApplyResult {
  /** Groups whose membership this daemon did not serve before. */
  added: string[]
  /** Groups it already held, re-granted at a new term or new composition. */
  updated: string[]
  /** Agents that entered service (in a granted group, in none before). */
  agentsGained: string[]
  /** Agents that left service (in no granted group any more). */
  agentsLost: string[]
}

const EMPTY: DutyApplyResult = { added: [], updated: [], agentsGained: [], agentsLost: [] }

export class DutyRegistry {
  private readonly held = new Map<string, HeldDuty>()

  /** Held groups with the terms this daemon believes — the heartbeat's digest. */
  digest(): HeartbeatDuties['held'] {
    return [...this.held.values()]
      .map((d) => ({ groupId: d.groupId, term: d.term }))
      .sort((a, b) => (a.groupId < b.groupId ? -1 : 1))
  }

  /** Every agent this daemon holds a duty for. */
  agents(): Set<string> {
    const out = new Set<string>()
    for (const d of this.held.values()) for (const id of d.agentIds) out.add(id)
    return out
  }

  /** Every daemon-held bot this daemon is responsible for connecting. */
  bots(): Set<string> {
    const out = new Set<string>()
    for (const d of this.held.values()) for (const id of d.botIds) out.add(id)
    return out
  }

  groupIds(): string[] {
    return [...this.held.keys()].sort()
  }

  size(): number {
    return this.held.size
  }

  get(groupId: string): HeldDuty | undefined {
    return this.held.get(groupId)
  }

  holdsAgent(agentId: string): boolean {
    for (const d of this.held.values()) if (d.agentIds.includes(agentId)) return true
    return false
  }

  dutyForAgent(agentId: string): HeldDuty | undefined {
    return [...this.held.values()]
      .filter((duty) => duty.agentIds.includes(agentId))
      .sort((a, b) => a.groupId.localeCompare(b.groupId))[0]
  }

  /** A grant entry REPLACES its group: a bumped term after a composition change,
   *  or a term this daemon missed because the original EVT was lost. */
  applyGrant(grants: DutyGrantEntry[]): DutyApplyResult {
    if (grants.length === 0) return EMPTY
    const before = this.agents()
    const added: string[] = []
    const updated: string[] = []
    for (const g of grants) {
      ;(this.held.has(g.groupId) ? updated : added).push(g.groupId)
      this.held.set(g.groupId, {
        groupId: g.groupId,
        orgId: g.orgId,
        term: g.term,
        agentIds: g.members.filter((m) => m.kind === 'agent').map((m) => m.refId),
        botIds: g.members.filter((m) => m.kind === 'bot').map((m) => m.refId)
      })
    }
    return this.diff(before, { added, updated })
  }

  /** The removal half of a replacement whose install was refused. Shrink each held group to the
   *  members its replacement still names, keeping the OLD term: the removals are not what failed,
   *  so applying them alone only ever reduces what this daemon serves, while the stale term is what
   *  makes the CP reissue the full replacement. A group this daemon does not hold is skipped — a
   *  refusal must never resurrect one. */
  shrinkToGrant(grants: DutyGrantEntry[]): DutyApplyResult {
    if (grants.length === 0) return EMPTY
    const before = this.agents()
    const updated: string[] = []
    for (const g of grants) {
      const held = this.held.get(g.groupId)
      if (!held) continue
      const kept = new Set(g.members.map((m) => `${m.kind}:${m.refId}`))
      const agentIds = held.agentIds.filter((id) => kept.has(`agent:${id}`))
      const botIds = held.botIds.filter((id) => kept.has(`bot:${id}`))
      if (agentIds.length === held.agentIds.length && botIds.length === held.botIds.length) continue
      updated.push(g.groupId)
      this.held.set(g.groupId, { ...held, agentIds, botIds })
    }
    return this.diff(before, { added: [], updated })
  }

  applyRevoke(revocations: DutyRevoke['revocations']): DutyApplyResult {
    if (revocations.length === 0) return EMPTY
    const before = this.agents()
    for (const r of revocations) this.held.delete(r.groupId)
    return this.diff(before, { added: [], updated: [] })
  }

  /** Drop everything — the local half of an explicit drain release. */
  releaseAll(): string[] {
    const ids = this.groupIds()
    this.held.clear()
    return ids
  }

  private diff(before: Set<string>, base: { added: string[]; updated: string[] }): DutyApplyResult {
    const after = this.agents()
    return {
      added: base.added.sort(),
      updated: base.updated.sort(),
      agentsGained: [...after].filter((id) => !before.has(id)).sort(),
      agentsLost: [...before].filter((id) => !after.has(id)).sort()
    }
  }
}
