import { noopClusterMetrics, type LaunchTimer, type ClusterMetrics } from '../metrics/cluster-metrics.js'
import { systemClock, type Clock } from '@agentconnect.md/connection'
import type { SpawnDriver, SpawnRequest, SpawnedRuntime } from '../acp/spawn-driver.js'
import type { ShimCapability } from '../shim/protocol.js'
import type { ShimConnection } from '../shim/connection.js'
import type { ShimSession } from '../shim/session.js'
import type { SpawnRecord } from '../shim/binding.js'
import { isSandboxReady, type OperatingMode, type SandboxClaim, type SandboxApi } from './sandbox-api.js'
import { SandboxLease } from './sandbox-lease.js'
import { LaunchRegistry, type LaunchGenerations } from '../remote/launch-registry.js'
import { ChannelBinder } from '../remote/channel-binder.js'
import { RemoteShimDriver } from '../remote/shim-driver.js'
import { sandboxEndpointProvider, type SandboxLaunch } from './endpoint-provider.js'
import type { SandboxReadiness } from '../remote/channel-loss-watcher.js'
import { withStartupPhase } from '../session/startup-progress.js'
import { awaitBoundSandbox, awaitReady, readIfPresent, type SandboxWaitDeps } from './sandbox-waits.js'
import {
  AC_ANNOTATION_ADMITTED,
  AC_LABEL_AGENT,
  AC_LABEL_SESSION,
  RUNTIME_GRANTS,
  agentSandboxSubject,
  resolvePodIp,
  sandboxClaimName,
  sandboxPodLabels,
  sandboxSubjectAgentId,
  sandboxSubjectSessionLeaf,
  sessionSandboxSubject,
  type SandboxSubject
} from './sandbox-identity.js'

export interface K8sDriverDeps {
  api: SandboxApi
  /** Resolves tenant ownership at claim time; pool members serve more than one org. */
  orgForAgent: (agentId: string) => string | undefined
  /** Pool the claim references; v1beta1 requires one, and a cold pool is `replicas: 0`. */
  warmPoolName: string
  /** Where a launch's generation comes from — never a process-local counter, see `LaunchRegistry`. */
  generations: LaunchGenerations
  /** Optional claim metadata for host-owned synthetic agents such as runtime probes. */
  claimMetadataForAgent?: (
    agentId: string
  ) => Pick<NonNullable<SandboxClaim['metadata']>, 'annotations' | 'labels'> | undefined
  /** Dials the ready pod and binds the shim channel for this launch. */
  connectChannel: (record: SpawnRecord, podIp: string, timeoutMs: number) => Promise<ShimConnection>
  /** Stops any outbound channel when a launch is forgotten or deliberately suspended. */
  revokeChannel?: (subject: string) => void
  /** Prepares a freshly bound channel before anything runs on it; failures degrade, never fail the bind. */
  onChannelReady?: (subject: string, session: ShimSession) => Promise<void>
  /** Capabilities this agent's channels are bound with; omit for {@link RUNTIME_GRANTS}. Resolved per
   *  agent because `launch` binds on its own — a member's runtime probe runs an ACP runtime through
   *  the same driver and must not thereby receive an agent's workspace and tunnel authority. */
  grantsForAgent?: (agentId: string) => ShimCapability[]
  clock?: Clock
  log: { info: (m: string) => void; warn: (m: string) => void; debug?: (m: string) => void }
  /** How long to wait for a pod to become Ready and its shim to bind. */
  readyTimeoutMs?: number
  /** Staged latency and operability recorder; omit to record nothing. */
  metrics?: ClusterMetrics
}

const DEFAULT_READY_TIMEOUT_MS = 90_000

// Runs an ACP runtime in its own Sandbox pod — one per SUBJECT: the agent's shared pod, or a confined
// session's own (git-workspace-model §11). A facade over `LaunchRegistry` (launches, release fence,
// takeover dedup), `SandboxLease` (holds, mode writes, the idle gate) and `ChannelBinder` (sessions,
// mounts). What stays is the cluster I/O they are given plus the orchestration spanning them —
// invariants whose halves live in two of those objects at once.
export class K8sDriver implements SpawnDriver {
  private readonly metrics: ClusterMetrics
  private readonly registry: LaunchRegistry<SandboxLaunch>
  private readonly lease: SandboxLease
  private readonly binder: ChannelBinder<SandboxLaunch>
  private readonly shim: RemoteShimDriver<SandboxLaunch>
  private readonly clock: Clock
  /** So a Role without `patch` on claims says so once, not on every admission it degrades. */
  private stampRefusalReported = false

