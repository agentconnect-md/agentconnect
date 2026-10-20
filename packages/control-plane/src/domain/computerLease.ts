// The control lease state machine (computer-use.md §4.4): pure decisions over one Computer's lease row.
import type { ComputerLeaseHolder, ComputerLeaseRefusal } from '@agentconnect.md/protocol'
import { presentComputerStatus, type ComputerPolicy, type ComputerStatus } from './computer.js'

/** One held lease; times are epoch milliseconds. */
export interface ControlLease {
  leaseId: string
  computerId: string
  orgId: string
  sessionId: string
  agentId: string
  agentName: string | null
  /** The agent daemon that took the lease; its heartbeats keep the holder alive. */
  daemonId: string | null
  acquiredAt: number
  /** The last input the lease covered: acquire, renewal by the same session, or the desktop's report. */
  lastUsedAt: number
  /** The last heartbeat of the holder's daemon. */
  renewedAt: number
}

/** The slice of the Computer row a decision reads. */
export interface LeaseComputer {
  status: ComputerStatus
  lastSeenAt: Date | null
  policy: ComputerPolicy
}

export interface LeaseClock {
  now: number
  /** How long a holder may go without a heartbeat from its daemon. */
  holderTtlMs: number
  /** A live Computer status older than this reads as offline. */
  staleAfterMs: number
}

export type LeaseEndReason =
  'idle' | 'max' | 'holder_lost' | 'released' | 'session_ended' | 'paused' | 'human_takeover' | 'policy' | 'revoked'

/** The row to keep (`undefined`), replace, or delete (`null`), plus what happened. */
export interface LeaseStep<R> {
  next: ControlLease | null | undefined
  result: R
}

export function leaseHolder(lease: ControlLease): ComputerLeaseHolder {
  return {
    sessionId: lease.sessionId,
    agentId: lease.agentId,
    ...(lease.agentName ? { agentName: lease.agentName } : {})
  }
}

/** The hard cap from the policy; the lease may end sooner. */
export function leaseCap(lease: ControlLease, policy: ComputerPolicy): number {
  return lease.acquiredAt + policy.leaseMaxSeconds * 1000
}

/** When and why a lease runs out unless something renews it. */
export function leaseDeadline(
  lease: ControlLease,
  policy: ComputerPolicy,
  holderTtlMs: number
): { at: number; reason: 'idle' | 'max' | 'holder_lost' } {
  const deadlines = [
    { at: lease.lastUsedAt + policy.leaseIdleSeconds * 1000, reason: 'idle' as const },
    { at: leaseCap(lease, policy), reason: 'max' as const },
    { at: lease.renewedAt + holderTtlMs, reason: 'holder_lost' as const }
  ]
  return deadlines.reduce((first, d) => (d.at < first.at ? d : first))
}

/** Why a held lease has already ended at `now`, or undefined while it stands. */
export function leaseEnded(
  lease: ControlLease,
  computer: LeaseComputer | null,
  clock: LeaseClock
): LeaseEndReason | undefined {
  if (!computer || computer.status === 'revoked') return 'revoked'
  // A policy change that takes the holder's grant or input away ends its lease.
  if (!computer.policy.allowedAgents.includes(lease.agentId) || computer.policy.agentMode !== 'control') return 'policy'
  const deadline = leaseDeadline(lease, computer.policy, clock.holderTtlMs)
  return clock.now >= deadline.at ? deadline.reason : undefined
}

export type AcquireOutcome =
  | { granted: true; lease: ControlLease; fresh: boolean; replaced?: { lease: ControlLease; reason: LeaseEndReason } }
  | { granted: false; code: ComputerLeaseRefusal; message: string; holder?: ComputerLeaseHolder }

export interface AcquireRequest {
  sessionId: string
  agentId: string
  agentName: string | null
  daemonId: string | null
  /** The id a fresh lease takes. */
  leaseId: string
}

