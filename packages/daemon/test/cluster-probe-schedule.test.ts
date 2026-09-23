import { FakeClock } from '@agentconnect.md/connection'
import { describe, expect, it, vi } from 'vitest'
import {
  ClusterProbeSchedule,
  DEFAULT_RUNTIME_PROBE_INTERVAL_MS,
  configuredRuntimeProbeIntervalMs,
  configuredRuntimeProbeOnDemand
} from '../src/runtimes/cluster-probe-schedule.js'
import { K8S_PROBE_FRESH_MS } from '../src/runtimes/cluster-probe.js'

const log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never
const HOUR = 60 * 60_000

/** A run that stays in flight until the test settles it, recording the freshness each call asked for. */
function controlledRun() {
  const calls: number[] = []
  const settles: Array<() => void> = []
  const run = vi.fn(
    (freshAfter: number) =>
      new Promise<void>((resolve) => {
        calls.push(freshAfter)
        settles.push(resolve)
      })
  )
  const settle = async () => {
    settles.shift()?.()
    // The run's catch/finally chain settles on microtasks; one macrotask turn drains them.
    await new Promise((resolve) => setImmediate(resolve))
  }
  return { run, calls, settle }
}

describe('cluster runtime probe schedule', () => {
  it('inherits a pool answer at start-up only while it is younger than the interval', () => {
    const clock = new FakeClock(10 * HOUR)
    const { run, calls } = controlledRun()
    new ClusterProbeSchedule({ clock, intervalMs: 15 * 60_000, run, log }).start()
    expect(calls).toEqual([10 * HOUR - 15 * 60_000])
  })

  it('keeps the freshness window at start-up when the timer is off', () => {
    const clock = new FakeClock(10 * HOUR)
    const { run, calls } = controlledRun()
    new ClusterProbeSchedule({ clock, intervalMs: 0, run, log }).start()
    expect(calls).toEqual([10 * HOUR - K8S_PROBE_FRESH_MS])
  })

  it('re-probes one interval after each probe settles, accepting a peer answer from that interval', async () => {
    const clock = new FakeClock(0)
    const { run, calls, settle } = controlledRun()
    new ClusterProbeSchedule({ clock, intervalMs: HOUR, run, log }).start()
    await settle()
    clock.advance(HOUR - 1)
    expect(calls).toHaveLength(1)
    clock.advance(1)
    expect(calls).toEqual([-HOUR, 0])
    await settle()
    clock.advance(HOUR)
    expect(calls).toEqual([-HOUR, 0, HOUR])
  })

  it('arms no timer when the interval is 0', async () => {
    const clock = new FakeClock(0)
    const { run, settle } = controlledRun()
    new ClusterProbeSchedule({ clock, intervalMs: 0, run, log }).start()
    await settle()
    expect(clock.pending).toBe(0)
  })

  it('asks for an answer newer than the request, and folds requests made during a probe into one', async () => {
    const clock = new FakeClock(0)
    const { run, calls, settle } = controlledRun()
    const schedule = new ClusterProbeSchedule({ clock, intervalMs: HOUR, run, log })
    schedule.start()
    clock.advance(1_000)
    schedule.request()
    clock.advance(1_000)
    schedule.request()
    expect(calls).toHaveLength(1)
    await settle()
    // The queued run asks for the LATEST request's freshness, once.
    expect(calls).toEqual([-HOUR, 2_000])
    await settle()
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('replaces the pending tick with a request, so a request never doubles a probe', async () => {
    const clock = new FakeClock(0)
    const { run, calls, settle } = controlledRun()
    const schedule = new ClusterProbeSchedule({ clock, intervalMs: HOUR, run, log })
    schedule.start()
    await settle()
    clock.advance(10 * 60_000)
    schedule.request()
    expect(calls).toEqual([-HOUR, 10 * 60_000])
    await settle()
    // The next tick counts from the request's probe, not from the tick it replaced.
    clock.advance(HOUR - 1)
    expect(calls).toHaveLength(2)
    clock.advance(1)
    expect(calls).toHaveLength(3)
  })

  it('drops a tick while paused and tries again one interval later', async () => {
    const clock = new FakeClock(0)
    let paused = true
    const { run, calls, settle } = controlledRun()
    new ClusterProbeSchedule({ clock, intervalMs: HOUR, run, paused: () => paused, log }).start()
    await settle()
    clock.advance(HOUR)
    expect(calls).toHaveLength(1)
    paused = false
    clock.advance(HOUR)
    expect(calls).toHaveLength(2)
  })

  it('keeps its timer through a failed probe', async () => {
    const clock = new FakeClock(0)
    const run = vi.fn(async () => {
      throw new Error('probe sandbox bound no session')
    })
    const schedule = new ClusterProbeSchedule({ clock, intervalMs: HOUR, run, log })
    schedule.start()
    await schedule.idle()
    clock.advance(HOUR)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('runs nothing after stop, including a request queued behind the probe in flight', async () => {
    const clock = new FakeClock(0)
    const { run, settle } = controlledRun()
    const schedule = new ClusterProbeSchedule({ clock, intervalMs: HOUR, run, log })
    schedule.start()
    schedule.request()
    schedule.stop()
    await settle()
    clock.advance(2 * HOUR)
    schedule.request()
    expect(run).toHaveBeenCalledOnce()
    expect(clock.pending).toBe(0)
  })
})

describe('cluster runtime probe configuration', () => {
  it('re-probes hourly unless the deployment states minutes', () => {
    expect(configuredRuntimeProbeIntervalMs({})).toBe(DEFAULT_RUNTIME_PROBE_INTERVAL_MS)
    expect(configuredRuntimeProbeIntervalMs({ AC_RUNTIME_PROBE_INTERVAL_MINUTES: '15' })).toBe(15 * 60_000)
    expect(configuredRuntimeProbeIntervalMs({ AC_RUNTIME_PROBE_INTERVAL_MINUTES: '0' })).toBe(0)
  })

  it('falls back to hourly, and says so, on a value it cannot read', () => {
    const warn = vi.fn()
    expect(configuredRuntimeProbeIntervalMs({ AC_RUNTIME_PROBE_INTERVAL_MINUTES: 'hourly' }, warn)).toBe(HOUR)
    expect(configuredRuntimeProbeIntervalMs({ AC_RUNTIME_PROBE_INTERVAL_MINUTES: '-5' }, warn)).toBe(HOUR)
    expect(warn).toHaveBeenCalledTimes(2)
  })

  it('takes probe requests only where the deployment opts in', () => {
    expect(configuredRuntimeProbeOnDemand({})).toBe(false)
    expect(configuredRuntimeProbeOnDemand({ AC_RUNTIME_PROBE_ON_DEMAND: 'false' })).toBe(false)
    expect(configuredRuntimeProbeOnDemand({ AC_RUNTIME_PROBE_ON_DEMAND: 'true' })).toBe(true)
    expect(configuredRuntimeProbeOnDemand({ AC_RUNTIME_PROBE_ON_DEMAND: '1' })).toBe(true)
  })
})
