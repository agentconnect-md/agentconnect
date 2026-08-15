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
import type { DutyMemberKey } from '../domain/duty.js'
import type { AgentId, DaemonId, OrgId } from '../domain/ids.js'
import type { DutyClaimScope } from '../domain/placement.js'
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
  /** Consecutive beats a member may leave a group it holds out of its digest before the lease is
   *  handed back. An install can straddle one beat, so this must be >1 to be a refusal rather than
   *  a race; a member that keeps refusing is one that cannot serve the group. */
  refusalsBeforeRelease: number
  /** How long a group stays unclaimable by the member that just gave it back, so the rotation
   *  reaches a member that can install it instead of returning to the one that could not. */
  refusalBackoffMs: number
}

export const DUTY_LEASE_DEFAULTS: DutyLeaseConfig = {
  leaseMs: 120_000,
  recoveryGraceMs: 120_000,
  grantMaxPerTick: 32,
  grantsPerFrame: 50,
  grantMembersPerFrame: 2000,
  revocationsPerFrame: 500,
  refusalsBeforeRelease: 3,
  refusalBackoffMs: 300_000
}

type Send = (type: 'duty/grant' | 'duty/revoke' | 'duty/renewed', payload: unknown) => void

/** The agent members of a set of groups — the unit a routing convergence is keyed on. */
function agentIdsOf(groups: readonly { members: DutyMemberKey[] }[]): string[] {
  return [...new Set(groups.flatMap((g) => g.members.filter((m) => m.kind === 'agent').map((m) => m.refId)))]
}

/** The freshness signal's source: the CP's current spec revision per agent. */
export interface AgentRevisionReader {
  configRevisions(agentIds: readonly AgentId[]): Promise<Map<string, bigint>>
}

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

/** One member's refusal state for one group: how many beats it has left the group out of its
 *  digest, and — once it gave the lease back — until when it must not re-take it. */
interface RefusalState {
  misses: number
  backoffUntilMs?: number
}

export class DutyLeaseService {
  private readonly bootedAtMs: number
  /** Per-daemon serialization lane: WS handlers dispatch without awaiting, so
   *  every ledger-touching operation for one daemon chains on one tail —
   *  overlapping beats must not double-spend headroom, and a release must never
   *  interleave with a running exchange (its ack has to mean "every grant sent
   *  before it is already on the wire, and nothing else was granted since"). */
  private readonly lanes = new Map<string, DaemonLane>()
  /** daemonId → groupId → refusal state. Per CP instance, which is exact rather than approximate:
   *  a member has one socket, so every beat and every grant for it lands on this process. */
  private readonly refusals = new Map<string, Map<string, RefusalState>>()

  constructor(
    private readonly repo: DutyGroupRepo,
    private readonly clock: Clock,
    private readonly config: DutyLeaseConfig = DUTY_LEASE_DEFAULTS,
    private readonly log?: { warn(obj: unknown, msg?: string): void },
    /** Absent ⇒ unstamped entries, and a member falls back to presence alone. */
    private readonly agentRevisions?: AgentRevisionReader,
    /** Re-converges the routing projections that bake in the serving daemon. A grant or a release
     *  moves who serves the agent, so the hook rules, HTTP-bot assignment and collaboration
     *  snapshot have to follow — otherwise the ledger heals and ingress keeps arriving at the
     *  member that lost it. Absent (tests / no pool) ⇒ no convergence, the pre-duty behavior. */
    private readonly routing?: { kick(agentIds: Iterable<string>): void }
  ) {
    this.bootedAtMs = clock.now()
  }

