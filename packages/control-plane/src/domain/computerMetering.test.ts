import { describe, expect, it } from 'vitest'
import { meteredState, splitByUtcDay } from './computerMetering.js'

describe('managed computer metering (computer-use.md §15.5)', () => {
  it('bills a pod that is up as running and a kept volume alone as sleeping', () => {
    expect(meteredState('awake')).toBe('running')
    expect(meteredState('provisioning')).toBe('running')
    expect(meteredState('waking')).toBe('running')
    expect(meteredState('sleeping')).toBe('sleeping')
    expect(meteredState('failed')).toBe('sleeping')
    expect(meteredState('reclaiming')).toBeNull()
  })

  it('splits an interval at UTC midnights without losing a second', () => {
    const from = Date.parse('2026-10-20T23:59:30.400Z')
    const to = Date.parse('2026-10-22T00:00:10.400Z')
    const parts = splitByUtcDay(from, to)
    expect(parts.map((p) => [p.day.toISOString().slice(0, 10), p.seconds])).toEqual([
      ['2026-10-20', 29],
      ['2026-10-21', 86_400],
      ['2026-10-22', 11]
    ])
    expect(parts.reduce((n, p) => n + p.seconds, 0)).toBe((to - from) / 1000)
    expect(splitByUtcDay(to, from)).toEqual([])
  })
})
