import { describe, expect, it, vi } from 'vitest'
import { FakeClock } from '../../test/fakes/fake-clock.js'
import {
  AgentMemoryStagingSweeper,
  MEMORY_STAGING_MAX_AGE_MS,
  MEMORY_STAGING_SWEEP_INTERVAL_MS,
  MEMORY_STAGING_SWEEP_LIMIT
} from './agentMemoryStagingSweeper.js'

describe('AgentMemoryStagingSweeper', () => {
  it('sweeps rows staged longer than the max age, bounded per tick, on every interval', async () => {
    const clock = new FakeClock(10 * MEMORY_STAGING_MAX_AGE_MS)
    const sweepStaged = vi.fn(async () => 3)
    const sweeper = new AgentMemoryStagingSweeper({ sweepStaged }, clock)
    sweeper.start()
    expect(sweepStaged).not.toHaveBeenCalled()

    clock.advance(MEMORY_STAGING_SWEEP_INTERVAL_MS)
    await Promise.resolve()
    expect(sweepStaged).toHaveBeenCalledWith(
      new Date(clock.now() - MEMORY_STAGING_MAX_AGE_MS),
      MEMORY_STAGING_SWEEP_LIMIT
    )

    await sweeper.tick() // re-arms after the sweep
    clock.advance(MEMORY_STAGING_SWEEP_INTERVAL_MS)
    await Promise.resolve()
    expect(sweepStaged).toHaveBeenCalledTimes(3)
    sweeper.stop()
  })

  it('logs and survives a failing sweep, and stop() cancels the loop', async () => {
    const clock = new FakeClock(10 * MEMORY_STAGING_MAX_AGE_MS)
    const sweepStaged = vi.fn(async () => {
      throw new Error('db down')
    })
    const error = vi.fn()
    const sweeper = new AgentMemoryStagingSweeper({ sweepStaged }, clock, { info: vi.fn(), error })
    sweeper.start()
    await sweeper.tick()
    expect(error).toHaveBeenCalledOnce()

    sweeper.stop()
    clock.advance(10 * MEMORY_STAGING_SWEEP_INTERVAL_MS)
    await Promise.resolve()
    expect(sweepStaged).toHaveBeenCalledTimes(1)
  })
})
