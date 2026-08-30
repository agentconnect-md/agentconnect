import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CronDto } from './api'
import {
  cronNext,
  cronTimezoneInput,
  cronTimezoneSelectModel,
  cronUpdateInput,
  fmtNextRun,
  isIanaTimezone,
  zonedDay
} from './cron'

afterEach(() => vi.useRealTimers())

describe('cronNext', () => {
  it('computes the next absolute fire time in the stored IANA timezone', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:30:00.000Z'))

    expect(cronNext('0 9 * * *', 'UTC')?.toISOString()).toBe('2026-01-01T09:00:00.000Z')
    expect(cronNext('0 9 * * *', 'Asia/Tokyo')?.toISOString()).toBe('2026-01-02T00:00:00.000Z')
  })
})

describe('fmtNextRun', () => {
  // 2026-01-01T20:30Z is still Jan 1 in UTC but already Jan 2 in Tokyo, so "Today" has to be
  // decided in the zone being rendered rather than in the viewer's.
  const evening = new Date('2026-01-01T20:30:00.000Z')

  // The wall clock is derived, not spelled out: `fmtNextRun` formats with the runtime's own locale,
  // so a literal "8:30 PM" would fail on a 24-hour runner for a reason these tests are not about.
  // The zone axis they ARE about stays real — each pair asserts the two zones differ first.
  const wall = (d: Date, timeZone: string) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone })

  it("names the calendar day of the zone it renders in, not the viewer's", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T12:00:00.000Z'))

    expect(wall(evening, 'UTC')).not.toBe(wall(evening, 'Asia/Tokyo'))
    expect(fmtNextRun(evening, 'UTC')).toBe(`Today ${wall(evening, 'UTC')}`)
    expect(fmtNextRun(evening, 'Asia/Tokyo')).toBe(`Tomorrow ${wall(evening, 'Asia/Tokyo')}`)
  })

  it('renders the same instant at the wall clock of each zone', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    const morning = new Date('2026-01-01T09:00:00.000Z')

    expect(wall(morning, 'UTC')).not.toBe(wall(morning, 'Asia/Shanghai'))
    expect(fmtNextRun(morning, 'UTC')).toBe(`Today ${wall(morning, 'UTC')}`)
    expect(fmtNextRun(morning, 'Asia/Shanghai')).toBe(`Today ${wall(morning, 'Asia/Shanghai')}`)
  })

  it('stays relative inside the hour, where a duration reads the same in every zone', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T09:00:00.000Z'))

    const soon = new Date('2026-01-01T09:20:00.000Z')
    expect(fmtNextRun(soon, 'UTC')).toBe('in 20 min')
    expect(fmtNextRun(soon, 'Asia/Tokyo')).toBe('in 20 min')
    expect(fmtNextRun(null, 'UTC')).toBe('—')
  })
})

describe('zonedDay', () => {
  it('splits one instant across two calendar days by zone', () => {
    const instant = new Date('2026-01-01T20:30:00.000Z')
    expect(zonedDay(instant, 'UTC')).toBe('2026-01-01')
    expect(zonedDay(instant, 'Asia/Tokyo')).toBe('2026-01-02')
  })
})

describe('cronUpdateInput', () => {
  const cron: CronDto = {
    id: 'cron-1',
    orgId: 'org-1',
    agentId: 'agent-1',
    name: 'daily',
    schedule: '0 9 * * *',
    timezone: 'America/New_York',
    targetPlatform: 'slack',
    targetChannel: null,
    targetIntegrationId: null,
    trigger: 'daily report',
    enabled: true,
    lastRunAt: null,
    createdBy: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastModifiedBy: null,
    lastModifiedAt: '2026-01-01T00:00:00.000Z',
    visibility: 'org',
    sharedWith: [],
    canEdit: true,
    canManageSharing: true
  }

  it('builds every edit from the stored timezone and applies only explicit overrides', () => {
    expect(cronUpdateInput(cron, { enabled: false })).toMatchObject({
      agentId: 'agent-1',
      schedule: '0 9 * * *',
      timezone: 'America/New_York',
      trigger: 'daily report',
      enabled: false
    })
    expect(cronUpdateInput({ ...cron, agentId: null })).toBeNull()
  })

  it('omits a blank timezone only on create and rejects clearing it on edit', () => {
    expect(cronTimezoneInput(null, '')).toEqual({})
    expect(cronTimezoneInput(cron, '')).toBeNull()
    expect(cronTimezoneInput(cron, 'Mars/Olympus_Mons')).toBeNull()
    expect(cronTimezoneInput(cron, ' Asia/Singapore ')).toEqual({ timezone: 'Asia/Singapore' })
  })

  it('submits an explicit timezone on create', () => {
    expect(cronTimezoneInput(null, 'Asia/Singapore')).toEqual({ timezone: 'Asia/Singapore' })
  })

  it('passes through only an unchanged stored timezone that Intl does not recognize', () => {
    const legacyCron = { ...cron, timezone: 'Legacy/Stored_Zone' }

    expect(isIanaTimezone(legacyCron.timezone)).toBe(false)
    expect(cronTimezoneInput(legacyCron, 'Legacy/Stored_Zone')).toEqual({ timezone: 'Legacy/Stored_Zone' })
    expect(cronTimezoneInput(legacyCron, 'Legacy/New_Zone')).toBeNull()
  })

  it('rejects a whitespace-modified stored timezone that Intl does not recognize', () => {
    const legacyCron = { ...cron, timezone: 'Legacy/Stored_Zone' }

    expect(cronTimezoneInput(legacyCron, ' Legacy/Stored_Zone ')).toBeNull()
  })
})

describe('cronTimezoneSelectModel', () => {
  const supportedTimezones = ['UTC', 'Asia/Singapore']

  it('defaults a new cron to the browser timezone and labels that option', () => {
    expect(cronTimezoneSelectModel(null, 'Asia/Singapore', supportedTimezones)).toEqual({
      initialValue: 'Asia/Singapore',
      options: [
        { value: 'Asia/Singapore', label: 'Browser default (Asia/Singapore)' },
        { value: 'UTC', label: 'UTC' }
      ]
    })
  })

  it('preserves a stored timezone omitted from the supported list and uses plain labels while editing', () => {
    expect(cronTimezoneSelectModel('US/Eastern', 'Asia/Singapore', supportedTimezones)).toEqual({
      initialValue: 'US/Eastern',
      options: [
        { value: 'Asia/Singapore', label: 'Asia/Singapore' },
        { value: 'US/Eastern', label: 'US/Eastern' },
        { value: 'UTC', label: 'UTC' }
      ]
    })
  })

  it('falls back to the browser timezone and UTC when the supported list is empty', () => {
    expect(cronTimezoneSelectModel(null, 'Asia/Singapore', [])).toEqual({
      initialValue: 'Asia/Singapore',
      options: [
        { value: 'Asia/Singapore', label: 'Browser default (Asia/Singapore)' },
        { value: 'UTC', label: 'UTC' }
      ]
    })
  })
})

describe('isIanaTimezone', () => {
  it('accepts IANA zones and rejects arbitrary labels', () => {
    expect(isIanaTimezone('Asia/Singapore')).toBe(true)
    expect(isIanaTimezone('+01:00')).toBe(false)
    expect(isIanaTimezone('Mars/Olympus_Mons')).toBe(false)
    expect(isIanaTimezone('')).toBe(false)
  })
})
