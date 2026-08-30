import { describe, it, expect, vi } from 'vitest'
import {
  buildSyntheticMessage,
  missedOccurrence,
  scheduleFingerprint,
  scheduledRunContext,
  Scheduler
} from '../src/scheduler/scheduler.js'
import type { ScheduleDefinition } from '../src/scheduler/scheduler.js'
import type { CronDef } from '../src/agents/agent-schema.js'

const cron = (id: string, over: Partial<CronDef> = {}): CronDef => ({
  id,
  schedule: '0 9 * * *',
  target: { platform: 'slack', channel: 'C1' },
  trigger: 'post health report',
  enabled: true,
  ...over
})

// 17:58 UTC is already the NEXT day in Shanghai — the straddle that dated a nightly digest to
// yesterday, because the host clock and the schedule's clock disagreed about what day it was.
const FIRED_AT = new Date('2026-08-29T17:58:10.000Z')

describe('buildSyntheticMessage', () => {
  it('builds a cron-sourced NormalizedMessage targeting the cron channel', () => {
    const { agentId, msg } = buildSyntheticMessage('bot-a', cron('daily'), 'trace-1', FIRED_AT)
    expect(agentId).toBe('bot-a')
    expect(msg.source).toBe('cron')
    expect(msg.trigger).toBe('cron')
    expect(msg.channel).toBe('C1')
    expect(msg.sender.isBot).toBe(false)
    expect(msg.headless).toBeUndefined()
  })

  it('leads with the firing clock and keeps the operator’s prompt intact below it', () => {
    const { msg } = buildSyntheticMessage('bot-a', cron('daily', { timezone: 'Asia/Shanghai' }), 't', FIRED_AT)
    expect(msg.text).toBe(
      "Scheduled run: 2026-08-30 01:58 Asia/Shanghai — the schedule's own clock; this host's may differ.\n\npost health report"
    )
  })

  it('a target-less cron builds a HEADLESS message with a synthetic channel key', () => {
    const { msg } = buildSyntheticMessage('bot-a', cron('daily', { target: undefined }), 'trace-1', FIRED_AT)
    expect(msg.headless).toBe(true)
    expect(msg.channel).toBe('cron:daily')
    expect(msg.text.endsWith('post health report')).toBe(true)
  })
})

describe('scheduledRunContext', () => {
  it('reads the fire on the schedule’s clock, which can be a different day than the host’s', () => {
    expect(scheduledRunContext(cron('d', { timezone: 'Asia/Shanghai' }), FIRED_AT)).toContain('2026-08-30 01:58')
    expect(scheduledRunContext(cron('d', { timezone: 'UTC' }), FIRED_AT)).toContain('2026-08-29 17:58')
    expect(scheduledRunContext(cron('d', { timezone: 'America/New_York' }), FIRED_AT)).toContain('2026-08-29 13:58')
  })

  it('names the zone it read in, so the agent can tell which clock it was given', () => {
    expect(scheduledRunContext(cron('d', { timezone: 'Asia/Tokyo' }), FIRED_AT)).toContain('Asia/Tokyo')
  })

  it('falls back to the host clock for a cron that names no zone — croner reads it locally too', () => {
    const hostZone = Intl.DateTimeFormat().resolvedOptions().timeZone
    expect(scheduledRunContext(cron('d'), FIRED_AT)).toContain(hostZone)
  })

  // A hand-authored cron is not validated against IANA, and Intl throws on a name it does not know.
  it('falls back rather than throw on a zone no formatter accepts', () => {
    const hostZone = Intl.DateTimeFormat().resolvedOptions().timeZone
    expect(scheduledRunContext(cron('d', { timezone: 'Not/AZone' }), FIRED_AT)).toContain(hostZone)
  })

  it('renders midnight as hour 00, never 24', () => {
    const midnight = new Date('2026-08-29T16:00:00.000Z')
    expect(scheduledRunContext(cron('d', { timezone: 'Asia/Shanghai' }), midnight)).toContain('2026-08-30 00:00')
  })
})

describe('Scheduler (per-agent converge — §5.2 crons change → upsert/remove)', () => {
  const deps = () => ({ onFire: vi.fn(), newTraceId: () => 't', warn: vi.fn() })

  it("sync registers an agent's cron set and is replace-all idempotent", () => {
    const s = new Scheduler(deps())
    s.sync('bot-a', [cron('one'), cron('two')])
    expect(s.count('bot-a')).toBe(2)
    s.sync('bot-a', [cron('one')]) // re-sync replaces, never accumulates
    expect(s.count('bot-a')).toBe(1)
    s.sync('bot-a', [])
    expect(s.count('bot-a')).toBe(0)
    s.stop()
  })

  it("unregister drops only that agent's jobs", () => {
    const s = new Scheduler(deps())
    s.sync('bot-a', [cron('one')])
    s.sync('bot-b', [cron('two')])
    s.unregister('bot-a')
    expect(s.count('bot-a')).toBe(0)
    expect(s.count('bot-b')).toBe(1)
    s.stop()
  })

  it('a malformed schedule skips that cron (warned) but registers the rest', () => {
    const d = deps()
    const s = new Scheduler(d)
    s.sync('bot-a', [cron('bad', { schedule: 'not-a-cron' }), cron('good')])
    expect(s.count('bot-a')).toBe(1)
    expect(d.warn).toHaveBeenCalledOnce()
    s.stop()
  })

  it('disabled crons stay unscheduled', () => {
    const s = new Scheduler(deps())
    s.sync('bot-a', [cron('off', { enabled: false }), cron('on')])
    expect(s.count('bot-a')).toBe(1)
    s.stop()
  })

  it('uses an explicit IANA timezone while local crons without one keep daemon-local scheduling', () => {
    const d = deps()
    const s = new Scheduler(d)
    s.sync('bot-a', [
      cron('zoned', { timezone: 'Asia/Singapore' }),
      cron('local'),
      cron('bad-zone', { timezone: 'Mars/Olympus_Mons' })
    ])
    expect(s.count('bot-a')).toBe(2)
    expect(d.warn).toHaveBeenCalledOnce()
    s.stop()
  })

  it('fires at timezone-correct UTC instants across a DST offset change', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-07T13:59:59.000Z'))
    const firedAt: string[] = []
    const s = new Scheduler({
      onFire: () => firedAt.push(new Date().toISOString()),
      newTraceId: () => 't',
      warn: vi.fn()
    })

    try {
      s.sync('bot-a', [cron('new-york-morning', { timezone: 'America/New_York' })])
      await vi.advanceTimersByTimeAsync(1_000)
      expect(firedAt).toEqual(['2026-03-07T14:00:00.000Z'])

      await vi.advanceTimersByTimeAsync(23 * 60 * 60 * 1_000)
      expect(firedAt).toEqual(['2026-03-07T14:00:00.000Z', '2026-03-08T13:00:00.000Z'])
    } finally {
      s.stop()
      vi.useRealTimers()
    }
  })
})

