// Duty grant admission, install, and convergence — the timing-critical half of the duty
// lease path, hoisted out of `Daemon` verbatim. Every await order and map write here is
// load-bearing: a reorder is a split brain or a preempted duty in production.
import type {
  DutyAgentBundle,
  DutyGrantEntry,
  DutyMemberRef,
  DutyRevoke,
  HeartbeatDuties
} from '@agentconnect.md/protocol'
import type { Clock, TimerHandle } from '@agentconnect.md/connection'
import type { Logger } from '../log.js'
import { formatErr } from '../daemon/text.js'
import type { Config } from '../config/config-schema.js'
import type { LoadedAgent } from '../agents/load-agents.js'
import type { ShutdownDutyDrain, TurnInterruptDisposition, TurnInterruptReason } from '../daemon/turn-types.js'
import type { CpClient } from './client.js'
import type { DutyRegistry, DutyApplyResult } from './duty-registry.js'
import type { CpAgentRegistry } from './cp-agent-registry.js'
import type { CpIntegrationRegistry } from './cp-integration-registry.js'
import type { CpCronRegistry } from './cp-cron.js'
import type { CpMemoryConnectionRegistry } from './memory-connection-registry.js'
import type { CpMcpDefs } from '../mcp/cp-mcp-defs.js'
import { RESERVED_MCP_SERVER_NAME } from '../mcp/resolve-servers.js'

// What an unbounded member reports as heartbeat headroom: the CP's own per-tick grant cap, so the
// wire carries a finite number without implying a ceiling. Never used for a local capacity decision.
const DUTY_UNBOUNDED_HEADROOM = 32
// Retry window for a failed duty install: the default heartbeat cadence, which is how fast the
// CP's missing-regrant path can offer the group back.
const DUTY_INSTALL_RETRY_MS = 15_000
// Backoff for retrying the platform convergence a duty change needs, when the reconcile that
// carries it throws. It doubles to a slow poll and never gives up: the state it exists to leave
// is a fenced agent whose sockets are still open.
const DUTY_CONVERGE_RETRY_BASE_MS = 1_000
const DUTY_CONVERGE_RETRY_CAP_MS = 30_000

/** Process-wide daemon state the duty path reads, plus the ledger it writes through. */
export interface DutyCoreHost {
  cfg(): Config
  log(): Logger
  clock(): Clock
  cpClient(): CpClient | undefined
  /** Duty leases this daemon holds (cp/duty-registry.ts). */
  duties(): DutyRegistry
  /** Latched for the whole drain handoff — a claim landing there installs nothing. */
  dutyClaimsSuspended(): boolean
  /** Set by stop() only: the sticky `draining` bit the digest carries. */
  shutdownDraining(): boolean
  draining(): boolean
  drainingAgents(): Set<string>
  shutdownDutyDrain(): ShutdownDutyDrain | undefined
}

/** The CP-owned in-memory definition registries a granted bundle lands in. */
export interface DutyRegistryHost {
  cpAgents(): CpAgentRegistry | undefined
  cpIntegrations(): CpIntegrationRegistry | undefined
  cpCrons(): CpCronRegistry | undefined
  cpMcpDefs(): CpMcpDefs | undefined
  memoryConnections(): CpMemoryConnectionRegistry | undefined
  onMcpDefsChanged(): void
  exactCpDependents(agentId: string, desired: { integrationIds: string[]; cronIds: string[] }): void
}

/** Move/removal fences and the per-agent lifecycle queue a duty install serializes against. */
export interface DutyGateHost {
  moveStagedAgents(): Set<string>
  agentRemovalPending(agentId: string): boolean
  queueAgentLifecycle<T>(agentId: string, work: () => Promise<T>): Promise<T>
}

/** The physical half of a duty change: connections, schedules, sandboxes, and parked work. */
export interface DutyConvergeHost {
  agents(): ReadonlyMap<string, LoadedAgent>
  reconcile(): Promise<void>
  flushReconcile(): Promise<void>
  /** The reconcile pass in flight, and whether another is already queued behind it. */
  reconcileRun(): Promise<void> | undefined
  reconcilePending(): boolean
  interruptAgentTurns(
    agentId: string,
    reason: TurnInterruptReason,
    disposition: TurnInterruptDisposition
  ): Promise<void>
  unregisterSchedule(agentId: string): void
  unregisterDreamSchedule(agentId: string): void
  stopHost(agentId: string): Promise<void>
  releaseClusterSandbox(agentId: string): void
  adoptClusterSandbox(agentId: string): void
  reclaimInterruptedWork(agentIds: readonly string[]): Promise<void>
  syncAgentSchedules(agent: LoadedAgent): Promise<void>
  syncOrchestrationDeadlines(): Promise<void>
  catchUpMissedSchedules(agentIds: string[]): Promise<void>
  drainSessionPurges(): Promise<void>
  replayGainedSessionMetadata(agentIds: readonly string[]): Promise<void>
  /** Inbox rows a newly-gained duty owes, replayed once convergence is idle. */
  pendingInboxReplayAgents(): Set<string>
}

/** Deadline primitives plus the in-flight-work reads the shutdown release waits on. */
export interface DutyDrainHost {
  raceDeadline(work: Promise<unknown>, ms: number): Promise<'done' | 'timeout'>
  sleepUntil(at: number): Promise<void>
  /** Admitted work an agent still owns: dispatch leases, pending ACP turns, cold gate entries, dreams. */
  activeDispatchCount(agentId: string): number
  pendingTurnAgentIds(): Iterable<string>
  activeGateAgentIds(): Iterable<string>
  dreamInFlight(agentId: string): boolean
}

/** Everything the duty coordinator touches on the `Daemon`. */
export interface DutyHost extends DutyCoreHost, DutyRegistryHost, DutyGateHost, DutyConvergeHost, DutyDrainHost {}

