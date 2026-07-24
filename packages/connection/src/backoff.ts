/**
 * Exponential reconnect backoff with additive jitter — the shared policy every
 * dial-out client (daemon→CP, relay→CP, daemon→relay) uses to space retries.
 *
 * `nextDelayMs(attempt)` returns `min(cap, base·2^attempt) + jitter`, clamped so
 * no delay ever exceeds the cap. `jitter()` returns a value in [0, 1) (default
 * `Math.random`; inject `() => 0` in tests to pin the delay to exactly the base).
 */
export interface BackoffOpts {
  /** First-attempt base delay; doubles each attempt up to the cap. */
  baseMs?: number
  /** Ceiling — the delay (base + jitter) never exceeds this. */
  capMs?: number
  /** Additive jitter fraction in [0, 1); defaults to Math.random. */
  jitter?: () => number
}

export const DEFAULT_BACKOFF_BASE_MS = 1000
export const DEFAULT_BACKOFF_CAP_MS = 30_000

/**
 * A small stateful backoff helper: `next()` yields the delay for the current
 * attempt and advances the counter; `reset()` returns to attempt 0 (call on a
 * successful connect). Keeps the exponent/jitter math in one place instead of
 * inline in each client FSM.
 */
export class Backoff {
  private attempt = 0
  private readonly baseMs: number
  private readonly capMs: number
  private readonly jitter: () => number

  constructor(opts: BackoffOpts = {}) {
    this.baseMs = opts.baseMs ?? DEFAULT_BACKOFF_BASE_MS
    this.capMs = opts.capMs ?? DEFAULT_BACKOFF_CAP_MS
    this.jitter = opts.jitter ?? Math.random
  }

  /** The delay for the current attempt, then advance (so the next call grows). */
  next(): number {
    const base = Math.min(this.capMs, this.baseMs * 2 ** this.attempt)
    const delay = Math.min(this.capMs, base + Math.floor(this.jitter() * base))
    this.attempt += 1
    return delay
  }

  /** Reset to attempt 0 — call once a connect succeeds. */
  reset(): void {
    this.attempt = 0
  }
}
