// `createAgentWaker` — the daemon half of the console's "start this agent's sandbox" (#1070).
import { describe, expect, it, vi } from 'vitest'
import { createAgentWaker, AgentWakeViolationError } from '../../src/cp/agent-wake.js'

const silent = { warn: vi.fn() }
const tick = () => new Promise((r) => setImmediate(r))

function sandbox(running = false) {
  const state = { running }
  let release: () => void = () => {}
  const bound = new Promise<void>((resolve) => (release = resolve))
  const ensureChannel = vi.fn(async () => {
    await bound
    state.running = true
  })
  return { plane: { isRunning: () => state.running, ensureChannel }, ensureChannel, release, state }
}

describe('createAgentWaker', () => {
  it('answers unsupported on a daemon with no sandbox plane, without touching duty', async () => {
    const claimDuty = vi.fn(async () => true)
    const waker = createAgentWaker({ knowsAgent: () => false, claimDuty, log: silent })
    await expect(waker.wake({ agentId: 'a1' })).resolves.toEqual({ agentId: 'a1', state: 'unsupported' })
    expect(claimDuty).not.toHaveBeenCalled()
  })

  it('answers running when the channel is already bound, and starts nothing', async () => {
    const box = sandbox(true)
    const waker = createAgentWaker({ sandbox: box.plane, knowsAgent: () => true, log: silent })
    await expect(waker.wake({ agentId: 'a1' })).resolves.toEqual({ agentId: 'a1', state: 'running' })
    expect(box.ensureChannel).not.toHaveBeenCalled()
  })

  it('kicks off ONE bind for a burst of wakes and answers starting until it lands', async () => {
    const box = sandbox()
    const waker = createAgentWaker({ sandbox: box.plane, knowsAgent: () => true, log: silent })
    await expect(waker.wake({ agentId: 'a1' })).resolves.toEqual({ agentId: 'a1', state: 'starting' })
    await expect(waker.wake({ agentId: 'a1' })).resolves.toEqual({ agentId: 'a1', state: 'starting' })
    expect(box.ensureChannel).toHaveBeenCalledTimes(1)
    box.release()
    await tick()
    await expect(waker.wake({ agentId: 'a1' })).resolves.toEqual({ agentId: 'a1', state: 'running' })
    expect(box.ensureChannel).toHaveBeenCalledTimes(1)
  })

  it('claims the duty for an agent this member does not hold, then wakes it (the rendezvous)', async () => {
    const box = sandbox()
    let held = false
    const claimDuty = vi.fn(async () => {
      held = true
      return true
    })
    const waker = createAgentWaker({ sandbox: box.plane, knowsAgent: () => held, claimDuty, log: silent })
    await expect(waker.wake({ agentId: 'a1' })).resolves.toEqual({ agentId: 'a1', state: 'starting' })
    expect(claimDuty).toHaveBeenCalledWith('a1')
    expect(box.ensureChannel).toHaveBeenCalledWith('a1')
  })

  it('refuses as unknown-agent when the claim is lost, and binds nothing', async () => {
    const box = sandbox()
    const waker = createAgentWaker({
      sandbox: box.plane,
      knowsAgent: () => false,
      claimDuty: async () => false,
      log: silent
    })
    await expect(waker.wake({ agentId: 'a1' })).rejects.toBeInstanceOf(AgentWakeViolationError)
    expect(box.ensureChannel).not.toHaveBeenCalled()
  })

  it('a failed bind is logged and forgotten, so the next wake tries again', async () => {
    const ensureChannel = vi.fn(async () => {
      throw new Error('pod never became ready')
    })
    const log = { warn: vi.fn() }
    const waker = createAgentWaker({
      sandbox: { isRunning: () => false, ensureChannel },
      knowsAgent: () => true,
      log
    })
    await waker.wake({ agentId: 'a1' })
    await tick()
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('pod never became ready'))
    await waker.wake({ agentId: 'a1' })
    expect(ensureChannel).toHaveBeenCalledTimes(2)
  })
})