export class DutyCoordinator {
  // Claims in flight to the CP. Each reserves one slot of headroom so concurrent
  // rendezvous claims cannot read the same capacity and collectively overshoot,
  // and a drain joins them so none can settle after `drain/done`.
  private readonly inFlightDutyClaims = new Set<Promise<unknown>>()
  // Installs in flight per granted agent. The EVT path fires one and the
  // rendezvous claim awaits one for the SAME grant, so both must join a single
  // fetch+apply rather than race two of them.
  private readonly dutyInstalls = new Map<string, Promise<void>>()
  // Admissions in flight: groupId → the admission that owns it. Deadline tracking and every
  // withdrawal are synchronous while admission is deliberately not, so this mark is what lets a
  // withdrawal landing mid-admission win — and what tells the fence that a group absent from the
  // digest is still intended to be held.
  private readonly dutyAdmissions = new Map<string, number>()
  private dutyAdmissionSeq = 0
  // When each agent's install last failed. A dropped group is regranted on the
  // next beat, so without this a permanently failing agent would be re-fetched
  // once per regrant AND once per inbound trigger that claims its group.
  private readonly dutyInstallFailures = new Map<string, number>()
  // A duty change moves no agent FILE, so the agent diff is empty and platform convergence would
  // be skipped — while the serving gate it feeds (`transportAgents`) has just changed. Counters,
  // not a flag: a pass claims the requested value and publishes it only once the sockets are
  // actually converged, so neither a failed pass nor a duty change landing mid-pass is lost.
  private connectionsRequested = 0
  private connectionsConverged = 0
  private dutyConvergeRetryTimer?: TimerHandle

  constructor(private readonly host: DutyHost) {}

  private get log(): Logger {
    return this.host.log()
  }

  private get duties(): DutyRegistry {
    return this.host.duties()
  }

  /** Platform convergences duty changes have asked for, and how many have actually run. */
  get dutyConnectionsRequested(): number {
    return this.connectionsRequested
  }

  get dutyConnectionsConverged(): number {
    return this.connectionsConverged
  }

  set dutyConnectionsConverged(value: number) {
    this.connectionsConverged = value
  }

  /** Drop the convergence retry timer — the daemon's stop() owns the lifetime. */
  dispose(): void {
    if (this.dutyConvergeRetryTimer !== undefined) {
      this.host.clock().clearTimeout(this.dutyConvergeRetryTimer)
      this.dutyConvergeRetryTimer = undefined
    }
  }

  /** The heartbeat's lease fields: what this daemon holds, and how many more
   *  groups it will accept. Capacity is the daemon's own call (design D14). */
  dutyDigest(): HeartbeatDuties {
    // A draining member — shutting down, or mid rebalance drain — asks for nothing; only the
    // shutdown says so on the wire, because that bit is sticky for the registration at the CP.
    const headroom = this.host.dutyClaimsSuspended() || this.host.shutdownDraining() ? 0 : this.dutyHeadroom()
    return { held: this.duties.digest(), headroom, ...(this.host.shutdownDraining() ? { draining: true } : {}) }
  }

  /** How many more duty-covered agents this member will accept. `maxAgents: 0`
   *  means unbounded, reported as the CP's own per-tick grant cap. */
  dutyHeadroom(): number {
    const max = this.host.cfg()?.limits?.maxAgents ?? 0
    // `maxAgents: 0` is unbounded, but the WIRE still needs a finite number —
    // the CP caps a tick's grants at 32 anyway, so that is what an unbounded
    // member advertises. This sentinel is a batching hint, never a capacity.
    if (max <= 0) return DUTY_UNBOUNDED_HEADROOM
    return Math.max(0, max - this.duties.agents().size - this.inFlightDutyClaims.size)
  }

  /** Slots left for a claim that is ITSELF in flight — its own reservation is
   *  excluded, every other one still counts, and the result is deliberately not
   *  clamped: a full member must come out negative and refuse, never at zero
   *  with a slot to spare. Unbounded means unbounded here: a local fit decision
   *  must not inherit the heartbeat's batching sentinel and reject a group of
   *  33 agents from a member that was configured with no ceiling at all. */
  dutyHeadroomForPendingClaim(): number {
    const max = this.host.cfg()?.limits?.maxAgents ?? 0
    if (max <= 0) return Number.POSITIVE_INFINITY
    return max - this.duties.agents().size - Math.max(0, this.inFlightDutyClaims.size - 1)
  }

  /** True when duty leases gate service: a membership question, not an option (daemon-groups.md
   *  §3). A member of a member set — the install-wide pool or an organization's own — serves only
   *  what it holds a lease for; a daemon in no set owns its agents outright and never participates
   *  in the ledger. The set is what `auth/ok` announced, and nothing else stands in for it. */
  dutyEnforced(): boolean {
    // `cpClient` lands in start(); transportAgents can run before that in tests.
    return this.host.cpClient()?.memberSet?.() != null
  }

  /** `duty/grant` EVT: admit the grants off the frame-dispatch path, so a slow
   *  CP cannot stall the socket. */
  applyDutyGrant(grants: DutyGrantEntry[]): void {
    // A grant that wins after the shutdown latch — an exchange that began before the SIGTERM can
    // still commit one — is never installed, but the ledger records this exiting member as its
    // holder. One global rule, no per-case proof: record it, and acknowledge its release only once
    // the release loop is done with every held group — by then nothing is served here any more —
    // unless it covers an agent left to lapse. A small, bounded delay for those groups.
    const drain = this.host.shutdownDutyDrain()
    if (drain) {
      this.log.info(
        `duty: ${grants.length} grant(s) landed while shutting down — held unserved until the drain completes`
      )
      for (const grant of grants) drain.late.set(grant.groupId, grant)
      // Landed after the loop finished: settle them now rather than at the socket close.
      if (drain.loopDone) void this.settleLateGrants(drain)
      return
    }
    // A CP-commanded rebalance drain accepts no grant either: it would install a group the release
    // snapshot has already passed by. The CP re-issues on the next beat once the member reopens.
    if (this.host.dutyClaimsSuspended()) {
      this.log.info(`duty: ignoring ${grants.length} grant(s) while draining`)
      return
    }
    void this.admitDutyGrants(grants)
  }

