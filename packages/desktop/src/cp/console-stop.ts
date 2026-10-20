// The console Stop (computer-use.md §6): pause a working desktop, and resume only a pause the Stop itself caused.
export interface StoppableComputer {
  liveStatus(): 'online' | 'paused' | 'human_in_control' | 'busy'
  pause(reason: string): void
  resume(): void
}

export const CONSOLE_STOP_REASON = 'stopped from the console; resume it there'

/** Returns the handler for `computer/stop`; `changed` runs after it paused or resumed the Computer. */
export function consoleStopHandler(
  computer: StoppableComputer,
  changed: () => void
): (stop: { at: string } | null) => void {
  let stoppedByConsole = false
  return (stop) => {
    const status = computer.liveStatus()
    if (stop) {
      // A local pause or a viewer takeover already blocks agents; the CP tells the Stop again once it lifts.
      if (status !== 'online' && status !== 'busy') return
      stoppedByConsole = true
      computer.pause(CONSOLE_STOP_REASON)
      changed()
      return
    }
    if (!stoppedByConsole) return
    stoppedByConsole = false
    if (status !== 'paused') return
    computer.resume()
    changed()
  }
}
