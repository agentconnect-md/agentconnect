import { describe, expect, it, vi } from 'vitest'
import { CONSOLE_STOP_REASON, consoleStopHandler, type StoppableComputer } from './console-stop.js'

function fakeComputer(initial: ReturnType<StoppableComputer['liveStatus']> = 'online') {
  let status = initial
  let reason: string | undefined = initial === 'paused' ? 'owner' : undefined
  const computer = {
    liveStatus: () => status,
    pauseReason: () => reason,
    pause: vi.fn((why: string) => {
      status = 'paused'
      reason = why
    }),
    resume: vi.fn(() => {
      status = 'online'
      reason = undefined
    }),
    set: (next: typeof status) => (status = next)
  }
  return computer
}

const STOP = { at: '2026-10-21T00:00:00.000Z' }

describe('consoleStopHandler', () => {
  it('pauses a working desktop and resumes it when the Stop lifts', () => {
    const computer = fakeComputer('busy')
    const changed = vi.fn()
    const apply = consoleStopHandler(computer, changed)
    apply(STOP)
    expect(computer.pause).toHaveBeenCalledWith(CONSOLE_STOP_REASON)
    apply(null)
    expect(computer.resume).toHaveBeenCalledTimes(1)
    expect(changed).toHaveBeenCalledTimes(2)
  })

  it('never resumes a pause it did not cause', () => {
    const computer = fakeComputer('paused')
    const apply = consoleStopHandler(computer, () => {})
    apply(STOP)
    apply(null)
    expect(computer.pause).not.toHaveBeenCalled()
    expect(computer.resume).not.toHaveBeenCalled()
  })

  it('leaves a viewer takeover alone and does not resume over one that followed the Stop', () => {
    const computer = fakeComputer('human_in_control')
    const apply = consoleStopHandler(computer, () => {})
    apply(STOP)
    expect(computer.pause).not.toHaveBeenCalled()
    computer.set('online')
    apply(STOP)
    computer.set('human_in_control')
    apply(null)
    expect(computer.resume).not.toHaveBeenCalled()
  })

  it('does not resume a local pause that replaced the Stop', () => {
    const computer = fakeComputer('online')
    const apply = consoleStopHandler(computer, () => {})
    apply(STOP)
    computer.resume()
    computer.pause('paused by the owner')
    apply(null)
    expect(computer.resume).toHaveBeenCalledTimes(1)
    expect(computer.liveStatus()).toBe('paused')
    expect(computer.pauseReason()).toBe('paused by the owner')
  })
})
