import { Backoff, systemClock, type Clock, type TimerHandle } from '@agentconnect.md/connection'

export interface WorkQueueOptions {
  clock?: Clock
  /** Fresh per-key failure backoff; replaced on every success. */
  newBackoff?: () => Backoff
  log?: { debug?: (message: string) => void; warn?: (message: string) => void }
}

interface KeyState {
  running: boolean
  /** An add() arrived while running — run once more after this pass. */
  dirty: boolean
  backoff: Backoff
  retryTimer?: TimerHandle
  /** A handler-requested follow-up pass; any earlier wake supersedes it. */
  requeueTimer?: TimerHandle
}

/** What one pass reports back: a delay after which the key is worth looking at again. */
export interface WorkResult {
  requeueAfterMs?: number
}

/**
 * Per-key serialized, coalescing work queue with failure backoff — the
 * controller-runtime rate-limited-queue equivalent for a level-triggered
 * reconciler: N adds while running collapse into one follow-up pass, a failing
 * key retries alone on its own growing delay, and a pass may ask to be run
 * again after a delay when it knows its own reading was provisional.
 */
export class WorkQueue {
  private readonly states = new Map<string, KeyState>()
  private readonly clock: Clock
  private readonly newBackoff: () => Backoff
  private readonly log: WorkQueueOptions['log']
  private shuttingDown = false
  private readonly inFlight = new Set<Promise<void>>()

  constructor(
    private readonly handler: (key: string) => Promise<WorkResult | void>,
    options: WorkQueueOptions = {}
  ) {
    this.clock = options.clock ?? systemClock
    this.newBackoff = options.newBackoff ?? (() => new Backoff())
    this.log = options.log
  }

  add(key: string): void {
    if (this.shuttingDown) return
    const state = this.states.get(key) ?? { running: false, dirty: false, backoff: this.newBackoff() }
    this.states.set(key, state)
    this.clearTimers(state)
    if (state.running) {
      state.dirty = true
      return
    }
    this.run(key, state)
  }

  /** Run the key again after `delayMs` unless a watch, a retry, or another add gets there first. */
  addAfter(key: string, delayMs: number): void {
    if (this.shuttingDown) return
    const state = this.states.get(key) ?? { running: false, dirty: false, backoff: this.newBackoff() }
    this.states.set(key, state)
    if (state.running || state.dirty || state.retryTimer !== undefined || state.requeueTimer !== undefined) return
    state.requeueTimer = this.clock.setTimeout(() => {
      state.requeueTimer = undefined
      this.add(key)
    }, delayMs)
  }

  private clearTimers(state: KeyState): void {
    for (const slot of ['retryTimer', 'requeueTimer'] as const) {
      if (state[slot] !== undefined) this.clock.clearTimeout(state[slot])
      state[slot] = undefined
    }
  }

  /** Stops pending timers and waits for in-flight passes to finish. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true
    for (const state of this.states.values()) {
      this.clearTimers(state)
      state.dirty = false
    }
    await Promise.allSettled([...this.inFlight])
  }

  private run(key: string, state: KeyState): void {
    state.running = true
    const pass = this.handler(key)
      .then((result) => {
        state.backoff = this.newBackoff()
        this.finish(key, state)
        if (result?.requeueAfterMs !== undefined) this.addAfter(key, result.requeueAfterMs)
      })
      .catch((error: unknown) => {
        this.log?.warn?.(`reconcile of ${key} failed: ${String(error)}`)
        state.dirty = false
        state.running = false
        if (this.shuttingDown) return
        const delay = state.backoff.next()
        state.retryTimer = this.clock.setTimeout(() => {
          state.retryTimer = undefined
          this.add(key)
        }, delay)
      })
    this.inFlight.add(pass)
    void pass.finally(() => this.inFlight.delete(pass))
  }

  private finish(key: string, state: KeyState): void {
    state.running = false
    if (this.shuttingDown) return
    if (state.dirty) {
      state.dirty = false
      this.run(key, state)
      return
    }
    // Idle and healthy: drop the entry so lifetime org churn (every deleted CR
    // still gets one final successful pass) cannot grow this map without bound.
    this.states.delete(key)
  }

  /** Live key states — pending timers and in-flight passes only. */
  get size(): number {
    return this.states.size
  }
}
