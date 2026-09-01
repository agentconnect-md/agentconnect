/**
 * `HookRateLimiter` — per-hook token bucket for the public webhook ingress
 * (security boundary 2: the endpoint is bearer-less, so a leaked/guessed URL
 * must not buy unbounded agent runs). Refill is computed lazily from the
 * injected clock; state is bounded by a hard cap flush (the daemon dedup-map
 * precedent) so a hostile token sweep can't grow the map without bound.
 */
import type { Clock } from '@agentconnect.md/connection'

interface Bucket {
  tokens: number
  lastRefillMs: number
}

export interface HookRateLimiterOpts {
  /** Burst capacity per hook (default 10). */
  capacity?: number
  /** Sustained refill rate per hook, tokens/second (default 1). */
  refillPerSec?: number
  /** Max tracked hooks before the state map is flushed (default 10_000). */
  maxEntries?: number
}

export class HookRateLimiter {
  private readonly buckets = new Map<string, Bucket>()
  private readonly capacity: number
  private readonly refillPerSec: number
  private readonly maxEntries: number

  // Only `now()` is read — narrowed so a caller holding a read-only clock (the platform
  // ingress host, which exposes no timers) can reuse this limiter instead of forking one.
  constructor(
    private readonly clock: Pick<Clock, 'now'>,
    opts: HookRateLimiterOpts = {}
  ) {
    this.capacity = opts.capacity ?? 10
    this.refillPerSec = opts.refillPerSec ?? 1
    this.maxEntries = opts.maxEntries ?? 10_000
  }

  /** Take one token for `hookId`; false ⇒ the caller answers 429. */
  allow(hookId: string): boolean {
    const now = this.clock.now()
    let b = this.buckets.get(hookId)
    if (!b) {
      if (this.buckets.size >= this.maxEntries) this.buckets.clear()
      b = { tokens: this.capacity, lastRefillMs: now }
      this.buckets.set(hookId, b)
    } else {
      const elapsedSec = Math.max(0, now - b.lastRefillMs) / 1000
      b.tokens = Math.min(this.capacity, b.tokens + elapsedSec * this.refillPerSec)
      b.lastRefillMs = now
    }
    if (b.tokens < 1) return false
    b.tokens -= 1
    return true
  }
}
