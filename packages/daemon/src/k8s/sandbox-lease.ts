import type { ClusterMetrics } from '../metrics/cluster-metrics.js'
import {
  assertSandboxFence,
  GuardedResumeRejectedError,
  OperatingModeRejectedError,
  type OperatingMode,
  type Sandbox,
  type SandboxApi
} from './sandbox-api.js'
import { poolRuntimeImage } from './sandbox-identity.js'
import type { SandboxLaunch } from './endpoint-provider.js'

const MAX_MODE_ATTEMPTS = 5

export interface SandboxLeaseDeps {
  api: SandboxApi
  isCurrent: (launch: SandboxLaunch) => boolean
  /** Pool whose template names the runtime image a resume must converge onto. */
  warmPoolName: string
  log: { info: (m: string) => void; warn: (m: string) => void; debug?: (m: string) => void }
  metrics: ClusterMetrics
}

// Work holds, serialized mode changes, and the admission gate of each launch.
export class SandboxLease {
  /** Live work per Sandbox: binds, workspace preparation, and runtimes that have not exited. */
  private readonly busy = new Map<SandboxLaunch, number>()
  // Serialize even no-op decisions, which could otherwise overtake a pending mode write.
  private readonly modeQueue = new Map<string, Promise<void>>()
  // Gate only the subject being suspended; sibling sessions remain available.
  private readonly suspending = new Map<string, { launch: SandboxLaunch; done: Promise<void>; open: () => void }>()
  /** What to run once the last hold on a Sandbox goes, per Sandbox — see `whenReleased`. */
  private readonly onReleased = new Map<SandboxLaunch, () => void>()

  constructor(private readonly deps: SandboxLeaseDeps) {}

  /** Count work on a Sandbox so the idle sweep cannot suspend it. */
  retain(launch: SandboxLaunch): void {
    this.assertCurrent(launch)
    if (this.suspending.has(launch.subject)) throw new Error(`sandbox ${launch.subject} is being suspended`)
    this.busy.set(launch, (this.busy.get(launch) ?? 0) + 1)
  }

  isHeld(launch: SandboxLaunch): boolean {
    return (this.busy.get(launch) ?? 0) > 0
  }

  release(launch: SandboxLaunch): void {
    const left = (this.busy.get(launch) ?? 0) - 1
    if (left > 0) {
      this.busy.set(launch, left)
      return
    }
    this.busy.delete(launch)
    const then = this.onReleased.get(launch)
    this.onReleased.delete(launch)
    then?.()
  }

  /** Run `then` once nothing holds the Sandbox — at once when nothing does now; a later call replaces an earlier one. */
  whenReleased(launch: SandboxLaunch, then: () => void): void {
    if ((this.busy.get(launch) ?? 0) > 0) this.onReleased.set(launch, then)
    else then()
  }

  /** The suspension gate to wait on before reading a cached launch, or undefined when none is open. */
  suspensionOf(subject: string): Promise<void> | undefined {
    return this.suspending.get(subject)?.done
  }

  // Retain and close the admission gate in the same synchronous step.
  async suspendIfIdle(launch: SandboxLaunch, onSuspended: () => void): Promise<'suspended' | 'busy'> {
    const { subject } = launch
    if (this.suspending.has(subject) || this.isHeld(launch)) return 'busy'
    this.retain(launch)
    let open!: () => void
    const done = new Promise<void>((resolve) => (open = resolve))
    const gate = { launch, done, open }
    this.suspending.set(subject, gate)
    try {
      await this.queueMode(launch, 'Suspended')
      onSuspended()
      return 'suspended'
    } finally {
      this.release(launch)
      if (this.suspending.get(subject) === gate) this.suspending.delete(subject)
      open()
    }
  }

  // Serialize transitions of the same Sandbox; the immutable launch fences each queued operation.
  queueMode(launch: SandboxLaunch, desired: OperatingMode): Promise<OperatingMode | undefined> {
    const { sandboxName } = launch
    const previous = this.modeQueue.get(sandboxName) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(() => this.applyMode(launch, desired))
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

  // An old holder's late releases and gates must not affect a successor's launch.
  forgetSandbox(launch: SandboxLaunch): void {
    this.busy.delete(launch)
    this.modeQueue.delete(launch.sandboxName)
    this.onReleased.delete(launch)
    const gate = this.suspending.get(launch.subject)
    if (gate?.launch === launch) {
      this.suspending.delete(launch.subject)
      gate.open()
    }
  }

  private assertCurrent(launch: SandboxLaunch): void {
    if (!this.deps.isCurrent(launch))
      throw new Error(`sandbox ${launch.subject} left this member before its mode change`)
  }

  // Re-read rejected writes, retaining the original launch fence and a finite retry budget.
  private async applyMode(launch: SandboxLaunch, desired: OperatingMode): Promise<OperatingMode | undefined> {
    const { sandboxName } = launch
    // Report the mode seen before this call changed anything.
    let first: OperatingMode | undefined
    let lastRejection: GuardedResumeRejectedError | OperatingModeRejectedError | undefined
    for (let attempt = 1; attempt <= MAX_MODE_ATTEMPTS; attempt += 1) {
      this.assertCurrent(launch)
      const sandbox = await this.deps.api.getSandbox(sandboxName)
      this.assertCurrent(launch)
      assertSandboxFence(sandbox, launch)
      const observed = sandbox.spec?.operatingMode ?? 'Running'
      if (observed === desired) return first ?? observed
      first ??= observed
      try {
        if (desired === 'Running' && observed === 'Suspended') {
          const image = await this.resolveResumeImage(sandboxName, sandbox)
          this.assertCurrent(launch)
          await this.deps.api.resumeWithRuntimeImage(sandboxName, image, launch)
          if (image.observedImage === image.targetImage) {
            this.deps.log.info(`cluster: sandbox ${sandboxName} → Running`)
          } else {
            this.deps.log.info(
              `cluster: sandbox ${sandboxName} runtime image ${image.observedImage} → ${image.targetImage}; resumed`
            )
          }
        } else {
          await this.deps.api.setOperatingMode(sandboxName, desired, observed, launch)
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
