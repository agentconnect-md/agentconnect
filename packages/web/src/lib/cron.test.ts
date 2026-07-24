import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CronDto } from './api'
import { cronNext, cronTimezoneInput, cronTimezoneSelectModel, cronUpdateInput, isIanaTimezone } from './cron'

afterEach(() => vi.useRealTimers())

describe('cronNext', () => {
  it('computes the next absolute fire time in the stored IANA timezone', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:30:00.000Z'))

    expect(cronNext('0 9 * * *', 'UTC')?.toISOString()).toBe('2026-01-01T09:00:00.000Z')
    expect(cronNext('0 9 * * *', 'Asia/Tokyo')?.toISOString()).toBe('2026-01-02T00:00:00.000Z')
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