  constructor(private readonly deps: K8sDriverDeps) {
    this.clock = deps.clock ?? systemClock
    this.metrics = deps.metrics ?? noopClusterMetrics
    this.registry = new LaunchRegistry({ generations: deps.generations, clock: this.clock })
    this.lease = new SandboxLease({
      api: deps.api,
      warmPoolName: deps.warmPoolName,
      log: deps.log,
      metrics: this.metrics
    })
    const endpoints = sandboxEndpointProvider({
      lease: this.lease,
      awaitReady: (sandboxName) => awaitReady(sandboxName, this.waits)
    })
    this.binder = new ChannelBinder({
      registry: this.registry,
      endpoints,
      clock: this.clock,
      log: deps.log,
      metrics: this.metrics,
      channelTimeoutMs: this.podUpTimeoutMs,
      connectChannel: deps.connectChannel,
      ...(deps.revokeChannel ? { revokeChannel: deps.revokeChannel } : {}),
      ...(deps.onChannelReady ? { onChannelReady: deps.onChannelReady } : {})
    })
    this.shim = new RemoteShimDriver({
      ensureLaunch: (subject, timer) => this.ensureSandbox(subject, timer),
      endpoints,
      binder: this.binder,
      grantsFor: (subject) => this.grantsFor(subject),
      holdCompanion: (subject, held) => this.holdCompanion(subject, held),
      clock: this.clock,
      log: deps.log,
      metrics: this.metrics
    })
  }

  private get waits(): SandboxWaitDeps {
    return { api: this.deps.api, clock: this.clock, timeoutMs: this.podUpTimeoutMs }
  }

  /** The deterministic claim name a subject converges on (`agent-<id>`, or `agent-<id>-<leaf hash>` for a session). */
  claimName(subject: string): string {
    return sandboxClaimName(subject)
  }

  // One definition, so the loss window and the launch path agree on what a cold start may cost.
  get podUpTimeoutMs(): number {
    return this.deps.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS
  }

  // Ensure the subject has a claim and a bound Sandbox; idempotent, the claim name derives from it.
  // The ordering is the point: wait out an in-flight idle suspension (its pod is being deleted) and
  // then an in-flight takeover — the same answer from the cluster — before claiming against a fence
  // snapshot. Nothing per-agent or per-session goes in the claim SPEC beyond the pod labels, or it would
  // bypass warm-pool adoption; the same labels ride the claim's own metadata so a member can list an
  // agent's session claims without knowing their sessions.
  async ensureSandbox(subject: SandboxSubject, timer?: LaunchTimer): Promise<SandboxLaunch> {
    const ensure = () => this.ensureSandboxInner(subject, timer)
    return this.sessionFor(subject)?.isAttached() ? await ensure() : await withStartupPhase('sandbox', ensure)
  }

