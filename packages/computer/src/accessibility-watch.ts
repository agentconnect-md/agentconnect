// Cua Driver reads the Accessibility grant once when it starts, so a grant switched on later needs a fresh driver (#3403).
export interface AccessibilityWatchOptions {
  // The grant as a fresh process sees it, not the running driver.
  check: () => Promise<boolean>
  restartDriver: () => Promise<void>
  log: (line: string) => void
  intervalMs?: number
}

export interface AccessibilityWatch {
  // Checks at once; resolves whether the grant is in effect for the driver now.
  now(): Promise<boolean>
  stop(): void
}

const INTERVAL_MS = 5_000

// Polls only while the grant is missing, and stops once the driver restarted onto it.
export function watchAccessibility(options: AccessibilityWatchOptions): AccessibilityWatch {
  let done = false
  let running: Promise<boolean> | undefined
  const now = (): Promise<boolean> => {
    if (done) return Promise.resolve(true)
    running ??= (async () => {
      if (!(await options.check().catch(() => false))) return false
      done = true
      clearInterval(timer)
      options.log('Accessibility granted; restarting Cua Driver so input takes effect')
      await options.restartDriver()
      return true
    })().finally(() => {
      running = undefined
    })
    return running
  }
  const timer = setInterval(() => void now(), options.intervalMs ?? INTERVAL_MS)
  timer.unref()
  return {
    now,
    stop() {
      done = true
      clearInterval(timer)
    }
  }
}