  /**
   * Install first, open the serving gate second. Applying the grant is what
   * makes this member routable for its agents — the CP and the relay resolve
   * triggers to whoever holds the group — so a grant applied while its install
   * is still in flight advertises service the daemon cannot yet give, and a
   * trigger landing in that window is dropped without even being re-routable.
   *
   * A group whose install fails or comes back empty is therefore never applied
   * at all. The digest omits it, the CP sees a lease this member does not
   * report, and its existing missing-regrant path reissues it — that IS the
   * retry, paced by the heartbeat rather than a private loop. Nothing needs the
   * group present in the meantime: `renewHeld` renews by holder alone.
   *
   * Refusing a REPLACEMENT of a held group is not enough on its own: an addition is what failed,
   * yet the entry also carries removals, and keeping the old composition keeps serving agents the
   * CP has reassigned. So the removals are applied alone — the group shrinks to what both
   * compositions share, at the OLD term, which is what makes the CP's stale-term branch reissue
   * the whole replacement every beat until it installs.
   *
   * Returns the groupIds it refused — a failed install, or a withdrawal that landed while the
   * install was in flight.
   */
  async admitDutyGrants(entries: DutyGrantEntry[]): Promise<Set<string>> {
    const admission = ++this.dutyAdmissionSeq
    for (const entry of entries) this.dutyAdmissions.set(entry.groupId, admission)
    try {
      const failed = await this.installGrantedAgents(entries)
      // The withdrawal fence, checked with NO await between it and `applyGrant`. Admission is
      // deliberately async, so a fence, a revoke, or a drain release can land inside this window —
      // and each of them means "this member must not serve that group". A withdrawal drops the
      // group's admission mark, so the identity check below fails and the grant is never applied.
      // A newer admission for the same group replaces the mark for the same reason.
      const withdrawn = new Set(
        entries.filter((entry) => this.dutyAdmissions.get(entry.groupId) !== admission).map((e) => e.groupId)
      )
      const refused = new Set([...withdrawn, ...failed])
      const servable = entries.filter((entry) => !refused.has(entry.groupId))
      if (servable.length > 0) {
        const result = this.duties.applyGrant(servable)
        this.log.info(
          `duty: granted ${result.added.length} + re-granted ${result.updated.length} group(s); ` +
            `holding ${this.duties.size()} covering ${this.duties.agents().size} agent(s)`
        )
        await this.settleDutyChange(result)
      }
      // Same fence, same absence of an await: a group a withdrawal took away is not shrunk either,
      // because it is not ours to write any more — it was revoked outright, or a newer admission
      // owns it and will apply its own composition.
      const shrinking = entries.filter((entry) => failed.has(entry.groupId) && !withdrawn.has(entry.groupId))
      if (shrinking.length > 0) {
        const result = this.duties.shrinkToGrant(shrinking)
        if (result.updated.length > 0) {
          this.log.warn(
            `duty: refused ${shrinking.length} group(s) but applied their removals; ` +
              `${result.agentsLost.length} agent(s) left service, ${result.updated.length} group(s) shrunk`
          )
        }
        await this.settleDutyChange(result)
      }
      if (withdrawn.size > 0) {
        this.log.info(`duty: ${withdrawn.size} group(s) were withdrawn while being admitted — not held`)
      }
      return refused
    } finally {
      // Only ours to clear: a withdrawal already dropped it, and a newer admission owns it now.
      for (const entry of entries) {
        if (this.dutyAdmissions.get(entry.groupId) === admission) this.dutyAdmissions.delete(entry.groupId)
      }
    }
  }

  /** Settle what a registry write changed: an agent that left every held group stops being served
   *  through the revoke teardown (#948 — workspace, sessions and registry entry survive), and any
   *  change at all re-derives the physical half, since `transportAgents` gates sockets and direct
   *  ingress is never re-checked per message. */
  async settleDutyChange(result: DutyApplyResult): Promise<void> {
    for (const agentId of result.agentsLost) this.stopServingAgent(agentId)
    for (const agentId of result.agentsGained) this.host.adoptClusterSandbox(agentId)
    await this.host.reclaimInterruptedWork(result.agentsGained)
    // A duty newly held here replays that agent's shared inbox backlog even when its replica was
    // already installed and the grant fetched nothing (#1034): a crashed holder's admitted rows
    // must run on the successor. Drained by the reconcile below, once its connections converge.
    for (const agentId of result.agentsGained) this.host.pendingInboxReplayAgents().add(agentId)
    const changed = result.added.length + result.updated.length + result.agentsGained.length + result.agentsLost.length
    if (changed === 0) return
    // Report the new digest immediately. The CP publishes the projections that address this member
    // only once it has SEEN the group held (the grant alone is not proof of an install), so waiting
    // for the next tick leaves an agent this member is already serving unroutable for up to a
    // heartbeat. Outside the duty gate below on purpose: the CP acts on the digest either way.
    this.host.cpClient()?.reportDutiesNow()
    await this.onDutyChanged()
    // After the arm, so a catch-up runs against the schedules this member now actually holds.
    await this.host.catchUpMissedSchedules(result.agentsGained)
    // The purge-receipt drain is holder-scoped, so a receipt a prior holder left is owed by this member now.
    if (result.agentsGained.length) void this.host.drainSessionPurges()
    // Same for the session-metadata outbox: a snapshot the previous holder parked is this member's to emit.
    await this.host.replayGainedSessionMetadata(result.agentsGained)
  }