  private async ensureSandboxInner(subject: SandboxSubject, timer?: LaunchTimer): Promise<SandboxLaunch> {
    const suspending = this.lease.suspensionOf(subject)
    if (suspending) await suspending
    const adopting = this.registry.adoptInFlight(subject)
    if (adopting) await adopting
    const existing = this.registry.currentLaunch(subject)
    if (existing) return existing
    const releasedAt = this.registry.releaseFence(subject)
    const name = this.claimName(subject)
    const agentId = sandboxSubjectAgentId(subject)
    const orgId = this.deps.orgForAgent(agentId)
    if (!orgId) throw new Error(`cannot resolve sandbox organization for agent ${agentId}`)
    const claimMetadata = this.deps.claimMetadataForAgent?.(agentId)
    const labels = sandboxPodLabels(orgId, subject)
    // Every admission STAMPS the claim, including one that only reuses an existing object: the write
    // gives a re-admitted claim a new resourceVersion, so the orphan sweep's preconditioned delete —
    // fenced on the version it listed — loses to a session that came back after that snapshot (§4).
    const ensured = await this.deps.api.ensureClaim({
      metadata: {
        name,
        annotations: {
          ...claimMetadata?.annotations,
          [AC_ANNOTATION_ADMITTED]: new Date(this.clock.now()).toISOString()
        },
        labels: { ...labels, ...claimMetadata?.labels }
      },
      spec: {
        warmPoolRef: { name: this.deps.warmPoolName },
        additionalPodMetadata: { labels }
      }
    })
    if (ensured.stampRefused) this.reportStampRefused(name)
    // Bound, NOT ready: waiting for Ready here would block the only call that revives a suspended
    // claim, whose Sandbox it still names. Resume is "patch Running, then wait", in that order.
    const sandboxName = await awaitBoundSandbox(name, this.waits)
    timer?.mark('claim_bound')
    const sandbox = await this.deps.api.getSandbox(sandboxName)
    // Cold is "the claim did not exist"; elapsed time would make the metric depend on what it measures.
    timer?.observedPath(
      ensured.created ? 'cold' : (sandbox.spec?.operatingMode ?? 'Running') === 'Running' ? 'warm' : 'resume'
    )
    const sandboxUid = sandbox.metadata?.uid
    if (!sandboxUid) throw new Error(`sandbox ${sandboxName} has no metadata.uid to bind against`)
    const claimUid = ensured.claim.metadata?.uid ?? sandboxUid
    this.registry.assertStillServed(subject, releasedAt)
    return this.registry.recordLaunch(subject, sandboxUid, { sandboxName, claimUid })
  }

  /**
   * Re-stamp every claim this member holds a launch for, so a claim in USE never looks like a leak.
   *
   * The stamp cannot be an admission marker alone. `ensureSandbox` returns from the launch registry
   * without touching the API, and `adoptSessions` caches a Running claim this member never admitted,
   * so a member can serve a session indefinitely without writing to its claim. A sweep that snapshotted
   * the session's row as absent would then still match on `resourceVersion` when the row came back, and
   * take a live pod's volume. Refreshed well inside the sweep's grace, the stamp means "last seen in
   * use by a member", which is the fact the sweep actually needs.
   *
   * Best effort by construction: one claim's failure never stops the rest, and nothing here is on a
   * turn's path — a refresh that does not land costs freshness, and the next tick tries again.
   */
  async refreshAdmissionStamps(): Promise<void> {
    // Best effort, unlike a publication fence: a claim retired under this member is on its way out, and
    // a write that does not land costs freshness the next tick restores, never a launch.
    for (const { subject } of this.registry.launched()) {
      const outcome = await this.writeStamp(subject)
      if (outcome === 'failed') {
        this.deps.log.debug?.(`cluster: could not refresh the stamp on claim ${this.claimName(subject)}`)
      }
    }
  }

  /**
   * Mark a claim as in use, as the fence a launch about to be PUBLISHED depends on.
   *
   * Only two outcomes may publish: the write landed, or the API server refused the permission — the
   * mixed-Role degradation this daemon already reports once and accepts, because failing every takeover
   * over a missing verb would be worse than the race. A transient rejection is neither, and swallowing
   * it would publish a launch the sweep cannot see: it would still hold the resourceVersion it listed
   * while the session's row was absent, and its delete would take a live pod's volume.
   */
  private async fenceLaunch(subject: SandboxSubject): Promise<boolean> {
    const outcome = await this.writeStamp(subject)
    if (outcome === 'failed') {
      this.deps.log.warn(
        `cluster: not publishing the launch of sandbox ${subject} — its claim ${this.claimName(subject)} could not be ` +
          `marked in use, and an unmarked claim can be collected while this member serves it`
      )
    }
    return outcome !== 'failed'
  }

