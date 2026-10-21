// The control lease state machine (computer-use.md §4.4): pure decisions over one Computer's lease row.
import { computerLeaseHolderName, type ComputerLeaseHolder, type ComputerLeaseRefusal } from '@agentconnect.md/protocol'
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
  /** The daemon-clock time of its session's latest acquire; only a turn end stamped at or after it releases the lease. */
  turnAt: number
  /** When it reached `leaseMaxSeconds`: a spent row holds nothing and only bars its session until its turn ends. */
  spentAt: number | null
}

/** The slice of the Computer row a decision reads. */
export interface LeaseComputer {
  status: ComputerStatus
  lastSeenAt: Date | null
  policy: ComputerPolicy
  /** A console Stop: no lease stands or is granted until someone resumes the Computer (§6). */
  stoppedAt?: Date | null
  /** An ephemeral managed computer serves only the session it was made for (§15.1). */
  poolSessionId?: string | null
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

const sameHolder = (lease: ControlLease, who: { sessionId: string; agentId: string }) =>
  lease.sessionId === who.sessionId && lease.agentId === who.agentId

/** A spent row stops barring its session once its daemon is lost or one more `leaseMaxSeconds` has passed. */
export function spentLapsed(lease: ControlLease, computer: LeaseComputer | null, clock: LeaseClock): boolean {
  if (!computer || computer.status === 'revoked' || lease.spentAt === null) return true
  return (
    clock.now >= lease.renewedAt + clock.holderTtlMs ||
    clock.now >= lease.spentAt + computer.policy.leaseMaxSeconds * 1000
  )
}

/** Why a held lease has already ended at `now`, or undefined while it stands. */
export function leaseEnded(
  lease: ControlLease,
  computer: LeaseComputer | null,
  clock: LeaseClock
): LeaseEndReason | undefined {
  if (!computer || computer.status === 'revoked') return 'revoked'
  if (computer.stoppedAt) return 'paused'
  // A policy change that takes the holder's grant or input away ends its lease.
  if (!computer.policy.allowedAgents.includes(lease.agentId) || computer.policy.agentMode !== 'control') return 'policy'
  const deadline = leaseDeadline(lease, computer.policy, clock.holderTtlMs)
  return clock.now >= deadline.at ? deadline.reason : undefined
}

export type AcquireOutcome =
  | { granted: true; lease: ControlLease; fresh: boolean; replaced?: { lease: ControlLease; reason: LeaseEndReason } }
  | {
      granted: false
      code: ComputerLeaseRefusal
      message: string
      holder?: ComputerLeaseHolder
      /** A lease this decision found at its max limit and marked spent. */
      ended?: { lease: ControlLease; reason: LeaseEndReason }
    }

export interface AcquireRequest {
  sessionId: string
  agentId: string
  agentName: string | null
  daemonId: string | null
  /** The daemon-clock time of the request. */
  turnAt: number
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
  if (computer.poolSessionId && computer.poolSessionId !== req.sessionId)
    return refuse('denied', 'this computer belongs to another session')
  if (computer.stoppedAt) return refuse('human_in_control', 'this computer was stopped from the console')
  const status = presentComputerStatus(computer, clock.now, clock.staleAfterMs)
  if (status === 'offline') return refuse('unavailable', 'this computer is offline')
  if (status === 'sleeping') return refuse('unavailable', 'this computer is asleep')
  if (status === 'paused') return refuse('human_in_control', 'the owner paused this computer')
  if (status === 'human_in_control') return refuse('human_in_control', 'a person is controlling this computer')
  // The max limit bounds the session, not one lease: it may not take the Computer again until its turn ends.
  const capped = `this session used its ${computer.policy.leaseMaxSeconds}s control limit; it can take the computer again in a later turn`
  const spent = current?.spentAt != null ? current : null
  if (spent && sameHolder(spent, req) && !spentLapsed(spent, computer, clock)) return refuse('denied', capped)
  const ended = current && !spent ? leaseEnded(current, computer, clock) : undefined
  if (current && ended === 'max' && sameHolder(current, req)) {
    return {
      next: { ...current, spentAt: clock.now },
      result: { granted: false, code: 'denied', message: capped, ended: { lease: current, reason: ended } }
    }
  }
  const live = current && !spent && !ended ? current : null
  if (live && !sameHolder(live, req)) {
    const holder = leaseHolder(live)
    return refuse('computer_busy', `this computer is controlled by ${holder.agentName ?? holder.agentId}`, holder)
  }
  if (live) {
    const renewed = {
      ...live,
      lastUsedAt: clock.now,
      renewedAt: clock.now,
      turnAt: Math.max(live.turnAt, req.turnAt),
      daemonId: req.daemonId ?? live.daemonId
    }
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
    renewedAt: clock.now,
    turnAt: req.turnAt,
    spentAt: null
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

/** The holder session gives the lease up; `before` (daemon clock) keeps a late end of an earlier turn from ending a later lease. */
export function decideRelease(
  current: ControlLease | null,
  holder: { sessionId: string; agentId: string; before?: number },
  reason: 'released' | 'session_ended'
): LeaseStep<{ ended: ControlLease; reason: LeaseEndReason } | null> {
  if (!current || !sameHolder(current, holder)) return { next: undefined, result: null }
  if (holder.before !== undefined && current.turnAt > holder.before) return { next: undefined, result: null }
  // A spent row already reported its end; only the turn's end clears it, so a release cannot reset the limit.
  if (current.spentAt !== null) return { next: reason === 'session_ended' ? null : undefined, result: null }
  return { next: null, result: { ended: current, reason } }
}

type ReadStep = LeaseStep<{ lease: ControlLease | null; ended?: { lease: ControlLease; reason: LeaseEndReason } }>

// A spent row holds nothing; it is cleared once it stops barring its session.
function readSpent(current: ControlLease, computer: LeaseComputer | null, clock: LeaseClock): ReadStep {
  return { next: spentLapsed(current, computer, clock) ? null : undefined, result: { lease: null } }
}

// A lease that ran out: a max-limit end leaves a spent row behind, every other end deletes it.
function endLease(current: ControlLease, reason: LeaseEndReason, clock: LeaseClock): ReadStep {
  return {
    next: reason === 'max' ? { ...current, spentAt: clock.now } : null,
    result: { lease: null, ended: { lease: current, reason } }
  }
}

export interface DesktopReport {
  status: ComputerStatus
  /** The desktop's local lease: its holder and how long since its last input. */
  lease?: { holder: string; idleMs: number; heldMs?: number }
}

/** A Computer heartbeat: a pause or takeover pre-empts the lease, real use refreshes its idle clock, a lapsed lease is cleared. */
export function decideObserve(
  computer: LeaseComputer | null,
  current: ControlLease | null,
  report: DesktopReport,
  clock: LeaseClock
): ReadStep {
  if (!current) return { next: undefined, result: { lease: null } }
  if (current.spentAt !== null) return readSpent(current, computer, clock)
  if (report.status === 'paused') return endLease(current, 'paused', clock)
  if (report.status === 'human_in_control') return endLease(current, 'human_takeover', clock)
  // A desktop lease taken while this one stood never idled out locally, so its last input carries this lease's use.
  const local = report.lease?.holder === computerLeaseHolderName(current) ? report.lease : undefined
  const used = local ? clock.now - local.idleMs : undefined
  const since = local?.heldMs !== undefined ? clock.now - local.heldMs : used
  const idleAt = computer ? current.lastUsedAt + computer.policy.leaseIdleSeconds * 1000 : 0
  const live = used !== undefined && since !== undefined && used > current.lastUsedAt && since < idleAt
  const touched = live ? { ...current, lastUsedAt: used } : current
  const ended = leaseEnded(touched, computer, clock)
  if (ended) return endLease(current, ended, clock)
  return { next: touched === current ? undefined : touched, result: { lease: touched } }
}

/** A read: the lease while it stands, and a lapsed row to clear. */
export function decideRead(computer: LeaseComputer | null, current: ControlLease | null, clock: LeaseClock): ReadStep {
  if (!current) return { next: undefined, result: { lease: null } }
  if (current.spentAt !== null) return readSpent(current, computer, clock)
  const ended = leaseEnded(current, computer, clock)
  return ended ? endLease(current, ended, clock) : { next: undefined, result: { lease: current } }
}

/** A forced end by a person (the console's Stop) or the Computer's revoke; a spent row keeps barring its session. */
export function decidePreempt(
  current: ControlLease | null,
  reason: LeaseEndReason
): LeaseStep<{ ended: ControlLease; reason: LeaseEndReason } | null> {
  return current && current.spentAt === null
    ? { next: null, result: { ended: current, reason } }
    : { next: undefined, result: null }
}
