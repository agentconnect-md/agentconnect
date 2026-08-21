/**
 * The armed watcher as a running thing: a timer around `tick`, plus the status the console reads.
 *
 * A LEAF module beside `core.ts` for the same reason — it is bundled into the in-sandbox entry.
 * State is in memory and nowhere else: the entry point is a process in the agent's pod (cluster
 * placement) or an object in the daemon (local placement), so losing the pod or restarting the
 * daemon forgets the intent and the box reads back unchecked. That is the designed lifetime, not
 * a limitation — nobody is watching the pull request any more, and the console must not claim
 * otherwise.
 */
import { AUTO_MERGE_POLL_MS, tick, type GithubAccess, type TickOutcome } from './core.js'

export interface AutoMergeStatus {
  waitingOn?: string
  lastError?: string
  merged: boolean
}

export interface AutoMergeLoopDeps {
  access: GithubAccess
  repoFullName: string
  prNumber: number
  pollMs?: number
  /** Called after every tick, so a host can log it or hand it to its own reader. */
  onStatus?: (status: AutoMergeStatus) => void
  /** Timer seam — a test drives ticks without waiting for a real minute. */
  timers?: {
    setInterval: (fn: () => void, ms: number) => unknown
    clearInterval: (handle: unknown) => void
  }
}

export class AutoMergeLoop {
  private handle?: unknown
  private running = false
  private status: AutoMergeStatus = { merged: false }
  private readonly timers: NonNullable<AutoMergeLoopDeps['timers']>

  constructor(private readonly deps: AutoMergeLoopDeps) {
    this.timers = deps.timers ?? {
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>)
    }
  }

  /** Arm: one immediate tick (an already-green pull request should not wait out a poll), then the
   *  cadence. Idempotent — arming an armed loop keeps the one timer it has. */
  start(): void {
    if (this.handle !== undefined) return
    this.handle = this.timers.setInterval(() => void this.run(), this.deps.pollMs ?? AUTO_MERGE_POLL_MS)
    void this.run()
  }

  stop(): void {
    if (this.handle === undefined) return
    this.timers.clearInterval(this.handle)
    this.handle = undefined
  }

  /** True until the merge lands; the host drops the entry on the falling edge. */
  armed(): boolean {
    return this.handle !== undefined && !this.status.merged
  }

  current(): AutoMergeStatus {
    return { ...this.status }
  }

  /** One tick, guarded against overlap: a slow GitHub must not stack requests behind itself. */
  async run(): Promise<AutoMergeStatus> {
    if (this.running) return this.current()
    this.running = true
    try {
      this.apply(await tick(this.deps.access, this.deps.repoFullName, this.deps.prNumber))
    } finally {
      this.running = false
    }
    this.deps.onStatus?.(this.current())
    return this.current()
  }

  /** A merge is terminal (the timer goes); an error keeps the loop armed, because the usual cure
   *  is the next commit and disarming would throw away the operator's intent on one red tick. */
  private apply(outcome: TickOutcome): void {
    if (outcome.kind === 'merged') {
      this.status = { merged: true }
      this.stop()
      return
    }
    this.status =
      outcome.kind === 'waiting'
        ? { merged: false, waitingOn: outcome.waitingOn }
        : { merged: false, lastError: outcome.error }
  }
}
