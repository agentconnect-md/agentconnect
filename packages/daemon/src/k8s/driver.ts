import { LaunchTimer, noopClusterMetrics, type ClusterMetrics } from './cluster-metrics.js'
import { Backoff, systemClock, type Clock } from '@agentconnect.md/connection'
import type { SpawnDriver, SpawnRequest, SpawnedRuntime } from '../acp/spawn-driver.js'
import type { ShimCapability } from '../shim/protocol.js'
import type { ShimConnection } from '../shim/listener.js'
import { ShimRequestTimeoutError } from '../shim/channels.js'
import { ShimSession } from '../shim/session.js'
import type { SpawnRecord } from '../shim/binding.js'
import {
  OperatingModeRejectedError,
  isSandboxReady,
  type OperatingMode,
  type Sandbox,
  type SandboxClaim,
  type SandboxApi
} from './sandbox-api.js'
import { K8sApiError } from '@agentconnect.md/k8s-client'

/** Label domain the claim controller must be configured to allow. */
export const AC_LABEL_ORG = 'agentconnect.md/org'
export const AC_LABEL_AGENT = 'agentconnect.md/agent'

/**
 * Where agent-sandbox records the pod a Sandbox is currently backed by.
 *
 * This is the ONLY way the daemon can bind the dial target to the launch that started it: a
 * TokenReview yields a pod name and uid, `SandboxStatus` carries no pod reference at all
 * (v1beta1: serviceFQDN, service, conditions, selector, podIPs, nodeName), and reading the Pod
 * API is deliberately outside this daemon's Role. Upstream's `resolvePodName` is exactly this
 * annotation with the Sandbox's own name as the fallback, so mirroring it keeps the two in step.
 */
export const SANDBOX_POD_NAME_ANNOTATION = 'agents.x-k8s.io/pod-name'

/** The pod backing this Sandbox: the adopted warm-pool pod, or the Sandbox's own name. */
export function resolvePodName(sandbox: Sandbox): string | undefined {
  const adopted = sandbox.metadata?.annotations?.[SANDBOX_POD_NAME_ANNOTATION]
  return adopted && adopted.length > 0 ? adopted : sandbox.metadata?.name
}

/** The first routable address reported for the pod backing this Sandbox. */
export function resolvePodIp(sandbox: Sandbox): string | undefined {
  for (const entry of sandbox.status?.podIPs ?? []) {
    const ip = typeof entry === 'string' ? entry : entry.ip
    if (ip?.trim()) return ip.trim()
  }
  return undefined
}

/** Capabilities a runtime launch receives. Narrow by construction: a launch gets exactly
 *  what the channels it uses require, so a future capability is an explicit decision. */
export const RUNTIME_GRANTS: ShimCapability[] = ['acp', 'materialize', 'exec', 'read', 'tunnel']

/** A probe sandbox runs no runtime and touches no workspace, so it gets the one channel it uses
 *  and nothing else. Granting `probe` to every launch instead would hand each agent's runtime an
 *  authority it never exercises — which the direct-connect grant test exists to catch. */
export const PROBE_GRANTS: ShimCapability[] = ['probe']

