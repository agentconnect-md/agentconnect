import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { LocalStore } from '../src/store/local-store.js'

function dbPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'ac-loop-guard-')), 'local.sqlite')
}

/** Two pool members over ONE store, exactly as an install-wide shared database presents it. */
function pool(): { a: LocalStore; b: LocalStore; close: () => void } {
  const path = dbPath()
  const seed = new LocalStore(path)
  seed.close()
  const a = new LocalStore({ database: new DatabaseSync(path), shared: true, ownerId: 'daemon-a' })
  const b = new LocalStore({ database: new DatabaseSync(path), shared: true, ownerId: 'daemon-b' })
  return { a, b, close: () => [a, b].forEach((store) => store.close()) }
}

/** Run `concurrent` at the moment the member's next loop-guard write is about to execute —
 *  the exact window in which a read-modify-write member loses a peer's increment. */
function interleaveLoopGuardWrite(store: LocalStore, concurrent: () => void): void {
  const db = (store as unknown as { db: { prepare: (sql: string) => unknown } }).db
  const prepare = db.prepare.bind(db)
  let fired = false
  db.prepare = (sql: string) => {
    const statement = prepare(sql) as Record<string, (...args: unknown[]) => unknown>
    if (!/^\s*INSERT INTO loop_guard/i.test(sql)) return statement
    for (const method of ['run', 'get'] as const) {
      const original = statement[method]!.bind(statement)
      statement[method] = (...args: unknown[]) => {
        if (!fired) {
          fired = true
          concurrent()
        }
        return original(...args)
      }
    }
    return statement
  }
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

describe('LocalStore loop guard on a shared pool store (#1038)', () => {
  const limits = { windowMs: 10_000, maxTotal: 100, maxAutomatic: 100 }

  it('sums every member’s charge exactly, including a write that lands mid-charge', () => {
    const { a, b, close } = pool()
    // A charges while B charges: an absolute upsert derived from a prior read drops B's turn.
    interleaveLoopGuardWrite(a, () => {
      b.recordLoopGuardTurn('slack:C1:T1', 100, true, limits)
    })
    expect(a.recordLoopGuardTurn('slack:C1:T1', 100, true, limits)).toMatchObject({
      allowed: true,
      totalCount: 2,
      automaticCount: 2
    })
    for (let i = 0; i < 8; i++) (i % 2 === 0 ? a : b).recordLoopGuardTurn('slack:C1:T1', 200 + i, true, limits)
    expect(a.getLoopGuard('slack:C1:T1')).toMatchObject({ totalCount: 10, automaticCount: 10 })
    close()
  })

  it('elects exactly one member to own the trip’s side effects', () => {
    const { a, b, close } = pool()
    const burst = { windowMs: 10_000, maxTotal: 1, maxAutomatic: 100 }
    a.recordLoopGuardTurn('slack:C1:T1', 100, false, burst)
    // Both members exceed the budget in the same window; only the winner runs the trip.
    interleaveLoopGuardWrite(a, () => {
      expect(b.recordLoopGuardTurn('slack:C1:T1', 100, false, burst)).toMatchObject({
        allowed: false,
        trippedNow: true,
        reason: 'turn_rate_burst'
      })
    })
    expect(a.recordLoopGuardTurn('slack:C1:T1', 100, false, burst)).toMatchObject({
      allowed: false,
      trippedNow: false,
      reason: 'turn_rate_burst'
    })
    expect(a.getLoopGuard('slack:C1:T1')).toMatchObject({ totalCount: 2, trippedAt: 100 })
    // A concurrent structural trip is elected the same way.
    expect(a.tripLoopGuard('slack:C2:T2', 7, 'malformed_platform_event').trippedNow).toBe(true)
    expect(b.tripLoopGuard('slack:C2:T2', 9, 'malformed_platform_event')).toMatchObject({
      trippedNow: false,
      reason: 'malformed_platform_event'
    })
    expect(b.getLoopGuard('slack:C2:T2')).toMatchObject({ trippedAt: 7 })
    close()
  })

  it('never recharges a latched scope, whichever member reads it', () => {
    const { a, b, close } = pool()
    a.recordLoopGuardTurn('slack:C1:T1', 100, true, limits)
    a.tripLoopGuard('slack:C1:T1', 150, 'incident')
    expect(b.recordLoopGuardTurn('slack:C1:T1', 200, true, limits)).toMatchObject({
      allowed: false,
      trippedNow: false,
      totalCount: 1,
      reason: 'incident'
    })
    expect(a.getLoopGuard('slack:C1:T1')).toMatchObject({ totalCount: 1, trippedAt: 150, reason: 'incident' })
    close()
  })
})
