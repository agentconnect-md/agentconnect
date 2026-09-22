// The holder's `ShimEndpointProvider` for a session placed on another machine (session-executors.md §6): §4's one sentence, which here is one `executor/prepare` the Control Plane relays, and then a TLS-PSK dial.
import { randomUUID } from 'node:crypto'
import type { TLSSocket } from 'node:tls'
import type { ExecutorPrepareResult, ExecutorReleaseResult } from '@agentconnect.md/protocol'
import type { LaunchTimer } from '../metrics/cluster-metrics.js'
import type { Launch } from '../remote/launch-registry.js'
import type { ShimEndpoint, ShimEndpointProvider } from '../remote/shim-endpoint.js'
import { dialPipe } from './executor-pipe.js'
import { executorLost, type PlacementChoice } from './executor-placement.js'

/** The `ready` answer a launch keeps for as long as it lives here: a re-dial and a second bind cost no round trip (§6). */
export type ExecutorReady = Extract<ExecutorPrepareResult, { status: 'ready' }>

/** One session's launch on an executor. The generation is the executor's, applied when its reply arrives; the holder allocates none. */
export interface ExecutorLaunch extends Launch {
  /** The leaf the executor keys the environment on, and the identity its pipe admits this holder by. */
  leaf: string
  sessionKey: string
  /** The machine this session is placed on; a lost environment moves it and this follows (§7). */
  executorDaemonId: string
  strategy: string
  /** The uuid naming this launch: a resend carries the same one, a new launch a new one (§6). */
  launchId: string
  ready?: ExecutorReady
}

/** A turn's launch could not be prepared. Retryable by nature: the environment is one `prepare` away once whatever refused it stops refusing. */
export class ExecutorUnavailableError extends Error {
  constructor(
    readonly why: string,
    message: string
  ) {
    super(message)
    this.name = 'ExecutorUnavailableError'
  }
}

export interface ExecutorEndpointDeps {
  /** Sends `executor/prepare` through this daemon's control connection; a throw is "the CP could not be asked", which is a wait, never a loss (§6). */
  prepare: (launch: ExecutorLaunch) => Promise<ExecutorPrepareResult>
  /** The session's environment is gone (§7): re-place it, tell the user, and answer where to prepare instead. Undefined leaves the session where it is. */
  relocate: (launch: ExecutorLaunch, lastSeenAt: string | null) => Promise<PlacementChoice | undefined>
  now: () => number
  log: { info: (m: string) => void; warn: (m: string) => void }
  /** Test seam: the TLS-PSK dial. */
  dialPipe?: typeof dialPipe
  /** Test seam: how long the executor's loss grace is. */
  lossGraceMs?: number
}

/** What the plane holds and the provider needs: the launches by subject, and the hold every dial and runtime takes. */
export class ExecutorEndpoints implements ShimEndpointProvider<ExecutorLaunch> {
  private readonly held = new Map<string, number>()

  constructor(private readonly deps: ExecutorEndpointDeps) {}

  retain(launch: ExecutorLaunch): void {
    this.held.set(launch.subject, (this.held.get(launch.subject) ?? 0) + 1)
  }

  release(launch: ExecutorLaunch): void {
    const held = (this.held.get(launch.subject) ?? 0) - 1
    if (held > 0) this.held.set(launch.subject, held)
    else this.held.delete(launch.subject)
  }

  /** Whether work still holds this subject's environment — the idle sweep's gate, read in one synchronous step. */
  isHeld(subject: string): boolean {
    return (this.held.get(subject) ?? 0) > 0
  }

  /** Prepare this launch's environment if it is not prepared already, and say where its pipe is. */
  async resolve(launch: ExecutorLaunch, timer?: LaunchTimer): Promise<ShimEndpoint> {
    const ready = launch.ready ?? (await this.prepareLaunch(launch))
    timer?.mark('pod_ready')
    // The name is the leaf, and the proof is the pipe: the dial below crosses one the executor keyed for this session alone (§6).
    return { address: `ws://${pipeAuthority(ready)}`, peer: { name: launch.leaf, proof: 'executor' } }
  }

