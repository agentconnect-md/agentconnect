// The in-process executor entry (session-executors.md §11 step 4): this machine's own sandboxed sessions, started by their strategy's launcher with the local descriptor and bound as any executor's shim is — no Control Plane, no pipe, no handshake.
import { randomUUID, timingSafeEqual } from 'node:crypto'
import type { Socket } from 'node:net'
import { ClientTransport, systemClock, type Clock } from '@agentconnect.md/connection'
import type { SpawnDriver, SpawnRequest, SpawnedRuntime } from '../acp/spawn-driver.js'
import type { Logger } from '../log.js'
import { noopClusterMetrics } from '../metrics/cluster-metrics.js'
import { ChannelBinder } from '../remote/channel-binder.js'
import type { CodehostListener } from '../remote/codehost-spawn.js'
import { LaunchRegistry, type Launch, type LaunchGenerations } from '../remote/launch-registry.js'
import { sandboxSubjectAgentId } from '../remote/sandbox-subject.js'
import { RemoteShimDriver } from '../remote/shim-driver.js'
import type { ShimEndpoint, ShimEndpointProvider } from '../remote/shim-endpoint.js'
import { TunnelBinder } from '../remote/tunnel-binder.js'
import { spawnSubject, type SpawnRecord } from '../shim/binding.js'
import type { ShimTransport } from '../shim/client.js'
import { ShimDialer } from '../shim/dialer.js'
import { DEFAULT_SHIM_LISTEN_PORT } from '../shim/protocol.js'
import type { ShimSession } from '../shim/session.js'
import type { TunnelListenOptions, TunnelName } from '../shim/tunnel.js'
import { EXECUTOR_GRANTS } from './executor-plane.js'
import type { EnvironmentDescriptor, SessionEnvironment, StrategyLauncher } from './strategies.js'

// Renewal re-presents the same one-time token, so it proves nothing new here and only ends tunnel streams with a frame in flight (#2165).
const CREDENTIAL_TTL_MS = 24 * 60 * 60_000
// The launcher answers once the shim listens, so the dial has only a stream to open.
const CHANNEL_TIMEOUT_MS = 15_000
// The helper tunnels, which every local environment gets; a VM adds `codehost` through its own policy.
const LOCAL_TUNNELS: readonly TunnelName[] = ['agent', 'mcp']

/** One environment life on this machine: the descriptor it started from, what its launcher started, and the holds on it. */
interface LocalLaunch extends Launch {
  environment: EnvironmentDescriptor
  started?: Promise<SessionEnvironment>
  running?: SessionEnvironment
  holds: Array<() => void>
  /** Runtimes launched or launching into it, which a changed descriptor is refused over. */
  runtimes: number
  /** The `withEnvironment` operations on it, which end by themselves, so a changed descriptor waits them out. */
  operations: Set<Promise<void>>
}

export interface LocalExecutorDeps {
  launcher: StrategyLauncher
  /** This daemon's own allocator, the store's: a local environment's generation never goes backwards across restarts. */
  generations: LaunchGenerations
  // Refuse work for an agent this daemon no longer serves, including closures created before its departure.
  servesAgent?: (agentId: string) => boolean
  /** Where this daemon's own sockets are; a local VM reaches every one of them through its shim. */
  tunnelSocketPath: (tunnel: TunnelName, agentId: string) => string | undefined
  /** Tags a subject's daemon-socket connection with that subject (the agent channel binds a pod window to its pod). */
  tunnelGreeting?: (subject: string, tunnel: TunnelName) => Buffer | undefined
  /** Tunnels beyond the helpers an environment's agent gets (a VM's `codehost` and `provider`); omitted means none. */
  extraTunnelsFor?: (agentId: string) => TunnelName[]
  /** What a `listen` carries beside the name (`codehost`'s or `provider`'s routes and CA). */
  tunnelListenOptions?: (agentId: string, tunnel: TunnelName) => TunnelListenOptions | undefined
  log: Logger
  clock?: Clock
  /** Test seam: the dial's budget. */
  channelTimeoutMs?: number
}