  // The stamp write itself: `refused` is the permission gap, reported once; `failed` is everything else.
  private async writeStamp(subject: SandboxSubject): Promise<'stamped' | 'refused' | 'failed'> {
    const name = this.claimName(subject)
    const at = new Date(this.clock.now()).toISOString()
    const stamped = await this.deps.api.stampClaim(name, { [AC_ANNOTATION_ADMITTED]: at }).catch(() => undefined)
    if (!stamped) return 'failed'
    if (stamped.stampRefused) {
      this.reportStampRefused(name)
      return 'refused'
    }
    return 'stamped'
  }

  // Said once per process: the launch is unaffected, but the orphan sweep loses the stamp that tells a
  // claim in use from a leaked one and falls back to the object's own age for it.
  private reportStampRefused(name: string): void {
    if (this.stampRefusalReported) return
    this.stampRefusalReported = true
    this.deps.log.warn(
      `cluster: the API server refused the admission stamp on claim ${name} — sandboxes still launch, but the orphan sweep ` +
        `judges this claim by age alone until the pool member's Role is granted patch on sandboxclaims`
    )
  }

  /** Takeover: re-derive the launch from the cluster (claim → bound Sandbox → mode), creating nothing. */
  // Only a Running pod is recorded — its idleness is now this member's to own; a suspended or unclaimed
  // subject needs no launch until its next turn claims one.
  adopt(subject: SandboxSubject): Promise<SandboxLaunch | undefined> {
    return this.registry.adopt(subject, async (releasedAt) => {
      const claim = await readIfPresent(() => this.deps.api.getClaim(this.claimName(subject)))
      const sandboxName = claim?.status?.sandbox?.name
      if (!sandboxName) return undefined
      const sandbox = await readIfPresent(() => this.deps.api.getSandbox(sandboxName))
      const sandboxUid = sandbox?.metadata?.uid
      const claimUid = claim?.metadata?.uid ?? sandboxUid
      if (!sandbox || !sandboxUid || (sandbox.spec?.operatingMode ?? 'Running') !== 'Running') return undefined
      // A turn that did not wait acquired it meanwhile, or the subject already left again.
      const current = this.registry.currentLaunch(subject)
      if (current) return current
      if (!this.registry.stillServed(subject, releasedAt)) return undefined
      // Stamped BEFORE the launch is published, not at the next tick: a takeover writes nothing to the
      // claim otherwise, and the launch it publishes is then served from the registry — so a sweep that
      // listed this claim while the session's row was absent would still match its version when the row
      // came back, and delete a pod this member is serving. A fence that does not land adopts nothing;
      // the next duty tick or the next turn tries again.
      if (!(await this.fenceLaunch(subject))) return undefined
      this.deps.log.info(`cluster: sandbox ${subject} taken over with sandbox ${sandboxName} running`)
      return this.registry.recordLaunch(subject, sandboxUid, { sandboxName, claimUid: claimUid ?? sandboxUid })
    })
  }

  /**
   * Mark every claim of an agent this member has just started serving, suspended pods included.
   *
   * The takeover below only records RUNNING pods, so a pod asleep across a placement return is
   * never touched by it — and the orphan sweep's version fence, which is what makes a return beat a
   * collection already in flight, then has nothing to collide with. The stamp says "last seen in
   * use by a member", and a member taking the agent over is exactly that.
   */
  async markServed(agentId: string): Promise<void> {
    const subjects = await this.sessionClaimSubjects(agentId).catch((err: unknown) => {
      this.deps.log.warn(`cluster: could not list the session claims of agent ${agentId} — ${(err as Error).message}`)
      return [] as SandboxSubject[]
    })
    for (const subject of [...subjects, agentSandboxSubject(agentId)]) {
      const outcome = await this.writeStamp(subject).catch(() => 'failed' as const)
      if (outcome === 'failed')
        this.deps.log.warn(`cluster: could not mark claim ${this.claimName(subject)} as served here`)
    }
  }

  /** Takeover of every session pod the agent has in the cluster — listed by label, since their sessions are not known here. */
  async adoptSessions(agentId: string): Promise<SandboxSubject[]> {
    const adopted: SandboxSubject[] = []
    for (const subject of await this.sessionClaimSubjects(agentId)) {
      if (await this.adopt(subject).catch(() => undefined)) adopted.push(subject)
    }
    return adopted
  }

