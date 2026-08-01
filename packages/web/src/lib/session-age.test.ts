import { describe, expect, it } from 'vitest'
import { groupSessionsByAge, sessionAgeBucket } from './session-age'

// A fixed "now" so the calendar-day boundaries are assertable. Mid-afternoon, so
// "two hours ago" and "today" are not the same thing by accident.
const NOW = new Date('2026-08-02T15:00:00')
const at = (iso: string) => ({ lastActivityAt: iso })

describe('sessionAgeBucket', () => {
  it('buckets by calendar day, not elapsed hours', () => {
    // 16 hours old, but a different calendar day — people read this as yesterday.
    expect(sessionAgeBucket('2026-08-01T23:00:00', NOW)).toBe('yesterday')
    // 15 hours old and the same day.
    expect(sessionAgeBucket('2026-08-02T00:00:00', NOW)).toBe('today')
  })

  it('places each boundary on the near side', () => {
    expect(sessionAgeBucket('2026-08-02T15:00:00', NOW)).toBe('today')
    expect(sessionAgeBucket('2026-08-01T00:01:00', NOW)).toBe('yesterday')
    expect(sessionAgeBucket('2026-07-31T12:00:00', NOW)).toBe('week') // 2 days
    expect(sessionAgeBucket('2026-07-26T12:00:00', NOW)).toBe('week') // 7 days
    expect(sessionAgeBucket('2026-07-25T12:00:00', NOW)).toBe('month') // 8 days
    expect(sessionAgeBucket('2026-07-03T12:00:00', NOW)).toBe('month') // 30 days
    expect(sessionAgeBucket('2026-07-02T12:00:00', NOW)).toBe('older') // 31 days
  })

  it('reads a future timestamp as today rather than hiding it', () => {
    // Daemon/browser clock skew must not file a fresh run under "Older".
    expect(sessionAgeBucket('2026-08-03T09:00:00', NOW)).toBe('today')
  })

  it('sorts an unusable timestamp to older instead of throwing', () => {
    expect(sessionAgeBucket(null, NOW)).toBe('older')
    expect(sessionAgeBucket(undefined, NOW)).toBe('older')
    expect(sessionAgeBucket('not a date', NOW)).toBe('older')
  })
})

describe('groupSessionsByAge', () => {
  it('emits groups oldest-last and drops empty buckets', () => {
    const groups = groupSessionsByAge(
      [at('2026-08-02T09:00:00'), at('2026-07-20T09:00:00'), at('2026-08-01T09:00:00')],
      NOW
    )
    expect(groups.map((g) => g.bucket)).toEqual(['today', 'yesterday', 'month'])
    expect(groups.map((g) => g.label)).toEqual(['Today', 'Yesterday', 'Previous 30 days'])
  })

  it('preserves the caller order inside a group', () => {
    const first = at('2026-08-02T14:00:00')
    const second = at('2026-08-02T08:00:00')
    const groups = groupSessionsByAge([first, second], NOW)
    expect(groups[0]?.rows).toEqual([first, second])
  })

  it('returns nothing for an empty list', () => {
    expect(groupSessionsByAge([], NOW)).toEqual([])
  })
})
