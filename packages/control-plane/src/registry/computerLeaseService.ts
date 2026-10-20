// ComputerLeaseService — acquire, renew, release and pre-empt Computer control leases (computer-use.md §4.4).
import { randomUUID } from 'node:crypto'
import type { ComputerControlLease } from '@agentconnect.md/protocol'
import type { Clock } from '../domain/clock.js'
import { ComputerId, OrgId } from '../domain/ids.js'
import type { ComputerPolicy } from '../domain/computer.js'
import {
  decideAcquire,
  decideObserve,
  decidePreempt,
  decideRead,
  decideRelease,
  leaseCap,
  leaseHolder,
  type AcquireOutcome,
  type ControlLease,
  type DesktopReport,
  type LeaseClock,
  type LeaseComputer,
  type LeaseEndReason,
  type LeaseStep
} from '../domain/computerLease.js'
import type { AuditRepo, ComputerLeaseRepo } from '../persistence/ports.js'

/** Where a lease change goes: the connected desktop daemon re-reads the lease, so pushes follow the commits they reflect. */
export interface ComputerLeaseSink {
  leaseChanged(computerId: string): void
}

export interface ComputerLeaseServiceOpts {
  /** How long a holder may go without a heartbeat from its daemon. */
  holderTtlMs: number
  /** A live Computer status older than this reads as offline. */
  staleAfterMs: number
  channels?: ComputerLeaseSink
  audit?: AuditRepo
  log?: { warn(obj: object, msg: string): void }
}

export interface LeaseRequester {
  sessionId: string
  agentId: string
  agentName: string | null
  daemonId: string | null
  /** The daemon-clock time of the request. */
  turnAt: number
}

export type AcquireResult =
  | (Extract<AcquireOutcome, { granted: true }> & { view: ComputerControlLease })
  | Extract<AcquireOutcome, { granted: false }>

/** The wire view of a lease; its cap comes from the policy it was read under. */
export function wireLease(lease: ControlLease, policy: ComputerPolicy): ComputerControlLease {
  return {
    leaseId: lease.leaseId,
    computerId: lease.computerId,
    holder: leaseHolder(lease),
    acquiredAt: new Date(lease.acquiredAt).toISOString(),
    expiresAt: new Date(leaseCap(lease, policy)).toISOString()
  }
}

export class ComputerLeaseService {
  constructor(
    private readonly repo: ComputerLeaseRepo,
    private readonly clock: Clock,
    private readonly opts: ComputerLeaseServiceOpts
  ) {}

  /** Take the lease for a session, or renew it when that session already holds it. */
  async acquire(orgId: string, computerId: string, who: LeaseRequester): Promise<AcquireResult> {
    const { result, policy } = await this.step(orgId, computerId, (computer, lease, clock) =>
      decideAcquire(computerId, orgId, computer, lease, { ...who, leaseId: randomUUID() }, clock)
    )
    if (!result.granted) {
      if (result.ended) this.ended(result.ended.lease, result.ended.reason)
      return result
    }
    // A grant implies the Computer row was read, so its policy is known.
    const view = wireLease(result.lease, policy!)
    if (result.replaced) this.ended(result.replaced.lease, result.replaced.reason)
    if (result.fresh) {
      this.opts.channels?.leaseChanged(computerId)
      this.record(orgId, 'lease_acquire', result.lease, {})
    }
    return { ...result, view }
  }

  /** The session gives the lease up; false when it held none. */
  async release(orgId: string, computerId: string, holder: { sessionId: string; agentId: string }): Promise<boolean> {
    const { result } = await this.step(orgId, computerId, (_computer, lease) =>
      decideRelease(lease, holder, 'released')
    )
    if (result) this.ended(result.ended, result.reason)
    return result !== null
  }

