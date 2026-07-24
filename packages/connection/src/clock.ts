/**
 * `Clock` — the time seam every long-lived WS actor depends on. The correlator's
 * retransmit and a client's heartbeat / reconnect timers all go through this, so
 * a {@link FakeClock} drives them deterministically in tests.
 *
 * Shared by the daemon's CP client, the relay's CP client, and (later) the CP
 * server edges — one Clock contract instead of a per-package copy.
 */
export type TimerHandle = number | object

export interface Clock {
  now(): number
  setTimeout(fn: () => void, ms: number): TimerHandle
  clearTimeout(h: TimerHandle): void
}

export class SystemClock implements Clock {
  now(): number {
    return Date.now()
  }
  setTimeout(fn: () => void, ms: number): TimerHandle {
    return globalThis.setTimeout(fn, ms)
  }
  clearTimeout(h: TimerHandle): void {
    globalThis.clearTimeout(h as ReturnType<typeof globalThis.setTimeout>)
  }
}

export const systemClock: Clock = new SystemClock()

/**
 * A deterministic Clock for unit tests: `now` only advances via {@link advance},
 * which fires every timer whose deadline has passed (in deadline order). No real
 * timers arm, so tests never race the wall clock.
 */
export class FakeClock implements Clock {
  private t = 0
  private seq = 0
  private timers = new Map<number, { at: number; fn: () => void }>()

  constructor(startMs = 0) {
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

  clearTimeout(h: TimerHandle): void {
    this.timers.delete(h as number)
  }

  /** Advance time by `ms`, firing every timer that comes due, earliest first. */
  advance(ms: number): void {
    const until = this.t + ms
    for (;;) {
      let next: { id: number; at: number; fn: () => void } | undefined
      for (const [id, e] of this.timers) {
        if (e.at <= until && (!next || e.at < next.at)) next = { id, at: e.at, fn: e.fn }
      }
      if (!next) break
      this.timers.delete(next.id)
      this.t = next.at
      next.fn()
    }
    this.t = until
  }
}