  /**
   * Stamp every agent member with the CP's current spec revision. Presence is not
   * freshness: a member that already holds an agent — installed under an earlier
   * duty it has since lost, then edited while it was not a delivery target — must
   * be able to tell a frozen replica from a current one and refetch only the
   * frozen ones. An agent with no row (deleted under the projection, or a
   * synthetic ref) is simply left unstamped.
   */
  private async stamp(entries: DutyGrantEntry[]): Promise<DutyGrantEntry[]> {
    if (!this.agentRevisions || entries.length === 0) return entries
    const agentIds = [
      ...new Set(entries.flatMap((e) => e.members.filter((m) => m.kind === 'agent').map((m) => m.refId)))
    ] as AgentId[]
    if (agentIds.length === 0) return entries
    const revisions = await this.agentRevisions.configRevisions(agentIds)
    return entries.map((entry) => ({
      ...entry,
      members: entry.members.map((member) => {
        const revision = member.kind === 'agent' ? revisions.get(member.refId) : undefined
        return revision === undefined ? member : { ...member, configRevision: revision.toString() }
      })
    }))
  }

  /**
   * Bound the cost of a group one member cannot install.
   *
   * A refused grant is invisible on the wire: the member simply never reports the group, so the
   * CP's missing-regrant path offers it back on the next beat — and `renewHeld` renews by holder
   * alone, so the lease never lapses either. Left alone, one member that cannot install an agent
   * holds its group for as long as it keeps beating, and no member that CAN install it is ever
   * offered the vacancy. The daemon's own per-agent failure stamp (#976) does not help: it paces
   * one member's fetches, it does not move the group.
   *
   * So the CP counts consecutive beats in which a held group is absent from the digest. An install
   * legitimately straddles one beat, which is why the threshold is above one rather than a single
   * miss. Past it the lease is handed back and the group enters a per-member backoff, so the next
   * claim reaches a different member and the rotation is bounded by member count rather than
   * unbounded in time. Reporting the group at any point clears the count — that is convergence.
   *
   * Deliberately only the MISSING case. A member that refused a replacement shrank the group and
   * still reports it at the old term (#977), so it is serving the shared part; taking that away
   * over a failing addition would cost service rather than move it. Its retry is the stale-term
   * re-issue, which costs nothing against headroom.
   *
   * Returns the missing groups still worth re-issuing to this member.
   */
  private async settleRefusals(
    daemonId: DaemonId,
    digestIds: ReadonlySet<string>,
    missing: DutyGroupRecord[]
  ): Promise<DutyGroupRecord[]> {
    const nowMs = this.clock.now()
    const states = this.refusals.get(daemonId) ?? new Map<string, RefusalState>()
    for (const [groupId, state] of states) {
      if (digestIds.has(groupId)) states.delete(groupId)
      else if (state.backoffUntilMs !== undefined && state.backoffUntilMs <= nowMs) states.delete(groupId)
    }

    const regrant: DutyGroupRecord[] = []
    const surrendered: string[] = []
    for (const group of missing) {
      const state = states.get(group.groupId) ?? { misses: 0 }
      // A group already in backoff cannot be missing-and-held at the same time (the release
      // vacated it), so reaching here means it was re-claimed elsewhere and lost again.
      state.misses += 1
      if (state.misses < this.config.refusalsBeforeRelease) {
        states.set(group.groupId, state)
        regrant.push(group)
        continue
      }
      states.set(group.groupId, { misses: 0, backoffUntilMs: nowMs + this.config.refusalBackoffMs })
      surrendered.push(group.groupId)
    }
    if (states.size > 0) this.refusals.set(daemonId, states)
    else this.refusals.delete(daemonId)

    if (surrendered.length > 0) {
      await this.repo.release(daemonId, surrendered)
      this.routing?.kick(agentIdsOf(missing.filter((g) => surrendered.includes(g.groupId))))
      this.log?.warn(
        { daemonId, groupIds: surrendered, beats: this.config.refusalsBeforeRelease },
        'duty groups were granted but never reported as held; lease handed back so another member can take them'
      )
    }
    return regrant
  }