/** Take the lease, or renew it for the session that holds it; anyone else gets a definite refusal. */
export function decideAcquire(
  computerId: string,
  orgId: string,
  computer: LeaseComputer | null,
  current: ControlLease | null,
  req: AcquireRequest,
  clock: LeaseClock
): LeaseStep<AcquireOutcome> {
  const refuse = (code: ComputerLeaseRefusal, message: string, holder?: ComputerLeaseHolder) => ({
    next: undefined,
    result: { granted: false as const, code, message, ...(holder ? { holder } : {}) }
  })
  if (!computer || computer.status === 'revoked') return refuse('unavailable', 'this computer was revoked or removed')
  if (!computer.policy.allowedAgents.includes(req.agentId))
    return refuse('denied', 'this agent is not granted this computer')
  if (computer.policy.agentMode !== 'control') return refuse('denied', 'agents may only view this computer')
  const status = presentComputerStatus(computer, clock.now, clock.staleAfterMs)
  if (status === 'offline') return refuse('unavailable', 'this computer is offline')
  if (status === 'paused') return refuse('human_in_control', 'the owner paused this computer')
  if (status === 'human_in_control') return refuse('human_in_control', 'a person is controlling this computer')
  const ended = current ? leaseEnded(current, computer, clock) : undefined
  const live = current && !ended ? current : null
  if (live && (live.sessionId !== req.sessionId || live.agentId !== req.agentId)) {
    const holder = leaseHolder(live)
    return refuse('computer_busy', `this computer is controlled by ${holder.agentName ?? holder.agentId}`, holder)
  }
  if (live) {
    const renewed = { ...live, lastUsedAt: clock.now, renewedAt: clock.now, daemonId: req.daemonId ?? live.daemonId }
    return { next: renewed, result: { granted: true, lease: renewed, fresh: false } }
  }
  const lease: ControlLease = {
    leaseId: req.leaseId,
    computerId,
    orgId,
    sessionId: req.sessionId,
    agentId: req.agentId,
    agentName: req.agentName,
    daemonId: req.daemonId,
    acquiredAt: clock.now,
    lastUsedAt: clock.now,
    renewedAt: clock.now
  }
  return {
    next: lease,
    result: {
      granted: true,
      lease,
      fresh: true,
      ...(current && ended ? { replaced: { lease: current, reason: ended } } : {})
    }
  }
}

/** The holder session gives the lease up; `before` keeps a late report of an earlier turn from ending a later lease. */
export function decideRelease(
  current: ControlLease | null,
  holder: { sessionId: string; agentId: string; before?: number },
  reason: 'released' | 'session_ended'
): LeaseStep<{ ended: ControlLease; reason: LeaseEndReason } | null> {
  if (!current || current.sessionId !== holder.sessionId || current.agentId !== holder.agentId)
    return { next: undefined, result: null }
  if (holder.before !== undefined && current.acquiredAt > holder.before) return { next: undefined, result: null }
  return { next: null, result: { ended: current, reason } }
}

export interface DesktopReport {
  status: ComputerStatus
  /** The desktop's local lease: its holder and how long since its last input. */
  lease?: { holder: string; idleMs: number }
}

/** A Computer heartbeat: a pause or takeover pre-empts the lease, real use refreshes its idle clock, a lapsed lease is cleared. */
export function decideObserve(
  computer: LeaseComputer | null,
  current: ControlLease | null,
  report: DesktopReport,
  clock: LeaseClock
): LeaseStep<{ lease: ControlLease | null; ended?: { lease: ControlLease; reason: LeaseEndReason } }> {
  if (!current) return { next: undefined, result: { lease: null } }
  const end = (reason: LeaseEndReason) => ({ next: null, result: { lease: null, ended: { lease: current, reason } } })
  if (report.status === 'paused') return end('paused')
  if (report.status === 'human_in_control') return end('human_takeover')
  const ended = leaseEnded(current, computer, clock)
  if (ended) return end(ended)
  const used = report.lease?.holder === current.sessionId ? clock.now - report.lease.idleMs : undefined
  if (used === undefined || used <= current.lastUsedAt) return { next: undefined, result: { lease: current } }
  const touched = { ...current, lastUsedAt: used }
  return { next: touched, result: { lease: touched } }
}

/** A read: the lease while it stands, and a lapsed row to clear. */
export function decideRead(
  computer: LeaseComputer | null,
  current: ControlLease | null,
  clock: LeaseClock
): LeaseStep<{ lease: ControlLease | null; ended?: { lease: ControlLease; reason: LeaseEndReason } }> {
  if (!current) return { next: undefined, result: { lease: null } }
  const ended = leaseEnded(current, computer, clock)
  if (!ended) return { next: undefined, result: { lease: current } }
  return { next: null, result: { lease: null, ended: { lease: current, reason: ended } } }
}

/** A forced end by a person (the console's Stop) or the Computer's revoke. */
export function decidePreempt(
  current: ControlLease | null,
  reason: LeaseEndReason
): LeaseStep<{ ended: ControlLease; reason: LeaseEndReason } | null> {
  return current ? { next: null, result: { ended: current, reason } } : { next: undefined, result: null }
}