  /** The session's turn ended (`end` or `problem`): every lease it took at or before `endedAt` (daemon clock) is released. */
  async sessionEnded(sessionId: string, agentId: string, endedAt: number): Promise<number> {
    let released = 0
    for (const held of await this.repo.listBySession(sessionId)) {
      if (held.agentId !== agentId) continue
      const { result } = await this.step(held.orgId, held.computerId, (_computer, lease) =>
        decideRelease(lease, { sessionId, agentId, before: endedAt }, 'session_ended')
      )
      if (result) {
        released++
        this.ended(result.ended, result.reason)
      }
    }
    return released
  }

  /** An agent daemon's heartbeat keeps the sessions it holds leases for alive. */
  async daemonHeartbeat(daemonId: string): Promise<number> {
    const now = this.clock.now()
    return this.repo.renewByDaemon(daemonId, new Date(now), new Date(now - this.opts.holderTtlMs))
  }

  /** A Computer heartbeat: a pause or takeover pre-empts, real use refreshes the idle clock; returns the lease to enforce. */
  async observe(orgId: string, computerId: string, report: DesktopReport): Promise<ComputerControlLease | null> {
    // Most heartbeats find no lease: skip the lock for them.
    if (!(await this.repo.get(ComputerId(computerId)))) return null
    const { result, policy } = await this.step(orgId, computerId, (computer, lease, clock) =>
      decideObserve(computer, lease, report, clock)
    )
    if (result.ended) this.ended(result.ended.lease, result.ended.reason, false)
    return result.lease && policy ? wireLease(result.lease, policy) : null
  }

  /** The lease that stands now, clearing a lapsed one. */
  async current(orgId: string, computerId: string): Promise<ComputerControlLease | null> {
    if (!(await this.repo.get(ComputerId(computerId)))) return null
    const { result, policy } = await this.step(orgId, computerId, (computer, lease, clock) =>
      decideRead(computer, lease, clock)
    )
    if (result.ended) this.ended(result.ended.lease, result.ended.reason)
    return result.lease && policy ? wireLease(result.lease, policy) : null
  }

  /** A person or a revoke ends the lease whoever holds it. */
  async preempt(orgId: string, computerId: string, reason: LeaseEndReason): Promise<boolean> {
    const { result } = await this.step(orgId, computerId, (_computer, lease) => decidePreempt(lease, reason))
    if (result) this.ended(result.ended, result.reason)
    return result !== null
  }

  private async step<R>(
    orgId: string,
    computerId: string,
    decide: (computer: LeaseComputer | null, lease: ControlLease | null, clock: LeaseClock) => LeaseStep<R>
  ): Promise<{ result: R; policy: ComputerPolicy | undefined }> {
    let policy: ComputerPolicy | undefined
    const result = await this.repo.step(OrgId(orgId), ComputerId(computerId), (computer, lease) => {
      policy = computer?.policy
      return decide(computer, lease, {
        now: this.clock.now(),
        holderTtlMs: this.opts.holderTtlMs,
        staleAfterMs: this.opts.staleAfterMs
      })
    })
    return { result, policy }
  }

  // A lease ended: tell the desktop (unless the desktop itself reported why) and leave an audit row.
  private ended(lease: ControlLease, reason: LeaseEndReason, push = true): void {
    if (push) this.opts.channels?.leaseChanged(lease.computerId)
    this.record(lease.orgId, 'lease_end', lease, { reason })
  }

  // Best-effort audit: never blocks or fails the lease operation.
  private record(orgId: string, action: string, lease: ControlLease, extra: Record<string, unknown>): void {
    void this.opts.audit
      ?.append({
        kind: 'computer_change',
        orgId: OrgId(orgId),
        details: {
          action,
          computerId: lease.computerId,
          leaseId: lease.leaseId,
          sessionId: lease.sessionId,
          agentId: lease.agentId,
          ...extra
        }
      })
      .catch((err: Error) => this.opts.log?.warn({ err: err.message }, 'computer lease: audit write failed'))
  }
}