  /** The subjects of every session claim the cluster holds for the agent, whether or not this member launched them. */
  async sessionClaimSubjects(agentId: string): Promise<SandboxSubject[]> {
    const claims = await this.deps.api.listClaims(`${AC_LABEL_AGENT}=${agentId},${AC_LABEL_SESSION}`)
    const subjects: SandboxSubject[] = []
    for (const claim of claims) {
      const labels = claim.metadata?.labels
      const leaf = labels?.[AC_LABEL_SESSION]
      // Re-checked here: a selector names what was ASKED for, and a listing that ignored it must not widen a delete.
      if (labels?.[AC_LABEL_AGENT] !== agentId || !leaf) continue
      subjects.push(sessionSandboxSubject(agentId, leaf))
    }
    return subjects
  }

  /** Whether the cluster holds a claim for the subject at all — asked before waking a pod only to find it empty. */
  async hasClaim(subject: SandboxSubject): Promise<boolean> {
    return (await this.claimUidFor(subject)) !== undefined
  }

  /** The UID of the claim the cluster holds for this subject, or undefined when it holds none — what a resume is fenced on. */
  async claimUidFor(subject: SandboxSubject): Promise<string | undefined> {
    return (await readIfPresent(() => this.deps.api.getClaim(this.claimName(subject))))?.metadata?.uid
  }

  // Bind the channel of a pod the caller ALREADY observed a claim for, creating nothing: a read that wakes a sleeping session pod may never claim one, since retention, a conversion or an agent removal can delete the claim between the observation and the wake and `ensureClaim` would then make a fresh empty one — a live agent's orphan.
  async resumeBoundChannel(subject: SandboxSubject, claimUid: string): Promise<ShimConnection> {
    const launch = await this.resumeSandbox(subject, claimUid)
    return await this.binder.bindChannel(subject, launch, undefined, this.grantsFor(subject))
  }

  // `ensureSandbox` without the ensure: the same suspension, takeover and release fences, then a READ of the claim the caller named — re-judged against the object AFTER that gap, so a claim that is gone or replaced refuses.
  private async resumeSandbox(subject: SandboxSubject, claimUid: string): Promise<SandboxLaunch> {
    const suspending = this.lease.suspensionOf(subject)
    if (suspending) await suspending
    const adopting = this.registry.adoptInFlight(subject)
    if (adopting) await adopting
    const existing = this.registry.currentLaunch(subject)
    if (existing) return existing
    const releasedAt = this.registry.releaseFence(subject)
    const name = this.claimName(subject)
    const claim = await readIfPresent(() => this.deps.api.getClaim(name))
    if (claim?.metadata?.uid !== claimUid) {
      throw new Error(`sandbox ${subject} no longer holds claim ${claimUid} — nothing to resume`)
    }
    // The Sandbox as the claim names it, never polled for: waiting for one would be waiting on a creation nobody asked for.
    const sandboxName = claim.status?.sandbox?.name
    if (!sandboxName) throw new Error(`sandbox ${subject} claim ${name} names no sandbox to resume`)
    const sandbox = await readIfPresent(() => this.deps.api.getSandbox(sandboxName))
    const sandboxUid = sandbox?.metadata?.uid
    if (!sandboxUid) throw new Error(`sandbox ${sandboxName} is gone — nothing to resume`)
    this.registry.assertStillServed(subject, releasedAt)
    // A resume publishes a launch without admitting one, exactly as a takeover does, so it stamps too —
    // and refuses the read rather than serving a pod the sweep could collect underneath it.
    if (!(await this.fenceLaunch(subject))) {
      throw new Error(`sandbox ${subject} claim ${name} could not be marked in use — not resuming onto it`)
    }
    return await this.registry.recordLaunch(subject, sandboxUid, { sandboxName, claimUid })
  }

