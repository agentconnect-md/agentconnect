/**
 * `FakeClock` — deterministic `Clock` for tests (design §5.4).
 *
 * Implements `domain/clock.ts:Clock`. Time only moves when a test calls
 * `advance(ms)`, which fires every timer whose deadline falls within the elapsed
 * window, **in deadline order** (ties broken by insertion order). This drives
 * epoch timestamps, the `ACK_TIMEOUT_MS` retransmit cadence, lease TTL, and the
 * `3×HEARTBEAT_SEC` watchdog without real wall-clock waits.
 */
import type { Clock, TimerHandle } from '../../src/domain/clock.js'

interface Scheduled {
  id: number
  fireAt: number
  seq: number // insertion order, for deterministic tie-break
  fn: () => void
  cancelled: boolean
}

export class FakeClock implements Clock {
  private current: number
  private nextId = 1
  private seqCounter = 0
  private timers = new Map<number, Scheduled>()

  constructor(startMs = 0) {
    this.current = startMs
  }

  now(): number {
    return this.current
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const id = this.nextId++
    this.timers.set(id, {
      id,
      fireAt: this.current + Math.max(0, ms),
      seq: this.seqCounter++,
      fn,
      cancelled: false
    })
    return id
  }

  clearTimeout(h: TimerHandle): void {
    const t = this.timers.get(h as number)
    if (t) t.cancelled = true
    this.timers.delete(h as number)
  }

  /**
   * Advance time by `ms`, firing all timers due in `(now, now+ms]` in deadline
   * order. A timer scheduled by a fired callback runs too if its deadline also
   * falls inside the window (mirrors real timer semantics).
   */
  advance(ms: number): void {
    const target = this.current + ms
    // Loop because a fired callback may schedule a new timer within the window.
    for (;;) {
      const due = [...this.timers.values()]
        .filter((t) => !t.cancelled && t.fireAt <= target)
        .sort((a, b) => a.fireAt - b.fireAt || a.seq - b.seq)
      if (due.length === 0) break
      const next = due[0]!
      this.timers.delete(next.id)
      this.current = next.fireAt
      next.fn()
    }
    this.current = target
  }

  /** Number of live (un-fired, un-cancelled) timers — handy for assertions. */
  pendingTimers(): number {
    return this.timers.size
  }
}
