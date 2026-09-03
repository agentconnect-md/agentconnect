import type { Clock } from '@agentconnect.md/connection'
import type { LaunchTimer, ClusterMetrics } from '../metrics/cluster-metrics.js'
import type { ShimCapability } from '../shim/protocol.js'
import type { ShimConnection } from '../shim/connection.js'
import { ShimSession } from '../shim/session.js'
import { spawnSubject, type SpawnRecord } from '../shim/binding.js'
import type { SandboxLease } from './sandbox-lease.js'
import { LaunchTimeoutError, sandboxSubjectAgentId } from './sandbox-identity.js'
import type { LaunchRegistry, Launch } from './launch-registry.js'

export interface ChannelBinderDeps {
  registry: LaunchRegistry
  lease: SandboxLease
  clock: Clock
  log: { info: (m: string) => void; warn: (m: string) => void; debug?: (m: string) => void }
  metrics: ClusterMetrics
  /** How long a bind may wait for the pod's shim to dial back. */
  channelTimeoutMs: number
  /** Wait for the launch's Sandbox to report Ready and name its pod. */
  awaitReady: (sandboxName: string) => Promise<{ podName: string; podIp: string }>
  /** Dials the ready pod and binds the shim channel for this launch. */
  connectChannel: (record: SpawnRecord, podIp: string, timeoutMs: number) => Promise<ShimConnection>
  /** Stops any outbound channel when a bind is abandoned. */
  revokeChannel?: (subject: string) => void
  /** Prepares a freshly bound channel before anything runs on it; failures degrade, never fail the bind. */
  onChannelReady?: (subject: string, session: ShimSession) => Promise<void>
}

/**
 * A subject's logical channel to its pod: the session and the mount it reported.
 *
 * Two subject-keyed maps that only make sense together — the session survives the shim's
 * credential renewals, and the workspace root is whatever the CURRENT bound pod reported.
 *
 * The binder owns those primitives only. Dropping a session alongside its launch is one
 * invariant spanning this class and `LaunchRegistry`, so its ORCHESTRATION stays in the
 * `K8sDriver` methods that own the other half.
 */
export class ChannelBinder {
  /** Logical channels per subject, which survive the shim's credential renewals. */
  private readonly sessions = new Map<string, ShimSession>()
  /** Workspace mount per subject, as the bound pod's shim reported it. */
  private readonly workspaceRoots = new Map<string, string>()

  constructor(private readonly deps: ChannelBinderDeps) {}

  /** Resume the launch's pod, wait for it, and bind the shim channel onto the subject's session. */
  async bindChannel(
    subject: string,
    launch: Launch,
    timer: LaunchTimer | undefined,
    grants: ShimCapability[]
  ): Promise<ShimConnection> {
    this.deps.lease.retain(launch.sandboxName)
    try {
      return await this.bindHeld(subject, launch, timer, grants)
    } finally {
      this.deps.lease.release(launch.sandboxName)
    }
  }