export class LocalExecutor {
  private readonly registry: LaunchRegistry<LocalLaunch>
  private readonly endpoints: ShimEndpointProvider<LocalLaunch>
  private readonly dialer: ShimDialer
  private readonly tunnels: TunnelBinder
  private readonly binder: ChannelBinder<LocalLaunch>
  private readonly driver: RemoteShimDriver<LocalLaunch>
  /** The descriptor each environment was last asked for, which a launch the driver re-derives starts from. */
  private readonly latest = new Map<string, EnvironmentDescriptor>()
  // Serialize acquisitions with pending records and release cleanup for the same environment.
  private readonly recording = new Map<string, Promise<unknown>>()
  private readonly operations = new Set<Promise<unknown>>()
  private closed = false

  constructor(private readonly deps: LocalExecutorDeps) {
    const clock = deps.clock ?? systemClock
    this.registry = new LaunchRegistry<LocalLaunch>({
      generations: deps.generations,
      clock,
      ...(deps.servesAgent ? { servesAgent: deps.servesAgent } : {})
    })
    this.endpoints = {
      resolve: (launch) => this.resolve(launch),
      retain: (launch) => this.retain(launch),
      release: (launch) => launch.holds.pop()?.()
    }
    this.dialer = new ShimDialer({
      verifier: { reviewToken: (token) => Promise.resolve(this.review(token)) },
      dial: (url, options, record) => this.dial(url, options, record),
      onConnection: (connection) => this.binder.onChannelBound(connection),
      credentialTtlMs: CREDENTIAL_TTL_MS,
      clock,
      log: deps.log
    })
    // Both helper endpoints, as a local VM always had: its launch names the git-credential socket whatever the agent's credential is.
    this.tunnels = new TunnelBinder({
      tunnelsFor: (agentId) => [...LOCAL_TUNNELS, ...(deps.extraTunnelsFor?.(agentId) ?? [])],
      tunnelSocketPath: deps.tunnelSocketPath,
      ...(deps.tunnelGreeting === undefined ? {} : { tunnelGreeting: deps.tunnelGreeting }),
      ...(deps.tunnelListenOptions === undefined ? {} : { tunnelListenOptions: deps.tunnelListenOptions }),
      log: deps.log
    })
    this.binder = new ChannelBinder<LocalLaunch>({
      registry: this.registry,
      endpoints: this.endpoints,
      clock,
      log: deps.log,
      metrics: noopClusterMetrics,
      channelTimeoutMs: deps.channelTimeoutMs ?? CHANNEL_TIMEOUT_MS,
      connectChannel: (record, address, timeoutMs) => this.dialer.connect(address, record, timeoutMs),
      revokeChannel: (subject) => this.dialer.revoke(subject),
      onChannelReady: (subject, session) => this.tunnels.ensure(subject, session)
    })
    this.driver = new RemoteShimDriver<LocalLaunch>({
      ensureLaunch: (subject) => this.ensureLaunch(this.descriptorFor(subject)),
      endpoints: this.endpoints,
      binder: this.binder,
      grantsFor: () => EXECUTOR_GRANTS,
      clock,
      log: deps.log,
      metrics: noopClusterMetrics,
      codehostFor: (subject) => this.tunnels.listeningAt(subject, 'codehost')?.proxy,
      providerFor: (subject) => this.providerListener(subject)
    })
  }

  /** The `provider` listener of the subject's bound shim, asked for again since its slot is registered as the launch is built. */
  private async providerListener(subject: string) {
    const session = this.binder.sessionFor(subject)
    if (session) await this.tunnels.ensure(subject, session)
    return this.tunnels.listeningAt(subject, 'provider')?.proxy
  }

  /** The driver a host launches into this environment with. */
  driverFor(environment: EnvironmentDescriptor): SpawnDriver {
    return { launch: (request) => this.launch(environment, request) }
  }

  /** Run `work` over the environment's bound shim — started and bound without a runtime if need be — holding it against its owner's idle stop throughout. */
  async withEnvironment<T>(environment: EnvironmentDescriptor, work: (session: ShimSession) => Promise<T>): Promise<T> {
    if (this.closed) throw new Error('this daemon is shutting down')
    const operation = (async () => {
      const launch = await this.ensureLaunch(environment)
      this.assertCurrent(launch)
      this.endpoints.retain(launch)
      let done!: () => void
      const held = new Promise<void>((resolve) => (done = resolve))
      launch.operations.add(held)
      try {
        await this.driver.ensureBoundChannel(environment.id)
        this.assertCurrent(launch)
        const session = this.sessionFor(environment.id)
        if (!session) throw new Error(`environment ${environment.id} has no bound shim`)
        return await work(session)
      } finally {
        this.endpoints.release(launch)
        launch.operations.delete(held)
        done()
      }
    })()
    this.operations.add(operation)
    try {
      return await operation
    } finally {
      this.operations.delete(operation)
    }
  }