export interface K8sDriverDeps {
  api: SandboxApi
  /** Resolves tenant ownership at claim time; cloud daemons serve more than one org. */
  orgForAgent: (agentId: string) => string | undefined
  /** Pool the claim references; v1beta1 requires one, and a cold pool is `replicas: 0`. */
  warmPoolName: string
  /** Optional claim metadata for host-owned synthetic agents such as runtime probes. */
  claimMetadataForAgent?: (
    agentId: string
  ) => Pick<NonNullable<SandboxClaim['metadata']>, 'annotations' | 'labels'> | undefined
  /** Dials the ready pod and binds the shim channel for this launch. */
  connectChannel: (record: SpawnRecord, podIp: string, timeoutMs: number) => Promise<ShimConnection>
  /** Stops any outbound channel when a launch is forgotten or deliberately suspended. */
  revokeChannel?: (agentId: string) => void
  /**
   * Prepare a freshly bound channel before anything runs on it — today, opening the unix-socket
   * tunnels the agent's runtime expects to find in its pod.
   *
   * Awaited inside the bind, deliberately: the workspace clone and the runtime both reach for
   * those sockets, so a launch that returned first would race its own credential channel. A
   * failure here does NOT fail the launch; the hook reports it and the affected feature degrades.
   */
  onChannelReady?: (agentId: string, session: ShimSession) => Promise<void>
  clock?: Clock
  log: { info: (m: string) => void; warn: (m: string) => void; debug?: (m: string) => void }
  /** How long to wait for a pod to become Ready and its shim to bind. */
  readyTimeoutMs?: number
  /** Staged latency and operability recorder; omit to record nothing. */
  metrics?: ClusterMetrics
}

/** A launch stage that ran out of time. Typed, because a missed target and a broken cluster are
 *  different operational stories and telling them apart by error text is a liability. */
export class LaunchTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LaunchTimeoutError'
  }
}

const DEFAULT_READY_TIMEOUT_MS = 90_000
const MAX_MODE_ATTEMPTS = 5

/** Per-agent launch state the driver keeps: the Sandbox it bound and which launch it is. */
interface Launch {
  agentId: string
  sandboxName: string
  sandboxUid: string
  generation: number
}

/**
 * Runs an agent's ACP runtime in its own Sandbox pod.
 *
 * Lifecycle lives here rather than in the control plane on purpose: claim creation, sleep,
 * wake and teardown are all local decisions, so a control-plane outage cannot stop an
 * existing agent from starting or stopping its runtime.
 */
export class K8sDriver implements SpawnDriver {
  private readonly metrics: ClusterMetrics
  private readonly launches = new Map<string, Launch>()
  private readonly generations = new Map<string, number>()
  /** Live work per Sandbox: binds, workspace preparation, and runtimes that have not exited. */
  private readonly busy = new Map<string, number>()
  /** Per-SANDBOX transition queue. A guarded write protects competing writes, but it cannot
   *  protect a decision that performs NO write: a later wake could observe Running and
   *  return while an earlier suspend patch was still in flight, and the older write would
   *  then land last and reverse the newer decision. Serializing removes that entirely. */
  private readonly modeQueue = new Map<string, Promise<void>>()
  /** Idle suspensions in flight, per agent. `busy` COUNTS work but does not exclude it, so a
   *  dispatch admitted while the suspend was mid-write would otherwise lose its pod. Acquisition
   *  waits this out and then re-claims, which is the ordinary resume path. */
  private readonly suspending = new Map<string, Promise<void>>()
  /** Logical channels per agent, which survive the shim's credential renewals. */
  private readonly sessions = new Map<string, ShimSession>()
  /** Workspace mount per agent, as the bound pod's shim reported it. */
  private readonly workspaceRoots = new Map<string, string>()
  private readonly clock: Clock

  constructor(private readonly deps: K8sDriverDeps) {
    this.clock = deps.clock ?? systemClock
    this.metrics = deps.metrics ?? noopClusterMetrics
  }

  claimName(agentId: string): string {
    return `agent-${agentId}`
  }

