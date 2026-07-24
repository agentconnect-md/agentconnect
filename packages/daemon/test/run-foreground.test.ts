import { describe, it, expect, vi } from 'vitest'
import { runForeground } from '../src/cli/run-foreground.js'

describe('runForeground', () => {
  it('starts the daemon, announces running, and stops on signal', async () => {
    const start = vi.fn(async () => {})
    const stop = vi.fn(async () => {})
    const writes: string[] = []
    let handler: (() => void) | undefined

    const p = runForeground(
      {},
      {
        createDaemon: () => ({ start, stop }),
        onSignal: (h) => {
          handler = h
        },
        out: { write: (s: string) => (writes.push(s), true) } as unknown as NodeJS.WritableStream
      }
    )

    // start() has resolved by now; the announce line is written, handler registered
    await Promise.resolve()
    expect(start).toHaveBeenCalledOnce()
    expect(writes.join('')).toMatch(/running/i)
    expect(handler).toBeTypeOf('function')

    handler!() // simulate Ctrl-C
    await p
    expect(stop).toHaveBeenCalledOnce()
  })

  it('force-exits on a second signal while the graceful stop is still in flight', async () => {
    let handler: (() => void) | undefined
    let finishStop!: () => void
    const stop = vi.fn(() => new Promise<void>((r) => (finishStop = r))) // a wedged stop()
    const exits: number[] = []

    const p = runForeground(
      {},
      {
        createDaemon: () => ({ start: async () => {}, stop }),
        onSignal: (h) => {
          handler = h
        },
        out: { write: () => true } as unknown as NodeJS.WritableStream,
        forceExit: (code) => exits.push(code)
      }
    )

    await Promise.resolve()
    handler!() // first Ctrl-C — graceful stop begins and hangs
    expect(exits).toEqual([])
    handler!() // second Ctrl-C — the user insists
    expect(exits).toEqual([130])
    expect(stop).toHaveBeenCalledOnce() // not a second graceful attempt

    finishStop() // unwedge so the test's promise settles
    await p
  })
})
