import { LaunchTimer, noopClusterMetrics, type ClusterMetrics } from '../metrics/cluster-metrics.js'
import { systemClock, type Clock } from '@agentconnect.md/connection'
import type { SpawnDriver, SpawnRequest, SpawnedRuntime } from '../acp/spawn-driver.js'
import type { ShimCapability } from '../shim/protocol.js'
import type { ShimConnection } from '../shim/connection.js'
import { ShimFileSink } from '../shim/channels.js'
import { ShimSession } from '../shim/session.js'
import { createRemoteRuntime } from '../shim/remote-runtime.js'
import type { SpawnRecord } from '../shim/binding.js'
import { isSandboxReady, type OperatingMode, type SandboxClaim, type SandboxApi } from './sandbox-api.js'
import { SandboxLease } from './sandbox-lease.js'
import { LaunchRegistry, type Launch, type LaunchGenerations } from './launch-registry.js'
import { ChannelBinder } from './channel-binder.js'
import { awaitBoundSandbox, awaitReady, readIfPresent, type SandboxWaitDeps } from './sandbox-waits.js'
import { AC_LABEL_AGENT, AC_LABEL_ORG, LaunchTimeoutError, resolvePodIp } from './sandbox-identity.js'
import { RUNTIME_GRANTS } from '../shim/grants.js'

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
  revokeChannel?: (agentId: string) => void
  /** Prepares a freshly bound channel before anything runs on it; failures degrade, never fail the bind. */
  onChannelReady?: (agentId: string, session: ShimSession) => Promise<void>
  /** Capabilities this agent's channel is bound with; omit for {@link RUNTIME_GRANTS}. Resolved per
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

// Runs an agent's ACP runtime in its own Sandbox pod: a facade over `LaunchRegistry` (launches,
// release fence, takeover dedup), `SandboxLease` (holds, mode writes, the idle gate) and
// `ChannelBinder` (sessions, mounts). What stays is the cluster I/O they are given plus the
// orchestration spanning them — invariants whose halves live in two of those objects at once.
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

  claimName(agentId: string): string {
    return `agent-${agentId}`
  }

  // One definition, so the loss window and the launch path agree on what a cold start may cost.
  get podUpTimeoutMs(): number {
    return this.deps.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS
  }

  // Ensure the agent has a claim and a bound Sandbox; idempotent, the claim name derives from the id.
  // The ordering is the point: wait out an in-flight idle suspension (its pod is being deleted) and
  // then an in-flight takeover — the same answer from the cluster — before claiming against a fence
  // snapshot. Nothing per-agent goes in the claim, or it would bypass warm-pool adoption.
  async ensureSandbox(agentId: string, timer?: LaunchTimer): Promise<Launch> {
    const suspending = this.lease.suspensionOf(agentId)
    if (suspending) await suspending
    const adopting = this.registry.adoptInFlight(agentId)
    if (adopting) await adopting
    const existing = this.registry.currentLaunch(agentId)
    if (existing) return existing
    const releasedAt = this.registry.releaseFence(agentId)
    const name = this.claimName(agentId)
    const orgId = this.deps.orgForAgent(agentId)
    if (!orgId) throw new Error(`cannot resolve sandbox organization for agent ${agentId}`)
    const claimMetadata = this.deps.claimMetadataForAgent?.(agentId)
    const ensured = await this.deps.api.ensureClaim({
      metadata: {
        name,
        ...(claimMetadata?.annotations ? { annotations: claimMetadata.annotations } : {}),
        ...(claimMetadata?.labels ? { labels: claimMetadata.labels } : {})
      },
      spec: {
        warmPoolRef: { name: this.deps.warmPoolName },
        additionalPodMetadata: { labels: { [AC_LABEL_ORG]: orgId, [AC_LABEL_AGENT]: agentId } }
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
    this.registry.assertStillServed(agentId, releasedAt)
    return this.registry.recordLaunch(agentId, sandboxName, sandboxUid, claimUid)
  }

  /** Takeover: re-derive the launch from the cluster (claim → bound Sandbox → mode), creating nothing. */
  // Only a Running pod is recorded — its idleness is now this member's to own; a suspended or unclaimed
  // agent needs no launch until its next turn claims one.
  adoptAgent(agentId: string): Promise<Launch | undefined> {
    return this.registry.adopt(agentId, async (releasedAt) => {
      const claim = await readIfPresent(() => this.deps.api.getClaim(this.claimName(agentId)))
      const sandboxName = claim?.status?.sandbox?.name
      if (!sandboxName) return undefined
      const sandbox = await readIfPresent(() => this.deps.api.getSandbox(sandboxName))
      const sandboxUid = sandbox?.metadata?.uid
      const claimUid = claim?.metadata?.uid ?? sandboxUid
      if (!sandbox || !sandboxUid || (sandbox.spec?.operatingMode ?? 'Running') !== 'Running') return undefined
      // A turn that did not wait acquired it meanwhile, or the agent already left again.
      const current = this.registry.currentLaunch(agentId)
      if (current) return current
      if (!this.registry.stillServed(agentId, releasedAt)) return undefined
      this.deps.log.info(`cluster: agent ${agentId} taken over with sandbox ${sandboxName} running`)
      return this.registry.recordLaunch(agentId, sandboxName, sandboxUid, claimUid)
    })
  }

  // Whether the pod that should hold this agent's channel is up — what tells an unbound channel apart
  // from a lost one. It takes the caller's `signal`: a stalled API server must abort the read.
  async sandboxReadiness(agentId: string, opts: { signal?: AbortSignal } = {}): Promise<SandboxReadiness> {
    const launch = this.registry.currentLaunch(agentId)
    if (!launch) return 'absent'
    const sandbox = await readIfPresent(() => this.deps.api.getSandbox(launch.sandboxName, opts))
    if (!sandbox) return 'absent'
    // Suspended is a decision this daemon made: the pod is gone and none is coming up for it.
    if ((sandbox.spec?.operatingMode ?? 'Running') !== 'Running') return 'absent'
    return isSandboxReady(sandbox) && resolvePodIp(sandbox) ? 'ready' : 'starting'
  }

  /** Wake a suspended Sandbox, reporting the mode found — where a CACHED launch learns it resumed. */
  async wake(agentId: string): Promise<OperatingMode | undefined> {
    return await this.setMode(agentId, 'Running')
  }

  /** Suspend an idle Sandbox. The object and its volume survive; only the pod goes. */
  async suspend(agentId: string): Promise<void> {
    await this.setMode(agentId, 'Suspended')
  }

  // Suspend a quiet agent's Sandbox: the pod goes, object and volume stay, the next message resumes
  // onto the same checkout. Session and launch drop TOGETHER once the write lands — the pod they name
  // is being deleted, so its replacement binds at a fresh generation instead of waiting for the
  // channel-loss timer. The re-read guards a launch replaced during the write.
  async suspendIfIdle(agentId: string): Promise<'suspended' | 'busy' | 'absent'> {
    const launch = this.registry.currentLaunch(agentId)
    if (!launch) return 'absent'
    return await this.lease.suspendIfIdle(agentId, launch.sandboxName, () => {
      if (this.registry.currentLaunch(agentId) === launch) {
        this.binder.dropSession(agentId)
        this.forgetLaunch(agentId)
      }
    })
  }

  /** Agents this daemon holds a Sandbox for, and since when — the idle sweep's candidates. */
  launchedAgents(): Array<{ agentId: string; since: number }> {
    return this.registry.launchedAgents()
  }

  /** Move this agent's Sandbox to a mode, through the lease's per-Sandbox transition queue. */
  private setMode(agentId: string, desired: OperatingMode): Promise<OperatingMode | undefined> {
    const launch = this.registry.currentLaunch(agentId)
    if (!launch) return Promise.reject(new Error(`no sandbox launch recorded for agent ${agentId}`))
    return this.lease.queueMode(launch.sandboxName, desired)
  }

  /** Hold the agent's Sandbox for `work`, including workspace preparation before launch. */
  async withSandbox<T>(agentId: string, work: () => Promise<T>): Promise<T> {
    const launch = await this.ensureSandbox(agentId)
    this.lease.retain(launch.sandboxName)
    try {
      return await work()
    } finally {
      this.lease.release(launch.sandboxName)
    }
  }

  /** Forget an agent and delete its claim; the volume goes with it, which is the intent. */
  async removeAgent(agentId: string): Promise<void> {
    this.releaseAgent(agentId)
    await this.deps.api.deleteClaim(this.claimName(agentId))
  }

  /** "No longer served here", not removal: launch, session, root and holds go; claim and volume stay. */
  releaseAgent(agentId: string): void {
    this.registry.bumpRelease(agentId)
    const launch = this.registry.forgetLaunch(agentId)
    if (launch) this.lease.forgetSandbox(launch.sandboxName)
    // Otherwise `runsInSandbox` keeps answering true for a pod that is not this member's to use.
    this.binder.forget(agentId)
    this.deps.revokeChannel?.(agentId)
  }

  // A lost pod is an unplanned suspension, not a new state: the next turn re-runs the wake path.
  forgetLaunch(agentId: string): void {
    this.registry.forgetLaunch(agentId)
    this.deps.revokeChannel?.(agentId)
  }

  currentLaunch(agentId: string): Launch | undefined {
    return this.registry.currentLaunch(agentId)
  }

  // Bring the Sandbox up and bind its shim WITHOUT starting a runtime: for a cluster agent a
  // "prepared workspace" is cloned onto the sandbox's own volume, before the runtime starts.
  async ensureBoundChannel(agentId: string, timer?: LaunchTimer, grants?: ShimCapability[]): Promise<ShimConnection> {
    const launch = await this.ensureSandbox(agentId, timer)
    return await this.binder.bindChannel(agentId, launch, timer, grants ?? this.grantsFor(agentId))
  }

  /** What this agent's channel may do. */
  private grantsFor(agentId: string): ShimCapability[] {
    return this.deps.grantsForAgent?.(agentId) ?? RUNTIME_GRANTS
  }

  /** The bound session for an agent, so the workspace seam reaches the same channel the runtime does. */
  sessionFor(agentId: string): ShimSession | undefined {
    return this.binder.sessionFor(agentId)
  }

  /** Where the bound pod mounts its workspace; unset before a bind, and callers then fall back. */
  workspaceRootFor(agentId: string): string | undefined {
    return this.binder.workspaceRootFor(agentId)
  }

  // Start the runtime and hand `AcpHost` a stream pair. Command resolution is deliberately NOT done
  // here: the shim resolves it in the filesystem the runtime will read.
  async launch(request: SpawnRequest): Promise<SpawnedRuntime> {
    const agentId = request.env.AC_AGENT_ID
    if (!agentId) throw new Error('cluster launch requires AC_AGENT_ID in the runtime environment')
    const timer = new LaunchTimer(this.metrics, () => this.clock.now())
    // The Sandbox is held from before bind until runtime exit and released on every failure path.
    let held: string | undefined
    try {
      const bound = await this.ensureSandbox(agentId, timer)
      this.lease.retain(bound.sandboxName)
      held = bound.sandboxName
      await this.ensureBoundChannel(agentId, timer)
      this.metrics.channel('bound')
      const session = this.binder.sessionFor(agentId)
      if (!session) throw new Error(`no shim session for agent ${agentId} after binding its channel`)
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
      // Runtime exit releases the hold so the next idle sweep can suspend the Sandbox.
      const sandboxName = held
      held = undefined
      runtime.onExit(() => this.lease.release(sandboxName))
      return runtime
    } catch (err) {
      if (held) this.lease.release(held)
      timer.finish(err instanceof LaunchTimeoutError ? 'timeout' : 'error')
      throw err
    }
  }

  /** Re-attach a renewed or replacement connection to the launch it belongs to. */
  onChannelBound(connection: ShimConnection): void {
    this.binder.onChannelBound(connection)
  }

  // Report that an agent's channel is gone, so its runtime learns rather than hanging. Session and
  // launch drop TOGETHER: a revived sandbox must never bind to a lost session.
  onChannelLost(agentId: string, reason: string): void {
    if (this.binder.loseChannel(agentId, reason)) this.forgetLaunch(agentId)
  }
}
