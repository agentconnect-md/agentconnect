// Unit tests for ComputerRegistrationReaper: a fake repo records each sweep's cutoff while a FakeClock drives the loop.
import { describe, it, expect } from 'vitest'
import { ComputerRegistrationReaper } from './computerRegistrationReaper.js'
import { FakeClock } from '../../test/fakes/fake-clock.js'

const GRACE_MS = 7 * 86_400_000
const INTERVAL_MS = 10 * 60_000

class FakeComputerRepo {
  calls: Date[] = []
  fail = false
  async reapRegistrations(before: Date): Promise<number> {
    this.calls.push(before)
    if (this.fail) throw new Error('db down')
    return 2
  }
}

// A real macrotask, so the sweep's awaited call and its `finally` re-arm drain before asserting.
const flush = () => new Promise<void>((r) => setTimeout(r, 0))

function setup() {
  const clock = new FakeClock(1_000_000_000_000)
  const repo = new FakeComputerRepo()
  const logs: Array<{ level: 'info' | 'error'; obj: unknown }> = []
  const log = {
    info: (obj: unknown) => logs.push({ level: 'info', obj }),
    error: (obj: unknown) => logs.push({ level: 'error', obj })
  }
  const reaper = new ComputerRegistrationReaper(repo, clock, { intervalMs: INTERVAL_MS, graceMs: GRACE_MS }, log)
  return { clock, repo, logs, reaper }
}

describe('ComputerRegistrationReaper', () => {
  it('sweeps once per interval with the grace-adjusted cutoff and re-arms', async () => {
    const { clock, repo, logs, reaper } = setup()
    reaper.start()
    clock.advance(INTERVAL_MS)
    await flush()
    expect(repo.calls.map((d) => d.getTime())).toEqual([clock.now() - GRACE_MS])
    expect(logs).toEqual([expect.objectContaining({ level: 'info' })])
    expect(clock.pendingTimers()).toBe(1)
    reaper.stop()
    expect(clock.pendingTimers()).toBe(0)
  })

  it('logs a failed sweep and keeps the loop armed', async () => {
    const { clock, repo, logs, reaper } = setup()
    repo.fail = true
    reaper.start()
    clock.advance(INTERVAL_MS)
    await flush()
    expect(logs).toEqual([expect.objectContaining({ level: 'error' })])
    expect(clock.pendingTimers()).toBe(1)
    reaper.stop()
  })
})
