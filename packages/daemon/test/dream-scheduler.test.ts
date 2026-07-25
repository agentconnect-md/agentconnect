import { describe, expect, it } from 'vitest'
import type { MemoryDreamingPolicy } from '@agentconnect.md/protocol'
import { DreamScheduler } from '../src/scheduler/dream-scheduler.js'

/** A cron that fires every second, so a real tick is observable in a test. */
const EVERY_SECOND = '* * * * * *'

function make(): { fired: string[]; warned: string[]; scheduler: DreamScheduler } {
  const fired: string[] = []
  const warned: string[] = []
  const scheduler = new DreamScheduler({ onFire: (id) => fired.push(id), warn: (m) => warned.push(m) })
  return { fired, warned, scheduler }
}

describe('DreamScheduler', () => {
  it('schedules only an enabled policy that carries a cron', () => {
    const { scheduler } = make()
    const cases: [string, MemoryDreamingPolicy | undefined, number][] = [
      ['no policy at all', undefined, 0],
      ['disabled with a schedule', { enabled: false, schedule: '0 4 * * *' }, 0],
      ['enabled without a schedule (manual-only)', { enabled: true }, 0],
      ['enabled with a schedule', { enabled: true, schedule: '0 4 * * *' }, 1]
    ]
    for (const [label, policy, expected] of cases) {
      scheduler.sync('a1', policy)
      expect(scheduler.count('a1'), label).toBe(expected)
    }
    scheduler.stop()
  })

  it('converges on re-sync and drops the job on unregister', () => {
    const { scheduler } = make()
    scheduler.sync('a1', { enabled: true, schedule: '0 4 * * *' })
    const first = scheduler.nextRun('a1')
    expect(first).toBeInstanceOf(Date)

    // Re-syncing is idempotent (replace-all), so a reconcile may call it freely.
    scheduler.sync('a1', { enabled: true, schedule: '0 4 * * *' })
    expect(scheduler.count('a1')).toBe(1)

    // Turning dreaming off converges the agent to unscheduled.
    scheduler.sync('a1', { enabled: false, schedule: '0 4 * * *' })
    expect(scheduler.count('a1')).toBe(0)
    expect(scheduler.nextRun('a1')).toBeNull()

    scheduler.sync('a1', { enabled: true, schedule: '0 4 * * *' })
    scheduler.unregister('a1')
    expect(scheduler.count('a1')).toBe(0)
    scheduler.stop()
  })

  it('drops a malformed expression with a warning instead of throwing at the reconciler', () => {
    const { warned, scheduler } = make()
    expect(() => scheduler.sync('a1', { enabled: true, schedule: 'not a cron' })).not.toThrow()
    expect(scheduler.count('a1')).toBe(0)
    expect(warned[0]).toContain('a1')

    // One bad agent must not stop a good one from scheduling.
    scheduler.sync('a2', { enabled: true, schedule: '0 4 * * *' })
    expect(scheduler.count('a2')).toBe(1)
    scheduler.stop()
  })

  it('rejects an invalid timezone without scheduling the agent', () => {
    const { warned, scheduler } = make()
    scheduler.sync('a1', { enabled: true, schedule: '0 4 * * *', timezone: 'Mars/Olympus_Mons' })
    expect(scheduler.count('a1')).toBe(0)
    expect(warned).toHaveLength(1)
    scheduler.stop()
  })

  it('fires onFire for the scheduled agent', async () => {
    const { fired, scheduler } = make()
    scheduler.sync('a1', { enabled: true, schedule: EVERY_SECOND })
    await new Promise((r) => setTimeout(r, 1400))
    scheduler.stop()
    expect(fired.length).toBeGreaterThanOrEqual(1)
    expect(new Set(fired)).toEqual(new Set(['a1']))
  })

  it('stops firing once stopped', async () => {
    const { fired, scheduler } = make()
    scheduler.sync('a1', { enabled: true, schedule: EVERY_SECOND })
    scheduler.stop()
    await new Promise((r) => setTimeout(r, 1200))
    expect(fired).toHaveLength(0)
  })
})