  /**
   * Ensure the agent has a claim and a bound Sandbox. Idempotent: the claim name is derived
   * from the agent id, so a retry after a partial reconcile converges instead of failing.
   *
   * Nothing per-agent goes into the claim — a claim carrying `env` or `volumeClaimTemplates`
   * bypasses warm-pool adoption, and pool pods are stamped before any user exists, so
   * identity travels over the shim handshake instead.
   */
  async ensureSandbox(agentId: string, timer?: LaunchTimer): Promise<Launch> {
    // An idle suspension mid-write is the one state a cached launch must not be read through: its
    // pod is being deleted. Waiting lets it finish and forget the launch, so the line below claims
    // a new one — the same resume this call would have done a moment later anyway.
    const suspending = this.suspending.get(agentId)
    if (suspending) await suspending
    const existing = this.launches.get(agentId)
    if (existing) return existing
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
    // Resolve the bound Sandbox WITHOUT requiring readiness. A suspended claim still names
    // its Sandbox and still has a uid, but suspension deleted the pod — so waiting for Ready
    // here would block the only call that could bring it back. Resume is "patch Running,
    // then wait", in that order.
    const sandboxName = await this.awaitBoundSandbox(name)
    timer?.mark('claim_bound')
    const sandbox = await this.deps.api.getSandbox(sandboxName)
    // Cold is "the claim did not exist", which is the launch that pays PVC provisioning and an
    // image pull. A claim that existed and a Sandbox already Running is warm; existing and
    // Suspended is the resume path. Guessing from elapsed time instead would make the metric
    // depend on the thing it is supposed to measure.
    timer?.observedPath(
      ensured.created ? 'cold' : (sandbox.spec?.operatingMode ?? 'Running') === 'Running' ? 'warm' : 'resume'
    )
    const sandboxUid = sandbox.metadata?.uid
    if (!sandboxUid) throw new Error(`sandbox ${sandboxName} has no metadata.uid to bind against`)
    const generation = (this.generations.get(agentId) ?? 0) + 1
    this.generations.set(agentId, generation)
    const launch: Launch = { agentId, sandboxName, sandboxUid, generation }
    this.launches.set(agentId, launch)
    return launch
  }

  /** Wait for the Sandbox to report Ready, after something has asked it to run. */
  // Pod identity and address are resolved only after readiness so a resumed launch cannot reuse
  // the previous incarnation's annotation or IP.
  private async awaitReady(sandboxName: string): Promise<{ podName: string; podIp: string }> {
    const backoff = new Backoff({ baseMs: 250, capMs: 2_000, jitter: () => 0 })
    const deadline = this.clock.now() + (this.deps.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS)
    for (;;) {
      const sandbox = await this.deps.api.getSandbox(sandboxName).catch(() => undefined)
      const podName = sandbox ? resolvePodName(sandbox) : undefined
      if (sandbox && isSandboxReady(sandbox)) {
        const podIp = resolvePodIp(sandbox)
        if (podName && podIp) return { podName, podIp }
      }
      if (this.clock.now() >= deadline) {
        if (sandbox && isSandboxReady(sandbox) && !podName) {
          throw new LaunchTimeoutError(`sandbox ${sandboxName} became ready but never named its pod`)
        }
        if (sandbox && isSandboxReady(sandbox) && !resolvePodIp(sandbox)) {
          throw new LaunchTimeoutError(`sandbox ${sandboxName} became ready but never reported a pod IP`)
        }
        throw new LaunchTimeoutError(`sandbox ${sandboxName} did not become ready in time`)
      }
      await new Promise<void>((resolve) => this.clock.setTimeout(resolve, backoff.next()))
    }
  }

  /** Wake a suspended Sandbox, or confirm it is already running. Reports the mode it found, which
   *  is the only place a CACHED launch can learn whether it is resuming or already warm. */
  async wake(agentId: string): Promise<OperatingMode | undefined> {
    return await this.setMode(agentId, 'Running')
  }

  /** Suspend an idle Sandbox. The object and its volume survive; only the pod goes. */
  async suspend(agentId: string): Promise<void> {
    await this.setMode(agentId, 'Suspended')
  }

