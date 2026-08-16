import { describe, it, expect, vi } from 'vitest'
import { buildSyntheticMessage, missedOccurrence, Scheduler } from '../src/scheduler/scheduler.js'
import type { CronDef } from '../src/agents/agent-schema.js'

const cron = (id: string, over: Partial<CronDef> = {}): CronDef => ({
  id,
  schedule: '0 9 * * *',
  target: { platform: 'slack', channel: 'C1' },
  trigger: 'post health report',
  ...over
})

describe('buildSyntheticMessage', () => {
  it('builds a cron-sourced NormalizedMessage targeting the cron channel', () => {
    const { agentId, msg } = buildSyntheticMessage('bot-a', cron('daily'), 'trace-1')
    expect(agentId).toBe('bot-a')
    expect(msg.source).toBe('cron')
    expect(msg.trigger).toBe('cron')
    expect(msg.channel).toBe('C1')
    expect(msg.text).toBe('post health report')
    expect(msg.sender.isBot).toBe(false)
    expect(msg.headless).toBeUndefined()
  })

  it('a target-less cron builds a HEADLESS message with a synthetic channel key', () => {
    const { msg } = buildSyntheticMessage('bot-a', cron('daily', { target: undefined }), 'trace-1')
    expect(msg.headless).toBe(true)
    expect(msg.channel).toBe('cron:daily')
    expect(msg.text).toBe('post health report')
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
// schedule? A fresh `Cron` cannot answer it, so the answer comes from the pattern plus the stamp.
describe('missedOccurrence (handover catch-up)', () => {
  const DAILY = '0 3 * * *'
  const at = (iso: string) => new Date(iso).getTime()

  it('returns the previous occurrence when it is newer than the stamp', () => {
    const now = at('2026-03-07T03:00:40.000Z')
    expect(missedOccurrence(DAILY, 'Etc/UTC', at('2026-03-06T03:00:00.000Z'), now)).toBe(at('2026-03-07T03:00:00.000Z'))
  })

  it('returns nothing when the stamp already covers the previous occurrence', () => {
    const now = at('2026-03-07T03:00:40.000Z')
    expect(missedOccurrence(DAILY, 'Etc/UTC', at('2026-03-07T03:00:00.500Z'), now)).toBeUndefined()
  })

  it('returns nothing without a stamp — nothing durable says this schedule has ever been due', () => {
    expect(missedOccurrence(DAILY, 'Etc/UTC', undefined, at('2026-03-07T03:00:40.000Z'))).toBeUndefined()
  })

  it('refuses a stale moment: past the grace window a missed fire is history, not a late fire', () => {
    // Every minute ⇒ a one-minute grace, so the moment inside it is owed and an older one is not.
    expect(
      missedOccurrence('* * * * *', 'Etc/UTC', at('2026-03-07T03:00:00.000Z'), at('2026-03-07T03:02:30.000Z'))
    ).toBe(at('2026-03-07T03:02:00.000Z'))
    expect(
      missedOccurrence(DAILY, 'Etc/UTC', at('2026-03-01T03:00:00.000Z'), at('2026-03-07T09:00:00.000Z'))
    ).toBeUndefined()
  })

  it('never returns a backlog — a stamp days behind still yields only the newest missed moment', () => {
    const now = at('2026-03-07T03:00:40.000Z')
    expect(missedOccurrence(DAILY, 'Etc/UTC', at('2026-03-01T03:00:00.000Z'), now)).toBe(at('2026-03-07T03:00:00.000Z'))
  })

  it('returns nothing for a malformed pattern or an unknown zone instead of throwing', () => {
    const now = at('2026-03-07T03:00:40.000Z')
    expect(missedOccurrence('not-a-cron', undefined, at('2026-03-01T00:00:00.000Z'), now)).toBeUndefined()
    expect(missedOccurrence(DAILY, 'Mars/Olympus_Mons', at('2026-03-01T00:00:00.000Z'), now)).toBeUndefined()
  })
})
