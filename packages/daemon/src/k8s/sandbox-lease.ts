import type { ClusterMetrics } from '../metrics/cluster-metrics.js'
import {
  GuardedResumeRejectedError,
  OperatingModeRejectedError,
  type OperatingMode,
  type Sandbox,
  type SandboxApi
} from './sandbox-api.js'
import { poolRuntimeImage } from './sandbox-identity.js'

const MAX_MODE_ATTEMPTS = 5

export interface SandboxLeaseDeps {
  api: SandboxApi
  /** Pool whose template names the runtime image a resume must converge onto. */
  warmPoolName: string
  log: { info: (m: string) => void; warn: (m: string) => void; debug?: (m: string) => void }
  metrics: ClusterMetrics
}

/**
 * Who holds a Sandbox and who may change its operating mode.
 *
 * Three pieces of state that only make sense together: the per-Sandbox work count, the
 * per-Sandbox transition queue that serializes mode writes, and the per-subject gate that an
 * idle suspension publishes so acquisition waits it out instead of racing it.
 */
export class SandboxLease {
  /** Live work per Sandbox: binds, workspace preparation, and runtimes that have not exited. */
  private readonly busy = new Map<string, number>()
  /** Per-SANDBOX transition queue. A guarded write protects competing writes, but it cannot
   *  protect a decision that performs NO write: a later wake could observe Running and
   *  return while an earlier suspend patch was still in flight, and the older write would
   *  then land last and reverse the newer decision. Serializing removes that entirely. */
  private readonly modeQueue = new Map<string, Promise<void>>()
  /** Idle suspensions in flight, per subject. `busy` COUNTS work but does not exclude it, so a
   *  dispatch admitted while the suspend was mid-write would otherwise lose its pod. Acquisition
   *  waits this out and then re-claims, which is the ordinary resume path. */
  // Per SUBJECT, never per agent: a subject owns exactly one Sandbox, so the gate and the `busy` count it pairs with name one pod — an agent-keyed gate would let a session pod's suspend refuse its sibling's acquisition.
  private readonly suspending = new Map<string, Promise<void>>()

  constructor(private readonly deps: SandboxLeaseDeps) {}

  /** Count work on a Sandbox so the idle sweep cannot suspend it. */
  retain(sandboxName: string): void {
    this.busy.set(sandboxName, (this.busy.get(sandboxName) ?? 0) + 1)
  }

  release(sandboxName: string): void {
    const left = (this.busy.get(sandboxName) ?? 0) - 1
    if (left > 0) {
      this.busy.set(sandboxName, left)
      return
    }
    this.busy.delete(sandboxName)
  }

  /** The suspension gate to wait on before reading a cached launch, or undefined when none is open. */
  suspensionOf(subject: string): Promise<void> | undefined {
    return this.suspending.get(subject)
  }

  /**
   * Suspend a quiet Sandbox, declining when work already holds it.
   *
   * Work admitted AFTER that check is a different problem, and `busy` cannot solve it: it counts
   * holders, it does not exclude them, so a dispatch arriving during the Kubernetes write would
   * lose the pod underneath itself and then find its launch forgotten. The decision is therefore
   * published before the first await, and acquisition waits it out instead of racing it.
   * Publication is synchronous with the `busy` read, which is what makes the pair atomic: a
   * holder either shows up in that read, or arrives to a gate that is already closed.
   *
   * `onSuspended` runs once the write lands, for the launch-side state the caller owns.
   */
  async suspendIfIdle(subject: string, sandboxName: string, onSuspended: () => void): Promise<'suspended' | 'busy'> {
    if (this.suspending.has(subject)) return 'busy'
    if ((this.busy.get(sandboxName) ?? 0) > 0) return 'busy'
    let opened: () => void = () => {}
    this.suspending.set(subject, new Promise<void>((resolve) => (opened = resolve)))
    this.retain(sandboxName)
    try {
      await this.queueMode(sandboxName, 'Suspended')
      onSuspended()
      return 'suspended'
    } finally {
      this.release(sandboxName)
      // Dropped BEFORE the gate opens, so a waiter that resumes cannot observe a suspension that
      // is still registered and refuse itself in this call's place.
      this.suspending.delete(subject)
      opened()
    }
  }

