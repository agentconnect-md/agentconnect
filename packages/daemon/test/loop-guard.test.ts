import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalStore } from '../src/store/local-store.js'

function dbPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'ac-loop-guard-')), 'local.sqlite')
}

describe('LocalStore loop guard', () => {
  it('tracks consecutive automatic turns, with a trusted human turn resetting only that streak', () => {
    const s = new LocalStore(dbPath())
    const limits = { windowMs: 1_000, maxTotal: 100, maxAutomatic: 2 }

    expect(s.recordLoopGuardTurn('slack:C1:dm', 100, true, limits)).toMatchObject({
      allowed: true,
      totalCount: 1,
      automaticCount: 1
    })
    expect(s.recordLoopGuardTurn('slack:C1:dm', 200, true, limits)).toMatchObject({
      allowed: true,
      totalCount: 2,
      automaticCount: 2
    })
    expect(s.recordLoopGuardTurn('slack:C1:dm', 300, false, limits)).toMatchObject({
      allowed: true,
      totalCount: 3,
      automaticCount: 0
    })

    expect(s.recordLoopGuardTurn('slack:C1:dm', 400, true, limits).allowed).toBe(true)
    expect(s.recordLoopGuardTurn('slack:C1:dm', 500, true, limits).allowed).toBe(true)
    expect(s.recordLoopGuardTurn('slack:C1:dm', 600, true, limits)).toMatchObject({
      allowed: false,
      trippedNow: true,
      automaticCount: 3,
      reason: 'automatic_turn_burst'
    })
    expect(s.isLoopGuardOpen('slack:C1:dm')).toBe(true)
    s.close()
  })

  it('uses the total-rate backstop even when every turn is classified as human', () => {
    const s = new LocalStore(dbPath())
    const limits = { windowMs: 1_000, maxTotal: 2, maxAutomatic: 100 }

    expect(s.recordLoopGuardTurn('slack:C1:dm', 100, false, limits).allowed).toBe(true)
    expect(s.recordLoopGuardTurn('slack:C1:dm', 200, false, limits).allowed).toBe(true)
    expect(s.recordLoopGuardTurn('slack:C1:dm', 300, false, limits)).toMatchObject({
      allowed: false,
      trippedNow: true,
      totalCount: 3,
      reason: 'turn_rate_burst'
    })
    s.close()
  })

  it('keeps an opened circuit latched across database reopen until explicitly reset', () => {
    const path = dbPath()
    const first = new LocalStore(path)
    expect(first.tripLoopGuard('slack:C1:dm', 123, 'malformed_platform_event')).toMatchObject({
      allowed: false,
      trippedNow: true,
      reason: 'malformed_platform_event'
    })
    first.close()

    const second = new LocalStore(path)
    expect(second.isLoopGuardOpen('slack:C1:dm')).toBe(true)
    expect(second.getLoopGuard('slack:C1:dm')).toMatchObject({
      trippedAt: 123,
      reason: 'malformed_platform_event'
    })
    // A later trip does not replace the original root cause or silently reopen it.
    expect(second.tripLoopGuard('slack:C1:dm', 999, 'later_reason')).toMatchObject({
      trippedNow: false,
      reason: 'malformed_platform_event'
    })
    expect(second.resetLoopGuard('slack:C1:dm')).toBe(true)
    expect(second.isLoopGuardOpen('slack:C1:dm')).toBe(false)
    expect(second.resetLoopGuard('slack:C1:dm')).toBe(false)
    second.close()
  })

  it('prunes only inactive counters while retaining latched incidents', () => {
    const s = new LocalStore(dbPath())
    const limits = { windowMs: 1_000, maxTotal: 100, maxAutomatic: 100 }
    s.recordLoopGuardTurn('recent-boundary', 0, true, limits)
    s.recordLoopGuardTurn('recent-boundary', 900, false, limits) // automatic window refreshed
    s.tripLoopGuard('latched', 0, 'incident')

    s.recordLoopGuardTurn('other', 1_001, false, limits)
    expect(s.getLoopGuard('recent-boundary')).toBeDefined()
    expect(s.getLoopGuard('latched')).toBeDefined()

    s.recordLoopGuardTurn('new-window', 2_001, false, limits)
    expect(s.getLoopGuard('recent-boundary')).toBeUndefined()
    expect(s.getLoopGuard('latched')).toMatchObject({ reason: 'incident' })
    s.close()
  })
})