  /**
   * Suspend the Sandbox of an agent that has gone quiet: the pod goes, the object and the
   * workspace volume stay, and the next message resumes onto the same checkout.
   *
   * Declines rather than waits when work already holds the sandbox — the caller is a periodic
   * sweep, so the next pass finds it quiet, whereas waiting here would hold a suspend decision
   * open across a turn that has already made it stale.
   *
   * Work admitted AFTER that check is a different problem, and `busy` cannot solve it: it counts
   * holders, it does not exclude them, so a dispatch arriving during the Kubernetes write would
   * lose the pod underneath itself and then find its launch forgotten. The decision is therefore
   * published before the first await, and acquisition waits it out (`ensureSandbox`) instead of
   * racing it. Publication is synchronous with the `busy` read, which is what makes the pair
   * atomic: a holder either shows up in that read, or arrives to a gate that is already closed.
   *
   * The launch is forgotten on success, deliberately: the pod it names is being deleted, and the
   * replacement must be bound at a new generation. Leaving it to the channel-loss path instead
   * would make correctness depend on a timer whose whole job is unplanned loss.
   */
  async suspendIfIdle(agentId: string): Promise<'suspended' | 'busy' | 'absent'> {
    const launch = this.launches.get(agentId)
    if (!launch) return 'absent'
    if (this.suspending.has(agentId)) return 'busy'
    if ((this.busy.get(launch.sandboxName) ?? 0) > 0) return 'busy'
    let opened: () => void = () => {}
    this.suspending.set(agentId, new Promise<void>((resolve) => (opened = resolve)))
    this.retain(launch.sandboxName)
    try {
      await this.queueMode(launch.sandboxName, 'Suspended')
      if (this.launches.get(agentId) === launch) {
        this.sessions.delete(agentId)
        this.forgetLaunch(agentId)
      }
      return 'suspended'
    } finally {
      this.release(launch.sandboxName)
      // Dropped BEFORE the gate opens, so a waiter that resumes cannot observe a suspension that
      // is still registered and refuse itself in `suspendIfIdle`'s place.
      this.suspending.delete(agentId)
      opened()
    }
  }

  /** Agents this daemon currently holds a Sandbox for — the candidates an idle sweep considers. */
  launchedAgents(): string[] {
    return [...this.launches.keys()]
  }

  /**
   * Move a Sandbox to a mode, re-reading and re-deciding when the guarded write is rejected.
   *
   * The rejection deliberately does not claim what the intervening state was, so the only
   * correct response is to look again — and the retry budget is finite because a permanently
   * invalid patch would otherwise loop forever.
   */
  private setMode(agentId: string, desired: OperatingMode): Promise<OperatingMode | undefined> {
    const launch = this.launches.get(agentId)
    if (!launch) return Promise.reject(new Error(`no sandbox launch recorded for agent ${agentId}`))
    return this.queueMode(launch.sandboxName, desired)
  }

  /** Queued per Sandbox because it is the object both decisions patch. */
  private queueMode(sandboxName: string, desired: OperatingMode): Promise<OperatingMode | undefined> {
    const previous = this.modeQueue.get(sandboxName) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(() => this.applyMode(sandboxName, desired))
    // Keep the chain even when a link rejects, so a failed transition cannot strand the queue.
    this.modeQueue.set(
      sandboxName,
      next.then(
        () => undefined,
        () => undefined
      )
    )
    return next
  }

  private async applyMode(sandboxName: string, desired: OperatingMode): Promise<OperatingMode | undefined> {
    // The mode observed on the FIRST read, before this call changed anything. A later attempt
    // sees the state we produced, which would say nothing about where the launch started.
    let first: OperatingMode | undefined
    for (let attempt = 1; attempt <= MAX_MODE_ATTEMPTS; attempt += 1) {
      const sandbox = await this.deps.api.getSandbox(sandboxName)
      const observed = sandbox.spec?.operatingMode ?? 'Running'
      if (observed === desired) return first ?? observed
      first ??= observed
      try {
        await this.deps.api.setOperatingMode(sandboxName, desired, observed)
        this.deps.log.info(`cluster: sandbox ${sandboxName} → ${desired}`)
        return first
      } catch (err) {
        if (!(err instanceof OperatingModeRejectedError)) throw err
        this.metrics.writeRetry('rejected_precondition')
        this.deps.log.debug?.(`cluster: ${desired} write for ${sandboxName} rejected (attempt ${attempt}) — re-reading`)
      }
    }
    throw new Error(
      `sandbox ${sandboxName} would not accept ${desired} after ${MAX_MODE_ATTEMPTS} attempts — ` +
        `something else is changing its mode`
    )
  }

