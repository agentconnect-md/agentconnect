/**
 * The ONE answer to "which daemons may hold this agent's duty, and what connection scope must
 * they have" (docs/designs/k8s-daemon-pool.md §14). Placement used to be a member id read inline
 * as `agent.daemonId`; it is now a TARGET — `daemon` names one machine, `pool` names the
 * install-wide member set — and every reader of eligibility comes through here.
 *
 * Nothing outside this module may branch on the string `pool`. A later `group` kind adds one arm
 * here and one join in the ledger's predicate; the callers do not learn about it.
 */
import type { DaemonId } from './ids.js'

/** Mirrors the Prisma `AgentPlacementKind` enum without importing the generated client. */
export type PlacementKind = 'daemon' | 'pool'

/** The placement columns, as every caller already has them on an agent record. */
export interface PlacementRef {
  placementKind: PlacementKind
  daemonId: string | null
}

/** What a connection is allowed to claim. Install-wide = frame-mode (org-less) member. */
export type DutyClaimScope = 'install-wide' | 'org-scoped'

/**
 * Who may hold this agent's duty.
 * - `daemon` — exactly that machine. An install-wide member is never it, so a local daemon's
 *   vacancies stay vacant, which is what keeps the pool off agents it must not serve.
 * - `install-wide` — any live frame-mode member.
 * - `none` — the agent is unplaced; nobody may hold it.
 */
export type DutyEligibility = { scope: 'daemon'; daemonId: DaemonId } | { scope: 'install-wide' } | { scope: 'none' }

export function dutyEligibility(agent: PlacementRef): DutyEligibility {
  if (agent.placementKind === 'pool') return { scope: 'install-wide' }
  return agent.daemonId ? { scope: 'daemon', daemonId: agent.daemonId as DaemonId } : { scope: 'none' }
}

/** The claim scope of a connected daemon: org-less rows are the install-wide pool members. */
export function claimScopeOf(daemon: { orgId: string | null }): DutyClaimScope {
  return daemon.orgId === null ? 'install-wide' : 'org-scoped'
}

/** May this claimant hold this agent's duty? The predicate the ledger's SQL mirrors row-wise. */
export function mayHold(agent: PlacementRef, claimant: { daemonId: DaemonId; scope: DutyClaimScope }): boolean {
  const eligibility = dutyEligibility(agent)
  if (eligibility.scope === 'none') return false
  if (eligibility.scope === 'install-wide') return claimant.scope === 'install-wide'
  return eligibility.daemonId === claimant.daemonId
}

/**
 * The delivery targets placement alone names — the placement half of `AgentDelivery.daemonsFor`.
 * A pool agent names none: its members are whoever holds the duty, which is the ledger's answer,
 * not placement's. That is the whole reason this returns a list rather than an id.
 */
export function placementTargets(agent: PlacementRef): string[] {
  const eligibility = dutyEligibility(agent)
  return eligibility.scope === 'daemon' ? [eligibility.daemonId] : []
}

/** Is this agent placed at all? `pool` is placed without naming a machine. */
export function isPlaced(agent: PlacementRef): boolean {
  return dutyEligibility(agent).scope !== 'none'
}

/** Where a placement write points. `unplaced` is the absence of a target, not a third kind. */
export type PlacementTarget = { kind: 'daemon'; daemonId: DaemonId } | { kind: 'pool' } | { kind: 'unplaced' }

export const UNPLACED: PlacementTarget = { kind: 'unplaced' }
export const ON_POOL: PlacementTarget = { kind: 'pool' }
export const onDaemon = (daemonId: DaemonId): PlacementTarget => ({ kind: 'daemon', daemonId })

export function placementTargetOf(agent: PlacementRef): PlacementTarget {
  if (agent.placementKind === 'pool') return { kind: 'pool' }
  return agent.daemonId ? { kind: 'daemon', daemonId: agent.daemonId as DaemonId } : UNPLACED
}

/** The two columns a target writes. `pool` clears `daemonId`: a pool agent names no machine, and
 *  leaving a stale member id there is exactly the dead-Pod pointer this representation removes. */
export function placementColumns(target: PlacementTarget): { placementKind: PlacementKind; daemonId: string | null } {
  if (target.kind === 'pool') return { placementKind: 'pool', daemonId: null }
  return { placementKind: 'daemon', daemonId: target.kind === 'daemon' ? target.daemonId : null }
}

export function samePlacement(a: PlacementTarget, b: PlacementTarget): boolean {
  if (a.kind !== b.kind) return false
  return a.kind !== 'daemon' || a.daemonId === (b as { daemonId: DaemonId }).daemonId
}

/** A stable label for logs and conflict messages — never a raw member id for a pool placement. */
export function placementLabel(target: PlacementTarget): string {
  return target.kind === 'daemon' ? target.daemonId : target.kind
}
