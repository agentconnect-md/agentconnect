import { describe, expect, it, vi } from 'vitest'
import { FakeClock } from '../../test/fakes/fake-clock.js'
import { WebchatMcpOperationReaper } from './webchatMcpOperationReaper.js'

const NOW = new Date('2026-07-31T00:00:00.000Z')

describe('WebchatMcpOperationReaper', () => {
  it('recovers operations before deleting expired authorities', async () => {
    const calls: string[] = []
    const operations = {
      reap: vi.fn(async (now: Date) => {
        calls.push(`operations:${now.toISOString()}`)
        return { markedAmbiguous: 1, markedStale: 2, evictedResponses: 3 }
      })
    }
    const delegations = {
      reapExpired: vi.fn(async (now: Date) => {
        calls.push(`delegations:${now.toISOString()}`)
        return { deleted: 4, expired: 2 }
      })
    }
    const reaper = new WebchatMcpOperationReaper(operations, delegations, new FakeClock(NOW.getTime()))

    await reaper.tick()

    expect(calls).toEqual([`operations:${NOW.toISOString()}`, `delegations:${NOW.toISOString()}`])
  })

  it('does not overlap ticks', async () => {
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const operations = {
      reap: vi.fn(async () => {
        await pending
        return { markedAmbiguous: 0, markedStale: 0, evictedResponses: 0 }
      })
    }
    const delegations = { reapExpired: vi.fn(async () => ({ deleted: 0, expired: 0 })) }
    const reaper = new WebchatMcpOperationReaper(operations, delegations, new FakeClock(NOW.getTime()))

    const first = reaper.tick()
    const second = reaper.tick()
    expect(second).toBe(first)
    expect(operations.reap).toHaveBeenCalledTimes(1)
    release()
    await first
  })
})
