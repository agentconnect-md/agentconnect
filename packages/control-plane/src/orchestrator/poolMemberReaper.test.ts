import { describe, it, expect, vi } from 'vitest'
import { PoolMemberReaper } from './poolMemberReaper.js'
import { DaemonId } from '../domain/ids.js'
import type { DaemonRecord } from '../persistence/ports.js'
import type { DaemonLiveness } from '../ports.js'
import { FakeClock } from '../../test/fakes/fake-clock.js'

const RETIRE_AFTER_MS = 15 * 60_000
const INTERVAL_MS = 5 * 60_000

const member = (id: string, sessionEpoch = 7n): DaemonRecord =>
  ({ id: DaemonId(id), orgId: null, sessionEpoch }) as DaemonRecord

type Retire = (member: { daemonId: DaemonId; sessionEpoch: bigint }, retiredBefore: Date) => Promise<boolean>

/** No inert delegation to collect unless a case says otherwise. */
const noDelegations = () => ({ revokeUnplaced: vi.fn(async () => 0) })

/** Only `get` is read; an entry means "connected to THIS control plane right now". */
const liveness = (...connected: string[]): DaemonLiveness =>
  ({ get: (id: string) => (connected.includes(id) ? { reachable: true } : undefined) }) as unknown as DaemonLiveness

describe('PoolMemberReaper', () => {
  it('retires every member unheard-from since now − retireAfterMs', async () => {
    const clock = new FakeClock(1_700_000_000_000)
    const findRetiredPoolMembers = vi.fn(async () => [member('a'), member('b')])
    const retire = vi.fn<Retire>(async () => true)
    const reaper = new PoolMemberReaper({ findRetiredPoolMembers }, noDelegations(), retire, liveness(), clock, {
      retireAfterMs: RETIRE_AFTER_MS,
      intervalMs: INTERVAL_MS
    })

    await reaper.tick()

    expect(findRetiredPoolMembers).toHaveBeenCalledWith(new Date(clock.now() - RETIRE_AFTER_MS))
    expect(retire.mock.calls.map(([m]) => m.daemonId)).toEqual(['a', 'b'])
    reaper.stop()
  })

  it('hands retirement the same cutoff and epoch the sweep read, to re-fence on', async () => {
    // The worklist is a nomination, not a decision: whoever deletes has to prove the row is
    // still the one that was read, or a member that reconnected mid-sweep loses its agents.
    const clock = new FakeClock(1_700_000_000_000)
    const retire = vi.fn<Retire>(async () => true)
    const reaper = new PoolMemberReaper(
      { findRetiredPoolMembers: async () => [member('a', 12n)] },
      noDelegations(),
      retire,
      liveness(),
      clock,
      { retireAfterMs: RETIRE_AFTER_MS, intervalMs: INTERVAL_MS }
    )

    await reaper.tick()

    expect(retire).toHaveBeenCalledWith({ daemonId: 'a', sessionEpoch: 12n }, new Date(clock.now() - RETIRE_AFTER_MS))
    reaper.stop()
  })

  it('does not count a member the claim refused — it came back', async () => {
    const clock = new FakeClock()
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const reaper = new PoolMemberReaper(
      { findRetiredPoolMembers: async () => [member('back')] },
      noDelegations(),
      async () => false,
      liveness(),
      clock,
      { retireAfterMs: RETIRE_AFTER_MS, intervalMs: INTERVAL_MS },
      log
    )

    await reaper.tick()

    expect(log.info).not.toHaveBeenCalled()
    reaper.stop()
  })

  it('leaves a member that is connected here, however stale its last heartbeat looks', async () => {
    const clock = new FakeClock()
    const retire = vi.fn<Retire>(async () => true)
    const reaper = new PoolMemberReaper(
      { findRetiredPoolMembers: async () => [member('live'), member('gone')] },
      noDelegations(),
      retire,
      liveness('live'),
      clock,
      { retireAfterMs: RETIRE_AFTER_MS, intervalMs: INTERVAL_MS }
    )

    await reaper.tick()

    expect(retire.mock.calls.map(([m]) => m.daemonId)).toEqual(['gone'])
    reaper.stop()
  })

  it('keeps going through the batch when retiring one member throws', async () => {
    const clock = new FakeClock()
    const retire = vi.fn(async (m: { daemonId: string }) => {
      if (m.daemonId === 'boom') throw new Error('cascade failed')
      return true
    })
    const reaper = new PoolMemberReaper(
      { findRetiredPoolMembers: async () => [member('boom'), member('next')] },
      noDelegations(),
      retire,
      liveness(),
      clock,
      { retireAfterMs: RETIRE_AFTER_MS, intervalMs: INTERVAL_MS }
    )

    await expect(reaper.tick()).resolves.toBeUndefined()
    expect(retire.mock.calls.map(([m]) => m.daemonId)).toEqual(['boom', 'next'])
    reaper.stop()
  })

  it('swallows a failed worklist read and keeps the loop alive', async () => {
    const clock = new FakeClock()
    const reaper = new PoolMemberReaper(
      {
        findRetiredPoolMembers: async () => {
          throw new Error('db down')
        }
      },
      noDelegations(),
      async () => true,
      liveness(),
      clock,
      { retireAfterMs: RETIRE_AFTER_MS, intervalMs: INTERVAL_MS }
    )

    await expect(reaper.tick()).resolves.toBeUndefined()
    reaper.stop() // cancel the re-armed timer
  })

  it('revokes the delegations a retirement leaves inert, every sweep', async () => {
    // Agent-keyed since #1057, so deleting a member no longer cascades them away; the rows go
    // inert (nothing serves the agent) rather than disappearing, and this is what collects them.
    const clock = new FakeClock()
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const delegations = { revokeUnplaced: vi.fn(async () => 3) }
    const reaper = new PoolMemberReaper(
      { findRetiredPoolMembers: async () => [] },
      delegations,
      async () => true,
      liveness(),
      clock,
      { retireAfterMs: RETIRE_AFTER_MS, intervalMs: INTERVAL_MS },
      log
    )

    await reaper.tick()

    expect(delegations.revokeUnplaced).toHaveBeenCalledWith(new Date(clock.now()))
    expect(log.info).toHaveBeenCalledWith({ revoked: 3 }, expect.stringContaining('unplaced'))
    reaper.stop()
  })

  it('swallows a failed delegation sweep and keeps the loop alive', async () => {
    const clock = new FakeClock()
    const reaper = new PoolMemberReaper(
      { findRetiredPoolMembers: async () => [] },
      {
        revokeUnplaced: async () => {
          throw new Error('db down')
        }
      },
      async () => true,
      liveness(),
      clock,
      { retireAfterMs: RETIRE_AFTER_MS, intervalMs: INTERVAL_MS }
    )

    await expect(reaper.tick()).resolves.toBeUndefined()
    reaper.stop()
  })

  it('start() arms a periodic sweep driven by the clock', async () => {
    const clock = new FakeClock()
    const findRetiredPoolMembers = vi.fn(async () => [])
    const reaper = new PoolMemberReaper(
      { findRetiredPoolMembers },
      noDelegations(),
      async () => true,
      liveness(),
      clock,
      {
        retireAfterMs: RETIRE_AFTER_MS,
        intervalMs: INTERVAL_MS
      }
    )

    reaper.start()
    expect(findRetiredPoolMembers).not.toHaveBeenCalled()
    clock.advance(INTERVAL_MS)
    await Promise.resolve() // let the async tick settle
    expect(findRetiredPoolMembers).toHaveBeenCalledTimes(1)
    reaper.stop()
  })
})