  private async bindHeld(
    subject: string,
    launch: Launch,
    timer: LaunchTimer | undefined,
    grants: ShimCapability[]
  ): Promise<ShimConnection> {
    const releasedAt = this.deps.registry.releaseFence(subject)
    // The fence only catches a release that lands DURING the bind; one that landed between
    // `ensureSandbox` resolving and this continuation running is already in the snapshot, so the
    // launch itself has to be re-read. Otherwise a departed member wakes a pod it no longer serves.
    if (this.deps.registry.currentLaunch(subject) !== launch) {
      throw new Error(`sandbox ${subject} left this member before its sandbox channel was bound`)
    }
    // Resume before waiting because suspension deleted the pod and readiness cannot arrive first.
    const modeBeforeWake = await this.deps.lease.queueMode(launch.sandboxName, 'Running')
    // A launch this daemon already has cached returns from ensureSandbox before any sandbox
    // read, so this is where the ordinary `launch → suspend → launch` resume learns what it is.
    // Without it that path — the COMMON one — reported `warm` and never entered resume p95.
    if (modeBeforeWake) timer?.observedPath(modeBeforeWake === 'Suspended' ? 'resume' : 'warm')
    timer?.mark('mode_running')
    const pod = await this.deps.awaitReady(launch.sandboxName)
    timer?.mark('pod_ready')
    const channelTimeoutMs = this.deps.channelTimeoutMs
    const waitingSince = this.deps.clock.now()
    const connection = await this.deps
      .connectChannel(
        {
          agentId: sandboxSubjectAgentId(subject),
          subject,
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
        if (this.deps.clock.now() - waitingSince >= channelTimeoutMs) {
          throw new LaunchTimeoutError(`no shim channel bound for ${subject} in time`)
        }
        throw err
      })
    timer?.mark('shim_handshake')
    // Released mid-bind: the pod is another member's to serve now, so the channel is dropped.
    if (!this.deps.registry.stillServed(subject, releasedAt)) {
      this.deps.revokeChannel?.(subject)
      throw new Error(`sandbox ${subject} left this member while its sandbox channel was being bound`)
    }
    this.recordWorkspaceRoot(subject, connection)
    // The session is created HERE rather than in `launch`, because a channel bound for workspace
    // preparation needs one too — and a second session per subject would mean the runtime and the
    // workspace seam disagreeing about whether the channel is alive.
    const existing = this.sessions.get(subject)
    if (existing && existing.generation === connection.binding.generation) {
      existing.attach(connection)
    } else {
      const session = new ShimSession(subject, connection.binding.generation, {
        setTimeout: (fn, ms) => this.deps.clock.setTimeout(fn, ms),
        clearTimeout: (handle) => this.deps.clock.clearTimeout(handle as never)
      })
      session.attach(connection)
      this.sessions.set(subject, session)
    }
    // After the session exists and before the caller can use the channel. Reported rather than
    // raised: a sandbox without its credential tunnel still runs, and refusing the launch would
    // turn one degraded feature into no agent at all.
    const ready = this.sessions.get(subject)
    if (ready && this.deps.onChannelReady) {
      await this.deps.onChannelReady(subject, ready).catch((err: unknown) => {
        this.deps.log.warn(`cluster: sandbox ${subject} channel prepared with errors: ${(err as Error).message}`)
      })
    }
    return connection
  }

  /** Re-attach a renewed or replacement connection to the session it belongs to. */
  onChannelBound(connection: ShimConnection): void {
    this.recordWorkspaceRoot(spawnSubject(connection.binding), connection)
    const session = this.sessions.get(spawnSubject(connection.binding))
    if (!session) return
    // Counted apart from the first bind: a re-establishment rate is the signal that renewals or
    // pod churn are happening more than they should, and pooling the two hides exactly that.
    this.deps.metrics.channel('reestablished')
    session.attach(connection)
  }

  /**
   * End the subject's session because its channel is gone, reporting whether this call dropped it.
   *
   * A lost session is TERMINAL, so it must not survive to meet the replacement pod: `attach()`
   * is a no-op once closed, and `bindChannel` re-attaches whenever the generations match — which
   * they would, because a cached launch keeps its own. The caller forgets the launch on a `true`
   * so the next turn re-claims at a FRESH generation, the fence the replacement pod is bound
   * against. The workspace root is deliberately kept: the next bind overwrites or deletes it.
   */
  loseChannel(subject: string, reason: string): boolean {
    this.deps.metrics.channel('dropped')
    const session = this.sessions.get(subject)
    session?.lose(reason)
    if (!session || this.sessions.get(subject) !== session) return false
    this.sessions.delete(subject)
    return true
  }

  /** Drop the session without ending it as a loss — the suspend path, which keeps the root. */
  dropSession(subject: string): void {
    this.sessions.delete(subject)
  }

  /** The subject is no longer served here: both the session and the remembered mount go. */
  forget(subject: string): void {
    this.sessions.delete(subject)
    this.workspaceRoots.delete(subject)
  }

  /** The bound session for a subject, so the workspace seam reaches the same channel the runtime
   *  does rather than opening a second one that can disagree about whether it is alive. */
  sessionFor(subject: string): ShimSession | undefined {
    return this.sessions.get(subject)
  }

  /** Where the subject's bound pod mounts its workspace, or undefined before a bind (or when a
   *  legacy shim reported nothing — callers fall back to the historical mount). */
  workspaceRootFor(subject: string): string | undefined {
    return this.workspaceRoots.get(subject)
  }

  // Mirrors the CURRENT pod, absence included: a root kept from a previous incarnation (an image
  // rollback to a shim that reports none) names a mount this pod may not have — the exact failure
  // this seam exists to remove. Unset ⇒ callers fall back to the historical mount.
  private recordWorkspaceRoot(subject: string, connection: ShimConnection): void {
    if (connection.workspaceRoot) this.workspaceRoots.set(subject, connection.workspaceRoot)
    else this.workspaceRoots.delete(subject)
  }
}