  /**
   * Withdraw these groups from service — a fence, a `duty/revoke`, or a drain release. Every one of
   * them means the same thing, so they share one guard: a withdrawal that lands while an admission
   * is in flight WINS, and that admission refuses to apply when it completes. Without this the group
   * sits in a gap between grant receipt and `applyGrant` — not yet held, so nothing to withdraw —
   * and then starts serving after the withdrawal that was meant to stop it.
   *
   * Returns the groups that were pending, for the caller's log; the retry story is unchanged, since
   * the CP still leases them, does not see them in our digest, and reissues through missing-regrant.
   */
  withdrawDutyGroups(groupIds: Iterable<string>): string[] {
    const pending: string[] = []
    for (const groupId of groupIds) if (this.dutyAdmissions.delete(groupId)) pending.push(groupId)
    return pending
  }

  /** Groups whose admission is in flight: intended to be held, absent from the digest until applied. */
  pendingDutyAdmissions(): string[] {
    return [...this.dutyAdmissions.keys()]
  }

  /**
   * Install every agent these grants cover that this daemon does not already have
   * AT THE GRANTED REVISION. Grants are thin by design, so the member pulls
   * exactly what it lacks or what has moved on (`duty/fetch`) and applies the
   * bundle the way an activation would — minus the move token, the staging fence,
   * and workspace preparation.
   *
   * Returns the granted groups it could NOT install. A group is served as a
   * unit, so its bots wait on its agents too — that is the point, not a cost.
   */
  async installGrantedAgents(entries: DutyGrantEntry[]): Promise<Set<string>> {
    const wanted = new Map<string, { orgId: string; groupId: string }>()
    for (const entry of entries) {
      for (const member of entry.members) {
        if (member.kind !== 'agent' || !this.dutyBundleIsStale(member)) continue
        // A duty grant must never resurrect an agent a move or removal is tearing down.
        if (this.host.moveStagedAgents().has(member.refId) || this.host.agentRemovalPending(member.refId)) continue
        wanted.set(member.refId, { orgId: entry.orgId, groupId: entry.groupId })
      }
    }
    const failed = new Set<string>()
    // Registered synchronously, then joined: a concurrent caller for the same
    // grant finds every in-flight install rather than starting a second one.
    const installs = [...wanted].map(async ([agentId, { orgId, groupId }]) => {
      try {
        await this.installDutyAgent(agentId, orgId)
      } catch (err) {
        this.log.warn(`duty: installing granted agent ${agentId} failed: ${err}`)
        // The whole group goes: an entry may cover several agents, and a member
        // missing one of them cannot serve that group's work.
        failed.add(groupId)
      }
    })
    await Promise.all(installs)
    return failed
  }

  /**
   * Does this granted agent need a (re)fetch? Presence is not freshness: an agent
   * this member installed under a duty it later lost keeps its replica (#948 — a
   * release is never a removal) while the CP goes on editing a spec this member is
   * no longer a delivery target for. A regrant that skipped on presence alone
   * would serve that frozen bundle forever. So the grant carries the CP's current
   * `configRevision` and it is compared against the applied one — the same fence
   * the install itself re-applies, never a second notion of freshness. Unstamped
   * (an older CP, a bot member's group) falls back to presence.
   */
  dutyBundleIsStale(member: DutyMemberRef): boolean {
    if (!this.host.cpAgents()?.has(member.refId)) return true
    if (member.configRevision === undefined) return false
    const applied = this.host.cpAgents()?.appliedRevision(member.refId)
    return applied === undefined || BigInt(member.configRevision) > applied
  }

  /** Join the in-flight install for this agent, or start one. A failure is
   *  remembered for one heartbeat cadence so a permanently broken agent cannot
   *  make regrants spin faster than the beat that produces them. */
  installDutyAgent(agentId: string, orgId: string): Promise<void> {
    const inFlight = this.dutyInstalls.get(agentId)
    if (inFlight) return inFlight
    const failedAt = this.dutyInstallFailures.get(agentId)
    if (failedAt !== undefined && this.host.clock().now() - failedAt < DUTY_INSTALL_RETRY_MS) {
      return Promise.reject(new Error('a previous install failed within the retry window'))
    }
    const run = this.runDutyAgentInstall(agentId, orgId)
      .then(
        () => void this.dutyInstallFailures.delete(agentId),
        (err) => {
          this.dutyInstallFailures.set(agentId, this.host.clock().now())
          throw err
        }
      )
      .finally(() => {
        if (this.dutyInstalls.get(agentId) === run) this.dutyInstalls.delete(agentId)
      })
    this.dutyInstalls.set(agentId, run)
    return run
  }

  /** Fetch and apply one granted agent's bundle inside its lifecycle lane, so it
   *  serializes against upsert/remove/activate like every other lifecycle write. */
  async runDutyAgentInstall(agentId: string, orgId: string): Promise<void> {
    const reply = await this.host.cpClient()?.fetchDutyAgent(agentId, orgId)
    const bundle = reply?.bundle
    // An absent bundle is the CP saying "you do not hold this duty, or the agent
    // is gone" — the strongest signal of all that our local state disagrees with
    // the ledger. Refuse the group rather than hold one we cannot serve.
    if (!bundle) throw new Error('the control plane returned no bundle for this agent')
    await this.host.queueAgentLifecycle(agentId, async () => {
      if (this.host.moveStagedAgents().has(agentId) || this.host.agentRemovalPending(agentId)) {
        this.log.info(`duty: skipping install of ${agentId} — a move or removal owns it`)
        return
      }
      if (!this.host.cpAgents()) return
      // Definitions BEFORE the spec that names them, same order as the reconnect
      // snapshot: an AgentSpec carries MCP server names and a memory connection id,
      // and static memory admission must never observe the agent before at least a
      // probing (fail-closed) connection entry exists. Applied unconditionally of
      // the revision fence below — they are separate registries with their own
      // fences, and a skipped spec still leaves a replica referencing them.
      this.applyDutyDefinitions(bundle)
      // The revision fence is the target's own (organization-secrets-and-variables.md
      // §7): a bundle older than what we already applied never overwrites it.
      const applied = this.host.cpAgents()?.upsert(agentId, bundle.spec)
      if (applied === 'stale' || applied === 'conflict') {
        this.log.warn(`duty: install of ${agentId} skipped — spec revision is ${applied}`)
        return
      }
      for (const integration of bundle.integrations) this.host.cpIntegrations()?.upsert(integration)
      for (const cron of bundle.crons) this.host.cpCrons()?.upsert(cron)
      this.host.exactCpDependents(agentId, {
        integrationIds: bundle.integrations.map((integration) => integration.integrationId),
        cronIds: bundle.crons.map((cron) => cron.cronId)
      })
      await this.host.flushReconcile()
      this.log.info(
        `duty: installed granted agent ${agentId} (${bundle.integrations.length} integration(s), ` +
          `${(bundle.mcpServers ?? []).length} MCP def(s), ${(bundle.memoryConnections ?? []).length} memory connection(s))`
      )
    })
  }

