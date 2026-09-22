// The holder's execution plane for its sessions placed on other machines of the group (session-executors.md §4, §7): the pool's remote path with the Kubernetes half replaced by one relayed `prepare` and a TLS-PSK pipe.
import { randomUUID } from 'node:crypto'
import type { Socket } from 'node:net'
import { ClientTransport, systemClock, type Clock } from '@agentconnect.md/connection'
import type { ExecutorPrepareResult, ExecutorReleaseResult } from '@agentconnect.md/protocol'
import { sessionKeyDirName } from '../acp/host-key.js'
import type { RuntimeDef } from '../config/config-schema.js'
import { clusterMetrics } from '../metrics/cluster-metrics.js'
import { ChannelBinder } from '../remote/channel-binder.js'
import { LaunchRegistry } from '../remote/launch-registry.js'
import { sandboxSubjectSessionLeaf, sessionSandboxSubject, type SandboxSubject } from '../remote/sandbox-subject.js'
import { RemoteShimDriver } from '../remote/shim-driver.js'
import { TunnelBinder } from '../remote/tunnel-binder.js'
import { spawnSubject } from '../shim/binding.js'
import { ShimFileSink } from '../shim/channels.js'
import type { ShimTransport } from '../shim/client.js'
import { ShimDialer } from '../shim/dialer.js'
import { ShimGitRunner } from '../shim/git-exec.js'
import { ClusterSkillClient } from '../shim/skill-client.js'
import type { ShimCapability } from '../shim/protocol.js'
import { shimPaths } from '../shim/sandbox-paths.js'
import type { ShimSession } from '../shim/session.js'
import { ShimWorkspaceFs } from '../shim/workspace-fs-channel.js'
import type { TunnelName } from '../shim/tunnel.js'
import type { GitRunner } from '../workspace/git-runner.js'
import { SESSIONS_DIR, sessionDirIn, sessionHomeIn } from '../workspace/session-layout.js'
import type { WorkspacePlacement } from '../workspace/workspace-fs.js'
import { ExecutorEndpoints, ExecutorUnavailableError, type ExecutorLaunch } from './executor-endpoint.js'
import type { PlacementChoice } from './executor-placement.js'
import type { ExecutionPlane, PlaneLaunch, PlaneScope, PlaneSpawn } from './plane.js'

/** What a runtime in an executor environment may do. The pool's list without `automerge`: the merge-when-ready watcher runs in the holder process for a spread session (§7). */
const EXECUTOR_GRANTS: ShimCapability[] = [
  'acp',
  'materialize',
  'exec',
  'read',
  'tunnel',
  'skills',
  'skills-wide',
  'skills-receipts'
]

/** A day, as a local VM's binding credential takes (#2165): a renewal proves nothing new on a pipe that is already authenticated. */
const CREDENTIAL_TTL_MS = 24 * 60 * 60_000
const CHANNEL_TIMEOUT_MS = 60_000

/** One session this holder placed on another machine. */
export interface PlacedSession {
  agentId: string
  sessionKey: string
  leaf: string
  subject: SandboxSubject
  executorDaemonId: string
  strategy: string
  /** The launch this holder last prepared, so a retirement can name it; what it cannot name, the executor's backstop owns (§6). */
  launchId?: string
}

export interface ExecutorPlaneDeps {
  /** Sends `executor/prepare` through this daemon's control connection; a throw is "the CP could not be asked". */
  prepare: (launch: ExecutorLaunch) => Promise<ExecutorPrepareResult>
  /** Sends `executor/release`; a throw leaves the environment to the executor's backstop (§7). */
  release: (placed: PlacedSession, launchId: string) => Promise<ExecutorReleaseResult>
  /** The session's environment is gone: re-place it, record the new verdict and tell the user, or answer undefined to leave it where it is (§7). */
  replace: (placed: PlacedSession, lastSeenAt: string | null) => Promise<PlacementChoice | undefined>
  /** Which of this daemon's own sockets a session needs a tunnel to, and where each one is — the same policy the pool's plane is given. */
  tunnelsFor?: (agentId: string) => TunnelName[]
  tunnelSocketPath?: (tunnel: TunnelName) => string | undefined
  log: { info: (m: string) => void; warn: (m: string) => void; debug?: (m: string) => void }
  clock?: Clock
  /** Test seams: the dial's budget and the loss grace. */
  channelTimeoutMs?: number
  lossGraceMs?: number
}

/**
 * The bridge command an executor environment runs for this daemon's tool server: that machine's own
 * bundle, under the helper root its reply named, and undefined when it has none there.
 *
 * `node` is resolved by the shim in its OWN filesystem, which is where the command is spawned.
 */
