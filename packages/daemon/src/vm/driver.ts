import { systemClock, type Clock } from '@agentconnect.md/connection'
import type { SpawnDriver, SpawnRequest, SpawnedRuntime } from '../acp/spawn-driver.js'
import type { ShimCapability } from '../shim/protocol.js'
import { DEFAULT_SHIM_LISTEN_PORT } from '../shim/protocol.js'
import { ShimFileSink } from '../shim/channels.js'
import { ShimSession } from '../shim/session.js'
import type { ShimDialer } from '../shim/dialer.js'
import { sanitizeWorkspaceRoot, type ShimConnection } from '../shim/connection.js'
import { createRemoteRuntime } from '../shim/remote-runtime.js'
import { RUNTIME_GRANTS } from '../shim/grants.js'
import { launchVmm, type RunningVmm, type VmmLaunch, type VmmProcessDeps } from './vmm-process.js'
import { vmNameFor, type VmBootRegistry } from './identity.js'

/** What a booted guest is, once its shim has bound: the pieces every later call needs. */
export interface VmLaunch {
  agentId: string
  vmName: string
  generation: number
  vm: RunningVmm
  session: ShimSession
  /** Where the guest mounts its workspace, as its shim reported it. */
  workspaceRoot?: string
}

/** Everything about a guest that is decided per agent rather than per daemon. */
export interface VmPlacement {
  bundlePath: string
  dataDiskPath: string
  consoleLogPath: string
  cpuCount: number
  memoryBytes: number
  /** Read-only share carrying this boot's shim secret; the tag the guest mounts it under. */
  bootShare?: { tag: string; path: string }
}

export interface VmDriverDeps {
  dialer: ShimDialer
  identities: VmBootRegistry
  /** Durable per-agent launch counter, so a restarted daemon never reuses a generation. */
  nextGeneration: (agentId: string) => Promise<number>
  /** Prepares the disposable rootfs clone, the persistent data disk and the boot-secret share. */
  place: (agentId: string, vmName: string, bootSecret: string) => Promise<VmPlacement>
  /** Releases what `place` created for a boot that is over. */
  unplace?: (agentId: string, vmName: string) => Promise<void>
  /** Host-wide budget, consulted BEFORE anything is created. Throws to refuse a launch. */
  admission?: { acquire: (agentId: string) => void; release: (agentId: string) => void }
  vmm: VmmProcessDeps
  grantsForAgent?: (agentId: string) => ShimCapability[]
  clock?: Clock
  log: { info: (m: string) => void; warn: (m: string) => void; debug?: (m: string) => void }
  /** How long a bound shim may take to answer the dial once the guest reports booting. */
  bindTimeoutMs?: number
  /** Guest vsock port the shim listens on. */
  shimPort?: number
  stopDeadlineMs?: number
}

const DEFAULT_BIND_TIMEOUT_MS = 30_000
const DEFAULT_STOP_DEADLINE_MS = 15_000

/**
 * Runs an agent's ACP runtime inside its own VM.
 *
 * Structurally the sibling of `K8sDriver`, and deliberately so: boot the sandbox, bind its shim,
 * materialize this launch's files, then hand `AcpHost` the same stream pair. Everything below the
 * bind is the shim protocol unchanged — `createRemoteRuntime`, `ShimSession` and `ShimDialer` do
 * not know a guest from a pod, because the daemon dials `ws://127.0.0.1:<forwarded>` and the helper
 * carries that to the guest over vsock.
 *
 * What it does NOT share with the cluster is the state machine around that: there is no claim, no
 * warm pool and no API server here, so a launch is just "is this agent's guest up, and is its shim
 * bound". Reusing `LaunchRegistry` and `SandboxLease` would have meant carrying cluster concepts
 * that have no meaning for a process this daemon owns outright.
 */
export class VmDriver implements SpawnDriver {
  private readonly launches = new Map<string, VmLaunch>()
  private readonly booting = new Map<string, Promise<VmLaunch>>()
  private readonly since = new Map<string, number>()
  private readonly holds = new Map<string, number>()
  private readonly clock: Clock

  constructor(private readonly deps: VmDriverDeps) {
    this.clock = deps.clock ?? systemClock
  }

  private get shimPort(): number {
    return this.deps.shimPort ?? DEFAULT_SHIM_LISTEN_PORT
  }

