import type { Clock, TimerHandle } from '@agentconnect.md/connection'

interface Timer {
  id: number
  due: number
  ms: number
  fn: () => void
}

/** Deterministic clock: `advance(ms)` fires all timers due at or before the new time, in due order. */
export class FakeClock implements Clock {
  private t = 0
  private seq = 0
  private timers: Timer[] = []

  now(): number {
    return this.t
  }
  setTimeout(fn: () => void, ms: number): TimerHandle {
    const id = ++this.seq
    this.timers.push({ id, due: this.t + ms, ms, fn })
    return id
  }
  clearTimeout(h: TimerHandle): void {
    this.timers = this.timers.filter((x) => x.id !== h)
  }
  advance(ms: number): void {
    this.t += ms
    const due = this.timers.filter((x) => x.due <= this.t).sort((a, b) => a.due - b.due)
    for (const d of due) {
      this.timers = this.timers.filter((x) => x.id !== d.id)
      d.fn()
    }
  }
  /** ms-delays of all currently-armed timers (for backoff assertions). */
  pending(): number[] {
    return this.timers.map((x) => x.ms)
  }
}
