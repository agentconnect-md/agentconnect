import { describe, expect, it, vi } from 'vitest'
import { SandboxLease } from '../src/k8s/sandbox-lease.js'
import { noopClusterMetrics } from '../src/metrics/cluster-metrics.js'
import type { OperatingMode, Sandbox, SandboxApi } from '../src/k8s/sandbox-api.js'

const log = { info: () => {}, warn: () => {}, debug: () => {} }

/** A Sandbox whose operating mode a test drives, and the writes the lease made against it. */
function fakeApi(mode: OperatingMode = 'Running') {
  const state = {
    sandbox: { metadata: { name: 'sb-1' }, spec: { operatingMode: mode } } as Sandbox,
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

function lease(api: SandboxApi) {
  return new SandboxLease({ api, warmPoolName: 'pool', log, metrics: noopClusterMetrics })
}

describe('sandbox lease holds', () => {
  it('keeps a Sandbox unsuspendable until every nested hold is released', async () => {
    const { api, state } = fakeApi()
    const subject = lease(api)
    subject.retain('sb-1')
    subject.retain('sb-1')

    expect(await subject.suspendIfIdle('agent-a', 'sb-1', () => {})).toBe('busy')
    subject.release('sb-1')
    // The outer hold is still open: a refcount that collapsed on the first release would suspend
    // the pod underneath the work that reentered it.
    expect(await subject.suspendIfIdle('agent-a', 'sb-1', () => {})).toBe('busy')
    subject.release('sb-1')

    expect(await subject.suspendIfIdle('agent-a', 'sb-1', () => {})).toBe('suspended')
    expect(state.writes).toEqual(['Suspended'])
  })

  it('reports the suspension it performed to the caller that owns the launch state', async () => {
    const { api } = fakeApi()
    const onSuspended = vi.fn()

    expect(await lease(api).suspendIfIdle('agent-a', 'sb-1', onSuspended)).toBe('suspended')
    expect(onSuspended).toHaveBeenCalledTimes(1)
  })

  it('treats a release with no matching retain as no hold at all', async () => {
    const { api } = fakeApi()
    const subject = lease(api)
    subject.release('sb-1')

    expect(await subject.suspendIfIdle('agent-a', 'sb-1', () => {})).toBe('suspended')
  })

  it('forgets the holds of a Sandbox this member no longer serves', async () => {
    const { api } = fakeApi()
    const subject = lease(api)
    subject.retain('sb-1')
    subject.forgetSandbox('sb-1')

    expect(await subject.suspendIfIdle('agent-a', 'sb-1', () => {})).toBe('suspended')
  })
})

describe('sandbox lease suspension gate', () => {
  it('publishes the gate synchronously, before the first await', async () => {
    // Work admitted during the Kubernetes write would otherwise lose its pod: the gate has to be
    // readable by an acquisition that runs between this call and its first suspension point.
    const { api } = fakeApi()
    const subject = lease(api)
    const pending = subject.suspendIfIdle('agent-a', 'sb-1', () => {})

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
    const first = subject.suspendIfIdle('agent-a', 'sb-1', () => {})
    await Promise.resolve()

    expect(await subject.suspendIfIdle('agent-a', 'sb-1', () => {})).toBe('busy')
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

    const rejected = subject.queueMode('sb-1', 'Suspended')
    await Promise.resolve()
    const queued = subject.queueMode('sb-1', 'Suspended')
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
    expect(await subject.queueMode('sb-1', 'Running')).toBe('Running')
    expect(await subject.queueMode('sb-1', 'Suspended')).toBe('Running')
    expect(await subject.queueMode('sb-1', 'Suspended')).toBe('Suspended')
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
        metadata: { name },
        spec: { operatingMode: modes.get(name) ?? 'Running' }
      }),
      setOperatingMode: async (name: string, desired: OperatingMode): Promise<Sandbox> => {
        if (name === 'sb-s') await held
        writes.push(`${name}:${desired}`)
        modes.set(name, desired)
        return { metadata: { name }, spec: { operatingMode: desired } }
      }
    } as unknown as SandboxApi
    const subject = lease(api)
    // Work on the AGENT pod, and a suspension in flight on the SESSION pod.
    subject.retain('sb-a')
    const suspending = subject.suspendIfIdle('agent-a/session-1', 'sb-s', () => {})
    expect(subject.suspensionOf('agent-a/session-1')).toBeDefined()
    // The agent pod's gate is untouched by the session pod's suspension, and its own hold decides for it.
    expect(subject.suspensionOf('agent-a')).toBeUndefined()
    expect(await subject.suspendIfIdle('agent-a', 'sb-a', () => {})).toBe('busy')
    // A sibling session pod is neither gated nor held by either of them.
    expect(subject.suspensionOf('agent-a/session-2')).toBeUndefined()
    expect(await subject.suspendIfIdle('agent-a/session-2', 'sb-t', () => {})).toBe('suspended')
    releaseWrite()
    expect(await suspending).toBe('suspended')
    expect(subject.suspensionOf('agent-a/session-1')).toBeUndefined()
    // The agent pod's work was never counted against a session pod's Sandbox, and each write named its own pod.
    subject.release('sb-a')
    expect(await subject.suspendIfIdle('agent-a', 'sb-a', () => {})).toBe('suspended')
    expect(writes).toEqual(['sb-t:Suspended', 'sb-s:Suspended', 'sb-a:Suspended'])
  })
})