  private forgetSandbox(name: string): void {
    this.busy.delete(name)
    this.modeQueue.delete(name)
  }

  /** Hold the agent's Sandbox for `work`, including workspace preparation before launch. */
  async withSandbox<T>(agentId: string, work: () => Promise<T>): Promise<T> {
    const launch = await this.ensureSandbox(agentId)
    this.retain(launch.sandboxName)
    try {
      return await work()
    } finally {
      this.release(launch.sandboxName)
    }
  }

  /** Count work on a Sandbox so the idle sweep cannot suspend it. */
  private retain(sandboxName: string): void {
    this.busy.set(sandboxName, (this.busy.get(sandboxName) ?? 0) + 1)
  }

  private release(sandboxName: string): void {
    const left = (this.busy.get(sandboxName) ?? 0) - 1
    if (left > 0) {
      this.busy.set(sandboxName, left)
      return
    }
    this.busy.delete(sandboxName)
  }

  /** Forget an agent and delete its claim; the volume goes with it, which is the intent. */
  async removeAgent(agentId: string): Promise<void> {
    const launch = this.launches.get(agentId)
    this.launches.delete(agentId)
    if (launch) this.forgetSandbox(launch.sandboxName)
    this.workspaceRoots.delete(agentId)
    // The session outlives the claim otherwise, and `runsInSandbox` would keep answering true for
    // an agent whose pod is being deleted — sending the workspace seam into a sandbox that is gone.
    this.sessions.delete(agentId)
    this.deps.revokeChannel?.(agentId)
    await this.deps.api.deleteClaim(this.claimName(agentId))
  }

  /**
   * Treat a lost pod as an unplanned suspension rather than a new state: the channel drops,
   * the Sandbox is not Ready, and the next turn re-runs the wake path. The generation fence
   * keeps the departed incarnation from acting on the way out.
   */
  forgetLaunch(agentId: string): void {
    this.launches.delete(agentId)
    this.deps.revokeChannel?.(agentId)
  }

  currentLaunch(agentId: string): Launch | undefined {
    return this.launches.get(agentId)
  }

  private async awaitBoundSandbox(claimName: string): Promise<string> {
    const backoff = new Backoff({ baseMs: 250, capMs: 2_000, jitter: () => 0 })
    const deadline = this.clock.now() + (this.deps.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS)
    for (;;) {
      const claim = await this.deps.api.getClaim(claimName).catch((err: unknown) => {
        if (err instanceof K8sApiError && err.isNotFound) return undefined
        throw err
      })
      const name = claim?.status?.sandbox?.name
      // Bound is enough here; readiness is a separate wait that follows the resume.
      if (name) return name
      if (this.clock.now() >= deadline) {
        throw new LaunchTimeoutError(`claim ${claimName} did not bind a sandbox in time`)
      }
      await new Promise<void>((resolve) => this.clock.setTimeout(resolve, backoff.next()))
    }
  }

  /**
   * Start the runtime in the agent's Sandbox and hand `AcpHost` a stream pair.
   *
   * Command resolution is deliberately NOT done here: the request's command and hints are
   * passed through unresolved, because the shim resolves them in the filesystem the runtime
   * will actually read.
   */
  /**
   * Bring the agent's Sandbox up and wait for its shim to bind, WITHOUT starting a runtime.
   *
   * Separate from `launch` because the workspace has to be prepared before the runtime starts,
   * and for a cluster agent "prepared" means cloned onto the sandbox's own volume. A caller that
   * prepared first and launched afterwards would clone on the daemon's disk and hand the runtime
   * an empty workspace.
   */
  async ensureBoundChannel(
    agentId: string,
    timer?: LaunchTimer,
    grants: ShimCapability[] = RUNTIME_GRANTS
  ): Promise<ShimConnection> {
    const launch = await this.ensureSandbox(agentId, timer)
    this.retain(launch.sandboxName)
    try {
      return await this.bindChannel(agentId, launch, timer, grants)
    } finally {
      this.release(launch.sandboxName)
    }
  }

