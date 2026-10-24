import { afterEach, describe, expect, it, vi } from 'vitest'
import { scheduleDoctor, type DoctorSchedule } from './doctor-schedule.js'

const settle = () => new Promise((resolve) => setImmediate(resolve))

function deferredRuns() {
  const pending: Array<() => void> = []
  let active = 0
  let maxActive = 0
  const run = () =>
    new Promise<void>((resolve) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      pending.push(() => {
        active -= 1
        resolve()
      })
    })
  return { run, pending, maxActive: () => maxActive }
}

let schedule: DoctorSchedule | undefined
afterEach(() => {
  schedule?.stop()
  schedule = undefined
})

describe('scheduleDoctor', () => {
  it('starts a refresh asked for mid-run only after that run finishes', async () => {
    const runs = deferredRuns()
    schedule = scheduleDoctor({ run: runs.run, intervalMs: 60_000, onError: () => undefined })
    expect(runs.pending).toHaveLength(1)
    // ffmpeg landing while the first doctor still runs.
    schedule.refresh()
    await settle()
    expect(runs.pending).toHaveLength(1)
    runs.pending[0]!()
    await settle()
    expect(runs.pending).toHaveLength(2)
    runs.pending[1]!()
    await settle()
    expect(runs.maxActive()).toBe(1)
  })

  it('keeps the schedule after a failed run and reports the failure', async () => {
    vi.useFakeTimers()
    try {
      const errors: string[] = []
      let calls = 0
      schedule = scheduleDoctor({
        run: async () => {
          calls += 1
          if (calls === 1) throw new Error('doctor crashed')
        },
        intervalMs: 1_000,
        onError: (error) => errors.push(error.message)
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(errors).toEqual(['doctor crashed'])
      await vi.advanceTimersByTimeAsync(1_000)
      expect(calls).toBe(2)
      schedule.stop()
      await vi.advanceTimersByTimeAsync(5_000)
      expect(calls).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
