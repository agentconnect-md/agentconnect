/**
 * Unit tests for `SlackInstallReaper` (Clock-driven policy in the no-Docker `unit`
 * project). A fake repo records each sweep's cutoff so the cadence and the
 * `now − ttl` cutoff are pinned by advancing a `FakeClock` — no DB, no socket.
 */
import { describe, it, expect } from 'vitest'
import { SlackInstallReaper, type SlackInstallReaperRepo } from './slackInstallReaper.js'
import { FakeClock } from '../../test/fakes/fake-clock.js'

const TTL_MS = 60 * 60_000 // 1h
const INTERVAL_MS = 10 * 60_000 // 10m

class FakeRepo implements SlackInstallReaperRepo {
  calls: Date[] = []
  reaped = 0
  fail = false
  async reapExpired(staleBefore: Date): Promise<number> {
    this.calls.push(staleBefore)
    if (this.fail) throw new Error('db down')
    return this.reaped
  }
}

// A real macrotask, so the awaited sweep's microtasks (its `finally` re-arm) drain
// before we assert. FakeClock only fakes the injected Clock, not globals.
const flush = () => new Promise<void>((r) => setTimeout(r, 0))

function setup(startMs = 1_000_000) {
  const clock = new FakeClock(startMs)
  const repo = new FakeRepo()
  const reaper = new SlackInstallReaper(repo, clock, { ttlMs: TTL_MS, intervalMs: INTERVAL_MS })
  return { clock, repo, reaper }
}

describe('SlackInstallReaper', () => {
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
    expect(repo.calls).toHaveLength(0)

    clock.advance(1)
    expect(repo.calls).toHaveLength(1)
    expect(repo.calls[0]!.getTime()).toBe(clock.now() - TTL_MS)

    await flush()
    clock.advance(INTERVAL_MS)
    expect(repo.calls).toHaveLength(2)
    reaper.stop()
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
