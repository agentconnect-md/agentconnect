import type { AutoMergeState, AutoMergeTarget } from '@agentconnect.md/protocol'
import { AUTO_MERGE_POLL_MS, type FetchLike, type GithubAccess } from './core.js'
import { AutoMergeLoop } from './loop.js'

/**
 * The daemon's half of merge-when-ready: one registry, two placements, no storage.
 *
 * A cluster-placed agent's watcher runs IN ITS POD — this object only forwards arm/disarm/state to
 * the sandbox's `automerge` channel, so the armed set belongs to the pod and a reclaimed sandbox
 * forgets it. A locally-placed agent has no pod, so the loop runs here in the daemon process and
 * the daemon's own lifetime is the intent's. Either way the console reads the armed fact back live
 * and an unchecked box means exactly what it says: nobody is watching.
 *
 * The CP is never asked. It relays the two frames for the console and keeps nothing — there is no
 * row to reconcile, no snapshot to replay, and no way for a stale intent to outlive the thing that
 * would act on it.
 */

/** The pod-side channel, as this registry needs it. Implemented by `ShimAutoMergeClient`. */
export interface AutoMergeSandbox {
  arm(target: SandboxCall): Promise<SandboxState>
  disarm(target: SandboxCall): Promise<SandboxState>
  state(target: SandboxCall): Promise<SandboxState>
  /** Whether anything at all is armed in that pod — asked by the sandbox keep-alive, which holds a
   *  pod whose in-pod watcher a suspend would kill. */
  anyArmed(agentId: string): Promise<boolean>
}

export interface SandboxCall {
  agentId: string
  repoFullName: string
  prNumber: number
  capability?: string
}

export interface SandboxState {
  armed: boolean
  waitingOn?: string
  lastError?: string
  merged?: boolean
}

/** Machine reason on a refusal, mirroring the frame's `AutoMergeErrorReason` — the CP maps it to a
 *  status the console can branch on instead of the 503 that reads as an offline daemon. */
export class AutoMergeViolationError extends Error {
  constructor(
    readonly reason: 'unknown-agent' | 'unsupported-image',
    message: string
  ) {
    super(message)
    this.name = 'AutoMergeViolationError'
  }
}

export interface AutoMergeWatcherDeps {
  /** Whether this daemon holds an agent by that id at all. */
  knownAgent: (agentId: string) => boolean
  /** The agent's pod channel when its work runs in a sandbox, undefined for a local agent. */
  sandboxFor: (agentId: string) => AutoMergeSandbox | undefined
  /** The agent's runtime-only gitcred capability, so the POD's watcher can fetch its own token. */
  capabilityFor: (agentId: string) => string
  /** A GH_TOKEN-plane token for the LOCAL loop; the pod fetches its own over the gitcred tunnel. */
  tokenFor: (agentId: string, repoFullName: string) => Promise<string>
  log?: { info: (message: string) => void; warn: (message: string) => void }
  /** GitHub seam for the LOCAL loop; the pod's watcher owns its own. Tests substitute it. */
  fetchImpl?: FetchLike
  pollMs?: number
  timers?: {
    setInterval: (fn: () => void, ms: number) => unknown
    clearInterval: (handle: unknown) => void
  }
}

export class AutoMergeWatcher {
  private readonly local = new Map<string, AutoMergeLoop>()

  constructor(private readonly deps: AutoMergeWatcherDeps) {}

  async set(target: AutoMergeTarget, enabled: boolean): Promise<AutoMergeState> {
    this.require(target)
    return enabled ? this.arm(target) : this.disarm(target)
  }

  async state(target: AutoMergeTarget): Promise<AutoMergeState> {
    this.require(target)
    const sandbox = this.deps.sandboxFor(target.agentId)
    if (sandbox) return this.project(target, 'sandbox', await sandbox.state(this.call(target)))
    const loop = this.local.get(keyOf(target))
    if (!loop) return this.project(target, undefined, { armed: false })
    return this.project(target, 'daemon', this.fromLoop(target, loop))
  }

