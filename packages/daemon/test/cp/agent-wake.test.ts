// `createAgentWaker` — the daemon half of the console's "start this sandbox" (#1070), agent- or session-scoped.
import { describe, expect, it, vi } from 'vitest'
import { createAgentWaker, AgentWakeViolationError, sessionPodOf } from '../../src/cp/agent-wake.js'

const silent = { warn: vi.fn() }
const tick = () => new Promise((r) => setImmediate(r))

const SESSION_POD = 'a1/session-0123456789abcdef01234567'

/** A plane whose binds wait for `release`; `claims` is what the cluster holds, by subject. */
function sandbox(running = false, claims: Record<string, string> = { [SESSION_POD]: 'claim-uid-1' }) {
  const bound = new Set<string>(running ? ['a1'] : [])
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => (release = resolve))
  const ensureChannel = vi.fn(async (subject: string) => {
    await gate
    bound.add(subject)
  })
  const resumeChannel = vi.fn(async (subject: string, _claimUid: string) => {
    await gate
    bound.add(subject)
  })
  const sessionPod = vi.fn(async (_agentId: string, sessionId: string) =>
    sessionId === 'unknown' ? undefined : sessionId === 'legacy' ? 'a1' : SESSION_POD
  )
  const claimUidFor = vi.fn(async (subject: string) => claims[subject])
  return {
    plane: {
      isRunning: (subject: string) => bound.has(subject),
      ensureChannel,
      sessionPod,
      claimUidFor,
      resumeChannel
    },
    ensureChannel,
    resumeChannel,
    claimUidFor,
    release,
    bound
  }
}

describe('createAgentWaker', () => {
  it('answers unsupported on a daemon with no sandbox plane, without touching duty', async () => {
    const claimDuty = vi.fn(async () => true)
    const waker = createAgentWaker({ knowsAgent: () => false, claimDuty, log: silent })
    await expect(waker.wake({ agentId: 'a1' })).resolves.toEqual({ agentId: 'a1', state: 'unsupported' })
    await expect(waker.wake({ agentId: 'a1', sessionId: 's1' })).resolves.toEqual({
      agentId: 'a1',
      state: 'unsupported'
    })
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
    await expect(waker.wake({ agentId: 'a1', sessionId: 's1' })).rejects.toMatchObject({ reason: 'unknown-agent' })
    expect(box.ensureChannel).not.toHaveBeenCalled()
    expect(box.resumeChannel).not.toHaveBeenCalled()
  })

  it('a failed bind is logged and forgotten, so the next wake tries again', async () => {
    const box = sandbox()
    box.ensureChannel.mockImplementation(async () => {
      throw new Error('pod never became ready')
    })
    const log = { warn: vi.fn() }
    const waker = createAgentWaker({ sandbox: box.plane, knowsAgent: () => true, log })
    await waker.wake({ agentId: 'a1' })
    await tick()
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('pod never became ready'))
    await waker.wake({ agentId: 'a1' })
    expect(box.ensureChannel).toHaveBeenCalledTimes(2)
  })
})

describe('createAgentWaker for one session', () => {
  it("resumes only that session's pod, onto the claim it just observed, and leaves the agent pod alone", async () => {
    const box = sandbox()
    const waker = createAgentWaker({ sandbox: box.plane, knowsAgent: () => true, log: silent })
    await expect(waker.wake({ agentId: 'a1', sessionId: 's1' })).resolves.toEqual({ agentId: 'a1', state: 'starting' })
    expect(box.resumeChannel).toHaveBeenCalledExactlyOnceWith(SESSION_POD, 'claim-uid-1')
    // The agent pod is neither ensured nor resumed: a session's page wakes one pod.
    expect(box.ensureChannel).not.toHaveBeenCalled()

    // A burst joins the resume in flight rather than observing and resuming again.
    await expect(waker.wake({ agentId: 'a1', sessionId: 's1' })).resolves.toEqual({ agentId: 'a1', state: 'starting' })
    expect(box.resumeChannel).toHaveBeenCalledTimes(1)
    box.release()
    await tick()
    await expect(waker.wake({ agentId: 'a1', sessionId: 's1' })).resolves.toEqual({ agentId: 'a1', state: 'running' })
    expect([...box.bound]).toEqual([SESSION_POD])
  })

  it('refuses as sandbox-removed when the cluster holds no claim for it, and creates or resumes nothing', async () => {
    const box = sandbox(false, {})
    const waker = createAgentWaker({ sandbox: box.plane, knowsAgent: () => true, log: silent })
    const refused = await waker.wake({ agentId: 'a1', sessionId: 's1' }).catch((err: unknown) => err)
    expect(refused).toBeInstanceOf(AgentWakeViolationError)
    expect(refused).toMatchObject({ reason: 'sandbox-removed' })
    expect(box.claimUidFor).toHaveBeenCalledWith(SESSION_POD)
    expect(box.resumeChannel).not.toHaveBeenCalled()
    // Ensuring is what claims: a removed session must never be handed to it, nor fall back to the agent pod.
    expect(box.ensureChannel).not.toHaveBeenCalled()
  })

  it("ensures the agent pod when that is where the session's workspace lives", async () => {
    const box = sandbox()
    const waker = createAgentWaker({ sandbox: box.plane, knowsAgent: () => true, log: silent })
    await expect(waker.wake({ agentId: 'a1', sessionId: 'legacy' })).resolves.toEqual({
      agentId: 'a1',
      state: 'starting'
    })
    expect(box.ensureChannel).toHaveBeenCalledExactlyOnceWith('a1')
    expect(box.resumeChannel).not.toHaveBeenCalled()
  })

  it('refuses a session with no workspace here as unknown-agent, touching no pod', async () => {
    const box = sandbox()
    const waker = createAgentWaker({ sandbox: box.plane, knowsAgent: () => true, log: silent })
    await expect(waker.wake({ agentId: 'a1', sessionId: 'unknown' })).rejects.toMatchObject({
      reason: 'unknown-agent'
    })
    expect(box.claimUidFor).not.toHaveBeenCalled()
    expect(box.ensureChannel).not.toHaveBeenCalled()
    expect(box.resumeChannel).not.toHaveBeenCalled()
  })
})

describe('sessionPodOf', () => {
  const plane = { subjectForPath: vi.fn((agentId: string, path: string) => `${agentId}@${path}`) }
  const scopeAnswering = (dir: string | null | undefined) => ({ sessionDirectory: vi.fn(async () => dir) })

  it('routes an isolated session to the pod of its own directory, as its reads are routed', async () => {
    const scope = scopeAnswering('/agent/sessions/session-0123')
    await expect(sessionPodOf(scope, plane, 'a1', 's1')).resolves.toBe('a1@/agent/sessions/session-0123')
    expect(scope.sessionDirectory).toHaveBeenCalledWith('a1', 's1')
  })

  it("answers the agent's pod for a session whose roots are the agent's checkouts, and nothing for an unknown one", async () => {
    await expect(sessionPodOf(scopeAnswering(null), plane, 'a1', 's1')).resolves.toBe('a1')
    plane.subjectForPath.mockClear()
    await expect(sessionPodOf(scopeAnswering(undefined), plane, 'a1', 's1')).resolves.toBeUndefined()
    expect(plane.subjectForPath).not.toHaveBeenCalled()
  })
})