  /** Agents this daemon holds a guest for. A launch outlives the host it was made for. */
  launchedAgents(): Array<{ agentId: string; since: number }> {
    return [...this.launches.keys()].map((agentId) => ({ agentId, since: this.since.get(agentId) ?? 0 }))
  }

  /** Hold this agent's guest against the idle sweep for the duration of some work. The cluster
   *  path gets this from `SandboxLease`; a guest needs it for the same reason, and without it the
   *  sweep suspends a guest mid-turn and the runtime loses its channel with a prompt in flight. */
  retain(agentId: string): void {
    this.holds.set(agentId, (this.holds.get(agentId) ?? 0) + 1)
  }

  releaseHold(agentId: string): void {
    const held = (this.holds.get(agentId) ?? 0) - 1
    if (held > 0) this.holds.set(agentId, held)
    else this.holds.delete(agentId)
  }

  private isHeld(agentId: string): boolean {
    return (this.holds.get(agentId) ?? 0) > 0
  }

  currentLaunch(agentId: string): VmLaunch | undefined {
    return this.launches.get(agentId)
  }

  sessionFor(agentId: string): ShimSession | undefined {
    return this.launches.get(agentId)?.session
  }

  workspaceRootFor(agentId: string): string | undefined {
    return this.launches.get(agentId)?.workspaceRoot
  }

  /** Re-attach a replacement connection to the launch it belongs to. During the first bind the
   *  launch is not registered yet, so this is a no-op then and `boot` does the attach; afterwards
   *  it is how a shim that reconnected keeps serving the same session. */
  onChannelBound(connection: ShimConnection): void {
    const launch = this.launches.get(connection.binding.agentId)
    if (!launch || launch.generation !== connection.binding.generation) return
    launch.session.attach(connection)
    launch.workspaceRoot = sanitizeWorkspaceRoot(connection.workspaceRoot) ?? launch.workspaceRoot
  }

  /**
   * A dropped channel is NOT a lost launch here.
   *
   * The shim closes its channel on purpose at half the credential TTL so the daemon reconnects,
   * and the dialer is supervised, so a replacement binds on its own. Ending the launch on the close
   * stopped the guest during that renewal and the runtime died writing to a pipe nobody was reading
   * any more, mid-prompt.
   *
   * The cluster path needs a grace window to tell renewal from death because it cannot see the pod.
   * This one can: the guest is a process this daemon owns, so `vm.exited` is the authoritative end
   * of a launch and this only has to report.
   */
  onChannelLost(agentId: string, reason: string): void {
    if (!this.launches.has(agentId)) return
    this.deps.log.info(`vm: channel for agent "${agentId}" dropped (${reason}) — awaiting the shim's reconnect`)
  }

  runsInSandbox(agentId: string): boolean {
    return this.launches.has(agentId)
  }

  /** Boot and bind without starting a runtime, so the workspace can be prepared on the guest's own
   *  disk before the runtime looks at it. Idempotent, and single-flighted per agent. */
  async ensureChannel(agentId: string): Promise<VmLaunch> {
    const live = this.launches.get(agentId)
    if (live) return live
    const inFlight = this.booting.get(agentId)
    if (inFlight) return await inFlight
    const boot = this.boot(agentId).finally(() => this.booting.delete(agentId))
    this.booting.set(agentId, boot)
    return await boot
  }

