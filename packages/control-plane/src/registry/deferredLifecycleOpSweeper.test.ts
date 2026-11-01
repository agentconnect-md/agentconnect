import { describe, it, expect, vi } from 'vitest'
import { FakeClock } from '../../test/fakes/fake-clock.js'
import { DeferredLifecycleOpSweeper } from './deferredLifecycleOpSweeper.js'

describe('DeferredLifecycleOpSweeper', () => {
  it('deletes deferred rows older than the retention on each interval until stopped', async () => {
    const clock = new FakeClock(10_000_000)
    const deleteDeferredBefore = vi.fn(async () => 1)
    const sweeper = new DeferredLifecycleOpSweeper({ deleteDeferredBefore }, clock, {
      retentionMs: 1_000,
      intervalMs: 5_000
    })
    sweeper.start()
    expect(deleteDeferredBefore).not.toHaveBeenCalled()
    clock.advance(5_000)
    await vi.waitFor(() => expect(deleteDeferredBefore).toHaveBeenCalledTimes(1))
    expect(deleteDeferredBefore).toHaveBeenCalledWith(new Date(10_005_000 - 1_000))
    sweeper.stop()
    clock.advance(50_000)
    expect(deleteDeferredBefore).toHaveBeenCalledTimes(1)
  })

  it('keeps sweeping after a failed round', async () => {
    const clock = new FakeClock(0)
    const deleteDeferredBefore = vi.fn(async () => {
      throw new Error('db down')
    })
    const error = vi.fn()
    const sweeper = new DeferredLifecycleOpSweeper(
      { deleteDeferredBefore },
      clock,
      { retentionMs: 1, intervalMs: 10 },
      { info: vi.fn(), error }
    )
    sweeper.start()
    clock.advance(10)
    await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(1))
    clock.advance(10)
    await vi.waitFor(() => expect(deleteDeferredBefore).toHaveBeenCalledTimes(2))
    sweeper.stop()
  })
})
