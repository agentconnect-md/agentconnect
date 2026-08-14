// DutyLeaseService — the CP half of the duty lease exchange (k8s daemons).
// Renewal IS the heartbeat: one batched expiry refresh per frame, then a digest
// diff answered with duty/grant (missed or re-issued terms) and duty/revoke
// (superseded or vanished groups), and vacancy grants up to the member's
// declared headroom. Terms only ever move through the repo's grant paths.
import {
  DUTY_GRANT_MEMBERS_MAX,
  type HeartbeatDuties,
  type DutyGrantEntry,
  type DutyRevoke
} from '@agentconnect.md/protocol'
import type { DutyGroupRepo, DutyGroupRecord, DutyGrantRecord } from '../persistence/ports.js'
import type { DaemonId } from '../domain/ids.js'
import type { Clock } from '../domain/clock.js'

export interface DutyLeaseConfig {
  /** Renewal horizon written on every renew/grant — the T_reassign vacancy bound. */
  leaseMs: number
  /** Startup recovery grace: no vacancy grants until boot + this, so a CP
   *  restart cannot misread quiet members as dead. Renewals are unaffected. */
  recoveryGraceMs: number
  /** Cap on fresh vacancy grants per heartbeat, under the member's headroom. */
  grantMaxPerTick: number
  /** Emission chunking: entries per duty/grant frame (schema caps at 100) and a
   *  member-ref budget per frame, so a reconnect restoring hundreds of groups
   *  never assembles one frame the daemon must reject on size. */
  grantsPerFrame: number
  grantMembersPerFrame: number
  /** Revocations per duty/revoke frame (schema caps at 1000). */
  revocationsPerFrame: number
  /** Vacancy grant policy. `incumbent` (the soak default until the shared data
   *  plane lands) pins grants to groups whose agents already live on the
   *  claimant, so the machinery runs without moving anyone; `any` is the target
   *  pool behavior. */
  grantPolicy: 'incumbent' | 'any'
}

export const DUTY_LEASE_DEFAULTS: DutyLeaseConfig = {
  leaseMs: 120_000,
  recoveryGraceMs: 120_000,
  grantMaxPerTick: 32,
  grantsPerFrame: 50,
  grantMembersPerFrame: 2000,
  revocationsPerFrame: 500,
  grantPolicy: 'incumbent'
}

type Send = (type: 'duty/grant' | 'duty/revoke', payload: unknown) => void

function toGrantEntry(g: Pick<DutyGrantRecord, 'groupId' | 'orgId' | 'term' | 'members'>): DutyGrantEntry {
  return { groupId: g.groupId, orgId: g.orgId, term: String(g.term), members: g.members }
}

function deliverable(groups: DutyGroupRecord[]): DutyGroupRecord[] {
  return groups.filter((g) => g.members.length <= DUTY_GRANT_MEMBERS_MAX)
}

/** Split by entry count AND total member refs; every entry is already ≤ the
 *  per-entry member cap, so a full-size single entry still fits a frame. */