  /**
   * Install the two definition kinds the granted agent's spec only NAMES. Additive
   * (`upsert`, never `converge`): this member may already serve other agents whose
   * definitions the bundle does not mention, and a duty install is never a
   * full-replace of a tenant registry. An older CP omits both arrays.
   *
   * NEVER log the defs — an MCP proxy def's headers carry the bearer grant key and
   * a memory def carries its grant plus secret leases.
   */
  applyDutyDefinitions(bundle: DutyAgentBundle): void {
    for (const spec of bundle.memoryConnections ?? []) this.host.memoryConnections()?.upsert(spec)
    let mcpChanged = false
    for (const { orgId, name, issuedAt, ...def } of bundle.mcpServers ?? []) {
      if (!orgId || name === RESERVED_MCP_SERVER_NAME) continue
      // Same monotonic fence as the live push: a bundle projected before a grant
      // rotation must never overwrite the fresh key it raced.
      if (this.host.cpMcpDefs()?.upsert(orgId, name, def, issuedAt)) mcpChanged = true
    }
    if (mcpChanged) this.host.onMcpDefsChanged()
  }

  /** Apply a `duty/revoke` EVT. Losing a duty is NOT a removal: the agent's
   *  workspace, sessions, and registry entry all survive — only the platform
   *  connections and schedules this daemon was running for it stop. */
  async applyDutyRevoke(revocations: DutyRevoke['revocations']): Promise<void> {
    // Same guard as the fence: a revoke landing while the group is still being admitted must stop
    // that admission, or the member starts serving a group the CP has already taken away.
    const pending = this.withdrawDutyGroups(revocations.map((revocation) => revocation.groupId))
    if (pending.length > 0) this.log.info(`duty: revoked ${pending.length} group(s) mid-admission`)
    const result = this.duties.applyRevoke(revocations)
    this.log.info(
      `duty: revoked ${revocations.length} group(s) (${revocations.map((r) => r.reason).join(',')}); ` +
        `${result.agentsLost.length} agent(s) left service`
    )
    for (const agentId of result.agentsLost) this.stopServingAgent(agentId)
    await this.onDutyChanged()
  }

  // The duty self-fence (`T_reassign > T_fence`): stop serving these groups before the CP can hand them to a
  // successor. Per group, because the CP expires each lease on its own schedule — a group whose lease is still
  // honoured keeps serving. Literally a local `duty/revoke`: same registry path, same teardown, so workspace,
  // sessions, and the registry entry all survive it (#948), and the omitted groups are what the CP's
  // missing-regrant path reissues on reconnect.
  async fenceDuties(groupIds: string[]): Promise<void> {
    // Not duty-governed (an org-scoped daemon) ⇒ a teardown would drop live traffic for no reason.
    if (!this.dutyEnforced()) return
    // BEFORE the held filter: a group still being admitted is not held yet, so there would be
    // nothing to shed — and it would start serving the moment its admission completed.
    const pending = this.withdrawDutyGroups(groupIds)
    if (pending.length > 0) this.log.warn(`duty: self-fenced ${pending.length} group(s) mid-admission`)
    const held = groupIds.filter((groupId) => this.duties.get(groupId) !== undefined)
    if (held.length === 0) return
    const result = this.duties.applyRevoke(held.map((groupId) => ({ groupId, reason: 'superseded' as const })))
    this.log.warn(
      `duty: self-fenced ${held.length} group(s); ${result.agentsLost.length} agent(s) left service, ` +
        `${this.duties.size()} group(s) still held — no confirmed lease renewal before the CP's horizon`
    )
    for (const agentId of result.agentsLost) this.stopServingAgent(agentId)
    await this.onDutyChanged()
  }