export function executorMcpBridge(roots: {
  helperRoot?: string
  missingHelpers: string[]
}): { command: string; args: string[] } | undefined {
  if (roots.missingHelpers.includes('mcpBridgeEntry')) return undefined
  return { command: 'node', args: [shimPaths(undefined, roots.helperRoot).mcpBridgeEntry] }
}

/** The executor's daemon root, which its shim's reported workspace root (`<root>/sessions/<leaf>`) names; undefined when it reported something else. */
export function executorMount(workspaceRoot: string | undefined, leaf: string): string | undefined {
  const suffix = `/${SESSIONS_DIR}/${leaf}`
  if (!workspaceRoot?.endsWith(suffix)) return undefined
  return workspaceRoot.slice(0, -suffix.length)
}

export class ExecutorPlane implements ExecutionPlane {
  /** A session placed here runs in the executor's own directories, in the executor's coordinates. */
  readonly workspacesOffDisk = true
  private readonly placements = new Map<string, PlacedSession>()
  private readonly bySubject = new Map<string, PlacedSession>()
  private readonly registry: LaunchRegistry<ExecutorLaunch>
  private readonly binder: ChannelBinder<ExecutorLaunch>
  private readonly endpoints: ExecutorEndpoints
  private readonly dialer: ShimDialer
  private readonly tunnels: TunnelBinder
  private readonly driver: RemoteShimDriver<ExecutorLaunch>
  private readonly clock: Clock

  constructor(private readonly deps: ExecutorPlaneDeps) {
    this.clock = deps.clock ?? systemClock
    this.endpoints = new ExecutorEndpoints({
      prepare: (launch) => deps.prepare(launch),
      relocate: (launch, lastSeenAt) => this.relocate(launch, lastSeenAt),
      now: () => this.clock.now(),
      log: deps.log,
      ...(deps.lossGraceMs === undefined ? {} : { lossGraceMs: deps.lossGraceMs })
    })
    this.dialer = new ShimDialer({
      // No pod verifier: every peer of this dialer is an executor environment, whose proof is the pipe below (§6).
      dial: (url, options, record) => this.dialThroughPipe(url, options, record),
      onConnection: (connection) => this.binder.onChannelBound(connection),
      credentialTtlMs: CREDENTIAL_TTL_MS,
      metrics: clusterMetrics,
      clock: this.clock,
      log: deps.log
    })
    // The registry allocates nothing: the executor owns its environment's generation and names it in the reply, which `resolve` applies to the launch (§6).
    this.registry = new LaunchRegistry<ExecutorLaunch>({
      generations: { nextSandboxGeneration: () => Promise.resolve(0) },
      clock: this.clock
    })
    this.tunnels = new TunnelBinder({
      ...(deps.tunnelsFor === undefined ? {} : { tunnelsFor: deps.tunnelsFor }),
      ...(deps.tunnelSocketPath === undefined ? {} : { tunnelSocketPath: deps.tunnelSocketPath }),
      log: deps.log
    })
    this.binder = new ChannelBinder<ExecutorLaunch>({
      registry: this.registry,
      endpoints: this.endpoints,
      clock: this.clock,
      log: deps.log,
      metrics: clusterMetrics,
      channelTimeoutMs: deps.channelTimeoutMs ?? CHANNEL_TIMEOUT_MS,
      connectChannel: async (record, address, timeoutMs) => {
        try {
          return await this.dialer.connect(address, record, timeoutMs)
        } catch (error) {
          // The executor answered and the pipe would not open: the session does NOT move (§7), but this launch is given up so the next turn prepares a new one.
          this.forgetLaunch(spawnSubject(record), 'its pipe could not be opened')
          throw error
        }
      },
      revokeChannel: (subject) => this.dialer.revoke(subject),
      onChannelReady: (subject, session) => this.tunnels.ensure(subject, session)
    })
    this.driver = new RemoteShimDriver<ExecutorLaunch>({
      ensureLaunch: (subject) => this.ensureLaunch(subject),
      endpoints: this.endpoints,
      binder: this.binder,
      // No companion: an agent's own environment stays on its holder, so a session's launch is the only one held (§7).
      grantsFor: () => EXECUTOR_GRANTS,
      clock: this.clock,
      log: deps.log,
      metrics: clusterMetrics
    })
  }

