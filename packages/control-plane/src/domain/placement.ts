/**
 * The ONE answer to "which daemons may hold this agent's duty"
 * (docs/designs/daemon-groups.md §2/§3). Placement is a TARGET — `daemon` names one machine,
 * `set` names a member set (the install-wide pool is the org-less one) — and every reader of
 * eligibility comes through here.
 *
 * Nothing outside this module may branch on the placement kind. Tenancy is deliberately NOT a
 * branch here: it is the write-time invariant on membership, so eligibility for a set is one
 * membership lookup and the module has fewer arms than when the pool was a kind.
 */
import type { DaemonId } from './ids.js'

/** Mirrors the Prisma `AgentPlacementKind` enum without importing the generated client. */
export type PlacementKind = 'daemon' | 'set'

/** The placement columns, as every caller already has them on an agent record. */
export interface PlacementRef {
  placementKind: PlacementKind
  daemonId: string | null
  setId: string | null
}

/** What a connected daemon may claim: the set it is a member of, or nothing at all. */
export type DutyClaimScope = { setId: string } | 'none'

/**
 * Who may hold this agent's duty.
 * - `daemon` — exactly that machine. A set member is never it, so a local daemon's vacancies stay
 *   vacant, which is what keeps the pool off agents it must not serve.
 * - `set` — exactly the members of that set.
 * - `none` — the agent is unplaced; nobody may hold it.
 */
export type DutyEligibility =
  { scope: 'daemon'; daemonId: DaemonId } | { scope: 'set'; setId: string } | { scope: 'none' }

export function dutyEligibility(agent: PlacementRef): DutyEligibility {
  if (agent.placementKind === 'set') return agent.setId ? { scope: 'set', setId: agent.setId } : { scope: 'none' }
  return agent.daemonId ? { scope: 'daemon', daemonId: agent.daemonId as DaemonId } : { scope: 'none' }
}

/** The claim scope of a connected daemon: the set it belongs to, read from membership. */
export function claimScopeOf(daemon: { setId: string | null }): DutyClaimScope {
  return daemon.setId === null ? 'none' : { setId: daemon.setId }
}

/** May this claimant hold this agent's duty? The predicate the ledger's SQL mirrors row-wise. */
export function mayHold(agent: PlacementRef, claimant: { daemonId: DaemonId; scope: DutyClaimScope }): boolean {
  const eligibility = dutyEligibility(agent)
  if (eligibility.scope === 'none') return false
  if (eligibility.scope === 'set') return claimant.scope !== 'none' && claimant.scope.setId === eligibility.setId
  return eligibility.daemonId === claimant.daemonId
}

/**
 * The delivery targets placement alone names — the placement half of `AgentDelivery.daemonsFor`.
 * A set agent names none: its members are whoever holds the duty, which is the ledger's answer,
 * not placement's. That is the whole reason this returns a list rather than an id.
 */
export function placementTargets(agent: PlacementRef): string[] {
  const eligibility = dutyEligibility(agent)
  return eligibility.scope === 'daemon' ? [eligibility.daemonId] : []
}

/** Is this agent placed at all? A `set` placement is placed without naming a machine. */
export function isPlaced(agent: PlacementRef): boolean {
  return dutyEligibility(agent).scope !== 'none'
}

/** Where a placement write points. `unplaced` is the absence of a target, not a third kind. */
export type PlacementTarget =
  { kind: 'daemon'; daemonId: DaemonId } | { kind: 'set'; setId: string } | { kind: 'unplaced' }

export const UNPLACED: PlacementTarget = { kind: 'unplaced' }
export const onSet = (setId: string): PlacementTarget => ({ kind: 'set', setId })
export const onDaemon = (daemonId: DaemonId): PlacementTarget => ({ kind: 'daemon', daemonId })

export function placementTargetOf(agent: PlacementRef): PlacementTarget {
  const eligibility = dutyEligibility(agent)
  if (eligibility.scope === 'set') return { kind: 'set', setId: eligibility.setId }
  return eligibility.scope === 'daemon' ? { kind: 'daemon', daemonId: eligibility.daemonId } : UNPLACED
}

/** The columns a target writes. Each kind clears the other's ref: a set agent names no machine,
 *  and leaving a stale member id there is exactly the dead-Pod pointer this representation removes. */
export function placementColumns(target: PlacementTarget): {
  placementKind: PlacementKind
  daemonId: string | null
  setId: string | null
} {
  if (target.kind === 'set') return { placementKind: 'set', daemonId: null, setId: target.setId }
  return {
    placementKind: 'daemon',
    daemonId: target.kind === 'daemon' ? target.daemonId : null,
    setId: null
  }
}

export function samePlacement(a: PlacementTarget, b: PlacementTarget): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'daemon') return a.daemonId === (b as { daemonId: DaemonId }).daemonId
  return a.kind !== 'set' || a.setId === (b as { setId: string }).setId
}

/** A stable label for logs and conflict messages — never a raw member id for a set placement. */
export function placementLabel(target: PlacementTarget): string {
  return target.kind === 'daemon' ? target.daemonId : target.kind
}
