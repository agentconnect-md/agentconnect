import { describe, expect, it, vi } from 'vitest'
import { Daemon } from '../src/daemon.js'
import type { TurnAcknowledgement } from '../src/platforms/turn-output.js'

function endAcknowledgement(handle: TurnAcknowledgement) {
  const release = vi.fn()
  const daemon = Object.assign(Object.create(Daemon.prototype), {
    retainsInboxRow: () => false,
    log: { warn: vi.fn() }
  }) as { endTurnAcknowledgement(entry: unknown, ended: string): Promise<void> }
  const ending = daemon.endTurnAcknowledgement({ acknowledgement: { handle, release } }, 'completed')
  return { ending, release }
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
}

describe('turn acknowledgement egress lease', () => {
  it('releases the connection once the acknowledgement ends', async () => {
    const { ending, release } = endAcknowledgement({ replace: async () => false, end: async () => {} })
    await ending
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('holds the connection until the cleanup the end left running settles', async () => {
    let finish = () => {}
    const settled = new Promise<void>((resolve) => (finish = resolve))
    const { ending, release } = endAcknowledgement({ replace: async () => false, end: async () => {}, settled })
    await ending
    await settle()
    expect(release).not.toHaveBeenCalled()
    finish()
    await settle()
    expect(release).toHaveBeenCalledTimes(1)
  })
})