  /** Record where a session was born, or where it moved to. */
  place(input: Omit<PlacedSession, 'subject' | 'leaf'>): PlacedSession {
    const leaf = sessionKeyDirName(input.sessionKey)
    const existing = this.placements.get(input.sessionKey)
    const placed: PlacedSession = Object.assign(
      existing ?? { ...input, leaf, subject: sessionSandboxSubject(input.agentId, leaf) },
      input
    )
    this.placements.set(placed.sessionKey, placed)
    this.bySubject.set(placed.subject, placed)
    return placed
  }

  /** Where a session is placed, or undefined for one that runs on this machine. */
  placementOf(sessionKey: string): PlacedSession | undefined {
    return this.placements.get(sessionKey)
  }

  /** The session one placed subject belongs to. */
  sessionKeyFor(subject: string): string | undefined {
    return this.bySubject.get(subject)?.sessionKey
  }

  /**
   * The roots this session's environment reported (§5): the daemon-side paths — the Git config
   * directory, the git-credential socket and the MCP endpoint — are derived from them rather than
   * from the image's constants, because an executor chose them. Undefined before its `prepare`.
   */
  rootsFor(sessionKey: string): { runtimeRoot: string; helperRoot?: string; missingHelpers: string[] } | undefined {
    const placed = this.placements.get(sessionKey)
    const ready = placed && this.registry.currentLaunch(placed.subject)?.ready
    if (!ready) return undefined
    return {
      runtimeRoot: ready.runtimeRoot,
      ...(ready.helperRoot === undefined ? {} : { helperRoot: ready.helperRoot }),
      missingHelpers: ready.missingHelpers ?? []
    }
  }

  /** The runtime a placed session starts: the command its executor named for its own install (§8), else this machine's definition as before. */
  runtimeDefFor(sessionKey: string, runtime: RuntimeDef): RuntimeDef {
    const placed = this.placements.get(sessionKey)
    const named = placed && this.registry.currentLaunch(placed.subject)?.ready?.runtimeLaunch
    return named ? { ...runtime, command: named.command, args: [...named.args] } : runtime
  }

  /** The roots of the session whose environment holds this path, for a caller that has one rather than a key. */
  rootsForPath(agentId: string, path: string | undefined): ReturnType<ExecutorPlane['rootsFor']> {
    const placed = this.placedFor({ agentId, ...(path === undefined ? {} : { path }) })
    return placed ? this.rootsFor(placed.sessionKey) : undefined
  }

  /**
   * Birth (§7): prepare this session's environment on the first candidate that takes it.
   *
   * `full` and every refusal move to the next candidate, which is what admission being the
   * executor's means for a holder — the counts it placed from are as fresh as a heartbeat, and
   * nothing of the session exists yet, so moving on costs nothing.
   */
  async prepareAt(
    agentId: string,
    sessionKey: string,
    choices: PlacementChoice[]
  ): Promise<{ placed: PlacedSession } | { refused: 'full' | 'none' }> {
    let full = false
    for (const choice of choices) {
      const placed = this.place({
        agentId,
        sessionKey,
        executorDaemonId: choice.daemonId,
        strategy: choice.strategy
      })
      try {
        await this.endpoints.resolve(await this.ensureLaunch(placed.subject))
        return { placed }
      } catch (error) {
        full ||= error instanceof ExecutorUnavailableError && error.why === 'full'
        this.forgetLaunch(placed.subject, 'nothing was prepared there')
        this.deps.log.warn(
          `executor: daemon ${choice.daemonId} prepared nothing for ${placed.leaf} (${message(error)})`
        )
      }
    }
    this.unplace(agentId, sessionKey)
    return { refused: full ? 'full' : 'none' }
  }

  /** The plane a scope resolves to: this one only for a session this holder placed elsewhere, and for the paths in its environment. */
  planeFor(scope: PlaneScope): ExecutionPlane | undefined {
    return this.placedFor(scope) ? this : undefined
  }

  /** Bring the session's environment up and bind its shim without starting a runtime, so its workspace can be prepared in it. */
  async ensureChannel(subject: SandboxSubject): Promise<void> {
    await this.driver.ensureBoundChannel(subject)
  }

  /** Run `work` while the session's environment is held against the idle sweep — one hold around the whole operation, as the pool takes one lease. */
  async withEnvironment<T>(subject: SandboxSubject, work: () => Promise<T>): Promise<T> {
    const launch = await this.ensureLaunch(subject)
    this.endpoints.retain(launch)
    try {
      await this.ensureChannel(subject)
      return await work()
    } finally {
      this.endpoints.release(launch)
    }
  }

  /** Where this session's paths are composed — the executor's own root — or undefined before its shim has reported one. */
  mountFor(subject: SandboxSubject): string | undefined {
    const leaf = sandboxSubjectSessionLeaf(subject)
    return leaf === undefined ? undefined : executorMount(this.binder.workspaceRootFor(subject), leaf)
  }