  /** Claim one agent's duty because a trigger for it arrived here. A win is
   *  installed exactly like a `duty/grant`, so the same converge path runs.
   *  Refuses without asking the CP when this member must not take new work:
   *  capacity is the member's own call (design D14), and a drain in progress
   *  would either hand the fresh lease straight back or pin it to an agent whose
   *  gate is about to drop the very turn that triggered the claim.
   *
   *  Both gates are checked AFTER the round trip, not instead of it. Refusing to
   *  ask would suppress the very answer that makes a stale delivery routable —
   *  the incumbent's identity — turning a re-routable trigger into a drop. So a
   *  full or draining member still asks, and hands back anything it wins. */
  async claimDutyForTrigger(agentId: string): Promise<{ granted: boolean; holder?: string }> {
    // A drain that has already begun is the one case worth short-circuiting: it
    // cannot be resolved by learning a holder, because this member is leaving.
    if (this.host.dutyClaimsSuspended() || this.host.drainingAgents().has(agentId)) {
      this.log.debug(`duty: not claiming ${agentId} while draining`)
      return { granted: false }
    }
    // Reserve a slot for the duration of the round trip so concurrent claims
    // cannot each read the same headroom and collectively overshoot, and so a
    // drain can join this claim rather than finish while it is still in flight.
    let markSettled!: () => void
    const settled = new Promise<void>((resolve) => {
      markSettled = resolve
    })
    this.inFlightDutyClaims.add(settled)
    try {
      const claim = await this.host.cpClient()?.claimDuty(agentId)
      if (!claim) return { granted: false }
      if (!claim.granted || !claim.grant) {
        return claim.holder ? { granted: false, holder: claim.holder } : { granted: false }
      }
      const grant = claim.grant
      // The group we were actually given may cover several agents, so capacity
      // is judged against it — never against the single agent we asked about.
      const arriving = grant.members.filter((m) => m.kind === 'agent' && !this.duties.holdsAgent(m.refId)).length
      const draining =
        this.host.dutyClaimsSuspended() || this.host.draining() || this.host.drainingAgents().has(agentId)
      if (draining || arriving > this.dutyHeadroomForPendingClaim()) {
        const why = draining ? 'a drain started while the claim was in flight' : 'it does not fit remaining capacity'
        this.log.info(`duty: handing ${grant.groupId} straight back — ${why}`)
        await this.host
          .cpClient()
          ?.releaseDuties([grant.groupId])
          .catch((err) => this.log.warn(`duty: handing back ${grant.groupId} failed (it will lapse): ${err}`))
        return { granted: false }
      }
      // Dispatch follows immediately, so install, hold, and connect the agent before answering `granted`.
      const failed = await this.admitDutyGrants([grant])
      // Never applied, so the answer and local duty state agree.
      if (failed.has(grant.groupId)) {
        this.log.warn(`duty: claimed ${grant.groupId} but could not install ${agentId} — handing the trigger back`)
        return { granted: false }
      }
      try {
        await this.host.flushReconcile()
      } catch (err) {
        this.log.warn(
          `duty: claimed ${grant.groupId} but its connections did not converge — withdrawing locally and ` +
            `letting the lease lapse: ${formatErr(err)}`
        )
        await this.applyDutyRevoke([{ groupId: grant.groupId, reason: 'superseded' }])
        return { granted: false }
      }
      return { granted: true }
    } catch (err) {
      // A CP blip must not look like "someone else holds it" — answering with no
      // holder makes the router account it as an unplaceable trigger rather than
      // re-routing into the void.
      this.log.warn(`duty: claiming ${agentId} for an inbound trigger failed: ${err}`)
      return { granted: false }
    } finally {
      this.inFlightDutyClaims.delete(settled)
      markSettled()
    }
  }

  /** Wait for every claim already awaiting the CP to settle. Called inside the
   *  drain latch, so each one sees the latch and hands back what it won —
   *  without this join a drain can finish and clear the latch while an older
   *  response is still in flight, installing a grant after `drain/done`. */
  async joinInFlightDutyClaims(): Promise<void> {
    while (this.inFlightDutyClaims.size > 0) {
      await Promise.allSettled([...this.inFlightDutyClaims])
    }
  }

  /** Re-derive platform connections and schedules from the new duty set. The physical
   *  half is not optional: `transportAgents` gates which agents get sockets, and direct
   *  ingress has no per-message duty check, so a group this member stopped serving keeps
   *  receiving platform traffic until its connection is actually closed. */
  async onDutyChanged(): Promise<void> {
    if (!this.dutyEnforced()) return
    // Register the convergence in the caller's own tick: the schedule syncs below await the
    // store, and a drain that snapshots `connectionsRequested` in between would read this
    // duty change as already converged.
    this.connectionsRequested++
    this.convergeDutyConnections()
    for (const agent of this.host.agents().values()) await this.host.syncAgentSchedules(agent)
    await this.host.syncOrchestrationDeadlines()
  }

  /** Reconcile until the duty-driven convergence has actually run. A pass that throws (a workspace
   *  authority conflict, a host teardown, a platform close) leaves the request outstanding, and a
   *  fence still holding its sockets open is the one state this must never settle in — so it
   *  retries, backing off to a slow poll rather than giving up. Any other reconcile trigger
   *  satisfies the same outstanding request and stops the loop. */
  convergeDutyConnections(delayMs = DUTY_CONVERGE_RETRY_BASE_MS): void {
    void this.host.reconcile().catch((err) => {
      this.log.warn(`duty: reconcile after a duty change failed: ${formatErr(err)}`)
      if (this.host.draining() || this.connectionsRequested === this.connectionsConverged) return
      this.log.warn(`duty: retrying platform convergence in ${delayMs}ms — a fenced agent may still be served`)
      if (this.dutyConvergeRetryTimer !== undefined) this.host.clock().clearTimeout(this.dutyConvergeRetryTimer)
      this.dutyConvergeRetryTimer = this.host.clock().setTimeout(() => {
        this.dutyConvergeRetryTimer = undefined
        if (this.connectionsRequested === this.connectionsConverged) return
        this.convergeDutyConnections(Math.min(delayMs * 2, DUTY_CONVERGE_RETRY_CAP_MS))
      }, delayMs)
    })
  }

  /** Stop serving one agent because its duty moved — the light teardown: no
   *  workspace deletion, no removal tombstone, no CP-drop latch, so a re-grant
   *  needs nothing from the CP to revive it. */
  stopServingAgent(agentId: string): void {
    void this.stopServingAgentSettled(agentId).catch((err) =>
      this.log.warn(`duty: stopping host for ${agentId} failed: ${err}`)
    )
  }

  // Host teardown per agent, observable by every duty path: the fire-and-forget wrapper and the
  // settled variant both register here, and a later caller chains behind whatever is pending — a
  // stop that FAILED stays recorded, so no path can later read that agent as torn down.
  private readonly dutyHostStops = new Map<string, Promise<void>>()

  /** The teardown still settling for this agent, if any — what the sandbox adoption chains behind. */
  dutyHostStop(agentId: string): Promise<void> | undefined {
    return this.dutyHostStops.get(agentId)
  }

