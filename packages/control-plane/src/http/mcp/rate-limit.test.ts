/**
 * Unit tests for the MCP per-credential rate limiter (agent-assistant.md §6.5):
 * sliding window, separate write budget, refusals never consume budget, and
 * per-key isolation.
 */
import { describe, it, expect } from 'vitest'
import type { Clock, TimerHandle } from '../../domain/clock.js'
import { McpRateLimiter, DEFAULT_MCP_RATE_LIMITS } from './rate-limit.js'

/** A now()-only clock the tests advance by hand (no timers involved here). */
function stubClock(): Clock & { advance(ms: number): void } {
  let t = 1_000_000
  return {
    now: () => t,
    setTimeout: (): TimerHandle => 0,
    clearTimeout: () => {},
    advance: (ms: number) => {
      t += ms
    }
  }
}

const LIMITS = { total: 5, write: 2, windowMs: 60_000 }

describe('McpRateLimiter', () => {
  it('admits writes up to the write budget, then refuses writes while reads still pass', () => {
    const limiter = new McpRateLimiter(stubClock(), LIMITS)
    expect(limiter.check('k', true)).toBeNull()
    expect(limiter.check('k', true)).toBeNull()
    expect(limiter.check('k', true)).not.toBeNull() // 3rd write refused
    expect(limiter.check('k', false)).toBeNull() // reads have their own headroom
  })

  it('the total budget caps reads and writes together', () => {
    const limiter = new McpRateLimiter(stubClock(), LIMITS)
    for (let i = 0; i < 5; i++) expect(limiter.check('k', false)).toBeNull()
    expect(limiter.check('k', false)).not.toBeNull()
    expect(limiter.check('k', true)).not.toBeNull() // writes refused via the total gate too
  })

  it('the window slides: an old admission expiring frees a slot', () => {
    const clock = stubClock()
    const limiter = new McpRateLimiter(clock, LIMITS)
    limiter.check('k', true)
    clock.advance(30_000)
    limiter.check('k', true)
    expect(limiter.check('k', true)).not.toBeNull()
    clock.advance(30_001) // first write leaves the window; second is still inside
    expect(limiter.check('k', true)).toBeNull()
    expect(limiter.check('k', true)).not.toBeNull()
  })

  it('reports whole seconds until the blocking admission expires', () => {
    const clock = stubClock()
    const limiter = new McpRateLimiter(clock, LIMITS)
    limiter.check('k', true)
    limiter.check('k', true)
    clock.advance(1_000)
    expect(limiter.check('k', true)).toBe(59)
    clock.advance(58_500)
    expect(limiter.check('k', true)).toBe(1) // 500ms left rounds up, never 0
  })

  it('refused calls do not consume budget (cannot push the horizon out)', () => {
    const clock = stubClock()
    const limiter = new McpRateLimiter(clock, LIMITS)
    limiter.check('k', true)
    limiter.check('k', true)
    for (let i = 0; i < 10; i++) limiter.check('k', true) // hammer while refused
    clock.advance(60_001)
    expect(limiter.check('k', true)).toBeNull() // window empty again — refusals left no trace
  })

  it('keys are isolated', () => {
    const limiter = new McpRateLimiter(stubClock(), LIMITS)
    limiter.check('a', true)
    limiter.check('a', true)
    expect(limiter.check('a', true)).not.toBeNull()
    expect(limiter.check('b', true)).toBeNull()
  })

  it('production defaults match §6.5: 120 total, 30 writes, per minute', () => {
    expect(DEFAULT_MCP_RATE_LIMITS).toEqual({ total: 120, write: 30, windowMs: 60_000 })
  })
})
