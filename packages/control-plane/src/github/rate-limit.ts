/**
 * Per-key token bucket for the gitcred mint path.
 *
 * One deployment shares ONE GitHub App across every org, so GitHub's mint
 * budget is a cross-tenant resource: a crash-looping daemon (whose ReqRep layer
 * retransmits every 5s) or a runaway agent must not be able to starve other
 * orgs into RATE_LIMITED. The service-level single-flight only coalesces
 * concurrent same-key mints; this bucket bounds distinct/serial requests
 * per daemon and per org, INDEPENDENT of the cache.
 */
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
