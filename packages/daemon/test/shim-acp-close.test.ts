import { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AcpRunner } from '../src/shim/acp-runner.js'
import type { ShimEvent } from '../src/shim/protocol.js'

// Both kill paths are stubbed, so a regression fails these cases instead of signalling the worker's own group.
const missing = { op: 'open', command: 'definitely-not-a-command', args: [], env: { PATH: '/nonexistent' } }

function stubKills() {
  return {
    group: vi.spyOn(process, 'kill').mockImplementation(() => true),
    child: vi.spyOn(ChildProcess.prototype, 'kill').mockImplementation(() => false)
  }
}

const exited = (events: Array<ShimEvent['event']>) =>
  vi.waitFor(() =>
    expect(events).toContainEqual(expect.objectContaining({ kind: 'exit', error: expect.stringMatching(/ENOENT/) }))
  )

describe('closing an ACP runtime that never spawned', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('signals nothing when the close is applied before Node reports the failed spawn', async () => {
    const kills = stubKills()
    const events: Array<ShimEvent['event']> = []
    const runner = new AcpRunner({ emit: (event) => events.push(event) })
    // Two frames from one socket read are applied in one macrotask, ahead of the tick that reports ENOENT.
    const opened = runner.apply(missing)
    const closed = runner.apply({ op: 'close', deadlineMs: 50 })
    await Promise.all([opened, closed])
    await exited(events)
    expect(kills.group).not.toHaveBeenCalled()
    expect(kills.child).not.toHaveBeenCalled()
  })

  it('signals nothing when the failed spawn is reported before the close', async () => {
    const kills = stubKills()
    const events: Array<ShimEvent['event']> = []
    const runner = new AcpRunner({ emit: (event) => events.push(event) })
    await runner.apply(missing)
    await exited(events)
    await runner.apply({ op: 'close', deadlineMs: 50 })
    expect(kills.group).not.toHaveBeenCalled()
    expect(kills.child).not.toHaveBeenCalled()
  })
})