  /** The session's HOME on that root — the one its executor seeded from its own sign-in (§7, §8) — or undefined before a root is known. */
  homeFor(subject: SandboxSubject): string | undefined {
    const leaf = sandboxSubjectSessionLeaf(subject)
    const mount = this.mountFor(subject)
    return leaf === undefined || mount === undefined ? undefined : sessionHomeIn(sessionDirIn(mount, leaf))
  }

  /** The skills seam over one session's shim, as the pool's is over a pod's; undefined until its channel is bound. */
  skillClientFor(subject: string): ClusterSkillClient | undefined {
    const session = this.boundSession(subject)
    if (!session?.hasCapability('skills')) return undefined
    return new ClusterSkillClient(
      session,
      session.hasCapability('skills-wide'),
      false,
      session.hasCapability('skills-receipts')
    )
  }

  /** The environment incarnation a skill receipt is fenced on: the launch, which is one environment life. */
  workspaceIncarnationFor(subject: string): string | undefined {
    return this.registry.currentLaunch(subject)?.sandboxUid
  }

  shimGenerationFor(subject: string): number | undefined {
    return this.registry.currentLaunch(subject)?.generation
  }

  /** Subjects this holder has a launch for, and since when — the idle sweep's candidates. */
  launched(): Array<{ subject: SandboxSubject; agentId: string; since: number }> {
    return this.registry.launched()
  }

  /**
   * Idle (§7): the pipe closes and the launch goes with it — the coupling the pool's suspend path
   * already has — so the reply its `prepare` returned goes too and the next turn's new launch id
   * prepares the environment again.
   */
  suspendIdle(subject: SandboxSubject): Promise<'suspended' | 'busy' | 'absent'> {
    if (!this.registry.currentLaunch(subject)) return Promise.resolve('absent')
    if (this.endpoints.isHeld(subject)) return Promise.resolve('busy')
    this.forgetLaunch(subject, 'the session went idle')
    return Promise.resolve('suspended')
  }

  /** The holder retired the session: its environment goes, named by the launch this holder last prepared (§6). */
  async retire(agentId: string, sessionKey: string): Promise<void> {
    const placed = this.placements.get(sessionKey)
    if (!placed || placed.agentId !== agentId) return
    const launchId = this.registry.currentLaunch(placed.subject)?.launchId ?? placed.launchId
    this.forgetLaunch(placed.subject, 'the session retired')
    this.unplace(agentId, sessionKey)
    if (!launchId) return
    await this.deps
      .release(placed, launchId)
      .then((result) =>
        this.deps.log.info(
          `executor: released ${placed.leaf} on daemon ${placed.executorDaemonId} (${result.status === 'refused' ? `refused: ${result.reason}` : result.status})`
        )
      )
      .catch((error: unknown) =>
        // Never fatal: an unreleased environment is what the executor's own backstop collects (§7).
        this.deps.log.warn(
          `executor: releasing ${placed.leaf} failed (${message(error)}) — its executor will collect it`
        )
      )
  }

  /** This agent is no longer served here: its launches and channels go, and its environments stay for the successor to attach to (§7). */
  releaseAgent(agentId: string): void {
    for (const placed of [...this.placements.values()]) {
      if (placed.agentId !== agentId) continue
      this.forgetLaunch(placed.subject, 'the agent is no longer served here')
      this.unplace(agentId, placed.sessionKey)
    }
  }

  /** Forget where a session was placed; its environment is the caller's to release or leave. */
  private unplace(agentId: string, sessionKey: string): void {
    const placed = this.placements.get(sessionKey)
    if (!placed || placed.agentId !== agentId) return
    this.placements.delete(sessionKey)
    this.bySubject.delete(placed.subject)
  }

  // ExecutionPlane

  spawnFor({ hostKey }: PlaneLaunch): PlaneSpawn {
    // A placed session always has its own host, and the driver launches into the environment that host names.
    return { driver: this.driver, hostKey }
  }

  gitRunnerFor(agentId: string, cwd?: string, abort?: AbortSignal): GitRunner | undefined {
    const session = this.sessionForScope({ agentId, ...(cwd === undefined ? {} : { path: cwd }) })
    return session ? new ShimGitRunner(session, cwd, undefined, abort) : undefined
  }

