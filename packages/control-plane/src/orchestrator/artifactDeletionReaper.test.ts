import { describe, expect, it, vi } from 'vitest'
import { FakeClock } from '../../test/fakes/fake-clock.js'
import { ArtifactDeletionReaper } from './artifactDeletionReaper.js'

describe('ArtifactDeletionReaper', () => {
  it('runs a retention pass and an unfinished-revision pass before each sweep, on every interval until stopped', async () => {
    const clock = new FakeClock(0)
    const calls: string[] = []
    const prune = vi.fn(async () => (calls.push('prune'), 2))
    const removeUnfinished = vi.fn(async () => (calls.push('removeUnfinished'), 3))
    const reap = vi.fn(async () => (calls.push('reap'), 1))
    const info = vi.fn()
    const passes = { prune, removeUnfinished, reap }
    const reaper = new ArtifactDeletionReaper(passes, clock, { intervalMs: 100 }, { info, error: vi.fn() })
    reaper.start()
    expect(prune).not.toHaveBeenCalled()
    clock.advance(100)
    await vi.waitFor(() => expect(reap).toHaveBeenCalledTimes(1))
    expect(calls).toEqual(['prune', 'removeUnfinished', 'reap'])
    expect(info).toHaveBeenCalledWith({ expired: 2 }, expect.any(String))
    expect(info).toHaveBeenCalledWith({ unfinished: 3 }, expect.any(String))
    clock.advance(100)
    await vi.waitFor(() => expect(reap).toHaveBeenCalledTimes(2))
    reaper.stop()
    clock.advance(1_000)
    expect(prune).toHaveBeenCalledTimes(2)
  })

  it('still sweeps when the earlier passes fail, and keeps going after any fails', async () => {
    const clock = new FakeClock(0)
    const prune = vi.fn(async () => {
      throw new Error('db down')
    })
    const removeUnfinished = vi.fn(async () => {
      throw new Error('db down')
    })
    const reap = vi.fn(async () => {
      throw new Error('bucket down')
    })
    const error = vi.fn()
    const passes = { prune, removeUnfinished, reap }
    const reaper = new ArtifactDeletionReaper(passes, clock, { intervalMs: 10 }, { info: vi.fn(), error })
    reaper.start()
    clock.advance(10)
    await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(3))
    expect(reap).toHaveBeenCalledTimes(1)
    clock.advance(10)
    await vi.waitFor(() => expect(prune).toHaveBeenCalledTimes(2))
    reaper.stop()
  })
})
