import { describe, expect, it } from 'vitest'
import { CronUpsert } from './cron.js'

const wireCron = {
  cronId: '11111111-1111-4111-8111-111111111111',
  agentId: '22222222-2222-4222-8222-222222222222',
  schedule: '0 9 * * *',
  timezone: 'Asia/Singapore',
  trigger: 'post the daily report',
  enabled: true
}

describe('CronUpsert', () => {
  it('requires and preserves the resolved IANA timezone', () => {
    expect(CronUpsert.parse(wireCron).timezone).toBe('Asia/Singapore')

    const { timezone: _, ...missingTimezone } = wireCron
    expect(CronUpsert.safeParse(missingTimezone).success).toBe(false)
  })
})