  /** Whether ANY pull request is armed for this agent, wherever its watcher lives. The sandbox
   *  keep-alive's question: suspending a pod with an armed watcher in it silently disarms the box. */
  async armedFor(agentId: string): Promise<boolean> {
    const sandbox = this.deps.sandboxFor(agentId)
    if (sandbox) return sandbox.anyArmed(agentId)
    for (const [key, loop] of this.local) {
      if (key.startsWith(`${agentId}|`) && loop.armed()) return true
    }
    return false
  }

  /** Drop every local loop — daemon shutdown, and the reason nothing survives a restart. */
  stop(): void {
    for (const loop of this.local.values()) loop.stop()
    this.local.clear()
  }

  private async arm(target: AutoMergeTarget): Promise<AutoMergeState> {
    const sandbox = this.deps.sandboxFor(target.agentId)
    if (sandbox) {
      const answer = await sandbox.arm({ ...this.call(target), capability: this.deps.capabilityFor(target.agentId) })
      return this.project(target, 'sandbox', answer)
    }
    const key = keyOf(target)
    const held = this.local.get(key)
    if (held) return this.project(target, 'daemon', this.fromLoop(target, held))
    const access: GithubAccess = {
      token: () => this.deps.tokenFor(target.agentId, target.repoFullName),
      ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {})
    }
    const loop = new AutoMergeLoop({
      access,
      repoFullName: target.repoFullName,
      prNumber: target.prNumber,
      pollMs: this.deps.pollMs ?? AUTO_MERGE_POLL_MS,
      ...(this.deps.timers ? { timers: this.deps.timers } : {}),
      onStatus: (status) => {
        // Merged is terminal: the loop already disarmed itself, and holding the entry would keep
        // reporting `armed` for a pull request nothing is watching.
        if (status.merged) this.local.delete(key)
      }
    })
    this.local.set(key, loop)
    loop.start()
    this.deps.log?.info(`automerge: watching ${target.repoFullName}#${target.prNumber} on this daemon`)
    return this.project(target, 'daemon', this.fromLoop(target, loop))
  }

  private async disarm(target: AutoMergeTarget): Promise<AutoMergeState> {
    const sandbox = this.deps.sandboxFor(target.agentId)
    if (sandbox) return this.project(target, undefined, await sandbox.disarm(this.call(target)))
    const key = keyOf(target)
    this.local.get(key)?.stop()
    this.local.delete(key)
    return this.project(target, undefined, { armed: false })
  }

  private require(target: AutoMergeTarget): void {
    if (!this.deps.knownAgent(target.agentId)) {
      throw new AutoMergeViolationError('unknown-agent', `no agent ${target.agentId} on this daemon`)
    }
  }

  private call(target: AutoMergeTarget): SandboxCall {
    return { agentId: target.agentId, repoFullName: target.repoFullName, prNumber: target.prNumber }
  }

  private fromLoop(target: AutoMergeTarget, loop: AutoMergeLoop): SandboxState {
    const status = loop.current()
    return {
      armed: loop.armed(),
      ...(status.waitingOn ? { waitingOn: status.waitingOn } : {}),
      ...(status.lastError ? { lastError: status.lastError } : {}),
      ...(status.merged ? { merged: true } : {})
    }
  }

  private project(
    target: AutoMergeTarget,
    placement: 'sandbox' | 'daemon' | undefined,
    s: SandboxState
  ): AutoMergeState {
    return {
      agentId: target.agentId,
      repoFullName: target.repoFullName,
      prNumber: target.prNumber,
      armed: s.armed,
      // Placement is stated only while something is actually armed there: it answers "where is this
      // being watched", and naming a placement for an unwatched pull request would invent a watcher.
      ...(s.armed && placement ? { placement } : {}),
      ...(s.waitingOn ? { waitingOn: s.waitingOn } : {}),
      ...(s.lastError ? { lastError: s.lastError } : {}),
      ...(s.merged ? { merged: true } : {})
    }
  }
}

function keyOf(target: AutoMergeTarget): string {
  return `${target.agentId}|${target.repoFullName.toLowerCase()}#${target.prNumber}`
}