  /** The environment's bound shim session, or undefined while it has none. */
  sessionFor(id: string): ShimSession | undefined {
    const session = this.binder.sessionFor(id)
    return session?.isAttached() ? session : undefined
  }

  /** The code-host listener reported by this environment's current attached shim. */
  codehostFor(id: string): CodehostListener | undefined {
    return this.sessionFor(id) ? this.tunnels.listeningAt(id, 'codehost')?.proxy : undefined
  }

  // Fence every preparation immediately, then stop only this agent's environments, including pending starts.
  releaseAgent(agentId: string): Promise<void> {
    this.registry.bumpRelease(agentId)
    const subjects = new Set([
      ...this.registry.subjectsOf(agentId),
      ...[...this.latest.keys(), ...this.recording.keys()].filter((id) => sandboxSubjectAgentId(id) === agentId)
    ])
    const stopping = [...subjects].map((subject) => {
      const launch = this.registry.currentLaunch(subject)
      const pending = this.recording.get(subject)
      this.forget(subject, 'the agent is no longer served here')
      const stopped = (async () => {
        await pending?.catch(() => undefined)
        const running = await launch?.started?.catch(() => undefined)
        await running?.stop()
      })().finally(() => {
        if (this.recording.get(subject) === stopped) this.recording.delete(subject)
      })
      this.recording.set(subject, stopped)
      return stopped
    })
    return Promise.all(stopping).then(() => undefined)
  }

  /** Shutdown: no new operation, the ones in flight finish, and every launch goes; the environments are their owner's to stop (§9). */
  async stop(): Promise<void> {
    this.closed = true
    await Promise.allSettled([...this.operations])
    for (const { subject } of this.registry.launched()) this.forget(subject, 'the daemon is shutting down')
    this.tunnels.releaseAll('the daemon is shutting down')
    this.dialer.stop()
  }

  private async launch(environment: EnvironmentDescriptor, request: SpawnRequest): Promise<SpawnedRuntime> {
    const launch = await this.ensureLaunch(environment)
    launch.runtimes += 1
    let counted = true
    const uncount = () => {
      if (counted) launch.runtimes -= 1
      counted = false
    }
    let quiet: (() => void) | undefined
    let local: SessionEnvironment['local']
    let runtime: SpawnedRuntime
    try {
      local = (await this.start(launch)).local
      this.assertCurrent(launch)
      quiet = request.suppressChildStderr ? local?.quiet() : undefined
      // A complete-env shim takes nothing but what it is sent, so the environment's own base goes beneath the launch's.
      runtime = await this.driver.launch(
        { ...request, env: { ...local?.runtimeEnv, ...request.env } },
        { subject: environment.id, cwd: environment.cwd ?? environment.workspaceRoot }
      )
      this.assertCurrent(launch)
    } catch (error) {
      quiet?.()
      uncount()
      throw error
    }
    let exited = false
    runtime.onExit(() => {
      exited = true
      quiet?.()
      uncount()
    })
    return {
      ...runtime,
      stop: async (deadlineMs, eofGraceMs) => {
        await runtime.stop(deadlineMs, eofGraceMs)
        // A stop the shim never confirmed leaves a runtime nobody can reach, so its environment is fenced.
        if (!exited) local?.fail()
      }
    }
  }

  private descriptorFor(subject: string): EnvironmentDescriptor {
    const environment = this.latest.get(subject)
    if (!environment) throw new Error(`environment ${subject} is no longer launched on this machine`)
    return environment
  }

