/**
 * Unit tests for `CronRunReaper` (design §5.3 — Clock-driven policy in the
 * no-Docker `unit` project). A fake repo records each sweep's cutoff so the
 * cadence and the `now − ttl` cutoff are pinned by advancing a `FakeClock` — no
 * DB, no socket.
 */
import { describe, it, expect } from 'vitest'
import { CronRunReaper, type CronRunReaperRepo } from './cronRunReaper.js'
import { FakeClock } from '../../test/fakes/fake-clock.js'

const TTL_MS = 30 * 60_000
const INTERVAL_MS = 5 * 60_000

class FakeRepo implements CronRunReaperRepo {
  calls: Date[] = []
  reaped = 0
  fail = false
  async reapStaleRuns(staleBefore: Date): Promise<number> {
    this.calls.push(staleBefore) // recorded synchronously on invocation
    if (this.fail) throw new Error('db down')
    return this.reaped
  }
}

// A real macrotask, so the awaited sweep's microtasks (its `finally` re-arm)
// drain before we assert. FakeClock only fakes the injected Clock, not globals.
const flush = () => new Promise<void>((r) => setTimeout(r, 0))

function setup(startMs = 1_000_000) {
  const clock = new FakeClock(startMs)
  const repo = new FakeRepo()
  const reaper = new CronRunReaper(repo, clock, { ttlMs: TTL_MS, intervalMs: INTERVAL_MS })
  return { clock, repo, reaper }
}

describe('CronRunReaper', () => {
  it('start() arms exactly one sweep; stop() cancels it', () => {
    const { clock, reaper } = setup()
    expect(clock.pendingTimers()).toBe(0)
    reaper.start()
    expect(clock.pendingTimers()).toBe(1)
    reaper.stop()
    expect(clock.pendingTimers()).toBe(0)
  })

  it('sweeps once per interval, with cutoff = now − ttl', async () => {
    const { clock, repo, reaper } = setup()
    reaper.start()

    clock.advance(INTERVAL_MS - 1)
    expect(repo.calls).toHaveLength(0) // not due yet

    clock.advance(1) // cross the interval
    expect(repo.calls).toHaveLength(1)
    expect(repo.calls[0]!.getTime()).toBe(clock.now() - TTL_MS)

    await flush() // let the sweep resolve and re-arm
    clock.advance(INTERVAL_MS)
    expect(repo.calls).toHaveLength(2) // loop re-armed itself
  })

  it('stops sweeping after stop()', async () => {
    const { clock, repo, reaper } = setup()
    reaper.start()
    clock.advance(INTERVAL_MS)
    await flush()
    expect(repo.calls).toHaveLength(1)

    reaper.stop()
    clock.advance(INTERVAL_MS * 5)
    expect(repo.calls).toHaveLength(1) // no further sweeps
    expect(clock.pendingTimers()).toBe(0)
  })

  it('swallows a failing sweep and keeps the loop alive', async () => {
    const { clock, repo, reaper } = setup()
    repo.fail = true
    reaper.start()

    clock.advance(INTERVAL_MS)
    await flush()
    expect(repo.calls).toHaveLength(1) // it ran…
    expect(clock.pendingTimers()).toBe(1) // …and re-armed despite throwing

    repo.fail = false
    clock.advance(INTERVAL_MS)
    expect(repo.calls).toHaveLength(2) // recovers on the next tick
    reaper.stop()
  })
})
