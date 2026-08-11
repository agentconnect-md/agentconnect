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
}

/**
 * Per-key serialized, coalescing work queue with failure backoff — the
 * controller-runtime rate-limited-queue equivalent for a level-triggered
 * reconciler: N adds while running collapse into one follow-up pass, and a
 * failing key retries alone on its own growing delay.
 */
export class WorkQueue {
  private readonly states = new Map<string, KeyState>()
  private readonly clock: Clock
  private readonly newBackoff: () => Backoff
  private readonly log: WorkQueueOptions['log']
  private shuttingDown = false
  private readonly inFlight = new Set<Promise<void>>()

  constructor(
    private readonly handler: (key: string) => Promise<void>,
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
    if (state.retryTimer !== undefined) {
      this.clock.clearTimeout(state.retryTimer)
      state.retryTimer = undefined
    }
    if (state.running) {
      state.dirty = true
      return
    }
    this.run(key, state)
  }

  /** Stops retry timers and waits for in-flight passes to finish. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true
    for (const state of this.states.values()) {
      if (state.retryTimer !== undefined) this.clock.clearTimeout(state.retryTimer)
      state.retryTimer = undefined
      state.dirty = false
    }
    await Promise.allSettled([...this.inFlight])
  }

  private run(key: string, state: KeyState): void {
    state.running = true
    const pass = this.handler(key)
      .then(() => {
        state.backoff = this.newBackoff()
        this.finish(key, state)
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
    }
  }
}