  private async bindChannel(
    agentId: string,
    launch: Launch,
    timer: LaunchTimer | undefined,
    grants: ShimCapability[]
  ): Promise<ShimConnection> {
    // Resume before waiting because suspension deleted the pod and readiness cannot arrive first.
    const modeBeforeWake = await this.setMode(agentId, 'Running')
    // A launch this daemon already has cached returns from ensureSandbox before any sandbox
    // read, so this is where the ordinary `launch → suspend → launch` resume learns what it is.
    // Without it that path — the COMMON one — reported `warm` and never entered resume p95.
    if (modeBeforeWake) timer?.observedPath(modeBeforeWake === 'Suspended' ? 'resume' : 'warm')
    timer?.mark('mode_running')
    const pod = await this.awaitReady(launch.sandboxName)
    timer?.mark('pod_ready')
    const channelTimeoutMs = this.deps.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS
    const waitingSince = this.clock.now()
    const connection = await this.deps
      .connectChannel(
        {
          agentId,
          sandboxUid: launch.sandboxUid,
          generation: launch.generation,
          grants: [...grants],
          podName: pod.podName
        },
        pod.podIp,
        channelTimeoutMs
      )
      .catch((err: unknown) => {
        // connectChannel is supplied by the host, so its error text is not ours to match on.
        // Elapsed-versus-the-deadline-we-set is a fact we own, and it is what distinguishes a
        // channel that never arrived from one that failed for another reason.
        if (this.clock.now() - waitingSince >= channelTimeoutMs) {
          throw new LaunchTimeoutError(`no shim channel bound for agent ${agentId} in time`)
        }
        throw err
      })
    timer?.mark('shim_handshake')
    this.recordWorkspaceRoot(agentId, connection)
    // The session is created HERE rather than in `launch`, because a channel bound for workspace
    // preparation needs one too — and a second session per agent would mean the runtime and the
    // workspace seam disagreeing about whether the channel is alive.
    const existing = this.sessions.get(agentId)
    if (existing && existing.generation === connection.binding.generation) {
      existing.attach(connection)
    } else {
      const session = new ShimSession(agentId, connection.binding.generation, {
        setTimeout: (fn, ms) => this.clock.setTimeout(fn, ms),
        clearTimeout: (handle) => this.clock.clearTimeout(handle as never)
      })
      session.attach(connection)
      this.sessions.set(agentId, session)
    }
    // After the session exists and before the caller can use the channel. Reported rather than
    // raised: a sandbox without its credential tunnel still runs, and refusing the launch would
    // turn one degraded feature into no agent at all.
    const ready = this.sessions.get(agentId)
    if (ready && this.deps.onChannelReady) {
      await this.deps.onChannelReady(agentId, ready).catch((err: unknown) => {
        this.deps.log.warn(`cluster: agent ${agentId} channel prepared with errors: ${(err as Error).message}`)
      })
    }
    return connection
  }

  /** The bound session for an agent, so the workspace seam reaches the same channel the runtime
   *  does rather than opening a second one that can disagree about whether it is alive. */
  sessionFor(agentId: string): ShimSession | undefined {
    return this.sessions.get(agentId)
  }

  /** Where the agent's bound pod mounts its workspace, or undefined before a bind (or when a
   *  legacy shim reported nothing — callers fall back to the historical mount). */
  workspaceRootFor(agentId: string): string | undefined {
    return this.workspaceRoots.get(agentId)
  }

