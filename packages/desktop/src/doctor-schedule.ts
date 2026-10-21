/** Runs doctor now, every interval, and on demand, never two runs at once (computer-use.md §3.8). */
export interface DoctorSchedule {
  /** Asks for another run, chained after any run in flight. */
  refresh(): void
  stop(): void
}

export function scheduleDoctor(options: {
  run: () => Promise<void>
  intervalMs: number
  onError: (error: Error) => void
}): DoctorSchedule {
  let timer: NodeJS.Timeout | undefined
  let stopped = false
  const runOnce = async (): Promise<void> => {
    if (stopped) return
    try {
      await options.run()
    } catch (error) {
      options.onError(error as Error)
    }
    if (timer) clearTimeout(timer)
    if (stopped) return
    // The timer feeds the same chain as refresh, so a periodic run cannot overlap one in flight either.
    timer = setTimeout(() => enqueue(), options.intervalMs)
    timer.unref()
  }
  let runs = runOnce()
  const enqueue = (): void => {
    runs = runs.then(runOnce)
  }
  return {
    refresh: enqueue,
    stop() {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }
}
