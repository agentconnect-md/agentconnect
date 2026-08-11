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
  type SandboxApi
} from './sandbox-api.js'
import { K8sApiError } from './http.js'

/** Label domain the claim controller must be configured to allow. */
export const AC_LABEL_ORG = 'agentconnect.md/org'
export const AC_LABEL_AGENT = 'agentconnect.md/agent'

/** Annotation an image rollout writes to ask a daemon to quiesce a Sandbox. */
export const DRAIN_REQUESTED_ANNOTATION = 'agentconnect.md/drain-requested'

/**
 * Where agent-sandbox records the pod a Sandbox is currently backed by.
 *
 * This is the ONLY way the daemon can map a dialing pod back to the launch that started it: a
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

/** Capabilities a runtime launch receives. Narrow by construction: a launch gets exactly
 *  what the channels it uses require, so a future capability is an explicit decision. */
export const RUNTIME_GRANTS: ShimCapability[] = ['acp', 'materialize', 'exec', 'read', 'tunnel', 'probe']

export interface K8sDriverDeps {
  api: SandboxApi
  orgId: string
  /** Pool the claim references; v1beta1 requires one, and a cold pool is `replicas: 0`. */
  warmPoolName: string
  /** Waits for a bound shim channel for this agent's current launch. */
  awaitChannel: (agentId: string, generation: number, timeoutMs: number) => Promise<ShimConnection>
  /** Publishes the spawn record the shim handshake resolves a pod against. */
  publishSpawnRecord: (record: SpawnRecord) => void
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
  /** Agents whose Sandbox carries a drain request: hold off waking until it clears. */
  private readonly draining = new Set<string>()
  /** Per-agent transition queue. A guarded write protects competing writes, but it cannot
   *  protect a decision that performs NO write: a later wake could observe Running and
   *  return while an earlier suspend patch was still in flight, and the older write would
   *  then land last and reverse the newer decision. Serializing removes that entirely. */
  private readonly modeQueue = new Map<string, Promise<void>>()
  /** Logical channels per agent, which survive the shim's credential renewals. */
  private readonly sessions = new Map<string, ShimSession>()
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
    const existing = this.launches.get(agentId)
    if (existing) return existing
    const name = this.claimName(agentId)
    const ensured = await this.deps.api.ensureClaim({
      metadata: {
        name,
        annotations: undefined
      } as { name: string },
      spec: {
        warmPoolRef: { name: this.deps.warmPoolName },
        additionalPodMetadata: { labels: { [AC_LABEL_ORG]: this.deps.orgId, [AC_LABEL_AGENT]: agentId } }
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
  // Returns the pod backing the ready Sandbox. Resolved HERE rather than at claim time because
  // warm-pool adoption writes the annotation as the pod is bound and suspension clears it, so a
  // name read any earlier belongs to the previous incarnation — and binding the next launch
  // against it would authorize the wrong pod.
  private async awaitReady(sandboxName: string, onPodResolved: (podName: string) => void): Promise<string> {
    const backoff = new Backoff({ baseMs: 250, capMs: 2_000, jitter: () => 0 })
    const deadline = this.clock.now() + (this.deps.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS)
    let resolved: string | undefined
    for (;;) {
      const sandbox = await this.deps.api.getSandbox(sandboxName).catch(() => undefined)
      // The pod is named as soon as it is bound, which is BEFORE it reports Ready — and the shim
      // dials from a pod that is merely running. Publishing here rather than after readiness is
      // what keeps that dial from arriving ahead of the record that authorizes it.
      const podName = sandbox ? resolvePodName(sandbox) : undefined
      if (podName && podName !== resolved) {
        resolved = podName
        onPodResolved(podName)
      }
      if (sandbox && isSandboxReady(sandbox)) {
        if (!resolved) throw new Error(`sandbox ${sandboxName} is ready but names no pod`)
        return resolved
      }
      if (this.clock.now() >= deadline) {
        throw new LaunchTimeoutError(`sandbox ${sandboxName} did not become ready in time`)
      }
      await new Promise<void>((resolve) => this.clock.setTimeout(resolve, backoff.next()))
    }
  }

  /** Wake a suspended Sandbox, or confirm it is already running. Reports the mode it found, which
   *  is the only place a CACHED launch can learn whether it is resuming or already warm. */
  async wake(agentId: string): Promise<OperatingMode | undefined> {
    if (this.draining.has(agentId)) {
      // A drain request is in flight: new messages queue rather than reviving the instance,
      // or one message would resurrect the image the rollout is replacing.
      this.deps.log.info(`cluster: holding agent ${agentId} suspended — a drain request is pending`)
      return undefined
    }
    return await this.setMode(agentId, 'Running')
  }

  /** Suspend an idle Sandbox. The object and its volume survive; only the pod goes. */
  async suspend(agentId: string): Promise<void> {
    await this.setMode(agentId, 'Suspended')
  }

  /**
   * Move a Sandbox to a mode, re-reading and re-deciding when the guarded write is rejected.
   *
   * The rejection deliberately does not claim what the intervening state was, so the only
   * correct response is to look again — and the retry budget is finite because a permanently
   * invalid patch would otherwise loop forever.
   */
  private setMode(agentId: string, desired: OperatingMode): Promise<OperatingMode | undefined> {
    const previous = this.modeQueue.get(agentId) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(() => this.applyMode(agentId, desired))
    // Keep the chain even when a link rejects, so a failed transition cannot strand the queue.
    this.modeQueue.set(
      agentId,
      next.then(
        () => undefined,
        () => undefined
      )
    )
    return next
  }

  private async applyMode(agentId: string, desired: OperatingMode): Promise<OperatingMode | undefined> {
    const launch = this.launches.get(agentId)
    if (!launch) throw new Error(`no sandbox launch recorded for agent ${agentId}`)
    // The mode observed on the FIRST read, before this call changed anything. A later attempt
    // sees the state we produced, which would say nothing about where the launch started.
    let first: OperatingMode | undefined
    for (let attempt = 1; attempt <= MAX_MODE_ATTEMPTS; attempt += 1) {
      const sandbox = await this.deps.api.getSandbox(launch.sandboxName)
      const observed = sandbox.spec?.operatingMode ?? 'Running'
      if (observed === desired) return first ?? observed
      first ??= observed
      try {
        await this.deps.api.setOperatingMode(launch.sandboxName, desired, observed)
        this.deps.log.info(`cluster: agent ${agentId} sandbox ${launch.sandboxName} → ${desired}`)
        return first
      } catch (err) {
        if (!(err instanceof OperatingModeRejectedError)) throw err
        this.metrics.writeRetry('rejected_precondition')
        this.deps.log.debug?.(
          `cluster: ${desired} write for ${launch.sandboxName} rejected (attempt ${attempt}) — re-reading`
        )
      }
    }
    throw new Error(
      `sandbox ${launch.sandboxName} would not accept ${desired} after ${MAX_MODE_ATTEMPTS} attempts — ` +
        `something else is changing its mode`
    )
  }

  /**
   * Observe a Sandbox's drain annotation. While it is present the daemon must not wake the
   * instance: the rollout is waiting for it to stay down long enough to change its image,
   * and a single arriving message would otherwise revive the old one.
   */
  onSandboxObserved(agentId: string, annotations: Record<string, string> | undefined): void {
    const requested = annotations?.[DRAIN_REQUESTED_ANNOTATION]
    if (requested && !this.draining.has(agentId)) {
      this.draining.add(agentId)
      this.deps.log.info(`cluster: drain requested for agent ${agentId} (${requested})`)
      return
    }
    if (!requested && this.draining.delete(agentId)) {
      this.deps.log.info(`cluster: drain request cleared for agent ${agentId} — resuming normally`)
    }
  }

  isDraining(agentId: string): boolean {
    return this.draining.has(agentId)
  }

  /** Forget an agent and delete its claim; the volume goes with it, which is the intent. */
  async removeAgent(agentId: string): Promise<void> {
    this.launches.delete(agentId)
    this.draining.delete(agentId)
    await this.deps.api.deleteClaim(this.claimName(agentId))
  }

  /**
   * Treat a lost pod as an unplanned suspension rather than a new state: the channel drops,
   * the Sandbox is not Ready, and the next turn re-runs the wake path. The generation fence
   * keeps the departed incarnation from acting on the way out.
   */
  forgetLaunch(agentId: string): void {
    this.launches.delete(agentId)
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
  async ensureBoundChannel(agentId: string, timer?: LaunchTimer): Promise<ShimConnection> {
    if (this.draining.has(agentId)) {
      throw new Error(`agent ${agentId} is draining for an image rollout — retry once it clears`)
    }
    const launch = await this.ensureSandbox(agentId, timer)
    // Resume BEFORE waiting: suspension deleted the pod, so readiness cannot arrive until
    // something asks for Running.
    const modeBeforeWake = await this.wake(agentId)
    // A launch this daemon already has cached returns from ensureSandbox before any sandbox
    // read, so this is where the ordinary `launch → suspend → launch` resume learns what it is.
    // Without it that path — the COMMON one — reported `warm` and never entered resume p95.
    if (modeBeforeWake) timer?.observedPath(modeBeforeWake === 'Suspended' ? 'resume' : 'warm')
    timer?.mark('mode_running')
    // Published the moment the Sandbox names its pod, which is before readiness — the record has
    // to exist by the time the shim dials, and the pod it authorizes is not knowable any earlier.
    // Publishing at claim time instead would name the PREVIOUS incarnation's pod, authorizing the
    // wrong one for as long as the window lasted.
    await this.awaitReady(launch.sandboxName, (podName) => {
      this.deps.publishSpawnRecord({
        agentId,
        sandboxUid: launch.sandboxUid,
        generation: launch.generation,
        grants: [...RUNTIME_GRANTS],
        podName
      })
    })
    timer?.mark('pod_ready')
    const channelTimeoutMs = this.deps.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS
    const waitingSince = this.clock.now()
    const connection = await this.deps
      .awaitChannel(agentId, launch.generation, channelTimeoutMs)
      .catch((err: unknown) => {
        // awaitChannel is supplied by the host, so its error text is not ours to match on.
        // Elapsed-versus-the-deadline-we-set is a fact we own, and it is what distinguishes a
        // channel that never arrived from one that failed for another reason.
        if (this.clock.now() - waitingSince >= channelTimeoutMs) {
          throw new LaunchTimeoutError(`no shim channel bound for agent ${agentId} in time`)
        }
        throw err
      })
    timer?.mark('shim_handshake')
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
    return connection
  }

  /** The bound session for an agent, so the workspace seam reaches the same channel the runtime
   *  does rather than opening a second one that can disagree about whether it is alive. */
  sessionFor(agentId: string): ShimSession | undefined {
    return this.sessions.get(agentId)
  }

  async launch(request: SpawnRequest): Promise<SpawnedRuntime> {
    const agentId = request.env.AC_AGENT_ID
    if (!agentId) throw new Error('cluster launch requires AC_AGENT_ID in the runtime environment')
    if (this.draining.has(agentId)) {
      // Launching now would wait out the readiness timeout against a sandbox we are
      // deliberately holding down. Say so instead of timing out.
      this.metrics.launch('warm', 'draining', 0)
      throw new Error(`agent ${agentId} is draining for an image rollout — retry once it clears`)
    }
    const timer = new LaunchTimer(this.metrics, () => this.clock.now())
    try {
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
      return runtime
    } catch (err) {
      // Timeouts are the interesting failure — they are what a missed target looks like — so they
      // are distinguished from an outright error. By TYPE: all three launch deadlines (claim bind,
      // pod readiness, channel bind) throw LaunchTimeoutError, and the message regex this replaced
      // silently stopped covering the channel wait the moment its wording changed.
      timer.finish(err instanceof LaunchTimeoutError ? 'timeout' : 'error')
      throw err
    }
  }

  /** Re-attach a renewed or replacement connection to the launch it belongs to. */
  onChannelBound(connection: ShimConnection): void {
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
    this.sessions.get(agentId)?.lose(reason)
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
