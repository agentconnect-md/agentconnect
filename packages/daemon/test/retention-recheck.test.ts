import { describe, expect, it } from 'vitest'
import { SESSION_RETENTION_RECHECK_MAX_MS, SESSION_RETENTION_SWEEP_INTERVAL_MS } from '../src/daemon/constants.js'
import { nextRetentionRecheck, retentionRecheckPending } from '../src/daemon/retention-recheck.js'

const HOUR = SESSION_RETENTION_SWEEP_INTERVAL_MS

describe('retention recheck back-off (#3281)', () => {
  it('judges a session retention never kept', () => {
    expect(retentionRecheckPending({ updatedAt: 0 }, 10 * HOUR)).toBe(false)
    expect(nextRetentionRecheck({ updatedAt: 0 }, 10 * HOUR)).toBe(11 * HOUR)
  })

  it('skips a kept session until its wait runs out, counting a pass that lands a little early', () => {
    const kept = { updatedAt: 0, retentionKeptAt: 10 * HOUR, retentionRecheckAt: 11 * HOUR }
    expect(retentionRecheckPending(kept, 10 * HOUR + 1)).toBe(true)
    expect(retentionRecheckPending(kept, 11 * HOUR - 5_000)).toBe(false)
  })

  it('doubles the wait on each keep, up to the cap', () => {
    let rec = { updatedAt: 0, retentionKeptAt: 0, retentionRecheckAt: 0 }
    const waits: number[] = []
    let now = HOUR
    for (let i = 0; i < 10; i += 1) {
      const recheckAt = nextRetentionRecheck(rec, now)
      waits.push((recheckAt - now) / HOUR)
      rec = { updatedAt: 0, retentionKeptAt: now, retentionRecheckAt: recheckAt }
      now = recheckAt
    }
    expect(waits).toEqual([1, 2, 4, 8, 16, 32, 64, 128, 168, 168])
    expect(SESSION_RETENTION_RECHECK_MAX_MS).toBe(168 * HOUR)
  })

  it('starts over once the session has had activity since the keep', () => {
    const stale = { updatedAt: 50 * HOUR, retentionKeptAt: 10 * HOUR, retentionRecheckAt: 74 * HOUR }
    expect(retentionRecheckPending(stale, 60 * HOUR)).toBe(false)
    expect(nextRetentionRecheck(stale, 60 * HOUR)).toBe(61 * HOUR)
  })
})
