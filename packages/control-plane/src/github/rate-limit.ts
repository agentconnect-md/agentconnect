/** Per-key token bucket bounding real GitHub mints, so one agent or one tenant of the built-in App cannot mint without limit. */
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

  /** True ⇒ a token is available right now; spends nothing. */
  has(key: string): boolean {
    return this.refill(key).tokens >= 1
  }

  /** True ⇒ allowed (one token consumed); false ⇒ over budget right now. */
  take(key: string): boolean {
    const b = this.refill(key)
    if (b.tokens < 1) return false
    b.tokens -= 1
    return true
  }

  private refill(key: string): BucketState {
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
    return b
  }
}