// #1031 — the arm-time question a duty handover creates: was a fire due while nobody held this
// schedule? A fresh `Cron` cannot answer it, so the answer comes from the pattern, the stamp, and
// the definition the stamp was written under.
describe('missedOccurrence (handover catch-up)', () => {
  const DAILY = { schedule: '0 3 * * *', timezone: 'Etc/UTC', enabled: true }
  const at = (iso: string) => new Date(iso).getTime()
  const ranAt = (iso: string, definition: ScheduleDefinition = DAILY) => ({
    lastRunAt: at(iso),
    definition: scheduleFingerprint(definition)
  })

  it('returns the previous occurrence when it is newer than the stamp', () => {
    expect(missedOccurrence(DAILY, ranAt('2026-03-06T03:00:00.000Z'), at('2026-03-07T03:00:40.000Z'))).toBe(
      at('2026-03-07T03:00:00.000Z')
    )
  })

  it('returns nothing when the stamp already covers the previous occurrence', () => {
    expect(missedOccurrence(DAILY, ranAt('2026-03-07T03:00:00.500Z'), at('2026-03-07T03:00:40.000Z'))).toBeUndefined()
  })

  it('returns nothing without a stamp — nothing durable says this schedule has ever been due', () => {
    expect(missedOccurrence(DAILY, undefined, at('2026-03-07T03:00:40.000Z'))).toBeUndefined()
  })

  it('returns nothing when the stamp was written under a DIFFERENT definition', () => {
    const now = at('2026-03-07T12:40:00.000Z')
    const hourly = { schedule: '0 * * * *', timezone: 'Etc/UTC', enabled: true }
    // Daily last stamped at 03:00, switched to hourly at 12:30: 12:00 is a moment the hourly
    // definition never covered, and the stamp is no evidence about it either way.
    expect(missedOccurrence(hourly, ranAt('2026-03-07T03:00:00.000Z'), now)).toBeUndefined()
    // A moved timezone and a moved enabled flag are the same kind of change.
    expect(
      missedOccurrence(DAILY, ranAt('2026-03-06T03:00:00.000Z', { ...DAILY, timezone: 'Asia/Singapore' }), now)
    ).toBeUndefined()
    expect(
      missedOccurrence(DAILY, ranAt('2026-03-06T03:00:00.000Z', { ...DAILY, enabled: false }), now)
    ).toBeUndefined()
    // A legacy row that predates the fingerprint is ineligible rather than assumed to match.
    expect(
      missedOccurrence(DAILY, { lastRunAt: at('2026-03-06T03:00:00.000Z'), definition: null }, now)
    ).toBeUndefined()
  })

  it('returns nothing for a disabled definition — it is not armed, so nothing is owed', () => {
    const off = { ...DAILY, enabled: false }
    expect(
      missedOccurrence(off, ranAt('2026-03-06T03:00:00.000Z', off), at('2026-03-07T03:00:40.000Z'))
    ).toBeUndefined()
  })

  it('refuses a stale moment: past the grace window a missed fire is history, not a late fire', () => {
    // Every minute ⇒ a one-minute grace, so the moment inside it is owed and an older one is not.
    const minutely = { schedule: '* * * * *', timezone: 'Etc/UTC', enabled: true }
    expect(
      missedOccurrence(minutely, ranAt('2026-03-07T03:00:00.000Z', minutely), at('2026-03-07T03:02:30.000Z'))
    ).toBe(at('2026-03-07T03:02:00.000Z'))
    expect(missedOccurrence(DAILY, ranAt('2026-03-01T03:00:00.000Z'), at('2026-03-07T09:00:00.000Z'))).toBeUndefined()
  })

  it('never returns a backlog — a stamp days behind still yields only the newest missed moment', () => {
    expect(missedOccurrence(DAILY, ranAt('2026-03-01T03:00:00.000Z'), at('2026-03-07T03:00:40.000Z'))).toBe(
      at('2026-03-07T03:00:00.000Z')
    )
  })

  it('returns nothing for a malformed pattern or an unknown zone instead of throwing', () => {
    const now = at('2026-03-07T03:00:40.000Z')
    const bad = { schedule: 'not-a-cron', enabled: true }
    const zone = { ...DAILY, timezone: 'Mars/Olympus_Mons' }
    expect(missedOccurrence(bad, ranAt('2026-03-01T00:00:00.000Z', bad), now)).toBeUndefined()
    expect(missedOccurrence(zone, ranAt('2026-03-01T00:00:00.000Z', zone), now)).toBeUndefined()
  })
})
