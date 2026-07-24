/**
 * `Clock` port (design §2.3 / §2.1 `domain/clock.ts`) — THE time seam.
 *
 * Every time-dependent component (epoch timestamps, REQ retransmit, watchdog
 * freeze/grace, lease TTL) takes a `Clock` instead of touching `Date.now()` or
 * the global timers, so a `FakeClock` (`test/fakes/fake-clock.ts`) drives them
 * deterministically: `advance(ms)` fires due timers in order.
 *
 * `domain/` has zero internal dependencies — this file imports nothing.
 */

/** Opaque handle for a scheduled timer; only `clearTimeout` consumes it. */
export type TimerHandle = { readonly __timer: unique symbol } | number | object

export interface Clock {
  /** Wall-clock epoch milliseconds (advisory; like `Date.now()`). */
  now(): number
  /** Schedule `fn` after `ms`; returns a handle for `clearTimeout`. */
  setTimeout(fn: () => void, ms: number): TimerHandle
  /** Cancel a previously-scheduled timer. */
  clearTimeout(h: TimerHandle): void
}

/**
 * The production clock — wraps the real wall clock and Node timers. Tests inject
 * a `FakeClock` instead; nothing in production constructs `FakeClock`.
 */
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

/** A shared default instance for production wiring. */
export const systemClock: Clock = new SystemClock()