  /** Groups this member gave back too recently to be offered again. */
  private backedOff(daemonId: DaemonId): string[] {
    const nowMs = this.clock.now()
    const states = this.refusals.get(daemonId)
    if (!states) return []
    return [...states].filter(([, s]) => s.backoffUntilMs !== undefined && s.backoffUntilMs > nowMs).map(([id]) => id)
  }

  /** Forget a departed member's refusal state — its lane is gone and so is its socket. */
  forget(daemonId: DaemonId): void {
    this.refusals.delete(daemonId)
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
   *  beat re-runs the whole idempotent diff anyway. NOT async: the lane is
   *  reserved synchronously, so the caller's dispatch order IS the lane order. */
  onHeartbeat(daemonId: DaemonId, duties: HeartbeatDuties, send: Send): Promise<void> {
    if ((this.lanes.get(daemonId)?.pending ?? 0) > 0) return Promise.resolve()
    return this.serialize(daemonId, () => this.exchange(daemonId, duties, send))
  }

  private async exchange(daemonId: DaemonId, duties: HeartbeatDuties, send: Send): Promise<void> {
    const now = new Date(this.clock.now())
    await this.repo.renewHeld(daemonId, now, this.config.leaseMs)
    const held = await this.repo.listHeldBy(daemonId)
    const heldById = new Map(held.map((g) => [g.groupId, g]))
    const digestIds = new Set(duties.held.map((d) => d.groupId))

    // The ADD side of routing convergence, and it belongs HERE rather than at the grant: a grant is
    // applied daemon-side only after its install succeeds (#972), so a group appearing in the
    // digest is the proof that the member is actually serving it. Publishing at grant time is the
    // same error #976 fixed for the fence — the gate opening before the fact — and on a pushed
    // projection it costs a message: relay ingress recovers through the rendezvous, but a
    // cross-daemon peer wake forwards ONCE and takes a terminal miss.
    //
    // `confirmHeld` only stamps unconfirmed rows, so this fires on the first beat that reports a
    // group and never again — no per-beat churn.
    const confirmed = await this.repo.confirmHeld(daemonId, [...digestIds], now)
    if (confirmed.length > 0) {
      const groups = held.filter((g) => confirmed.includes(g.groupId))
      this.routing?.kick(agentIdsOf(groups))
    }

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

    const regrant = await this.settleRefusals(daemonId, digestIds, deliverable(missing))

    let granted: DutyGrantRecord[] = []
    const budget = Math.max(0, duties.headroom - regrant.length)
    if (budget > 0 && this.clock.now() >= this.bootedAtMs + this.config.recoveryGraceMs) {
      // Oversized groups are excluded at the claim boundary (the size gate), so
      // a claim never lands on a group it would immediately have to release.
      // `scope` is install-wide because the heartbeat handler only reaches this service on an
      // org-less connection; it is passed rather than assumed so the gate stays a predicate.
      granted = await this.repo.claimVacant(
        daemonId,
        Math.min(budget, this.config.grantMaxPerTick),
        now,
        this.config.leaseMs,
        {
          scope: 'install-wide',
          maxMembers: DUTY_GRANT_MEMBERS_MAX,
          excludeGroupIds: this.backedOff(daemonId)
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
    const grants = await this.stamp([
      ...regrant.map(toGrantEntry),
      ...deliverable(stale).map(toGrantEntry),
      ...granted.map(toGrantEntry)
    ])
    for (const chunk of chunkGrants(grants, this.config.grantsPerFrame, this.config.grantMembersPerFrame)) {
      send('duty/grant', { grants: chunk })
    }
    for (let i = 0; i < revocations.length; i += this.config.revocationsPerFrame) {
      send('duty/revoke', { revocations: revocations.slice(i, i + this.config.revocationsPerFrame) })
    }
    // LAST, and the ordering is load-bearing. The member's self-fence anchors on receipt of this
    // frame, and the fence is global while renewal is per-group — so a delivered PREFIX of this
    // exchange must never extend the countdown without also carrying what invalidated the
    // member's holdings. Every digest entry `renewHeld` did not renew is answered above, in this
    // same exchange, by a revocation (or by a grant that re-took it), and one socket delivers in
    // order: "the confirmation arrived" therefore implies "everything that supersedes what I hold
    // arrived first". A truncated exchange simply leaves the fence running, which is the safe
    // direction, as does any throw before this line. Relative, never a timestamp — no shared clock.
    send('duty/renewed', { leaseMs: this.config.leaseMs })
  }

  /**
   * The activation rendezvous (design §4.4): claim one agent's home for a member
   * that was handed a trigger it does not serve. Serialized on the member's lane
   * like every other ledger touch, so a claim cannot interleave with its own
   * heartbeat exchange. Returns a grant the member can install verbatim, or the
   * incumbent it lost to. `scope` carries the claimant's connection scope into the same
   * eligibility gate the heartbeat claim uses: a trigger reaching the wrong member is not
   * authority to serve an agent that member may not hold.
   */
  async claimAgentHome(
    orgId: OrgId,
    agentId: AgentId,
    holder: DaemonId,
    scope: DutyClaimScope
  ): Promise<{ granted: boolean; grant?: DutyGrantEntry; holder?: string }> {
    return this.serialize(holder, async () => {
      const now = new Date(this.clock.now())
      const claim = await this.repo.claimAgentHome(orgId, agentId, holder, now, this.config.leaseMs, scope)
      if (!claim.granted || claim.groupId === undefined)
        return claim.holder ? { granted: false, holder: claim.holder } : { granted: false }
      const [group] = await this.repo.getByIds([claim.groupId])
      // An oversized group is undeliverable on this wire (§ member cap), so the
      // claim is handed straight back rather than wedged held-but-unserved.
      if (!group || group.members.length > DUTY_GRANT_MEMBERS_MAX) {
        await this.repo.release(holder, [claim.groupId])
        return { granted: false }
      }
      const [grant] = await this.stamp([toGrantEntry(group)])
      // No routing kick here: like every other grant this is not yet a fact — the claimant
      // installs before it answers, but the ledger has not seen the group in a digest. The
      // member's next beat confirms it and converges then.
      return { granted: true, grant }
    })
  }

  /** Does this member currently hold a duty covering the agent? The whole
   *  authorization story for `duty/fetch`. A pure read against the live lease
   *  horizon, so it deliberately skips the daemon's serialization lane — waiting
   *  behind a beat would only make the answer staler, never truer. */
  holdsAgent(holder: DaemonId, agentId: AgentId): Promise<boolean> {
    return this.repo.holdsAgent(holder, agentId, new Date(this.clock.now()))
  }

  /** The agents this member currently holds a duty for — the holder's-side twin of
   *  {@link DutyLeaseService.holdsAgent}, and the read behind "which agents does
   *  this daemon serve" (orchestrator/servedAgents.ts). Same live lease horizon. */
  heldAgentIds(holder: DaemonId, now: Date = new Date(this.clock.now())): Promise<AgentId[]> {
    return this.repo.heldAgentIds(holder, now)
  }

  /** Explicit drain release — vacate now instead of waiting out T_reassign.
   *  Queued behind any earlier beat's exchange (lane order = frame order), so
   *  every grant that exchange emitted reaches the daemon BEFORE this ack, and
   *  no grant can slip in between the vacate and the ack. */
  release(daemonId: DaemonId, groupIds: string[]): Promise<void> {
    return this.serialize(daemonId, async () => {
      // Read the membership BEFORE the vacate: `release` keeps the rows, but reading after would
      // race a successor's claim and converge for the wrong holder.
      const groups = await this.repo.getByIds(groupIds)
      await this.repo.release(daemonId, groupIds)
      this.routing?.kick(agentIdsOf(groups))
    })
  }
}
