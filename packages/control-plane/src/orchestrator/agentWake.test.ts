// `AgentWakeCoordinator` — the per-agent debounce in front of `agent/wake` (#1070).
import { describe, expect, it, vi } from 'vitest'
import { FakeClock } from '../../test/fakes/fake-clock.js'
import { AGENT_WAKE_DEBOUNCE_MS, AgentWakeCoordinator } from './agentWake.js'

const ok = (state: 'running' | 'starting' | 'unsupported') => ({ agentId: 'a1', state })

describe('AgentWakeCoordinator', () => {
  it('sends the first wake and joins every caller onto it while it is in flight', async () => {
    const clock = new FakeClock(1_000)
    const wakes = new AgentWakeCoordinator(clock)
    let settle: (v: ReturnType<typeof ok>) => void = () => {}
    const send = vi.fn(() => new Promise<ReturnType<typeof ok>>((resolve) => (settle = resolve)))
    const first = wakes.wake('a1', send)
    const second = wakes.wake('a1', send)
    settle(ok('starting'))
    await expect(first).resolves.toEqual({ state: 'starting', coalesced: false })
    await expect(second).resolves.toEqual({ state: 'starting', coalesced: true })
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('answers a repeat within the debounce window from the settled state, and re-sends after it', async () => {
    const clock = new FakeClock(1_000)
    const wakes = new AgentWakeCoordinator(clock)
    const send = vi.fn(async () => ok('starting'))
    await wakes.wake('a1', send)
    clock.advance(AGENT_WAKE_DEBOUNCE_MS - 1)
    await expect(wakes.wake('a1', send)).resolves.toEqual({ state: 'starting', coalesced: true })
    expect(send).toHaveBeenCalledTimes(1)
    clock.advance(1)
    send.mockResolvedValueOnce(ok('running'))
    await expect(wakes.wake('a1', send)).resolves.toEqual({ state: 'running', coalesced: false })
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('debounces per agent, and a failed wake is not remembered', async () => {
    const clock = new FakeClock(1_000)
    const wakes = new AgentWakeCoordinator(clock)
    const send = vi.fn(async () => ok('starting'))
    await wakes.wake('a1', send)
    await wakes.wake('a2', send)
    expect(send).toHaveBeenCalledTimes(2)
    const failing = vi.fn(async () => {
      throw new Error('connection closed')
    })
    await expect(wakes.wake('a3', failing)).rejects.toThrow('connection closed')
    await expect(wakes.wake('a3', send)).resolves.toEqual({ state: 'starting', coalesced: false })
  })
})
