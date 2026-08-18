import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChannelLossWatcher } from '../src/k8s/channel-loss-watcher.js'
import type { SandboxReadiness } from '../src/k8s/driver.js'

const log = { info: () => {}, warn: () => {}, debug: () => {} }

const GRACE_MS = 100
const POD_UP_MS = 1_000

/** A watcher whose pod readiness and live channels a test drives, plus the losses it reported. */
function watcher(readiness: SandboxReadiness = 'starting') {
  const state = { readiness, connections: 0, reads: 0 }
  const onChannelLost = vi.fn()
  const subject = new ChannelLossWatcher({
    sandboxReadiness: async (_agentId, _opts) => {
      state.reads += 1
      return state.readiness
    },
    connectionsFor: () => new Array<unknown>(state.connections),
    podUpTimeoutMs: () => POD_UP_MS,
    onChannelLost,
    rebindGraceMs: GRACE_MS,
    log
  })
  return { subject, state, onChannelLost }
}

describe('channel loss watcher', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('waits out a pod that is still coming up instead of spending the grace window on it', async () => {
    const { subject, state, onChannelLost } = watcher('starting')
    subject.schedule('agent-a', 'socket closed')

    // Well past the grace window: a cold start pays PVC provisioning and an image pull, and none of
    // that time is a shim failing to dial — nothing can dial a pod that is not up.
    await vi.advanceTimersByTimeAsync(GRACE_MS * 5)

    expect(onChannelLost).not.toHaveBeenCalled()
    expect(state.reads).toBeGreaterThan(1)
  })

  it('gives the shim a whole fresh grace window once its pod comes up', async () => {
    const { subject, state, onChannelLost } = watcher('starting')
    subject.schedule('agent-a', 'socket closed')
    await vi.advanceTimersByTimeAsync(GRACE_MS)
    state.readiness = 'ready'

    // The pod arriving restarts the clock: the window is for a shim that has somewhere to dial.
    await vi.advanceTimersByTimeAsync(GRACE_MS - 1)
    expect(onChannelLost).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(GRACE_MS)
    expect(onChannelLost).toHaveBeenCalledWith('agent-a', 'socket closed')
  })

  it('reports loss once the ceiling passes even while the pod claims to be starting', async () => {
    const { subject, onChannelLost } = watcher('starting')
    subject.schedule('agent-a', 'socket closed')

    await vi.advanceTimersByTimeAsync(POD_UP_MS + GRACE_MS * 2)

    expect(onChannelLost).toHaveBeenCalledWith('agent-a', 'socket closed')
  })

  it('drops the decision when a replacement channel binds', async () => {
    const { subject, onChannelLost } = watcher('ready')
    subject.schedule('agent-a', 'socket closed')
    subject.cancel('agent-a')

    await vi.advanceTimersByTimeAsync(POD_UP_MS + GRACE_MS * 2)

    expect(onChannelLost).not.toHaveBeenCalled()
  })

  it('drops a decision whose agent has a live channel again by the time it runs', async () => {
    const { subject, state, onChannelLost } = watcher('ready')
    subject.schedule('agent-a', 'socket closed')
    state.connections = 1

    await vi.advanceTimersByTimeAsync(POD_UP_MS + GRACE_MS * 2)

    expect(onChannelLost).not.toHaveBeenCalled()
    // Nothing was read: a bound channel settles the question without an API round trip.
    expect(state.reads).toBe(0)
  })

  it('cancels every pending decision when the plane goes down', async () => {
    const { subject, onChannelLost } = watcher('ready')
    subject.schedule('agent-a', 'socket closed')
    subject.schedule('agent-b', 'socket closed')
    subject.cancelAll()

    await vi.advanceTimersByTimeAsync(POD_UP_MS + GRACE_MS * 2)

    expect(onChannelLost).not.toHaveBeenCalled()
  })
})
