import { describe, it, expect, vi } from 'vitest'
import { buildSyntheticMessage, Scheduler } from '../src/scheduler/scheduler.js'
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