  /** The environment's current launch, or a new one: when there is none, or the descriptor now starts a different environment and no runtime holds the old one. */
  private async ensureLaunch(
    environment: EnvironmentDescriptor,
    releasedAt = this.registry.releaseFence(environment.id)
  ): Promise<LocalLaunch> {
    if (this.closed) throw new Error('this daemon is shutting down')
    this.registry.assertStillServed(environment.id, releasedAt)
    const pending = this.recording.get(environment.id)
    if (pending) {
      await pending.catch(() => undefined)
      return this.ensureLaunch(environment, releasedAt)
    }
    const current = this.registry.currentLaunch(environment.id)
    const same = current && (this.deps.launcher.sameEnvironment?.(current.environment, environment) ?? true)
    if (current && !same) {
      // A runtime holds its launch until it exits, but an operation (Git, a file) ends by itself, so the new descriptor waits for it.
      if (current.runtimes) throw new Error(`environment ${environment.id} configuration changed while active`)
      if (current.operations.size) {
        await Promise.allSettled([...current.operations])
        return this.ensureLaunch(environment, releasedAt)
      }
      this.forget(environment.id, 'its configuration changed')
    }
    // A launch that serves a narrower request keeps the descriptor it started from, which is what a re-derived launch must start again.
    if (current && same) return current
    this.latest.set(environment.id, environment)
    const recording = this.registry
      .recordLaunch(environment.id, randomUUID(), { environment, holds: [], runtimes: 0, operations: new Set() })
      .finally(() => {
        if (this.recording.get(environment.id) === recording) this.recording.delete(environment.id)
      })
    this.recording.set(environment.id, recording)
    return recording
  }

  private async resolve(launch: LocalLaunch): Promise<ShimEndpoint> {
    const running = await this.start(launch)
    this.assertCurrent(launch)
    launch.running = running
    // The address names nothing: the dial opens the environment's own stream, and the shim proves itself with its token.
    return { address: `ws://127.0.0.1:${DEFAULT_SHIM_LISTEN_PORT}`, peer: { name: launch.subject, proof: 'pod' } }
  }

  /** Start the launch's environment once; the launch lives exactly as long as it does. */
  private start(launch: LocalLaunch): Promise<SessionEnvironment> {
    this.assertCurrent(launch)
    if (!launch.started) {
      const started = this.deps.launcher.start({ environment: launch.environment, log: this.deps.log })
      launch.started = started
      started.then(
        (running) => {
          // However it ends — idle, a failure, a discard, shutdown — the next use starts it again at a new generation.
          const ended = () => {
            if (this.registry.currentLaunch(launch.subject) === launch)
              this.forget(launch.subject, 'its environment stopped')
          }
          void running.exited.then(ended, ended)
        },
        () => {
          if (launch.started === started) launch.started = undefined
        }
      )
    }
    return launch.started
  }

  private assertCurrent(launch: LocalLaunch): void {
    this.registry.assertStillServed(launch.subject, this.registry.releaseFence(launch.subject))
    if (this.registry.currentLaunch(launch.subject) !== launch)
      throw new Error(`environment ${launch.subject} is no longer launched on this machine`)
  }

  private retain(launch: LocalLaunch): void {
    let release = (): void => {}
    try {
      release = this.deps.launcher.hold?.(launch.environment) ?? release
    } catch {
      // Refused while the environment stops or fails, which the start this hold precedes reports.
    }
    launch.holds.push(release)
  }

  /** Which of this machine's environments presented the token: the local VM's constant-time compare, as its bound mode made it. */
  private review(token: string): { authenticated: boolean; podName?: string; podUid?: string; error?: string } {
    const presented = Buffer.from(token)
    for (const { subject } of this.registry.launched()) {
      const launch = this.registry.currentLaunch(subject)
      const identity = launch?.running?.local?.identity
      if (!launch || identity === undefined) continue
      const expected = Buffer.from(identity)
      if (presented.length === expected.length && timingSafeEqual(presented, expected))
        return { authenticated: true, podName: launch.subject, podUid: launch.sandboxUid }
    }
    return { authenticated: false, error: 'no environment on this machine presents that identity' }
  }

  private async dial(
    url: string,
    options: { subprotocol: string; path: string; handshakeTimeoutMs?: number },
    record: SpawnRecord
  ): Promise<ShimTransport> {
    const running = this.registry.currentLaunch(spawnSubject(record))?.running
    if (!running) throw new Error(`environment ${spawnSubject(record)} is not running`)
    const socket = await running.connect()
    try {
      return (await ClientTransport.dial(url, {
        ...options,
        createConnection: () => socket as unknown as Socket
      })) as unknown as ShimTransport
    } catch (error) {
      socket.destroy()
      throw error
    }
  }

  /** Give up a launch: the dial stops, the session ends with every runtime on it, and the next use records a new one. */
  private forget(subject: string, reason: string): void {
    const launch = this.registry.forgetLaunch(subject)
    this.latest.delete(subject)
    this.dialer.revoke(subject)
    this.binder.loseChannel(subject, reason)
    this.binder.forget(subject)
    this.tunnels.release(subject, reason)
    for (const release of launch?.holds.splice(0) ?? []) release()
  }
}