  // Whether the pod that should hold this subject's channel is up — what tells an unbound channel apart
  // from a lost one. It takes the caller's `signal`: a stalled API server must abort the read.
  async sandboxReadiness(subject: string, opts: { signal?: AbortSignal } = {}): Promise<SandboxReadiness> {
    const launch = this.registry.currentLaunch(subject)
    if (!launch) return 'absent'
    const sandbox = await readIfPresent(() => this.deps.api.getSandbox(launch.sandboxName, opts))
    if (!sandbox) return 'absent'
    // Suspended is a decision this daemon made: the pod is gone and none is coming up for it.
    if ((sandbox.spec?.operatingMode ?? 'Running') !== 'Running') return 'absent'
    return isSandboxReady(sandbox) && resolvePodIp(sandbox) ? 'ready' : 'starting'
  }

  /** Wake a suspended Sandbox, reporting the mode found — where a CACHED launch learns it resumed. */
  async wake(subject: string): Promise<OperatingMode | undefined> {
    return await this.setMode(subject, 'Running')
  }

  /** Suspend an idle Sandbox. The object and its volume survive; only the pod goes. */
  async suspend(subject: string): Promise<void> {
    await this.setMode(subject, 'Suspended')
  }

  // Suspend a quiet subject's Sandbox: the pod goes, object and volume stay, the next message resumes
  // onto the same checkout. Session and launch drop TOGETHER once the write lands — the pod they name
  // is being deleted, so its replacement binds at a fresh generation instead of waiting for the
  // channel-loss timer. The re-read guards a launch replaced during the write.
  async suspendIfIdle(subject: string): Promise<'suspended' | 'busy' | 'absent'> {
    const launch = this.registry.currentLaunch(subject)
    if (!launch) return 'absent'
    return await this.lease.suspendIfIdle(subject, launch.sandboxName, () => {
      if (this.registry.currentLaunch(subject) === launch) {
        this.binder.dropSession(subject)
        this.forgetLaunch(subject)
      }
    })
  }

  /** Subjects this daemon holds a Sandbox for, and since when — the idle sweep's candidates. */
  launched(): Array<{ subject: SandboxSubject; agentId: string; since: number }> {
    return this.registry.launched()
  }

  /** The session pods of the agent this member holds a launch for. */
  sessionSubjectsOf(agentId: string): SandboxSubject[] {
    return this.registry.subjectsOf(agentId).filter((subject) => sandboxSubjectSessionLeaf(subject) !== undefined)
  }

  /** Move this subject's Sandbox to a mode, through the lease's per-Sandbox transition queue. */
  private setMode(subject: string, desired: OperatingMode): Promise<OperatingMode | undefined> {
    const launch = this.registry.currentLaunch(subject)
    if (!launch) return Promise.reject(new Error(`no sandbox launch recorded for ${subject}`))
    return this.lease.queueMode(launch.sandboxName, desired)
  }

  // `withSandbox` without the ensure: retain a Sandbox this member ALREADY launched, or answer that it holds none. For a caller that may neither claim nor wake a pod but must not have one suspended underneath it either — the idle gate reads `busy` synchronously, so the retain excludes the sweep rather than racing it.
  retainLaunched(subject: string): (() => void) | undefined {
    const launch = this.registry.currentLaunch(subject)
    if (!launch) return undefined
    this.lease.retain(launch.sandboxName)
    let released = false
    return () => {
      if (released) return
      released = true
      this.lease.release(launch.sandboxName)
    }
  }

  /** Hold the subject's Sandbox for `work`, including workspace preparation before launch. */
  async withSandbox<T>(subject: SandboxSubject, work: () => Promise<T>): Promise<T> {
    const launch = await this.ensureSandbox(subject)
    this.lease.retain(launch.sandboxName)
    try {
      return await work()
    } finally {
      this.lease.release(launch.sandboxName)
    }
  }

  /** Forget a subject and delete its claim; the volume goes with it, which is the intent. */
  async removeSandbox(subject: SandboxSubject): Promise<void> {
    this.release(subject)
    await this.deps.api.deleteClaim(this.claimName(subject))
  }

  /** Every claim of the agent — its own pod's and each session pod's, listed from the cluster — deleted, the volumes with them. */
  async removeAgentSandboxes(agentId: string): Promise<void> {
    // A Role without `list` narrows this to the session pods this member launched; the reconciler collects the rest.
    const sessions = await this.sessionClaimSubjects(agentId).catch((err: unknown) => {
      this.deps.log.warn(
        `cluster: could not list the session sandboxes of agent ${agentId} — ${(err as Error).message}`
      )
      return [] as SandboxSubject[]
    })
    for (const subject of this.sessionSubjectsOf(agentId)) if (!sessions.includes(subject)) sessions.push(subject)
    for (const subject of sessions) await this.removeSandbox(subject)
    await this.removeSandbox(agentSandboxSubject(agentId))
  }