  // Mirrors the CURRENT pod, absence included: a root kept from a previous incarnation (an image
  // rollback to a shim that reports none) names a mount this pod may not have — the exact failure
  // this seam exists to remove. Unset ⇒ callers fall back to the historical mount.
  private recordWorkspaceRoot(agentId: string, connection: ShimConnection): void {
    if (connection.workspaceRoot) this.workspaceRoots.set(agentId, connection.workspaceRoot)
    else this.workspaceRoots.delete(agentId)
  }

  async launch(request: SpawnRequest): Promise<SpawnedRuntime> {
    const agentId = request.env.AC_AGENT_ID
    if (!agentId) throw new Error('cluster launch requires AC_AGENT_ID in the runtime environment')
    const timer = new LaunchTimer(this.metrics, () => this.clock.now())
    // The Sandbox is held from before bind until runtime exit and released on every failure path.
    let held: string | undefined
    try {
      const bound = await this.ensureSandbox(agentId, timer)
      this.retain(bound.sandboxName)
      held = bound.sandboxName
      await this.ensureBoundChannel(agentId, timer)
      this.metrics.channel('bound')
      const session = this.sessions.get(agentId)
      if (!session) throw new Error(`no shim session for agent ${agentId} after binding its channel`)
      // The open is asynchronous, so the stage closes when the runtime reports — not when the
      // call returns. Marking it here measured the cost of constructing a stream pair and called
      // a runtime that never started a success.
      const runtime = createRemoteRuntime({
        session,
        request,
        log: this.deps.log,
        metrics: this.metrics,
        onRuntimeOpen: (outcome) => {
          // Only a successful open crossed the "runtime is up" boundary. A rejected one recorded
          // as a completed stage would sit in the runtime-ready latency distribution as a fast
          // success, and the stage histogram carries no outcome to filter it back out.
          if (outcome === 'ok') timer.mark('runtime_ready')
          timer.finish(outcome)
        }
      })
      // Runtime exit releases the hold so the next idle sweep can suspend the Sandbox.
      const sandboxName = held
      held = undefined
      runtime.onExit(() => this.release(sandboxName))
      return runtime
    } catch (err) {
      if (held) this.release(held)
      timer.finish(err instanceof LaunchTimeoutError ? 'timeout' : 'error')
      throw err
    }
  }

  /** Re-attach a renewed or replacement connection to the launch it belongs to. */
  onChannelBound(connection: ShimConnection): void {
    this.recordWorkspaceRoot(connection.binding.agentId, connection)
    const session = this.sessions.get(connection.binding.agentId)
    if (!session) return
    // Counted apart from the first bind: a re-establishment rate is the signal that renewals or
    // pod churn are happening more than they should, and pooling the two hides exactly that.
    this.metrics.channel('reestablished')
    session.attach(connection)
  }

  /** Report that an agent's channel is gone, so its runtime learns rather than hanging. */
  onChannelLost(agentId: string, reason: string): void {
    this.metrics.channel('dropped')
    const session = this.sessions.get(agentId)
    session?.lose(reason)
    // A lost session is TERMINAL, so it must not survive to meet the replacement pod: `attach()`
    // is a no-op once closed, and `bindChannel` re-attaches whenever the generations match — which
    // they would, because a cached launch keeps its own. The resumed sandbox would then bind a
    // channel whose session can never serve a request. Dropping both here is what makes the next
    // turn re-claim at a FRESH generation, which is the fence the replacement pod is bound against.
    if (session && this.sessions.get(agentId) === session) {
      this.sessions.delete(agentId)
      this.forgetLaunch(agentId)
    }
  }
}

/**
 * Bridge a shim ACP stream to the byte-stream pair `AcpHost` consumes.
 *
 * The stream survives credential renewal because it talks to a {@link ShimSession} rather
 * than to one socket: a renewal re-attaches underneath, and only a lost session ends the
 * runtime. Writes await their acknowledgement, so a runtime that is not draining applies
 * backpressure instead of letting the daemon queue without bound.
 */
