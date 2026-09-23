import { MAX_AUTO_MERGE_DETAIL, type AutoMergeState, type AutoMergeTarget } from '@agentconnect.md/protocol'
import { sandboxSubjectSessionLeaf } from '../../remote/sandbox-subject.js'
import { ShimChannelLostError } from '../../shim/channels.js'
import { AUTO_MERGE_POLL_MS, fetchSnapshot, readiness, type FetchLike, type GithubAccess } from './core.js'
import { AutoMergeLoop } from './loop.js'

// The daemon's half of merge-when-ready: a cluster agent's watcher runs IN a pod (the arming isolated session's own, else the agent's) and this object only forwards to it; a local agent's loop runs here; nothing is stored anywhere, the CP included.

/** The pod-side channel, as this registry needs it. Implemented by `ShimAutoMergeClient`. */
export interface AutoMergeSandbox {
  arm(target: SandboxCall): Promise<SandboxState>
  disarm(target: SandboxCall): Promise<SandboxState>
  state(target: SandboxCall): Promise<SandboxState>
  /** `state`, except that a channel lost mid-question propagates: an arm must not read "not watched here" off a routine renewal. */
  watching(target: SandboxCall): Promise<SandboxState>
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
  /** Whether this agent's work belongs in a POD — a property of the daemon, never of a channel's attachment, so an arm and a later read cannot disagree about where a watcher may live. */
  clusterPlaced: (agentId: string) => boolean
  /** Every pod of the agent a watcher may run in, whoever armed it: the agent's own, then each session pod this member launched (§11). */
  podsOf: (agentId: string) => string[]
  /** One pod's channel while it is bound — with `bind`, also a launched pod that is up, bound on demand and never woken; undefined otherwise. */
  sandboxAt: (subject: string, bind?: boolean) => Promise<AutoMergeSandbox | undefined>
  /** The placement predicate: the pod an arm's watcher lives in — the arming session's own when isolated, else the agent's — from the session's tier alone, never from what is attached. */
  placementOf: (agentId: string, sessionId?: string) => Promise<string>
  /** Hold one pod against the idle sweep across an arm, or undefined when it is asleep or being suspended. */
  holdSandbox?: (subject: string) => (() => void) | undefined
  /** A pod answered with a watcher armed in it: renew the idle sweep's own hold on that pod. */
  onArmed?: (subject: string) => void
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
  // One arm or disarm per pull request at a time: two arms that each found nothing would otherwise start two watchers.
  private readonly queues = new Map<string, Promise<unknown>>()

  constructor(private readonly deps: AutoMergeWatcherDeps) {}

  /** Arm or disarm; `sessionId` only PLACES an arm — the watcher stays keyed by (agent, repo, pull request). */
  async set(target: AutoMergeTarget, enabled: boolean, sessionId?: string): Promise<AutoMergeState> {
    this.require(target)
    return this.serialized(keyOf(target), () => (enabled ? this.arm(target, sessionId) : this.disarm(target)))
  }

  async state(target: AutoMergeTarget): Promise<AutoMergeState> {
    this.require(target)
    if (this.deps.clusterPlaced(target.agentId)) {
      // Every bound pod is asked, which is complete because a pod with a watcher armed in it is held against the sweep; a pod that is down took its watcher with it.
      const answers = await Promise.allSettled(
        this.deps
          .podsOf(target.agentId)
          .map(async (subject) => (await this.deps.sandboxAt(subject))?.state(this.call(target)))
      )
      const armed = answers.find((a) => a.status === 'fulfilled' && a.value?.armed)
      if (armed?.status === 'fulfilled') return this.project(target, 'sandbox', armed.value!)
      // An image with no watcher has none to report; any other failure leaves the answer unknown rather than "not armed".
      const failed = answers.find((a) => a.status === 'rejected' && !isUnsupported(a.reason))
      if (failed?.status === 'rejected') throw failed.reason
      return this.project(target, undefined, { armed: false })
    }
    const loop = this.local.get(keyOf(target))
    if (!loop) return this.project(target, undefined, { armed: false })
    return this.project(target, 'daemon', this.fromLoop(loop))
  }

  /** Drop every local loop — daemon shutdown, and the reason nothing survives a restart. */
  stop(): void {
    for (const loop of this.local.values()) loop.stop()
    this.local.clear()
  }