  /** The socket a dial of this launch runs over: TLS-PSK with the key its `prepare` returned, under the session leaf as the identity. */
  async connect(launch: ExecutorLaunch): Promise<TLSSocket> {
    const ready = launch.ready
    if (!ready) throw new ExecutorUnavailableError('no_launch', `session ${launch.leaf} has no prepared environment`)
    return await (this.deps.dialPipe ?? dialPipe)({
      host: ready.endpoint.host,
      port: ready.endpoint.port,
      psk: ready.psk,
      identity: launch.leaf
    })
  }

  /**
   * One launch's `prepare`, and the three answers that are not a ready environment (§6, §7).
   *
   * A retired launch is the executor saying it has finished with the one being asked about, so the
   * holder mints a new one — that is what advances the fence after a wake or a restart. An executor
   * the CP cannot relay to is judged lazily, from the CP's own record of it. Everything else is a
   * refusal, and a refusal is not a loss: the environment is intact and the turn may simply retry.
   */
  private async prepareLaunch(launch: ExecutorLaunch): Promise<ExecutorReady> {
    // Bounded: each pass either settles the launch or replaces what it is asking (a new launch id, another machine).
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await this.deps.prepare(launch).catch((error: unknown) => {
        throw new ExecutorUnavailableError('control_plane', `the control plane could not be asked: ${text(error)}`)
      })
      if (result.status === 'ready') {
        // The binder binds at whatever the provider resolved, so the executor's number lands here and nowhere else.
        launch.generation = result.generation
        launch.ready = result
        return result
      }
      if (result.status === 'full') {
        throw new ExecutorUnavailableError('full', `executor ${launch.executorDaemonId} is at its session capacity`)
      }
      if (result.status === 'offline') {
        const moved = await this.moveOrWait(launch, result.lastSeenAt)
        if (!moved) throw new ExecutorUnavailableError('offline', `executor ${launch.executorDaemonId} is unreachable`)
        continue
      }
      if (result.reason !== 'launch_retired') {
        throw new ExecutorUnavailableError(
          result.reason,
          `executor ${launch.executorDaemonId} refused: ${result.reason}`
        )
      }
      // The environment stopped or its machine restarted: a new launch id, never a second key for the one it retired.
      renameLaunch(launch, randomUUID())
    }
    throw new ExecutorUnavailableError('unsettled', `session ${launch.leaf} could not be prepared on an executor`)
  }

  /** The loss rule's middle branch (§7): past the grace the session is prepared elsewhere, inside it the turn simply waits. */
  private async moveOrWait(launch: ExecutorLaunch, lastSeenAt: string | null): Promise<boolean> {
    const grace = this.deps.lossGraceMs === undefined ? {} : { graceMs: this.deps.lossGraceMs }
    if (!executorLost({ lastSeenAt, now: this.deps.now(), ...grace })) return false
    const next = await this.deps.relocate(launch, lastSeenAt)
    if (!next) return false
    this.deps.log.warn(
      `executor: session ${launch.leaf} moves to daemon ${next.daemonId} — its previous machine has been out of touch`
    )
    launch.executorDaemonId = next.daemonId
    launch.strategy = next.strategy
    // A new environment on another machine is a new launch, never the one the lost machine was asked about.
    renameLaunch(launch, randomUUID())
    return true
  }
}

/** A launch is renamed rather than replaced, so the registry entry the binder is holding stays the one being prepared. */
function renameLaunch(launch: ExecutorLaunch, launchId: string): void {
  launch.launchId = launchId
  // The incarnation the shim binding is fenced on: one launch, one environment life.
  launch.sandboxUid = launchId
  launch.ready = undefined
}

/** The dial's WebSocket authority, with the brackets an IPv6 literal needs. */
function pipeAuthority(ready: ExecutorReady): string {
  const { host, port } = ready.endpoint
  return `${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}`
}

function text(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** What a relayed `executor/release` answered, for the one log line a retirement gets. */
export function releaseOutcome(result: ExecutorReleaseResult): string {
  return result.status === 'refused' ? `refused (${result.reason})` : result.status
}
