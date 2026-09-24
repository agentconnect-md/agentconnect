import { describe, expect, it, vi } from 'vitest'
import { SANDBOX_LAUNCH_GENERATION } from '../src/k8s/sandbox-api.js'
import type { SandboxLaunch } from '../src/k8s/endpoint-provider.js'
import { SandboxLease } from '../src/k8s/sandbox-lease.js'
import { noopClusterMetrics } from '../src/metrics/cluster-metrics.js'
import type { OperatingMode, Sandbox, SandboxApi } from '../src/k8s/sandbox-api.js'

const launch: SandboxLaunch = {
  subject: 'agent-a',
  agentId: 'agent-a',
  sandboxName: 'sb-1',
  sandboxUid: 'uid-1',
  claimUid: 'claim-1',
  generation: 1,
  since: 0
}
const log = { info: () => {}, warn: () => {}, debug: () => {} }

/** A Sandbox whose operating mode a test drives, and the writes the lease made against it. */
function fakeApi(mode: OperatingMode = 'Running') {
  const state = {
    sandbox: {
      metadata: { name: 'sb-1', uid: 'uid-1', annotations: { [SANDBOX_LAUNCH_GENERATION]: '1' } },
      spec: { operatingMode: mode }
    } as Sandbox,
    reads: 0,
    writes: [] as OperatingMode[],
    /** Set to hand the NEXT read a promise the test resolves, so ordering can be observed. */
    gateRead: undefined as (() => Promise<Sandbox>) | undefined
  }
  const api = {
    getSandbox: vi.fn(async () => {
      state.reads += 1
      const gate = state.gateRead
      if (gate) {
        state.gateRead = undefined
        return await gate()
      }
      return state.sandbox
    }),
    setOperatingMode: vi.fn(async (_name: string, desired: OperatingMode) => {
      state.writes.push(desired)
      state.sandbox = { ...state.sandbox, spec: { ...state.sandbox.spec, operatingMode: desired } }
      return state.sandbox
    })
  }
  return { api: api as unknown as SandboxApi, state }
}

function lease(api: SandboxApi, isCurrent: (launch: SandboxLaunch) => boolean = () => true) {
  return new SandboxLease({ api, isCurrent, warmPoolName: 'pool', log, metrics: noopClusterMetrics })
}

describe('sandbox lease holds', () => {
  it('keeps successor holds when old work releases the same Sandbox after departure', async () => {
    const { api, state } = fakeApi()
    let current = launch
    const subject = lease(api, (candidate) => candidate === current)
    subject.retain(launch)
    subject.forgetSandbox(launch)
    current = { ...launch, generation: 2 }
    state.sandbox.metadata!.annotations![SANDBOX_LAUNCH_GENERATION] = '2'
    subject.retain(current)
    subject.release(launch)
    expect(() => subject.retain(launch)).toThrow(/left this member/)
    expect(await subject.suspendIfIdle(current, () => {})).toBe('busy')
    subject.release(current)
    expect(await subject.suspendIfIdle(current, () => {})).toBe('suspended')
  })

  it('keeps a Sandbox unsuspendable until every nested hold is released', async () => {
    const { api, state } = fakeApi()
    const subject = lease(api)
    subject.retain(launch)
    subject.retain(launch)

    expect(await subject.suspendIfIdle(launch, () => {})).toBe('busy')
    subject.release(launch)
    // The outer hold is still open: a refcount that collapsed on the first release would suspend
    // the pod underneath the work that reentered it.
    expect(await subject.suspendIfIdle(launch, () => {})).toBe('busy')
    subject.release(launch)

    expect(await subject.suspendIfIdle(launch, () => {})).toBe('suspended')
    expect(state.writes).toEqual(['Suspended'])
  })

  it('reports the suspension it performed to the caller that owns the launch state', async () => {
    const { api } = fakeApi()
    const onSuspended = vi.fn()

    expect(await lease(api).suspendIfIdle(launch, onSuspended)).toBe('suspended')
    expect(onSuspended).toHaveBeenCalledTimes(1)
  })

  it('treats a release with no matching retain as no hold at all', async () => {
    const { api } = fakeApi()
    const subject = lease(api)
    subject.release(launch)

    expect(await subject.suspendIfIdle(launch, () => {})).toBe('suspended')
  })

  it('forgets the holds of a Sandbox this member no longer serves', async () => {
    const { api } = fakeApi()
    const subject = lease(api)
    subject.retain(launch)
    subject.forgetSandbox(launch)

    expect(await subject.suspendIfIdle(launch, () => {})).toBe('suspended')
  })

  it('runs a release callback once the LAST hold goes, and at once when nothing holds the Sandbox', () => {
    const { api } = fakeApi()
    const subject = lease(api)
    const then = vi.fn()
    subject.retain(launch)
    subject.retain(launch)
    subject.whenReleased(launch, then)

    subject.release(launch)
    expect(then).not.toHaveBeenCalled()
    subject.release(launch)
    expect(then).toHaveBeenCalledTimes(1)
    // One-shot: a later hold and release on the same Sandbox does not run it again.
    subject.retain(launch)
    subject.release(launch)
    expect(then).toHaveBeenCalledTimes(1)

    const now = vi.fn()
    subject.whenReleased(launch, now)
    expect(now).toHaveBeenCalledTimes(1)
  })

  it('drops a pending release callback with the Sandbox this member no longer serves', () => {
    const { api } = fakeApi()
    const subject = lease(api)
    const then = vi.fn()
    subject.retain(launch)
    subject.whenReleased(launch, then)
    subject.forgetSandbox(launch)

    subject.retain(launch)
    subject.release(launch)
    expect(then).not.toHaveBeenCalled()
  })
})

