/** Per-key token bucket bounding real GitHub mints per daemon and per org, so one tenant cannot drain a shared App's mint budget. */
import type { Clock } from '../domain/clock.js'

interface BucketState {
  tokens: number
  lastRefillMs: number
}

export class TokenBucket {
  private readonly buckets = new Map<string, BucketState>()

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
    private readonly clock: Clock
  ) {}

  /** True ⇒ allowed (one token consumed); false ⇒ over budget right now. */
  take(key: string): boolean {
    const now = this.clock.now()
    let b = this.buckets.get(key)
    if (!b) {
      b = { tokens: this.capacity, lastRefillMs: now }
      this.buckets.set(key, b)
    } else {
      const elapsedSec = (now - b.lastRefillMs) / 1000
      if (elapsedSec > 0) {
        b.tokens = Math.min(this.capacity, b.tokens + elapsedSec * this.refillPerSec)
        b.lastRefillMs = now
      }
    }
    if (b.tokens < 1) return false
    b.tokens -= 1
    return true
  }
}
