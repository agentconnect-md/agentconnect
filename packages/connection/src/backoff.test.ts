import { describe, it, expect } from 'vitest'
import { Backoff, DEFAULT_BACKOFF_CAP_MS } from './backoff.js'

describe('Backoff', () => {
  it('grows exponentially from the base with jitter pinned to 0', () => {
    const b = new Backoff({ baseMs: 1000, capMs: 30_000, jitter: () => 0 })
    expect(b.next()).toBe(1000) // 1000 * 2^0
    expect(b.next()).toBe(2000) // 2^1
    expect(b.next()).toBe(4000) // 2^2
    expect(b.next()).toBe(8000) // 2^3
  })

  it('clamps the base AND the jittered total to the cap', () => {
    // jitter=1 would add a full `base` on top; the result must never exceed cap.
    const b = new Backoff({ baseMs: 1000, capMs: 5000, jitter: () => 0.999 })
    const delays = [b.next(), b.next(), b.next(), b.next(), b.next(), b.next()]
    for (const d of delays) expect(d).toBeLessThanOrEqual(5000)
    // Once base saturates the cap, every subsequent delay is exactly the cap.
    expect(b.next()).toBe(5000)
  })

  it('reset() returns to attempt 0', () => {
    const b = new Backoff({ baseMs: 1000, jitter: () => 0 })
    b.next()
    b.next()
    b.reset()
    expect(b.next()).toBe(1000)
  })

  it('defaults cap the growth at DEFAULT_BACKOFF_CAP_MS', () => {
    const b = new Backoff({ jitter: () => 0 })
    let last = 0
    for (let i = 0; i < 20; i++) last = b.next()
    expect(last).toBe(DEFAULT_BACKOFF_CAP_MS)
  })
})