describe('sandbox lease suspension gate', () => {
  it('publishes the gate synchronously, before the first await', async () => {
    // Work admitted during the Kubernetes write would otherwise lose its pod: the gate has to be
    // readable by an acquisition that runs between this call and its first suspension point.
    const { api } = fakeApi()
    const subject = lease(api)
    const pending = subject.suspendIfIdle(launch, () => {})

    expect(subject.suspensionOf('agent-a')).toBeDefined()
    await pending
    // Dropped before the gate opened, so a waiter cannot find a suspension that already finished.
    expect(subject.suspensionOf('agent-a')).toBeUndefined()
  })

  it('declines a second suspension while one is already in flight', async () => {
    const { api, state } = fakeApi()
    const subject = lease(api)
    let openRead: (() => void) | undefined
    state.gateRead = () => new Promise<Sandbox>((resolve) => (openRead = () => resolve(state.sandbox)))
    const first = subject.suspendIfIdle(launch, () => {})
    await Promise.resolve()

    expect(await subject.suspendIfIdle(launch, () => {})).toBe('busy')
    openRead?.()
    expect(await first).toBe('suspended')
  })
})

describe('sandbox lease mode queue', () => {
  it('serializes mode writes per Sandbox and survives a rejected link', async () => {
    // A guarded write protects competing writes but not a decision that performs none, so the queue
    // must keep running after a failure instead of stranding every later transition behind it.
    const { api, state } = fakeApi('Running')
    const subject = lease(api)
    let failFirst: (() => void) | undefined
    state.gateRead = () =>
      new Promise<Sandbox>((_resolve, reject) => (failFirst = () => reject(new Error('api server down'))))

    const rejected = subject.queueMode(launch, 'Suspended')
    await Promise.resolve()
    const queued = subject.queueMode(launch, 'Suspended')
    await Promise.resolve()
    // The second transition has not read anything yet: the first still holds the queue.
    expect(state.reads).toBe(1)

    failFirst?.()
    await expect(rejected).rejects.toThrow(/api server down/)
    expect(await queued).toBe('Running')
    expect(state.writes).toEqual(['Suspended'])
  })

  it('reports the mode observed before the transition, not the one it produced', async () => {
    const { api } = fakeApi('Running')
    const subject = lease(api)

    // Already in the desired mode reports that mode; a real transition reports where it started.
    expect(await subject.queueMode(launch, 'Running')).toBe('Running')
    expect(await subject.queueMode(launch, 'Suspended')).toBe('Running')
    expect(await subject.queueMode(launch, 'Suspended')).toBe('Suspended')
  })
})

describe('sandbox lease with one agent holding several pods (git-workspace-model §11)', () => {
  it('gates a suspension per SUBJECT, so a session pod mid-suspend neither blocks nor is blocked by its siblings', async () => {
    // Three Sandboxes of one agent — its own (`sb-a`) and two sessions' (`sb-s`, `sb-t`) — each a subject of its own.
    const modes = new Map<string, OperatingMode>()
    const writes: string[] = []
    let releaseWrite: () => void = () => {}
    const held = new Promise<void>((resolve) => (releaseWrite = resolve))
    const api = {
      getSandbox: async (name: string): Promise<Sandbox> => ({
        metadata: { name, uid: 'uid-1', annotations: { [SANDBOX_LAUNCH_GENERATION]: '1' } },
        spec: { operatingMode: modes.get(name) ?? 'Running' }
      }),
      setOperatingMode: async (name: string, desired: OperatingMode): Promise<Sandbox> => {
        if (name === 'sb-s') await held
        writes.push(`${name}:${desired}`)
        modes.set(name, desired)
        return {
          metadata: { name, uid: 'uid-1', annotations: { [SANDBOX_LAUNCH_GENERATION]: '1' } },
          spec: { operatingMode: desired }
        }
      }
    } as unknown as SandboxApi
    const subject = lease(api)
    const agent = { ...launch, sandboxName: 'sb-a' }
    const session = { ...launch, subject: 'agent-a/session-1', sandboxName: 'sb-s' }
    const sibling = { ...launch, subject: 'agent-a/session-2', sandboxName: 'sb-t' }
    // Work on the AGENT pod, and a suspension in flight on the SESSION pod.
    subject.retain(agent)
    const suspending = subject.suspendIfIdle(session, () => {})
    expect(subject.suspensionOf('agent-a/session-1')).toBeDefined()
    // The agent pod's gate is untouched by the session pod's suspension, and its own hold decides for it.
    expect(subject.suspensionOf('agent-a')).toBeUndefined()
    expect(await subject.suspendIfIdle(agent, () => {})).toBe('busy')
    // A sibling session pod is neither gated nor held by either of them.
    expect(subject.suspensionOf('agent-a/session-2')).toBeUndefined()
    expect(await subject.suspendIfIdle(sibling, () => {})).toBe('suspended')
    releaseWrite()
    expect(await suspending).toBe('suspended')
    expect(subject.suspensionOf('agent-a/session-1')).toBeUndefined()
    // The agent pod's work was never counted against a session pod's Sandbox, and each write named its own pod.
    subject.release(agent)
    expect(await subject.suspendIfIdle(agent, () => {})).toBe('suspended')
    expect(writes).toEqual(['sb-t:Suspended', 'sb-s:Suspended', 'sb-a:Suspended'])
  })
})