  /** The same light teardown, resolving once the agent's host is actually down — what the shutdown
   *  release awaits before it lets a successor bind the agent's sandbox. Rejects when the host stop
   *  failed (now, or in a still-recorded earlier attempt): the child may still be alive, so "no
   *  longer served here" cannot be claimed. Immediate when no host exists. */
  async stopServingAgentSettled(agentId: string): Promise<void> {
    if (!this.dutyEnforced()) return Promise.resolve()
    // A handoff, never a removal (#948): the turns stop here, but their admitted-but-unrun rows
    // stay for whoever holds the duty next. Only a duty-governed member reaches this line, so a
    // single daemon's terminal-purge semantics are untouched. `handover`, not `stop`: an outcome
    // reported for a killed turn must not read as a user's verdict on the work.
    await this.host.interruptAgentTurns(agentId, 'handover', 'handoff')
    this.host.unregisterSchedule(agentId)
    this.host.unregisterDreamSchedule(agentId)
    const prior = this.dutyHostStops.get(agentId) ?? Promise.resolve()
    // Behind a FAILED earlier stop the host is still stopped (a later host must not leak), but the
    // failure keeps propagating: that agent stays unconfirmed for the rest of this process.
    const stop: Promise<void> = prior.then(
      () => this.host.stopHost(agentId).finally(() => this.host.releaseClusterSandbox(agentId)),
      (err: unknown) =>
        this.host
          .stopHost(agentId)
          .finally(() => this.host.releaseClusterSandbox(agentId))
          .then(() => {
            throw err
          })
    )
    this.dutyHostStops.set(agentId, stop)
    void stop.then(
      () => {
        if (this.dutyHostStops.get(agentId) === stop) this.dutyHostStops.delete(agentId)
      },
      () => undefined
    )
    return stop
  }

  /** Prove a set of agents is no longer served here — hosts stopped, and the platform convergence
   *  up to `target` run — within the deadline. Returns why not, or undefined when confirmed. */
  async confirmDutyTeardown(agentIds: string[], target: number, deadlineAt: number): Promise<string | undefined> {
    let stopsFailed: unknown
    const stops = Promise.all(agentIds.map((agentId) => this.stopServingAgentSettled(agentId))).catch((err) => {
      stopsFailed = err
    })
    if ((await this.host.raceDeadline(stops, deadlineAt - this.host.clock().now())) === 'timeout')
      return 'host stop unfinished at the drain deadline'
    if (stopsFailed !== undefined) return `host stop failed: ${stopsFailed}`
    if (!(await this.awaitDutyConvergence(target, deadlineAt)))
      return 'connection teardown unconfirmed at the drain deadline'
    return undefined
  }

  /** Hand every held duty back to the CP. Best-effort by contract — on failure
   *  the leases simply lapse, which is the same outcome one T_reassign later. */
  async releaseAllDuties(): Promise<void> {
    // Join first: a claim still awaiting the CP would otherwise land after the
    // snapshot below and outlive the drain.
    await this.joinInFlightDutyClaims()
    // A grant EVT can still be mid-admission here — the claim join covers the rendezvous path only.
    // Withdraw those too, so nothing installs itself back into service after `drain/done`.
    const pending = this.withdrawDutyGroups(this.pendingDutyAdmissions())
    if (pending.length > 0) this.log.info(`duty: dropped ${pending.length} group(s) still being admitted on drain`)
    const groupIds = this.duties.releaseAll()
    if (groupIds.length === 0) return
    try {
      await this.host.cpClient()?.releaseDuties(groupIds)
      this.log.info(`duty: released ${groupIds.length} group(s) on drain`)
    } catch (err) {
      this.log.warn(`duty: releasing ${groupIds.length} group(s) failed (leases will lapse): ${err}`)
    }
  }

  /** Does any agent of this group still own admitted work — an active dispatch lease, a pending
   *  ACP turn, or a cold dispatch still initializing? The predicate the shutdown release waits on. */
  dutyGroupBusy(groupId: string): boolean {
    const held = this.duties.get(groupId)
    if (!held) return false
    for (const agentId of held.agentIds) {
      if (this.host.activeDispatchCount(agentId) > 0) return true
      for (const pendingAgentId of this.host.pendingTurnAgentIds()) if (pendingAgentId === agentId) return true
      for (const gateAgentId of this.host.activeGateAgentIds()) if (gateAgentId === agentId) return true
      // A dream in flight is an in-flight job: its host and staging are on the sandbox this member holds.
      if (this.host.dreamInFlight(agentId)) return true
    }
    return false
  }