  /** Queued per Sandbox because it is the object both decisions patch. */
  queueMode(sandboxName: string, desired: OperatingMode): Promise<OperatingMode | undefined> {
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

  /** Drop the holds and the queue for a Sandbox this member no longer serves. */
  forgetSandbox(sandboxName: string): void {
    this.busy.delete(sandboxName)
    this.modeQueue.delete(sandboxName)
  }

  /**
   * Move a Sandbox to a mode, re-reading and re-deciding when the guarded write is rejected.
   *
   * The rejection deliberately does not claim what the intervening state was, so the only
   * correct response is to look again — and the retry budget is finite because a permanently
   * invalid patch would otherwise loop forever.
   */
  private async applyMode(sandboxName: string, desired: OperatingMode): Promise<OperatingMode | undefined> {
    // The mode observed on the FIRST read, before this call changed anything. A later attempt
    // sees the state we produced, which would say nothing about where the launch started.
    let first: OperatingMode | undefined
    let lastRejection: GuardedResumeRejectedError | OperatingModeRejectedError | undefined
    for (let attempt = 1; attempt <= MAX_MODE_ATTEMPTS; attempt += 1) {
      const sandbox = await this.deps.api.getSandbox(sandboxName)
      const observed = sandbox.spec?.operatingMode ?? 'Running'
      if (observed === desired) return first ?? observed
      first ??= observed
      try {
        if (desired === 'Running' && observed === 'Suspended') {
          const image = await this.resolveResumeImage(sandboxName, sandbox)
          await this.deps.api.resumeWithRuntimeImage(sandboxName, image)
          if (image.observedImage === image.targetImage) {
            this.deps.log.info(`cluster: sandbox ${sandboxName} → Running`)
          } else {
            this.deps.log.info(
              `cluster: sandbox ${sandboxName} runtime image ${image.observedImage} → ${image.targetImage}; resumed`
            )
          }
        } else {
          await this.deps.api.setOperatingMode(sandboxName, desired, observed)
          this.deps.log.info(`cluster: sandbox ${sandboxName} → ${desired}`)
        }
        return first
      } catch (err) {
        if (!(err instanceof OperatingModeRejectedError) && !(err instanceof GuardedResumeRejectedError)) throw err
        lastRejection = err
        this.deps.metrics.writeRetry('rejected_precondition')
        this.deps.log.debug?.(`cluster: ${desired} write for ${sandboxName} rejected (attempt ${attempt}) — re-reading`)
      }
    }
    if (lastRejection instanceof GuardedResumeRejectedError) {
      throw new Error(
        `sandbox ${sandboxName} guarded mode/image resume was rejected after ${MAX_MODE_ATTEMPTS} attempts`,
        { cause: lastRejection.cause }
      )
    }
    throw new Error(
      `sandbox ${sandboxName} would not accept ${desired} after ${MAX_MODE_ATTEMPTS} attempts — ` +
        `the guarded mode write was repeatedly rejected`,
      { cause: lastRejection?.cause }
    )
  }

  private async resolveResumeImage(
    sandboxName: string,
    sandbox: Sandbox
  ): Promise<{ containerIndex: number; observedName: string; observedImage: string; targetImage: string }> {
    const targetImage = await poolRuntimeImage(this.deps.api, this.deps.warmPoolName)
    const containers = sandbox.spec?.podTemplate?.spec?.containers ?? []
    const containerIndexes = containers.flatMap((container, index) => (container.name === 'runtime' ? [index] : []))
    if (containerIndexes.length === 0) throw new Error(`sandbox ${sandboxName} has no runtime container`)
    if (containerIndexes.length > 1) throw new Error(`sandbox ${sandboxName} has multiple runtime containers`)
    const containerIndex = containerIndexes[0]!
    const observedImage = containers[containerIndex]?.image
    if (!observedImage?.trim()) throw new Error(`sandbox ${sandboxName} runtime container has no image`)
    if (observedImage.trim() !== observedImage) {
      throw new Error(`sandbox ${sandboxName} runtime container has invalid image`)
    }
    return { containerIndex, observedName: 'runtime', observedImage, targetImage }
  }
}