  private async boot(agentId: string): Promise<VmLaunch> {
    // Before the generation is spent and before anything is created on disk: a refused launch must
    // leave no trace, and the operator's message must name the limit rather than a failed boot.
    this.deps.admission?.acquire(agentId)
    const generation = await this.deps.nextGeneration(agentId)
    const vmName = vmNameFor(agentId, generation)
    const secret = this.deps.identities.issue(vmName)
    let vm: RunningVmm | undefined
    try {
      const placement = await this.deps.place(agentId, vmName, secret)
      vm = await launchVmm(this.toVmmLaunch(placement), this.deps.vmm)
      const connection = await this.deps.dialer.connect(
        `ws://127.0.0.1:${vm.hostPort}`,
        {
          agentId,
          generation,
          sandboxUid: vmName,
          podName: vmName,
          grants: this.deps.grantsForAgent?.(agentId) ?? RUNTIME_GRANTS
        },
        this.deps.bindTimeoutMs ?? DEFAULT_BIND_TIMEOUT_MS
      )
      const session = new ShimSession(agentId, generation, {
        setTimeout: (fn, ms) => this.clock.setTimeout(fn, ms),
        clearTimeout: (handle) => this.clock.clearTimeout(handle as never)
      })
      session.attach(connection)
      const launch: VmLaunch = {
        agentId,
        vmName,
        generation,
        vm,
        session,
        ...(sanitizeWorkspaceRoot(connection.workspaceRoot)
          ? { workspaceRoot: sanitizeWorkspaceRoot(connection.workspaceRoot)! }
          : {})
      }
      this.launches.set(agentId, launch)
      this.since.set(agentId, this.clock.now())
      // A guest that goes away on its own ends its launch, so the next turn boots a fresh
      // generation instead of binding a session whose peer is gone.
      void vm.exited.then((exit) => {
        if (this.launches.get(agentId) !== launch) return
        this.deps.log.warn(`vm: guest for agent "${agentId}" exited (${exit.reason ?? 'no report'})`)
        void this.forget(agentId, launch)
      })
      this.deps.log.info(`vm: agent "${agentId}" bound to ${vmName} on 127.0.0.1:${vm.hostPort}`)
      return launch
    } catch (err) {
      this.deps.admission?.release(agentId)
      this.deps.identities.revoke(vmName)
      if (vm) await vm.stop(this.deps.stopDeadlineMs ?? DEFAULT_STOP_DEADLINE_MS).catch(() => undefined)
      await this.deps.unplace?.(agentId, vmName).catch(() => undefined)
      throw err
    }
  }

  private toVmmLaunch(placement: VmPlacement): VmmLaunch {
    return {
      bundlePath: placement.bundlePath,
      dataDiskPath: placement.dataDiskPath,
      consoleLogPath: placement.consoleLogPath,
      cpuCount: placement.cpuCount,
      memoryBytes: placement.memoryBytes,
      shimPort: this.shimPort,
      ...(placement.bootShare
        ? { shares: [{ tag: placement.bootShare.tag, path: placement.bootShare.path, readOnly: true }] }
        : {})
    }
  }

  /** Start the runtime in the agent's guest and hand `AcpHost` a stream pair. Command resolution
   *  stays below this seam: only the shim can look in the filesystem the runtime will read. */
  async launch(request: SpawnRequest): Promise<SpawnedRuntime> {
    const agentId = request.env.AC_AGENT_ID
    if (!agentId) throw new Error('vm launch requires AC_AGENT_ID in the runtime environment')
    const { session } = await this.ensureChannel(agentId)
    // Per launch, not per bind: a resumed guest is a new boot whose tmpfs starts empty.
    const sink = new ShimFileSink(session)
    for (const file of request.files ?? []) await sink.write(file.root, file.relPath, file.content)
    // Held from here until the runtime reaches terminal exit, so the idle sweep cannot suspend the
    // guest out from under a live ACP session.
    this.retain(agentId)
    const runtime = createRemoteRuntime({ session, request, log: this.deps.log })
    runtime.onExit(() => this.releaseHold(agentId))
    return runtime
  }

  /** Suspend a quiet agent's guest, keeping its data disk. `busy` means work still holds it and
   *  the caller should try again later; the next turn boots onto the same data disk. */
  async suspend(agentId: string): Promise<'suspended' | 'busy' | 'absent'> {
    const launch = this.launches.get(agentId)
    if (!launch) return 'absent'
    if (this.isHeld(agentId)) return 'busy'
    await this.forget(agentId, launch)
    return 'suspended'
  }

  /** No longer served here: the guest stops and its secret is retired; the data disk stays. */
  async releaseAgent(agentId: string): Promise<void> {
    const launch = this.launches.get(agentId)
    if (launch) await this.forget(agentId, launch)
  }

  private async forget(agentId: string, launch: VmLaunch): Promise<void> {
    if (this.launches.get(agentId) === launch) {
      this.launches.delete(agentId)
      this.since.delete(agentId)
      this.holds.delete(agentId)
    }
    this.deps.admission?.release(agentId)
    this.deps.identities.revoke(launch.vmName)
    launch.session.lose('guest stopped')
    await launch.vm.stop(this.deps.stopDeadlineMs ?? DEFAULT_STOP_DEADLINE_MS).catch(() => undefined)
    await this.deps.unplace?.(agentId, launch.vmName).catch(() => undefined)
  }

  async stop(): Promise<void> {
    // Every guest is asked to stop before any is waited on: sequential teardown of a dozen guests
    // takes minutes, because each one spends seconds in its own shutdown.
    await Promise.all([...this.launches.keys()].map((agentId) => this.releaseAgent(agentId)))
  }
}
