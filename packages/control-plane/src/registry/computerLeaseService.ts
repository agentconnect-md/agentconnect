// ComputerLeaseService — acquire, renew, release and pre-empt Computer control leases (computer-use.md §4.4).
import { randomUUID } from 'node:crypto'
import { COMPUTER_LEASE_POLL_MAX_MS, type ComputerControlLease } from '@agentconnect.md/protocol'
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
  leaseOccupancy,
  type LeaseOccupancy,
  type AcquireOutcome,
  type ControlLease,
  type DesktopReport,
  type LeaseClock,
  type LeaseComputer,
  type LeaseEndReason,
  type LeaseStep
} from '../domain/computerLease.js'
import { dropWaiter, withoutWaiter, type LeaseWaiter } from '../domain/computerLeaseQueue.js'
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
  /** How often a held acquire re-reads the queue; a release on this replica wakes it sooner. */
  queuePollMs?: number
  /** A queued session that has not asked again for this long has left the line. */
  waiterTtlMs?: number
}

export interface LeaseRequester {
  sessionId: string
  agentId: string
  agentName: string | null
  daemonId: string | null
  /** The daemon-clock time of the request. */
  turnAt: number
}

export interface AcquireWait {
  /** Hold the reply up to this long while the session waits in line (capped at COMPUTER_LEASE_POLL_MAX_MS). */
  waitMs: number
  /** Aborts when the asking daemon's connection closes: the hold stops without asking again. */
  signal?: AbortSignal
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
  // Held acquires on this replica, woken when a lease here ends so the next in line does not wait out its poll.
  private readonly wakers = new Map<string, Set<() => void>>()

  constructor(
    private readonly repo: ComputerLeaseRepo,
    private readonly clock: Clock,
    private readonly opts: ComputerLeaseServiceOpts
  ) {}

  /** Take the lease for a session, or renew it when that session already holds it; with `wait`, queue and hold the reply a while. */
  async acquire(orgId: string, computerId: string, who: LeaseRequester, wait?: AcquireWait): Promise<AcquireResult> {
    let left = Math.min(Math.max(wait?.waitMs ?? 0, 0), COMPUTER_LEASE_POLL_MAX_MS)
    const signal = wait?.signal
    if (signal?.aborted) return { granted: false, code: 'unavailable', message: 'the daemon connection closed' }
    for (;;) {
      const result = await this.acquireOnce(orgId, computerId, who, wait !== undefined)
      if (result.granted || !result.queued || left <= 0) return result
      const slice = Math.min(left, this.opts.queuePollMs ?? 1000)
      await this.pause(computerId, slice, signal)
      // Nobody receives the reply of a closed connection: stop holding, keeping the place until it lapses.
      if (signal?.aborted) return result
      left -= slice
    }
  }

  private async acquireOnce(orgId: string, computerId: string, who: LeaseRequester, queue: boolean) {
    const { result, policy } = await this.step(orgId, computerId, (computer, lease, clock, waiting) =>
      decideAcquire(computerId, orgId, computer, lease, { ...who, leaseId: randomUUID(), wait: queue }, clock, waiting)
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

  /** The session gives the lease up, and its place in line; false when it held no lease. */
  async release(orgId: string, computerId: string, holder: { sessionId: string; agentId: string }): Promise<boolean> {
    const { result } = await this.step(orgId, computerId, (_computer, lease, _clock, queue) => ({
      ...decideRelease(lease, holder, 'released'),
      queue: withoutWaiter(queue, holder)
    }))
    if (result) this.ended(result.ended, result.reason)
    return result !== null
  }

  /** The session's turn ended (`end` or `problem`): every lease it took and wait it began at or before `endedAt` (daemon clock) ends. */
  async sessionEnded(sessionId: string, agentId: string, endedAt: number): Promise<number> {
    let released = 0
    const touched = new Map<string, string>()
    for (const row of [
      ...(await this.repo.listBySession(sessionId)),
      ...(await this.repo.listWaitingBySession(sessionId))
    ])
      if (row.agentId === agentId) touched.set(row.computerId, row.orgId)
    for (const [computerId, orgId] of touched) {
      const { result } = await this.step(orgId, computerId, (_computer, lease, clock, queue) => ({
        ...decideRelease(lease, { sessionId, agentId, before: endedAt }, 'session_ended'),
        queue: dropWaiter(queue, { sessionId, agentId }, endedAt, clock.now)
      }))
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

  /** Who holds each Computer's lease and who waits, read without a lock for the console; lapsed ones are left out. */
  async occupancy(computers: ReadonlyArray<LeaseComputer & { id: string }>): Promise<Map<string, LeaseOccupancy>> {
    const { leases, waiters } = await this.repo.listOccupancy(computers.map((c) => ComputerId(c.id)))
    const clock = {
      now: this.clock.now(),
      holderTtlMs: this.opts.holderTtlMs,
      staleAfterMs: this.opts.staleAfterMs,
      ...(this.opts.waiterTtlMs !== undefined ? { waiterTtlMs: this.opts.waiterTtlMs } : {})
    }
    const out = new Map<string, LeaseOccupancy>()
    for (const c of computers) {
      const lease = leases.find((l) => l.computerId === c.id) ?? null
      const queue = waiters.filter((w) => w.computerId === c.id)
      out.set(c.id, leaseOccupancy(c, lease, queue, clock))
    }
    return out
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
    decide: (
      computer: LeaseComputer | null,
      lease: ControlLease | null,
      clock: LeaseClock,
      queue: LeaseWaiter[]
    ) => LeaseStep<R>
  ): Promise<{ result: R; policy: ComputerPolicy | undefined }> {
    let policy: ComputerPolicy | undefined
    const result = await this.repo.step(OrgId(orgId), ComputerId(computerId), (computer, lease, queue) => {
      policy = computer?.policy
      const clock = {
        now: this.clock.now(),
        holderTtlMs: this.opts.holderTtlMs,
        staleAfterMs: this.opts.staleAfterMs,
        ...(this.opts.waiterTtlMs !== undefined ? { waiterTtlMs: this.opts.waiterTtlMs } : {})
      }
      return decide(computer, lease, clock, queue)
    })
    return { result, policy }
  }

  // Wait up to `ms` real time, until a lease on this Computer ends on this replica, or until `signal` aborts.
  private pause(computerId: string, ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      let set = this.wakers.get(computerId)
      if (!set) this.wakers.set(computerId, (set = new Set()))
      const done = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', done)
        set.delete(done)
        if (set.size === 0 && this.wakers.get(computerId) === set) this.wakers.delete(computerId)
        resolve()
      }
      const timer = setTimeout(done, ms)
      set.add(done)
      signal?.addEventListener('abort', done, { once: true })
    })
  }

  private wake(computerId: string): void {
    for (const done of [...(this.wakers.get(computerId) ?? [])]) done()
  }

  // A lease ended: tell the desktop (unless the desktop itself reported why), wake the line, and leave an audit row.
  private ended(lease: ControlLease, reason: LeaseEndReason, push = true): void {
    if (push) this.opts.channels?.leaseChanged(lease.computerId)
    this.wake(lease.computerId)
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