function chunkGrants(grants: DutyGrantEntry[], perFrame: number, membersPerFrame: number): DutyGrantEntry[][] {
  const chunks: DutyGrantEntry[][] = []
  let current: DutyGrantEntry[] = []
  let members = 0
  for (const g of grants) {
    if (current.length > 0 && (current.length >= perFrame || members + g.members.length > membersPerFrame)) {
      chunks.push(current)
      current = []
      members = 0
    }
    current.push(g)
    members += g.members.length
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

interface DaemonLane {
  pending: number
  tail: Promise<void>
}

export class DutyLeaseService {
  private readonly bootedAtMs: number
  /** Per-daemon serialization lane: WS handlers dispatch without awaiting, so
   *  every ledger-touching operation for one daemon chains on one tail —
   *  overlapping beats must not double-spend headroom, and a release must never
   *  interleave with a running exchange (its ack has to mean "every grant sent
   *  before it is already on the wire, and nothing else was granted since"). */
  private readonly lanes = new Map<string, DaemonLane>()

  constructor(
    private readonly repo: DutyGroupRepo,
    private readonly clock: Clock,
    private readonly config: DutyLeaseConfig = DUTY_LEASE_DEFAULTS,
    private readonly log?: { warn(obj: unknown, msg?: string): void }
  ) {
    this.bootedAtMs = clock.now()
  }

  /** Chain `fn` on the daemon's lane so operations never interleave. */
  private serialize<T>(daemonId: string, fn: () => Promise<T>): Promise<T> {
    const lane = this.lanes.get(daemonId) ?? { pending: 0, tail: Promise.resolve() }
    this.lanes.set(daemonId, lane)
    lane.pending++
    const result = lane.tail.then(fn)
    lane.tail = result
      .then(
        () => undefined,
        () => undefined
      )
      .then(() => {
        lane.pending--
        if (lane.pending === 0 && this.lanes.get(daemonId) === lane) this.lanes.delete(daemonId)
      })
    return result
  }

  /** The full per-heartbeat exchange. `send` emits on the reporting connection.
   *  A beat arriving while this daemon's lane is busy is dropped — the next
   *  beat re-runs the whole idempotent diff anyway. */
  async onHeartbeat(daemonId: DaemonId, duties: HeartbeatDuties, send: Send): Promise<void> {
    if ((this.lanes.get(daemonId)?.pending ?? 0) > 0) return
    await this.serialize(daemonId, () => this.exchange(daemonId, duties, send))
  }

  private async exchange(daemonId: DaemonId, duties: HeartbeatDuties, send: Send): Promise<void> {
    const now = new Date(this.clock.now())
    await this.repo.renewHeld(daemonId, now, this.config.leaseMs)
    const held = await this.repo.listHeldBy(daemonId)
    const heldById = new Map(held.map((g) => [g.groupId, g]))
    const digestIds = new Set(duties.held.map((d) => d.groupId))

    // Re-issue held groups the member does not know it holds (restart / lost
    // grant EVT) or knows only at a stale term — the reconnect crossing point:
    // confirm the terms or supersede, never both. A missing group will occupy a
    // NEW local slot, so it is charged against the reported headroom below; a
    // stale-term re-issue is already local and costs nothing.
    const missing: DutyGroupRecord[] = held.filter((g) => !digestIds.has(g.groupId))
    const stale: DutyGroupRecord[] = held.filter((g) => {
      const claimed = duties.held.find((d) => d.groupId === g.groupId)
      return claimed !== undefined && claimed.term !== String(g.term)
    })

    // A lease the ledger holds for this member that the member does not serve
    // (missing from the digest) and can never be told about (oversized) must
    // vacate — renewing it forever would wedge the group held-but-unserved.
    const missingOversized = missing.filter((g) => g.members.length > DUTY_GRANT_MEMBERS_MAX)
    if (missingOversized.length > 0) {
      await this.repo.release(
        daemonId,
        missingOversized.map((g) => g.groupId)
      )
      this.log?.warn(
        { daemonId, groupIds: missingOversized.map((g) => g.groupId) },
        'held duty groups exceed the grant member cap and are not served; released — move them to a dedicated tier'
      )
    }

    let granted: DutyGrantRecord[] = []
    const budget = Math.max(0, duties.headroom - deliverable(missing).length)
    if (budget > 0 && this.clock.now() >= this.bootedAtMs + this.config.recoveryGraceMs) {
      // Oversized groups are excluded at the claim boundary (the size gate), so
      // a claim never lands on a group it would immediately have to release.
      granted = await this.repo.claimVacant(
        daemonId,
        Math.min(budget, this.config.grantMaxPerTick),
        now,
        this.config.leaseMs,
        {
          maxMembers: DUTY_GRANT_MEMBERS_MAX,
          incumbentOnly: this.config.grantPolicy === 'incumbent'
        }
      )
    }

    // Classified AFTER the claim so the grant and revoke sets are disjoint by
    // construction: a vacant digest group the claim just re-took is a grant at
    // its new term, never a simultaneous revocation.
    const grantedIds = new Set(granted.map((g) => g.groupId))
    const lost = duties.held.filter((d) => !heldById.has(d.groupId) && !grantedIds.has(d.groupId))
    const revocations: DutyRevoke['revocations'] = []
    if (lost.length > 0) {
      const existing = new Set((await this.repo.getByIds(lost.map((d) => d.groupId))).map((g) => g.groupId))
      for (const d of lost)
        revocations.push({ groupId: d.groupId, reason: existing.has(d.groupId) ? 'superseded' : 'gone' })
    }

    // Chunked emission: each chunk is independently applicable (a grant entry
    // REPLACES its group), so a reconnect restoring hundreds of groups converges
    // over several frames instead of assembling one the daemon must reject.
    // An oversized STALE-TERM lease cannot converge either: the group grew past
    // the cap while held, its term moved, and the replacement entry can never
    // ride this wire — so the daemon would serve the obsolete composition
    // forever. Vacate and supersede instead; the size gate keeps the group
    // unclaimable until an operator moves it to a dedicated tier.
    const staleOversized = stale.filter((g) => g.members.length > DUTY_GRANT_MEMBERS_MAX)
    if (staleOversized.length > 0) {
      await this.repo.release(
        daemonId,
        staleOversized.map((g) => g.groupId)
      )
      for (const g of staleOversized) revocations.push({ groupId: g.groupId, reason: 'superseded' })
      this.log?.warn(
        { daemonId, groupIds: staleOversized.map((g) => g.groupId) },
        'held duty groups grew past the grant member cap; superseded and vacated — move them to a dedicated tier'
      )
    }
    const grants = [
      ...deliverable(missing).map(toGrantEntry),
      ...deliverable(stale).map(toGrantEntry),
      ...granted.map(toGrantEntry)
    ]
    for (const chunk of chunkGrants(grants, this.config.grantsPerFrame, this.config.grantMembersPerFrame)) {
      send('duty/grant', { grants: chunk })
    }
    for (let i = 0; i < revocations.length; i += this.config.revocationsPerFrame) {
      send('duty/revoke', { revocations: revocations.slice(i, i + this.config.revocationsPerFrame) })
    }
  }

  /** Explicit drain release — vacate now instead of waiting out T_reassign.
   *  Queued behind any running exchange: frames on one connection are ordered,
   *  so every grant that exchange emitted reaches the daemon BEFORE this ack,
   *  and no grant can slip in between the vacate and the ack. */
  async release(daemonId: DaemonId, groupIds: string[]): Promise<void> {
    await this.serialize(daemonId, () => this.repo.release(daemonId, groupIds))
  }
}