  /** "No longer served here", not removal: launch, session, root and holds go; claim and volume stay. */
  release(subject: string): void {
    this.registry.bumpRelease(subject)
    const launch = this.registry.forgetLaunch(subject)
    if (launch) this.lease.forgetSandbox(launch.sandboxName)
    // Otherwise `runsInSandbox` keeps answering true for a pod that is not this member's to use.
    this.binder.forget(subject)
    this.deps.revokeChannel?.(subject)
  }

  /** Release every pod of the agent this member holds: its own and its sessions'. */
  releaseAgentSandboxes(agentId: string): void {
    for (const subject of this.registry.subjectsOf(agentId)) this.release(subject)
    this.release(agentSandboxSubject(agentId))
  }

  // A lost pod is an unplanned suspension, not a new state: the next turn re-runs the wake path.
  forgetLaunch(subject: string): void {
    this.registry.forgetLaunch(subject)
    this.deps.revokeChannel?.(subject)
  }

  currentLaunch(subject: string): SandboxLaunch | undefined {
    return this.registry.currentLaunch(subject)
  }

  // Bring the Sandbox up and bind its shim WITHOUT starting a runtime: for a cluster agent a "prepared workspace" is cloned onto the sandbox's own volume, before the runtime starts.
  ensureBoundChannel(subject: SandboxSubject, timer?: LaunchTimer, grants?: ShimCapability[]): Promise<ShimConnection> {
    return this.shim.ensureBoundChannel(subject, timer, grants)
  }

  /** What this subject's channel may do — decided per agent. */
  private grantsFor(subject: string): ShimCapability[] {
    return this.deps.grantsForAgent?.(sandboxSubjectAgentId(subject)) ?? RUNTIME_GRANTS
  }

  /** The bound session for a subject, so the workspace seam reaches the same channel the runtime does. */
  sessionFor(subject: string): ShimSession | undefined {
    return this.binder.sessionFor(subject)
  }

  /** Where the bound pod mounts its workspace; unset before a bind, and callers then fall back. */
  workspaceRootFor(subject: string): string | undefined {
    return this.binder.workspaceRootFor(subject)
  }

  /** Start the runtime through the subject's shim; the dial, bind and hold logic is the generic driver's. */
  launch(request: SpawnRequest): Promise<SpawnedRuntime> {
    return this.shim.launch(request)
  }

  // A session runtime keeps its agent's pod reachable for the agent-scoped seams (managed memory, merge-when-ready, the console's primary checkout): bound and held for the runtime's life, reported rather than raised, so a companion that will not come up degrades those seams, never the launch.
  private async holdCompanion(subject: SandboxSubject, held: SandboxLaunch[]): Promise<void> {
    if (sandboxSubjectSessionLeaf(subject) === undefined) return
    const companion = agentSandboxSubject(sandboxSubjectAgentId(subject))
    let launch: SandboxLaunch | undefined
    try {
      launch = await this.ensureSandbox(companion)
      this.lease.retain(launch.sandboxName)
      await this.ensureBoundChannel(companion)
      held.push(launch)
    } catch (err) {
      if (launch) this.lease.release(launch.sandboxName)
      this.deps.log.warn(
        `cluster: agent ${companion} pod is not reachable beside its session pod — ${(err as Error).message}`
      )
    }
  }

  /** Re-attach a renewed or replacement connection to the launch it belongs to. */
  onChannelBound(connection: ShimConnection): void {
    this.binder.onChannelBound(connection)
  }

  // Report that a subject's channel is gone, so its runtime learns rather than hanging. Session and
  // launch drop TOGETHER: a revived sandbox must never bind to a lost session.
  onChannelLost(subject: string, reason: string): void {
    if (this.binder.loseChannel(subject, reason)) this.forgetLaunch(subject)
  }
}
