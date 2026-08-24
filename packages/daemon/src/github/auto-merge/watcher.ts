import { MAX_AUTO_MERGE_DETAIL, type AutoMergeState, type AutoMergeTarget } from '@agentconnect.md/protocol'
import { AUTO_MERGE_POLL_MS, fetchSnapshot, readiness, type FetchLike, type GithubAccess } from './core.js'
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
    readonly reason: 'unknown-agent' | 'unsupported-image' | 'sandbox-asleep' | 'already-mergeable',
    message: string
  ) {
    super(message)
    this.name = 'AutoMergeViolationError'
  }
}

export interface AutoMergeWatcherDeps {
  /** Whether this daemon holds an agent by that id at all. */
  knownAgent: (agentId: string) => boolean
  /**
   * Whether this agent's work belongs in a POD — a property of the daemon, not of the channel.
   *
   * This is the fix for the split-brain the two-predicate version had: `sandboxFor` answers on
   * ATTACHMENT (`runsInSandbox` is `sessionFor(agentId)?.isAttached()`), and a suspended sandbox is a
   * perfectly ordinary state for a cluster agent. Arming while detached would start a daemon-local
   * loop that a later `state`/`disarm` — taken while attached — could no longer see or stop, leaving
   * it polling and eventually merging behind an unchecked box. One predicate decides where an entry
   * may live, for every op, for the whole lifetime of the entry.
   */
  clusterPlaced: (agentId: string) => boolean
  /** The agent's pod channel while its sandbox is attached; undefined when it is asleep. */
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
    if (this.deps.clusterPlaced(target.agentId)) {
      const sandbox = this.deps.sandboxFor(target.agentId)
      // Asleep is an ANSWER: the watcher lived in that pod, so nothing is watching now. It is also
      // never a local entry — `arm` refuses rather than starting one somewhere this read cannot see.
      if (!sandbox) return this.project(target, undefined, { armed: false })
      return this.project(target, 'sandbox', await sandbox.state(this.call(target)))
    }
    const loop = this.local.get(keyOf(target))
    if (!loop) return this.project(target, undefined, { armed: false })
    return this.project(target, 'daemon', this.fromLoop(target, loop))
  }

  /** Whether ANY pull request is armed for this agent, wherever its watcher lives. The sandbox
   *  keep-alive's question: suspending a pod with an armed watcher in it silently disarms the box. */
  async armedFor(agentId: string): Promise<boolean> {
    if (this.deps.clusterPlaced(agentId)) {
      const sandbox = this.deps.sandboxFor(agentId)
      return sandbox ? sandbox.anyArmed(agentId) : false
    }
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
    if (this.deps.clusterPlaced(target.agentId)) {
      const sandbox = this.deps.sandboxFor(target.agentId)
      if (!sandbox) {
        throw new AutoMergeViolationError(
          'sandbox-asleep',
          'this agent’s sandbox is not running — start it, then arm merge-when-ready'
        )
      }
      await this.refuseIfMergeableNow(target)
      const answer = await sandbox.arm({ ...this.call(target), capability: this.deps.capabilityFor(target.agentId) })
      return this.project(target, 'sandbox', answer)
    }
    const key = keyOf(target)
    const held = this.local.get(key)
    if (held) return this.project(target, 'daemon', this.fromLoop(target, held))
    await this.refuseIfMergeableNow(target)
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
        // Both terminal states DROP the entry, not just its timer. The loop stops itself either way,
        // but a stopped loop left in this map is what `arm`'s fast path would hand back forever — so a
        // pull request that was closed and later reopened could never be armed again.
        if (status.merged || status.closed) this.local.delete(key)
      }
    })
    this.local.set(key, loop)
    loop.start()
    this.deps.log?.info(`automerge: watching ${target.repoFullName}#${target.prNumber} on this daemon`)
    return this.project(target, 'daemon', this.fromLoop(target, loop))
  }

  private async disarm(target: AutoMergeTarget): Promise<AutoMergeState> {
    if (this.deps.clusterPlaced(target.agentId)) {
      const sandbox = this.deps.sandboxFor(target.agentId)
      // A pod that went away took its watcher with it: there is nothing to disarm and saying so is
      // the truth, not a silent failure.
      if (!sandbox) return this.project(target, undefined, { armed: false })
      return this.project(target, undefined, await sandbox.disarm(this.call(target)))
    }
    const key = keyOf(target)
    const loop = this.local.get(key)
    this.local.delete(key)
    if (!loop) return this.project(target, undefined, { armed: false })
    // `stop()` fences the tick in flight before its merge; awaiting it means this `armed:false` is not
    // answered while a squash could still land behind it. A merge that had already been SENT is
    // reported rather than hidden — the toggle is off either way, but not silently.
    loop.stop()
    await loop.settle()
    return this.project(target, undefined, { armed: false, ...(loop.current().merged ? { merged: true } : {}) })
  }

  private require(target: AutoMergeTarget): void {
    if (!this.deps.knownAgent(target.agentId)) {
      throw new AutoMergeViolationError('unknown-agent', `no agent ${target.agentId} on this daemon`)
    }
  }

  private call(target: AutoMergeTarget): SandboxCall {
    return { agentId: target.agentId, repoFullName: target.repoFullName, prNumber: target.prNumber }
  }

  /**
   * Refuse to arm a pull request that is mergeable RIGHT NOW.
   *
   * The loop's first tick is immediate by design, so arming an already-green pull request would
   * squash-merge it inside one round trip — irreversible, from a single click on a checkbox whose
   * label promises a wait, while the box's own Merge button deliberately takes two presses (#1337).
   * The rule is evaluated HERE, with the same `readiness` the loop uses, so there is no second
   * definition of "ready" anywhere. A probe that cannot reach GitHub does not block arming: the loop
   * reports that failure itself, and refusing on it would make an unreachable GitHub unarmable.
   */
  private async refuseIfMergeableNow(target: AutoMergeTarget): Promise<void> {
    const access: GithubAccess = {
      token: () => this.deps.tokenFor(target.agentId, target.repoFullName),
      ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {})
    }
    let ready = false
    try {
      ready = readiness(await fetchSnapshot(access, target.repoFullName, target.prNumber)).ready
    } catch {
      return
    }
    if (ready) {
      throw new AutoMergeViolationError(
        'already-mergeable',
        'this pull request can be merged now — use Merge, which confirms before it merges'
      )
    }
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
      // Clamped HERE, for both placements: `AutoMergeState` bounds these at MAX_AUTO_MERGE_DETAIL and
      // the daemon does not validate on send, so one long GitHub message (the OAuth-App-restriction
      // one is ~350 chars) would fail the CP's strict decode — reported as a rejected reply, i.e. a
      // 503 on the arm and `null` on every read after, over a watcher that is armed and merging.
      ...(s.waitingOn ? { waitingOn: clamp(s.waitingOn) } : {}),
      ...(s.lastError ? { lastError: clamp(s.lastError) } : {}),
      ...(s.merged ? { merged: true } : {})
    }
  }
}

function clamp(detail: string): string {
  return detail.length > MAX_AUTO_MERGE_DETAIL ? detail.slice(0, MAX_AUTO_MERGE_DETAIL) : detail
}

function keyOf(target: AutoMergeTarget): string {
  return `${target.agentId}|${target.repoFullName.toLowerCase()}#${target.prNumber}`
}