  workspaceFsFor(agentId: string, scope?: Omit<PlaneScope, 'agentId'>): WorkspacePlacement | undefined {
    const placed = this.placedFor({ agentId, ...scope })
    const session = placed && this.boundSession(placed.subject)
    const root = placed && this.binder.workspaceRootFor(placed.subject)
    const mount = placed && this.mountFor(placed.subject)
    if (!session || !root || !mount) return undefined
    // The anchor is the shim's own root, which is the session's directory; the mount is the root the daemon composes paths on.
    return { fs: new ShimWorkspaceFs(session, root), mount }
  }

  async clearPath(agentId: string, root: string): Promise<string | undefined> {
    const session = this.sessionForScope({ agentId, path: root })
    if (!session) return `session ${root} has no bound channel to its executor`
    return await new ShimFileSink(session).clear(root)
  }

  /** A replaced workspace leaves every other session holding the old repository: each one's environment is released (§11). */
  async discardSessions(agentId: string, exceptLeaf?: string): Promise<void> {
    for (const placed of [...this.placements.values()]) {
      if (placed.agentId !== agentId || placed.leaf === exceptLeaf) continue
      await this.retire(agentId, placed.sessionKey)
    }
  }

  async stop(): Promise<void> {
    this.tunnels.releaseAll('the daemon is shutting down')
    this.dialer.stop()
    for (const { subject } of this.registry.launched()) this.registry.forgetLaunch(subject)
  }

  // Internals

  private async ensureLaunch(subject: SandboxSubject): Promise<ExecutorLaunch> {
    const placed = this.bySubject.get(subject)
    if (!placed) throw new Error(`session ${subject} is not placed on an executor`)
    const current = this.registry.currentLaunch(subject)
    if (current) return current
    // One uuid per launch, and the only identity `prepare` carries: a resend joins it, a new one advances the fence (§6).
    const launchId = randomUUID()
    placed.launchId = launchId
    return await this.registry.recordLaunch(subject, launchId, {
      leaf: placed.leaf,
      sessionKey: placed.sessionKey,
      executorDaemonId: placed.executorDaemonId,
      strategy: placed.strategy,
      launchId
    })
  }

  private async relocate(launch: ExecutorLaunch, lastSeenAt: string | null): Promise<PlacementChoice | undefined> {
    const placed = this.bySubject.get(launch.subject)
    if (!placed) return undefined
    const next = await this.deps.replace(placed, lastSeenAt).catch((error: unknown) => {
      this.deps.log.warn(`executor: re-placing ${placed.leaf} failed (${message(error)})`)
      return undefined
    })
    if (!next) return undefined
    this.place({ ...placed, executorDaemonId: next.daemonId, strategy: next.strategy })
    return next
  }

  /** Give up a launch: the pipe closes, the session ends, and the reply its `prepare` returned goes with them. */
  private forgetLaunch(subject: string, reason: string): void {
    this.dialer.revoke(subject)
    this.binder.loseChannel(subject, reason)
    this.binder.forget(subject)
    this.tunnels.release(subject, reason)
    this.registry.forgetLaunch(subject)
  }

  private boundSession(subject: string): ShimSession | undefined {
    const session = this.binder.sessionFor(subject)
    return session?.isAttached() ? session : undefined
  }

  private sessionForScope(scope: PlaneScope): ShimSession | undefined {
    const placed = this.placedFor(scope)
    return placed ? this.boundSession(placed.subject) : undefined
  }

  /** The placed session a scope names: its key when the caller holds one, else the session whose environment holds the path. */
  private placedFor(scope: PlaneScope): PlacedSession | undefined {
    const named = scope.sessionKey === undefined ? undefined : this.placements.get(scope.sessionKey)
    if (named) return named.agentId === scope.agentId ? named : undefined
    if (scope.sessionKey !== undefined || scope.path === undefined) return undefined
    for (const placed of this.placements.values()) {
      if (placed.agentId !== scope.agentId) continue
      const root = this.binder.workspaceRootFor(placed.subject)
      if (root && (scope.path === root || scope.path.startsWith(`${root}/`))) return placed
    }
    return undefined
  }

  private async dialThroughPipe(
    url: string,
    options: { subprotocol: string; path: string; handshakeTimeoutMs?: number },
    record: { agentId: string; subject?: string }
  ): Promise<ShimTransport> {
    const launch = this.registry.currentLaunch(spawnSubject(record))
    if (!launch) throw new Error(`session ${spawnSubject(record)} has no launch to dial`)
    const socket = await this.endpoints.connect(launch)
    try {
      // The dialer is handed a connected socket instead of opening one, exactly as the local VM starter does.
      return (await ClientTransport.dial(url, {
        ...options,
        createConnection: () => socket as unknown as Socket
      })) as unknown as ShimTransport
    } catch (error) {
      socket.destroy()
      throw error
    }
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
