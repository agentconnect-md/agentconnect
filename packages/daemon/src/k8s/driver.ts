import { LaunchTimer, noopClusterMetrics, type ClusterMetrics } from '../metrics/cluster-metrics.js'
import { systemClock, type Clock } from '@agentconnect.md/connection'
import type { SpawnDriver, SpawnRequest, SpawnedRuntime } from '../acp/spawn-driver.js'
import type { ShimCapability } from '../shim/protocol.js'
import type { ShimConnection } from '../shim/connection.js'
import { ShimFileSink } from '../shim/channels.js'
import { ShimSession } from '../shim/session.js'
import { createRemoteRuntime } from './remote-runtime.js'
import type { SpawnRecord } from '../shim/binding.js'
import { isSandboxReady, type OperatingMode, type SandboxClaim, type SandboxApi } from './sandbox-api.js'
import { SandboxLease } from './sandbox-lease.js'
import { LaunchRegistry, type Launch, type LaunchGenerations } from './launch-registry.js'
import { ChannelBinder } from './channel-binder.js'
import { awaitBoundSandbox, awaitReady, readIfPresent, type SandboxWaitDeps } from './sandbox-waits.js'
import {
  AC_ANNOTATION_ADMITTED,
  AC_LABEL_AGENT,
  AC_LABEL_SESSION,
  LaunchTimeoutError,
  RUNTIME_GRANTS,
  agentSandboxSubject,
  resolvePodIp,
  sandboxClaimName,
  sandboxPodLabels,
  sandboxSubjectAgentId,
  sandboxSubjectFor,
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

/** `starting` means the pod is not up yet, so nothing was lost; `absent` means none is coming. */
export type SandboxReadiness = 'ready' | 'starting' | 'absent'

// Runs an ACP runtime in its own Sandbox pod — one per SUBJECT: the agent's shared pod, or a confined
// session's own (git-workspace-model §11). A facade over `LaunchRegistry` (launches, release fence,
// takeover dedup), `SandboxLease` (holds, mode writes, the idle gate) and `ChannelBinder` (sessions,
// mounts). What stays is the cluster I/O they are given plus the orchestration spanning them —
// invariants whose halves live in two of those objects at once.
export class K8sDriver implements SpawnDriver {
  private readonly metrics: ClusterMetrics
  private readonly registry: LaunchRegistry
  private readonly lease: SandboxLease
  private readonly binder: ChannelBinder
  private readonly clock: Clock

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
    this.binder = new ChannelBinder({
      registry: this.registry,
      lease: this.lease,
      clock: this.clock,
      log: deps.log,
      metrics: this.metrics,
      channelTimeoutMs: this.podUpTimeoutMs,
      awaitReady: (sandboxName) => awaitReady(sandboxName, this.waits),
      connectChannel: deps.connectChannel,
      ...(deps.revokeChannel ? { revokeChannel: deps.revokeChannel } : {}),
      ...(deps.onChannelReady ? { onChannelReady: deps.onChannelReady } : {})
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
  async ensureSandbox(subject: SandboxSubject, timer?: LaunchTimer): Promise<Launch> {
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
    return this.registry.recordLaunch(subject, sandboxName, sandboxUid, claimUid)
  }

  /** Takeover: re-derive the launch from the cluster (claim → bound Sandbox → mode), creating nothing. */
  // Only a Running pod is recorded — its idleness is now this member's to own; a suspended or unclaimed
  // subject needs no launch until its next turn claims one.
  adopt(subject: SandboxSubject): Promise<Launch | undefined> {
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
      this.deps.log.info(`cluster: sandbox ${subject} taken over with sandbox ${sandboxName} running`)
      return this.registry.recordLaunch(subject, sandboxName, sandboxUid, claimUid)
    })
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
  private async resumeSandbox(subject: SandboxSubject, claimUid: string): Promise<Launch> {
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
    return await this.registry.recordLaunch(subject, sandboxName, sandboxUid, claimUid)
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

  currentLaunch(subject: string): Launch | undefined {
    return this.registry.currentLaunch(subject)
  }

  // Bring the Sandbox up and bind its shim WITHOUT starting a runtime: for a cluster agent a
  // "prepared workspace" is cloned onto the sandbox's own volume, before the runtime starts.
  async ensureBoundChannel(
    subject: SandboxSubject,
    timer?: LaunchTimer,
    grants?: ShimCapability[]
  ): Promise<ShimConnection> {
    const launch = await this.ensureSandbox(subject, timer)
    return await this.binder.bindChannel(subject, launch, timer, grants ?? this.grantsFor(subject))
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

  // Start the runtime and hand `AcpHost` a stream pair. Command resolution is deliberately NOT done
  // here: the shim resolves it in the filesystem the runtime will read.
  async launch(request: SpawnRequest): Promise<SpawnedRuntime> {
    const agentId = request.env.AC_AGENT_ID
    if (!agentId) throw new Error('cluster launch requires AC_AGENT_ID in the runtime environment')
    // The host key names the pod (§11): a session-bound host launches into the session's own; the agent's host, into the agent's.
    const subject = request.hostKey ? sandboxSubjectFor(request.hostKey) : agentSandboxSubject(agentId)
    if (sandboxSubjectAgentId(subject) !== agentId) {
      throw new Error(
        `cluster launch host key names agent ${sandboxSubjectAgentId(subject)}, its environment ${agentId}`
      )
    }
    const timer = new LaunchTimer(this.metrics, () => this.clock.now())
    // The Sandbox is held from before bind until runtime exit and released on every failure path.
    const held: string[] = []
    const releaseHeld = (): void => {
      for (const sandboxName of held.splice(0)) this.lease.release(sandboxName)
    }
    try {
      const bound = await this.ensureSandbox(subject, timer)
      this.lease.retain(bound.sandboxName)
      held.push(bound.sandboxName)
      // A session runtime keeps its agent's pod reachable for the agent-scoped seams (managed memory, merge-when-ready, the console's primary checkout): bound and held for the runtime's life, so "a runtime is running" still implies "the agent's pod is up"; a companion that will not come up degrades those seams, never the launch.
      const companion = sandboxSubjectSessionLeaf(subject) === undefined ? undefined : agentSandboxSubject(agentId)
      // Settled TOGETHER: a companion still binding when the session bind fails would retain its Sandbox after the catch below drained `held`, and nothing would ever release it.
      const [channel] = await Promise.allSettled([
        this.ensureBoundChannel(subject, timer),
        companion === undefined ? Promise.resolve() : this.holdCompanion(companion, held)
      ])
      if (channel.status === 'rejected') throw channel.reason
      this.metrics.channel('bound')
      const session = this.binder.sessionFor(subject)
      if (!session) throw new Error(`no shim session for ${subject} after binding its channel`)
      // Fail-closed and per-launch: the env below points at these files, and a resumed Sandbox is a
      // NEW pod whose tmpfs starts empty — so the write belongs to every launch, not to the bind.
      const sink = new ShimFileSink(session)
      for (const file of request.files ?? []) await sink.write(file.root, file.relPath, file.content)
      const runtime = createRemoteRuntime({
        session,
        request,
        log: this.deps.log,
        metrics: this.metrics,
        // The open is asynchronous, so the stage closes when the runtime reports — and only a
        // successful one, or a rejection would sit in runtime-ready latency as a fast success.
        onRuntimeOpen: (outcome) => {
          if (outcome === 'ok') timer.mark('runtime_ready')
          timer.finish(outcome)
        }
      })
      // Runtime exit releases the holds so the next idle sweep can suspend the Sandboxes.
      const released = held.splice(0)
      runtime.onExit(() => {
        for (const sandboxName of released) this.lease.release(sandboxName)
      })
      return runtime
    } catch (err) {
      releaseHeld()
      timer.finish(err instanceof LaunchTimeoutError ? 'timeout' : 'error')
      throw err
    }
  }

  /** Bind and hold the agent's own pod beside a session launch; reported rather than raised. */
  private async holdCompanion(companion: SandboxSubject, held: string[]): Promise<void> {
    let sandboxName: string | undefined
    try {
      sandboxName = (await this.ensureSandbox(companion)).sandboxName
      this.lease.retain(sandboxName)
      await this.ensureBoundChannel(companion)
      held.push(sandboxName)
    } catch (err) {
      if (sandboxName) this.lease.release(sandboxName)
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