function createRemoteRuntime(opts: {
  session: ShimSession
  request: SpawnRequest
  log: { info: (m: string) => void; warn: (m: string) => void }
  metrics?: ClusterMetrics
  /** Reports how the ACP open resolved. A timeout is separated from a failure because the two
   *  mean different things: one is a slow cluster, the other a runtime that will not start. */
  onRuntimeOpen?: (outcome: 'ok' | 'timeout' | 'error') => void
}): SpawnedRuntime {
  const exitListeners: Array<() => void> = []
  let stopped = false
  let streamId: string | undefined
  const inbound = new TransformStream<Uint8Array, Uint8Array>()
  const writer = inbound.writable.getWriter()

  const finish = (): void => {
    void writer.close().catch(() => undefined)
    for (const listener of exitListeners.splice(0)) listener()
  }

  const onEvent = (frame: { streamId: string; event: { kind: string; data?: string } }): void => {
    if (streamId && frame.streamId !== streamId) return
    if (frame.event.kind === 'chunk' && frame.event.data) {
      void writer.write(Buffer.from(frame.event.data, 'base64'))
      return
    }
    if (frame.event.kind === 'exit') {
      opts.session.offEvent(onEvent)
      finish()
    }
  }
  opts.session.onEvent(onEvent)
  // A lost session is a dead runtime: report terminal exit rather than leaving AcpHost
  // waiting on a stream that can never produce another byte.
  opts.session.onLost((reason) => {
    opts.log.warn(`cluster: shim channel lost for agent ${opts.session.agentId} (${reason})`)
    opts.session.offEvent(onEvent)
    finish()
  })

  const opened = opts.session
    .request('acp', {
      op: 'open',
      command: opts.request.command,
      args: opts.request.args,
      env: opts.request.env,
      ...(opts.request.hints ? { hints: opts.request.hints } : {})
    })
    .then((payload) => {
      streamId = (payload as { streamId?: string } | undefined)?.streamId
      if (!streamId) throw new Error('shim did not report a stream id for the ACP runtime')
    })

  const toAgent = new WritableStream<Uint8Array>({
    write: async (chunk) => {
      // AcpHost writes `initialize` the moment it has the stream, which can be before the
      // open round trip returns. Awaiting it here queues the write instead of dropping it.
      await opened
      if (!streamId) throw new Error('acp stream is not open')
      // Awaiting the ack is the backpressure: the shim only answers once the runtime's stdin
      // accepted the bytes.
      await opts.session.request('acp', {
        op: 'chunk',
        streamId,
        data: Buffer.from(chunk).toString('base64')
      })
    }
  })

  void opened.then(
    () => opts.onRuntimeOpen?.('ok'),
    (err: unknown) => {
      opts.log.warn(`cluster: runtime failed to start in the sandbox (${(err as Error).message})`)
      opts.onRuntimeOpen?.(err instanceof ShimRequestTimeoutError ? 'timeout' : 'error')
      finish()
    }
  )

  return {
    toAgent,
    fromAgent: inbound.readable,
    onExit: (listener) => exitListeners.push(listener),
    stop: async (deadlineMs) => {
      if (stopped) return
      stopped = true
      await opened.catch(() => undefined)
      if (streamId) {
        // A close that does not land means the rollout cannot confirm this runtime went quiet —
        // invisible before, because the failure was swallowed to keep teardown best-effort.
        await opts.session.request('acp', { op: 'close', streamId, deadlineMs }).catch(() => {
          opts.metrics?.drainTimeout()
          opts.log.warn(
            `cluster: runtime for agent ${opts.session.agentId} did not confirm close within ${deadlineMs}ms`
          )
        })
      }
      opts.session.offEvent(onEvent)
    }
  }
}
