import { Backoff, systemClock, type Clock } from '@agentconnect.md/connection'
import type { SpawnDriver, SpawnRequest, SpawnedRuntime } from '../acp/spawn-driver.js'
import type { ShimCapability } from '../shim/protocol.js'
import type { ShimConnection } from '../shim/listener.js'
import { ShimSession } from '../shim/session.js'
import type { SpawnRecord } from '../shim/binding.js'
import { OperatingModeRejectedError, isSandboxReady, type OperatingMode, type SandboxApi } from './sandbox-api.js'
import { K8sApiError } from './http.js'

/** Label domain the claim controller must be configured to allow. */
export const AC_LABEL_ORG = 'agentconnect.md/org'
export const AC_LABEL_AGENT = 'agentconnect.md/agent'

/** Annotation an image rollout writes to ask a daemon to quiesce a Sandbox. */
export const DRAIN_REQUESTED_ANNOTATION = 'agentconnect.md/drain-requested'

/** Capabilities a runtime launch receives. Narrow by construction: a launch gets exactly
 *  what the channels it uses require, so a future capability is an explicit decision. */
export const RUNTIME_GRANTS: ShimCapability[] = ['acp', 'materialize', 'exec', 'read', 'tunnel']

export interface ClusterDriverDeps {
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
export class ClusterSpawnDriver implements SpawnDriver {
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

  constructor(private readonly deps: ClusterDriverDeps) {
    this.clock = deps.clock ?? systemClock
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
  async ensureSandbox(agentId: string): Promise<Launch> {
    const existing = this.launches.get(agentId)
    if (existing) return existing
    const name = this.claimName(agentId)
    await this.deps.api.ensureClaim({
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
    const sandbox = await this.deps.api.getSandbox(sandboxName)
    const sandboxUid = sandbox.metadata?.uid
    if (!sandboxUid) throw new Error(`sandbox ${sandboxName} has no metadata.uid to bind against`)
    const generation = (this.generations.get(agentId) ?? 0) + 1
    this.generations.set(agentId, generation)
    const launch: Launch = { agentId, sandboxName, sandboxUid, generation }
    this.launches.set(agentId, launch)
    // The record must exist before the shim can bind: the handshake resolves a pod against
    // it, and an unpublished launch is indistinguishable from a pod we never started.
    this.deps.publishSpawnRecord({ agentId, sandboxUid, generation, grants: [...RUNTIME_GRANTS] })
    return launch
  }

  /** Wait for the Sandbox to report Ready, after something has asked it to run. */
  private async awaitReady(sandboxName: string): Promise<void> {
    const backoff = new Backoff({ baseMs: 250, capMs: 2_000, jitter: () => 0 })
    const deadline = this.clock.now() + (this.deps.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS)
    for (;;) {
      const sandbox = await this.deps.api.getSandbox(sandboxName).catch(() => undefined)
      if (sandbox && isSandboxReady(sandbox)) return
      if (this.clock.now() >= deadline) throw new Error(`sandbox ${sandboxName} did not become ready in time`)
      await new Promise<void>((resolve) => this.clock.setTimeout(resolve, backoff.next()))
    }
  }

  /** Wake a suspended Sandbox, or confirm it is already running. */
  async wake(agentId: string): Promise<void> {
    if (this.draining.has(agentId)) {
      // A drain request is in flight: new messages queue rather than reviving the instance,
      // or one message would resurrect the image the rollout is replacing.
      this.deps.log.info(`cluster: holding agent ${agentId} suspended — a drain request is pending`)
      return
    }
    await this.setMode(agentId, 'Running')
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
  private setMode(agentId: string, desired: OperatingMode): Promise<void> {
    const previous = this.modeQueue.get(agentId) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(() => this.applyMode(agentId, desired))
    // Keep the chain even when a link rejects, so a failed transition cannot strand the queue.
    this.modeQueue.set(
      agentId,
      next.catch(() => undefined)
    )
    return next
  }

  private async applyMode(agentId: string, desired: OperatingMode): Promise<void> {
    const launch = this.launches.get(agentId)
    if (!launch) throw new Error(`no sandbox launch recorded for agent ${agentId}`)
    for (let attempt = 1; attempt <= MAX_MODE_ATTEMPTS; attempt += 1) {
      const sandbox = await this.deps.api.getSandbox(launch.sandboxName)
      const observed = sandbox.spec?.operatingMode ?? 'Running'
      if (observed === desired) return
      try {
        await this.deps.api.setOperatingMode(launch.sandboxName, desired, observed)
        this.deps.log.info(`cluster: agent ${agentId} sandbox ${launch.sandboxName} → ${desired}`)
        return
      } catch (err) {
        if (!(err instanceof OperatingModeRejectedError)) throw err
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
        throw new Error(`claim ${claimName} did not bind a sandbox in time`)
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
  async launch(request: SpawnRequest): Promise<SpawnedRuntime> {
    const agentId = request.env.AC_AGENT_ID
    if (!agentId) throw new Error('cluster launch requires AC_AGENT_ID in the runtime environment')
    if (this.draining.has(agentId)) {
      // Launching now would wait out the readiness timeout against a sandbox we are
      // deliberately holding down. Say so instead of timing out.
      throw new Error(`agent ${agentId} is draining for an image rollout — retry once it clears`)
    }
    const launch = await this.ensureSandbox(agentId)
    // Resume BEFORE waiting: suspension deleted the pod, so readiness cannot arrive until
    // something asks for Running.
    await this.wake(agentId)
    await this.awaitReady(launch.sandboxName)
    const connection = await this.deps.awaitChannel(
      agentId,
      launch.generation,
      this.deps.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS
    )
    const session = new ShimSession(agentId, launch.generation, {
      setTimeout: (fn, ms) => this.clock.setTimeout(fn, ms),
      clearTimeout: (handle) => this.clock.clearTimeout(handle as never)
    })
    session.attach(connection)
    this.sessions.set(agentId, session)
    return createRemoteRuntime({ session, request, log: this.deps.log })
  }

  /** Re-attach a renewed or replacement connection to the launch it belongs to. */
  onChannelBound(connection: ShimConnection): void {
    this.sessions.get(connection.binding.agentId)?.attach(connection)
  }

  /** Report that an agent's channel is gone, so its runtime learns rather than hanging. */
  onChannelLost(agentId: string, reason: string): void {
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

  void opened.catch((err: unknown) => {
    opts.log.warn(`cluster: runtime failed to start in the sandbox (${(err as Error).message})`)
    finish()
  })

  return {
    toAgent,
    fromAgent: inbound.readable,
    onExit: (listener) => exitListeners.push(listener),
    stop: async (deadlineMs) => {
      if (stopped) return
      stopped = true
      await opened.catch(() => undefined)
      if (streamId) {
        await opts.session.request('acp', { op: 'close', streamId, deadlineMs }).catch(() => undefined)
      }
      opts.session.offEvent(onEvent)
    }
  }
}
