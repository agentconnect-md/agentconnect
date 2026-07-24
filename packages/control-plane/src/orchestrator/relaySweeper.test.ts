import { describe, it, expect, vi } from 'vitest'
import { RelaySweeper } from './relaySweeper.js'
import { FakeClock } from '../../test/fakes/fake-clock.js'

const STALE_MS = 45_000
const INTERVAL_MS = 15_000

describe('RelaySweeper', () => {
  it('reaps rows older than now − staleMs and fans the roster when any dropped', async () => {
    const clock = new FakeClock(1_700_000_000_000)
    const sweepStale = vi.fn(async () => 2)
    const onSwept = vi.fn(async () => {})
    const sweeper = new RelaySweeper({ sweepStale }, clock, { staleMs: STALE_MS, intervalMs: INTERVAL_MS }, onSwept)

    await sweeper.tick()
    expect(sweepStale).toHaveBeenCalledWith(new Date(clock.now() - STALE_MS))
    expect(onSwept).toHaveBeenCalledOnce()
  })

  it('does NOT fan the roster when nothing was swept', async () => {
    const clock = new FakeClock()
    const onSwept = vi.fn(async () => {})
    const sweeper = new RelaySweeper(
      { sweepStale: async () => 0 },
      clock,
      { staleMs: STALE_MS, intervalMs: INTERVAL_MS },
      onSwept
    )
    await sweeper.tick()
    expect(onSwept).not.toHaveBeenCalled()
  })

  it('swallows a sweep error and keeps the loop alive (re-arms)', async () => {
    const clock = new FakeClock()
    const onSwept = vi.fn(async () => {})
    const sweeper = new RelaySweeper(
      {
        sweepStale: async () => {
          throw new Error('db down')
        }
      },
      clock,
      { staleMs: STALE_MS, intervalMs: INTERVAL_MS },
      onSwept
    )
    await expect(sweeper.tick()).resolves.toBeUndefined()
    expect(onSwept).not.toHaveBeenCalled()
    sweeper.stop() // cancel the re-armed timer
  })

  it('start() arms a periodic sweep driven by the clock', async () => {
    const clock = new FakeClock()
    const sweepStale = vi.fn(async () => 0)
    const sweeper = new RelaySweeper({ sweepStale }, clock, { staleMs: STALE_MS, intervalMs: INTERVAL_MS })
    sweeper.start()
    expect(sweepStale).not.toHaveBeenCalled()
    clock.advance(INTERVAL_MS)
    await Promise.resolve() // let the async tick settle
    expect(sweepStale).toHaveBeenCalledTimes(1)
    sweeper.stop()
  })
})
