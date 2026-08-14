import { describe, it, expect, vi } from 'vitest'
import { CloudDaemonReaper } from './cloudDaemonReaper.js'
import { DaemonId } from '../domain/ids.js'
import type { DaemonRecord } from '../persistence/ports.js'
import type { DaemonLiveness } from '../ports.js'
import { FakeClock } from '../../test/fakes/fake-clock.js'

const RETIRE_AFTER_MS = 15 * 60_000
const INTERVAL_MS = 5 * 60_000

const member = (id: string): DaemonRecord => ({ id: DaemonId(id), orgId: null }) as DaemonRecord

/** Only `get` is read; an entry means "connected to THIS control plane right now". */
const liveness = (...connected: string[]): DaemonLiveness =>
  ({ get: (id: string) => (connected.includes(id) ? { reachable: true } : undefined) }) as unknown as DaemonLiveness

describe('CloudDaemonReaper', () => {
  it('retires every member unheard-from since now − retireAfterMs', async () => {
    const clock = new FakeClock(1_700_000_000_000)
    const findRetiredCloudMembers = vi.fn(async () => [member('a'), member('b')])
    const retire = vi.fn(async () => true)
    const reaper = new CloudDaemonReaper({ findRetiredCloudMembers }, retire, liveness(), clock, {
      retireAfterMs: RETIRE_AFTER_MS,
      intervalMs: INTERVAL_MS
    })

    await reaper.tick()

    expect(findRetiredCloudMembers).toHaveBeenCalledWith(new Date(clock.now() - RETIRE_AFTER_MS))
    expect(retire.mock.calls.map(([id]) => id)).toEqual(['a', 'b'])
    reaper.stop()
  })

  it('leaves a member that is connected here, however stale its last heartbeat looks', async () => {
    const clock = new FakeClock()
    const retire = vi.fn(async () => true)
    const reaper = new CloudDaemonReaper(
      { findRetiredCloudMembers: async () => [member('live'), member('gone')] },
      retire,
      liveness('live'),
      clock,
      { retireAfterMs: RETIRE_AFTER_MS, intervalMs: INTERVAL_MS }
    )

    await reaper.tick()

    expect(retire.mock.calls.map(([id]) => id)).toEqual(['gone'])
    reaper.stop()
  })

  it('keeps going through the batch when retiring one member throws', async () => {
    const clock = new FakeClock()
    const retire = vi.fn(async (id: string) => {
      if (id === 'boom') throw new Error('cascade failed')
      return true
    })
    const reaper = new CloudDaemonReaper(
      { findRetiredCloudMembers: async () => [member('boom'), member('next')] },
      retire,
      liveness(),
      clock,
      { retireAfterMs: RETIRE_AFTER_MS, intervalMs: INTERVAL_MS }
    )

    await expect(reaper.tick()).resolves.toBeUndefined()
    expect(retire.mock.calls.map(([id]) => id)).toEqual(['boom', 'next'])
    reaper.stop()
  })

  it('swallows a failed worklist read and keeps the loop alive', async () => {
    const clock = new FakeClock()
    const reaper = new CloudDaemonReaper(
      {
        findRetiredCloudMembers: async () => {
          throw new Error('db down')
        }
      },
      async () => true,
      liveness(),
      clock,
      { retireAfterMs: RETIRE_AFTER_MS, intervalMs: INTERVAL_MS }
    )

    await expect(reaper.tick()).resolves.toBeUndefined()
    reaper.stop() // cancel the re-armed timer
  })

  it('start() arms a periodic sweep driven by the clock', async () => {
    const clock = new FakeClock()
    const findRetiredCloudMembers = vi.fn(async () => [])
    const reaper = new CloudDaemonReaper({ findRetiredCloudMembers }, async () => true, liveness(), clock, {
      retireAfterMs: RETIRE_AFTER_MS,
      intervalMs: INTERVAL_MS
    })

    reaper.start()
    expect(findRetiredCloudMembers).not.toHaveBeenCalled()
    clock.advance(INTERVAL_MS)
    await Promise.resolve() // let the async tick settle
    expect(findRetiredCloudMembers).toHaveBeenCalledTimes(1)
    reaper.stop()
  })
})