  private serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
    // The queue's tail never rejects, so one failed arm cannot wedge the next.
    const run = (this.queues.get(key) ?? Promise.resolve()).then(() => work())
    const tail = run.catch(() => undefined)
    this.queues.set(key, tail)
    void tail.then(() => {
      if (this.queues.get(key) === tail) this.queues.delete(key)
    })
    return run
  }

  private async arm(target: AutoMergeTarget, sessionId?: string): Promise<AutoMergeState> {
    if (this.deps.clusterPlaced(target.agentId)) return this.armInPod(target, sessionId)
    const key = keyOf(target)
    const held = this.local.get(key)
    if (held) return this.project(target, 'daemon', this.fromLoop(held))
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
        // Both terminal states DROP the entry, not just its timer: a stopped loop left here is what the fast path above would hand back forever, so a reopened pull request could never be armed again.
        if (status.merged || status.closed) this.local.delete(key)
      }
    })
    this.local.set(key, loop)
    loop.start()
    this.deps.log?.info(`automerge: watching ${target.repoFullName}#${target.prNumber} on this daemon`)
    return this.project(target, 'daemon', this.fromLoop(loop))
  }

  private async armInPod(target: AutoMergeTarget, sessionId?: string): Promise<AutoMergeState> {
    // Idempotent across pods: a watcher any pod of the agent already runs for this pull request is the answer, wherever an earlier arm placed it.
    const watching = await this.watchingIn(target)
    if (watching) {
      this.deps.onArmed?.(watching.subject)
      return this.project(target, 'sandbox', watching.state)
    }
    const subject = await this.deps.placementOf(target.agentId, sessionId)
    if (!(await this.deps.sandboxAt(subject, true))) throw sandboxAsleep(subject)
    await this.refuseIfMergeableNow(target)
    // Held from before the arm is sent until the sweep's own hold is renewed, so a sweep that asked the pod before this arm landed cannot suspend it after.
    const release = this.deps.holdSandbox?.(subject)
    const sandbox = await this.deps.sandboxAt(subject)
    if (!sandbox || (this.deps.holdSandbox && !release)) {
      release?.()
      throw sandboxAsleep(subject)
    }
    try {
      const answer = await sandbox.arm({ ...this.call(target), capability: this.deps.capabilityFor(target.agentId) })
      if (answer.armed) this.deps.onArmed?.(subject)
      return this.project(target, 'sandbox', answer)
    } finally {
      release?.()
    }
  }

  private async disarm(target: AutoMergeTarget): Promise<AutoMergeState> {
    if (this.deps.clusterPlaced(target.agentId)) {
      // Every pod is asked and every answer awaited, each fencing its tick in flight; a request lost to a rebind is asked again once and fails the disarm if lost twice, so `armed:false` never covers a live watcher.
      const answers = await Promise.allSettled(
        this.deps.podsOf(target.agentId).map((subject) => this.askPod(subject, (s) => s.disarm(this.call(target))))
      )
      const failed = answers.find((a) => a.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
      const merged = answers.some((a) => a.status === 'fulfilled' && a.value?.merged)
      return this.project(target, undefined, { armed: false, ...(merged ? { merged: true } : {}) })
    }
    const key = keyOf(target)
    const loop = this.local.get(key)
    this.local.delete(key)
    if (!loop) return this.project(target, undefined, { armed: false })
    // `stop()` fences the tick in flight before its merge and `settle()` waits it out; a merge already SENT is reported, not hidden.
    loop.stop()
    await loop.settle()
    return this.project(target, undefined, { armed: false, ...(loop.current().merged ? { merged: true } : {}) })
  }

  /** The pod already watching this pull request, if any; a pod that cannot answer fails the arm rather than risk a second watcher. */
  private async watchingIn(target: AutoMergeTarget): Promise<{ subject: string; state: SandboxState } | undefined> {
    const answers = await Promise.all(
      this.deps.podsOf(target.agentId).map(async (subject) => ({
        subject,
        state: await this.askPod(subject, (s) => s.watching(this.call(target)))
      }))
    )
    const found = answers.find((a) => a.state?.armed)
    return found ? { subject: found.subject, state: found.state! } : undefined
  }

  /** One pod's answer, asked again on the channel a renewal re-attached; a pod with no channel, or an image with no watcher, runs none. */
  private async askPod(
    subject: string,
    ask: (sandbox: AutoMergeSandbox) => Promise<SandboxState>
  ): Promise<SandboxState | undefined> {
    for (let retried = false; ; retried = true) {
      const sandbox = await this.deps.sandboxAt(subject, true)
      if (!sandbox) return undefined
      try {
        return await ask(sandbox)
      } catch (err) {
        if (err instanceof ShimChannelLostError && !retried) continue
        if (isUnsupported(err)) return undefined
        throw err
      }
    }
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

  private fromLoop(loop: AutoMergeLoop): SandboxState {
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

/** A pod whose image ships no watcher, or that was bound without the grant, can hold none. */
function isUnsupported(err: unknown): boolean {
  return err instanceof AutoMergeViolationError && err.reason === 'unsupported-image'
}

function sandboxAsleep(subject: string): AutoMergeViolationError {
  const whose = sandboxSubjectSessionLeaf(subject) === undefined ? 'agent’s' : 'session’s'
  return new AutoMergeViolationError(
    'sandbox-asleep',
    `this ${whose} sandbox is not running — start it, then arm merge-when-ready`
  )
}

function clamp(detail: string): string {
  return detail.length > MAX_AUTO_MERGE_DETAIL ? detail.slice(0, MAX_AUTO_MERGE_DETAIL) : detail
}

function keyOf(target: AutoMergeTarget): string {
  return `${target.agentId}|${target.repoFullName.toLowerCase()}#${target.prNumber}`
}
