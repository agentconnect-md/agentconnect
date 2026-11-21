import { describe, expect, it } from 'vitest'
import { CRON_RUN_SKIPPED_FEATURE, CronReport, CronUpsert } from './cron.js'

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

describe('cron/report outcomes', () => {
  const fire = { cronId: wireCron.cronId, agentId: wireCron.agentId, firedAt: '2026-07-03T09:00:00.000Z' }

  it('reads a skipped fire with its reason and no session', () => {
    expect(CronReport.parse({ ...fire, status: 'skipped', reason: 'agent is paused' })).toEqual({
      ...fire,
      status: 'skipped',
      reason: 'agent is paused'
    })
  })

  it('still refuses an outcome it does not know', () => {
    expect(CronReport.safeParse({ ...fire, status: 'cancelled' }).success).toBe(false)
  })

  it('names the feature a control plane advertises to receive skipped outcomes', () => {
    expect(CRON_RUN_SKIPPED_FEATURE).toBe('cron-run-skipped-v1')
  })
})
