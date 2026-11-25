import type { Check } from './setup.js'

/** Runs doctor now, every interval, and on demand, never two runs at once (computer-use.md §3.6). */
export interface DoctorSchedule {
  /** Asks for another run, chained after any run in flight. */
  refresh(): void
  stop(): void
}

// capture is false only for the timer's runs: capturing the screen wakes a sleeping display.
export function scheduleDoctor(options: {
  run: (capture: boolean) => Promise<void>
  intervalMs: number
  onError: (error: Error) => void
}): DoctorSchedule {
  let timer: NodeJS.Timeout | undefined
  let stopped = false
  const runOnce = async (capture: boolean): Promise<void> => {
    if (stopped) return
    try {
      await options.run(capture)
    } catch (error) {
      options.onError(error as Error)
    }
    if (timer) clearTimeout(timer)
    if (stopped) return
    // The timer feeds the same chain as refresh, so a periodic run cannot overlap one in flight either.
    timer = setTimeout(() => enqueue(false), options.intervalMs)
    timer.unref()
  }
  let runs = runOnce(true)
  const enqueue = (capture: boolean): void => {
    runs = runs.then(() => runOnce(capture))
  }
  return {
    refresh: () => enqueue(true),
    stop() {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }
}

// Each capture check and the check that must still pass for its last result to stand.
const CAPTURE_CHECKS: Record<string, string> = { screenshot: 'cua-driver', 'screen capture': 'ffmpeg' }

/** Fills the capture checks a run without capture left out from the previous run's, after their prerequisite. */
export function carryCaptureChecks(next: Check[], previous: Check[] | undefined): Check[] {
  return next.flatMap((check) => {
    if (check.status !== 'ok') return [check]
    const carried = Object.entries(CAPTURE_CHECKS)
      .filter(([name, prerequisite]) => prerequisite === check.name && !next.some((other) => other.name === name))
      .flatMap(([name]) => previous?.filter((old) => old.name === name) ?? [])
    return [check, ...carried]
  })
}
