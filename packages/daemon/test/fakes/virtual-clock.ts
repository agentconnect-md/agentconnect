import type { Clock, TimerHandle } from '@agentconnect.md/connection'

/**
 * A daemon `Clock` whose time only moves when a test asks it to, plus {@link runVirtual} to
 * drive it while the daemon is parked on one of its own deadlines — a drain budget, a release
 * backoff, a convergence retry. Those deadlines are seconds long by design, so waiting them out
 * for real is what puts these suites near the 5s per-test budget on a loaded runner.
 *
 * `@agentconnect.md/connection`'s FakeClock is the same idea but advances by a caller-chosen
 * span; here the test does not know the span, only that the daemon is waiting for something, so
 * this one fires the EARLIEST armed timer and moves time exactly to its deadline.
 */
export class VirtualClock implements Clock {
  private t: number
  private seq = 0
  private readonly timers = new Map<number, { at: number; fn: () => void }>()

  constructor(startMs = 1_700_000_000_000) {
    this.t = startMs
  }

  now(): number {
    return this.t
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const id = ++this.seq
    this.timers.set(id, { at: this.t + Math.max(0, ms), fn })
    return id
  }

  clearTimeout(handle: TimerHandle): void {
    this.timers.delete(handle as number)
  }

  /** Armed-timer count — lets a test assert that a deadline was armed, or cancelled. */
  get pending(): number {
    return this.timers.size
  }

  /**
   * Fire the earliest armed timer due within `horizonMs`, moving time to its deadline.
   * Returns false when nothing qualifies.
   *
   * The horizon is the safety rail: a daemon also arms hour-scale periodic sweeps on this
   * clock, and firing one because it happened to be the only thing armed would jump virtual
   * time far past anything the test is about.
   */
  fireNext(horizonMs: number): boolean {
    let next: { id: number; at: number; fn: () => void } | undefined
    for (const [id, entry] of this.timers) {
      if (entry.at > this.t + horizonMs) continue
      if (!next || entry.at < next.at) next = { id, ...entry }
    }
    if (!next) return false
    this.timers.delete(next.id)
    this.t = Math.max(this.t, next.at)
    next.fn()
    return true
  }
}

/**
 * Await `work`, firing the deadlines it parks on so a wait the daemon measures in seconds costs
 * a test nothing. Real I/O still runs to completion: every fire is preceded by {@link settle},
 * which drains the macrotask queue, and time never moves while the work is settling on its own.
 *
 * `horizonMs` bounds which deadlines may be skipped — keep it just above the longest wait the
 * test means to skip, so a longer budget the test is actually asserting against stays real.
 */
export async function runVirtual<T>(clock: VirtualClock, work: Promise<T>, horizonMs = 1_500): Promise<T> {
  let settled = false
  const done = work.then(
    (value) => {
      settled = true
      return value
    },
    (error: unknown) => {
      settled = true
      throw error
    }
  )
  void done.catch(() => undefined)
  for (let turns = 0; !settled && turns < 20_000; turns++) {
    await settle()
    if (settled) break
    clock.fireNext(horizonMs)
  }
  return done
}

/** Drain the macrotask queue — every I/O completion already queued lands — without moving
 *  virtual time. What a "nothing further happened" assertion waits on instead of a fixed sleep:
 *  the daemon is parked on a virtual deadline nobody fired, so it demonstrably cannot proceed. */
export async function settle(turns = 8): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise((resolve) => setImmediate(resolve))
}