  /**
   * SIGTERM on a duty-holding member: hand every held group back with an ACKNOWLEDGED
   * `duty/release`, one group at a time, as soon as that group is idle — never cancelling a turn
   * to move faster. A group whose agents are all idle goes at once (its successor claims it on
   * the next beat while this member is still waiting on a busier group); a busy group goes when
   * its last turn settles, or when the drain deadline has cancelled it. A release is sent only
   * after the group's physical service here is gone — hosts stopped, platform connections
   * converged — so a successor never binds a sandbox or a socket this member still holds. Past
   * `deadlineAt`, or if that teardown cannot be confirmed, the group is NOT released: it is left
   * to lapse at T_reassign, the pre-existing takeover path and the honest answer when "no longer
   * served here" cannot be proven.
   */
  async releaseDutiesForShutdown(drain: ShutdownDutyDrain): Promise<void> {
    if (!this.dutyEnforced()) return
    const startedAt = this.host.clock().now()
    const { deadlineAt, stats } = drain
    // Join first: a claim still awaiting the CP would otherwise land after the last release.
    await this.joinInFlightDutyClaims()
    const pending = this.withdrawDutyGroups(this.pendingDutyAdmissions())
    if (pending.length > 0) this.log.info(`duty: dropped ${pending.length} group(s) still being admitted on shutdown`)
    for (;;) {
      const remaining = this.duties.groupIds()
      if (remaining.length === 0) break
      const forced = this.host.clock().now() >= deadlineAt
      const ready = forced ? remaining : remaining.filter((groupId) => !this.dutyGroupBusy(groupId))
      for (const groupId of ready) {
        // Withdraw locally first — the same teardown a revoke runs — and wait for it to be real.
        const held = this.duties.get(groupId)
        const result = this.duties.applyRevoke([{ groupId, reason: 'superseded' }])
        stats.groups++
        stats.agents += result.agentsLost.length
        await this.onDutyChanged()
        const why = await this.confirmDutyTeardown(held?.agentIds ?? [], this.connectionsRequested, deadlineAt)
        if (why !== undefined) {
          stats.lapsing++
          for (const agentId of held?.agentIds ?? []) drain.lapsedAgents.add(agentId)
          this.log.warn(`duty: ${groupId} may still be served here — not released, its lease lapses (${why})`)
          continue
        }
        if (await this.releaseDutyAcknowledged(groupId, deadlineAt)) stats.acked++
        else stats.lapsing++
      }
      if (forced) break
      if (ready.length === 0) {
        this.log.info(
          `duty: ${remaining.length} held group(s) still have turns in flight — releasing each as it settles`
        )
        await this.host.sleepUntil(Math.min(this.host.clock().now() + 1_000, deadlineAt))
      }
    }
    drain.loopDone = true
    await this.settleLateGrants(drain)
    if (stats.groups === 0 && stats.late === 0) return
    this.log.info(
      `duty: shutdown drain released ${stats.groups} group(s) covering ${stats.agents} agent(s) ` +
        `plus ${stats.late} late grant(s) in ${Math.round((this.host.clock().now() - startedAt) / 1000)}s — ` +
        `${stats.acked} acknowledged, ${stats.lapsing} left to lapse`
    )
  }

  /** Grants that landed after the latch, settled once the release loop is done: every held group has
   *  been withdrawn and torn down, or left to lapse, so nothing is served here any more. Each late
   *  grant is released acknowledged unless it covers an agent of a lapsing group or one whose host
   *  stop is still recorded as pending or failed — then it lapses too. Serialized, so a second call
   *  (a grant landing between the loop and the socket close) waits for the first. */
  private lateGrantSettling: Promise<void> = Promise.resolve()
  settleLateGrants(drain: ShutdownDutyDrain): Promise<void> {
    const run = this.lateGrantSettling.then(async () => {
      const { deadlineAt, stats } = drain
      if (drain.late.size === 0) return
      // One global proof for the whole batch: the platform convergence every duty change so far
      // requested has run — a group revoked or fenced just before the SIGTERM never entered the
      // loop, and only this closes the socket that revoke opened the teardown for. Unconfirmed
      // (deadline, or the reconcile gave up) ⇒ every late grant lapses.
      const converged = await this.awaitDutyConvergence(this.connectionsRequested, deadlineAt)
      while (drain.late.size > 0) {
        const [groupId, grant] = drain.late.entries().next().value as [string, DutyGrantEntry]
        drain.late.delete(groupId)
        stats.late++
        if (!converged) {
          stats.lapsing++
          this.log.warn(`duty: late grant ${groupId} — connection teardown unconfirmed, not released, its lease lapses`)
          continue
        }
        const agentIds = grant.members.filter((m) => m.kind === 'agent').map((m) => m.refId)
        // A stop still in flight is given until the deadline; a failed one stays recorded.
        for (const agentId of agentIds) {
          const stop = this.dutyHostStops.get(agentId)
          if (stop)
            await this.host.raceDeadline(
              stop.catch(() => undefined),
              deadlineAt - this.host.clock().now()
            )
        }
        const blocked = agentIds.find((agentId) => drain.lapsedAgents.has(agentId) || this.dutyHostStops.has(agentId))
        if (blocked !== undefined) {
          stats.lapsing++
          this.log.warn(
            `duty: late grant ${groupId} covers agent ${blocked}, whose teardown is unconfirmed — not released, its lease lapses`
          )
          continue
        }
        if (await this.releaseDutyAcknowledged(groupId, deadlineAt)) stats.acked++
        else stats.lapsing++
      }
    })
    this.lateGrantSettling = run.catch(() => undefined)
    return run
  }

  /** Wait until the platform convergence a duty change requested has run — `dutyConnectionsConverged`
   *  reaching `target` — or the deadline passes, or the reconcile carrying it gave up (a pass that
   *  throws is not retried while draining). True only when convergence is confirmed. */
  async awaitDutyConvergence(target: number, deadlineAt: number): Promise<boolean> {
    while (this.connectionsConverged < target) {
      const remainingMs = deadlineAt - this.host.clock().now()
      if (remainingMs <= 0) return false
      const run = this.host.reconcileRun()
      if (run) {
        if (
          (await this.host.raceDeadline(
            run.catch(() => undefined),
            remainingMs
          )) === 'timeout'
        )
          return false
      } else if (this.host.reconcilePending()) {
        await this.host.sleepUntil(this.host.clock().now() + 20)
      } else {
        return false
      }
    }
    return true
  }

  /** One `duty/release`, retried with backoff until acknowledged or the drain deadline passes. */
  async releaseDutyAcknowledged(groupId: string, deadlineAt: number): Promise<boolean> {
    let backoffMs = 1_000
    for (;;) {
      try {
        const release = this.host.cpClient()!.releaseDuties([groupId])
        const outcome = await this.host.raceDeadline(release, deadlineAt - this.host.clock().now())
        release.catch(() => undefined)
        if (outcome === 'timeout') throw new Error('no acknowledgement before the drain deadline')
        return true
      } catch (err) {
        if (this.host.clock().now() + backoffMs >= deadlineAt) {
          this.log.warn(`duty: releasing ${groupId} was not acknowledged before the drain deadline: ${err}`)
          return false
        }
        this.log.warn(`duty: releasing ${groupId} failed, retrying in ${backoffMs}ms: ${err}`)
        await this.host.sleepUntil(this.host.clock().now() + backoffMs)
        backoffMs = Math.min(backoffMs * 2, 5_000)
      }
    }
  }
}
