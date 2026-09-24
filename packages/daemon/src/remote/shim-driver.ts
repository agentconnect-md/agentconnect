import { LaunchTimer, type ClusterMetrics } from '../metrics/cluster-metrics.js'
import type { Clock } from '@agentconnect.md/connection'
import { clearSpawnDirs, type SpawnDriver, type SpawnRequest, type SpawnedRuntime } from '../acp/spawn-driver.js'
import type { ShimCapability } from '../shim/protocol.js'
import type { ShimConnection } from '../shim/connection.js'
import { ShimFileSink } from '../shim/channels.js'
import { withStartupPhase } from '../session/startup-progress.js'
import type { ChannelBinder } from './channel-binder.js'
import type { Launch } from './launch-registry.js'
import { createRemoteRuntime } from './remote-runtime.js'
import {
  agentSandboxSubject,
  sandboxSubjectAgentId,
  sandboxSubjectFor,
  type SandboxSubject
} from './sandbox-subject.js'
import { LaunchTimeoutError, type ShimEndpointProvider } from './shim-endpoint.js'

export interface RemoteShimDriverDeps<L extends Launch = Launch> {
  /** Obtain the subject's launch, creating whatever backs it; idempotent. */
  ensureLaunch: (subject: SandboxSubject, timer?: LaunchTimer) => Promise<L>
  endpoints: ShimEndpointProvider<L>
  binder: ChannelBinder<L>
  /** What this subject's channel may do when the caller names no grants. */
  grantsFor: (subject: string) => ShimCapability[]
  clock: Clock
  log: { info: (m: string) => void; warn: (m: string) => void; debug?: (m: string) => void }
  metrics: ClusterMetrics
}

/** Runs an ACP runtime through a shim it dials: bind at the launch's generation, write its files, open the runtime, hold the sandbox until it exits. */
export class RemoteShimDriver<L extends Launch = Launch> implements SpawnDriver {
  constructor(private readonly deps: RemoteShimDriverDeps<L>) {}

  // Bring the sandbox up and bind its shim WITHOUT starting a runtime: a "prepared workspace" is cloned onto the sandbox's own volume, before the runtime starts.
  async ensureBoundChannel(
    subject: SandboxSubject,
    timer?: LaunchTimer,
    grants?: ShimCapability[]
  ): Promise<ShimConnection> {
    const launch = await this.deps.ensureLaunch(subject, timer)
    const bind = () => this.deps.binder.bindChannel(subject, launch, timer, grants ?? this.deps.grantsFor(subject))
    return this.deps.binder.sessionFor(subject)?.isAttached() ? await bind() : await withStartupPhase('sandbox', bind)
  }

  // Start the runtime and hand `AcpHost` a stream pair; command resolution is deliberately NOT done here, the shim resolves it in the filesystem the runtime will read.
  async launch(request: SpawnRequest, target?: { subject: SandboxSubject; cwd?: string }): Promise<SpawnedRuntime> {
    const agentId = request.env.AC_AGENT_ID
    if (!agentId) throw new Error('cluster launch requires AC_AGENT_ID in the runtime environment')
    // The host key names the pod (§11), unless the caller names the environment and where in it to start, as a local VM's placement does.
    const subject =
      target?.subject ?? (request.hostKey ? sandboxSubjectFor(request.hostKey) : agentSandboxSubject(agentId))
    if (sandboxSubjectAgentId(subject) !== agentId) {
      throw new Error(
        `cluster launch host key names agent ${sandboxSubjectAgentId(subject)}, its environment ${agentId}`
      )
    }
    const timer = new LaunchTimer(this.deps.metrics, () => this.deps.clock.now())
    // The subject's own sandbox alone is held, from before bind until runtime exit, and released on every failure path.
    let held: L | undefined
    try {
      held = await this.deps.ensureLaunch(subject, timer)
      this.deps.endpoints.retain(held)
      await this.ensureBoundChannel(subject, timer)
      this.deps.metrics.channel('bound')
      const session = this.deps.binder.sessionFor(subject)
      if (!session) throw new Error(`no shim session for ${subject} after binding its channel`)
      // Fail-closed and per-launch: the env points at these files and a resumed sandbox starts with an empty tmpfs, so the write belongs to every launch, not to the bind.
      const sink = new ShimFileSink(session)
      await clearSpawnDirs(sink, request.clearDirs)
      for (const file of request.files ?? []) await sink.write(file.root, file.relPath, file.content)
      const runtime = createRemoteRuntime({
        session,
        request,
        ...(target?.cwd === undefined ? {} : { cwd: target.cwd }),
        log: this.deps.log,
        metrics: this.deps.metrics,
        // The open is asynchronous, so the stage closes when the runtime reports — and only a successful one, or a rejection would sit in runtime-ready latency as a fast success.
        onRuntimeOpen: (outcome) => {
          if (outcome === 'ok') timer.mark('runtime_ready')
          timer.finish(outcome)
        }
      })
      // Runtime exit releases the hold so the next idle sweep can suspend the sandbox.
      const bound = held
      held = undefined
      runtime.onExit(() => this.deps.endpoints.release(bound))
      return runtime
    } catch (err) {
      if (held) this.deps.endpoints.release(held)
      timer.finish(err instanceof LaunchTimeoutError ? 'timeout' : 'error')
      throw err
    }
  }
}
