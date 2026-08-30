// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SCHEDULE_TIME_ZONE_KEY,
  browserTimeZone,
  displayTimeZone,
  hasDistinctScheduleZone,
  readScheduleTimeZoneMode,
  writeScheduleTimeZoneMode
} from './schedule-timezone'

afterEach(() => {
  window.localStorage.clear()
  vi.restoreAllMocks()
})

describe('readScheduleTimeZoneMode', () => {
  it('defaults to the viewer’s own clock', () => {
    expect(readScheduleTimeZoneMode()).toBe('browser')
  })

  it('round-trips the stored choice', () => {
    writeScheduleTimeZoneMode('schedule')
    expect(window.localStorage.getItem(SCHEDULE_TIME_ZONE_KEY)).toBe('schedule')
    expect(readScheduleTimeZoneMode()).toBe('schedule')

    writeScheduleTimeZoneMode('browser')
    expect(readScheduleTimeZoneMode()).toBe('browser')
  })

  it('falls back to the default for anything another version or tab may have written', () => {
    window.localStorage.setItem(SCHEDULE_TIME_ZONE_KEY, 'Asia/Tokyo')
    expect(readScheduleTimeZoneMode()).toBe('browser')
  })

  it('survives storage that throws, which a private window does', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })

    expect(readScheduleTimeZoneMode()).toBe('browser')
    expect(() => writeScheduleTimeZoneMode('schedule')).not.toThrow()
  })
})

describe('displayTimeZone', () => {
  it('uses the schedule’s zone only when asked for it', () => {
    expect(displayTimeZone('schedule', 'UTC')).toBe('UTC')
    expect(displayTimeZone('browser', 'UTC')).toBe(browserTimeZone())
  })

  it('falls back to the viewer’s zone for a schedule that names none', () => {
    expect(displayTimeZone('schedule', null)).toBe(browserTimeZone())
    expect(displayTimeZone('schedule', '')).toBe(browserTimeZone())
  })

  // `Not/AZone` and `UTC+8` make Intl throw, and a formatter that throws takes the view down; a bare
  // offset formats fine but is not a zone, which is the line `isIanaTimezone` already drew.
  it('falls back rather than hand a name Intl would reject to a formatter', () => {
    for (const zone of ['Not/AZone', 'UTC+8', '+08:00']) {
      expect(displayTimeZone('schedule', zone)).toBe(browserTimeZone())
      expect(() => new Intl.DateTimeFormat('en-CA', { timeZone: displayTimeZone('schedule', zone) })).not.toThrow()
    }
  })
})

describe('hasDistinctScheduleZone', () => {
  it('is false when there is nothing to switch to', () => {
    expect(hasDistinctScheduleZone(browserTimeZone())).toBe(false)
    expect(hasDistinctScheduleZone(null)).toBe(false)
    expect(hasDistinctScheduleZone('')).toBe(false)
  })

  it('is true for a schedule kept on another clock than the viewer', () => {
    expect(hasDistinctScheduleZone(browserTimeZone() === 'UTC' ? 'Asia/Tokyo' : 'UTC')).toBe(true)
  })

  it('is false for a zone no formatter could use, so the switch is not offered for one', () => {
    expect(hasDistinctScheduleZone('Not/AZone')).toBe(false)
    expect(hasDistinctScheduleZone('+08:00')).toBe(false)
  })
})
