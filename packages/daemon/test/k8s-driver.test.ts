import { describe, expect, it, vi } from 'vitest'
import { FakeClock } from '@agentconnect.md/connection'
import { K8sDriver, DRAIN_REQUESTED_ANNOTATION, AC_LABEL_AGENT } from '../src/k8s/driver.js'
import { OperatingModeRejectedError } from '../src/k8s/sandbox-api.js'
import { K8sApiError, type ResourceEvent } from '@agentconnect.md/k8s-client'
import type { Sandbox, SandboxClaim } from '../src/k8s/sandbox-api.js'
import type { SpawnRecord } from '../src/shim/binding.js'
import type { ShimConnection } from '../src/shim/listener.js'

/** A SandboxApi stand-in whose object state a test drives directly. */
function fakeApi(options: { ready?: boolean; mode?: 'Running' | 'Suspended' } = {}) {
  const state = {
    claims: new Map<string, SandboxClaim>(),
    sandbox: {
      metadata: { name: 'sb-1', uid: 'sandbox-uid-1' },
      spec: { operatingMode: options.mode ?? 'Running' },
      status: {
        conditions: [{ type: 'Ready', status: options.ready === false ? 'False' : 'True' }],
        podIPs: ['10.0.0.8']
      }
    } as Sandbox,
    modeWrites: [] as Array<{ desired: string; observed: string }>,
    rejectNextModeWrites: 0,
    created: [] as SandboxClaim[],
    deleted: [] as string[]
  }
  const api = {
    ensureClaim: vi.fn(async (claim: SandboxClaim & { metadata: { name: string } }) => {
      state.created.push(claim)
      state.claims.set(claim.metadata.name, { ...claim, status: { sandbox: { name: 'sb-1' } } })
      return state.claims.get(claim.metadata.name)!
    }),
    getClaim: vi.fn(async (name: string) => {
      const claim = state.claims.get(name)
      if (!claim) throw new K8sApiError(404, 'NotFound', 'no claim')
      return claim
    }),
    deleteClaim: vi.fn(async (name: string) => {
      state.deleted.push(name)
      state.claims.delete(name)
    }),
    getSandbox: vi.fn(async () => state.sandbox),
    setOperatingMode: vi.fn(
      async (_name: string, desired: 'Running' | 'Suspended', observed: 'Running' | 'Suspended') => {
        state.modeWrites.push({ desired, observed })
        if (state.rejectNextModeWrites > 0) {
          state.rejectNextModeWrites -= 1
          throw new OperatingModeRejectedError('sb-1', observed, desired, new K8sApiError(422, 'Invalid', 'rejected'))
        }
        state.sandbox = { ...state.sandbox, spec: { ...state.sandbox.spec, operatingMode: desired } }
        return state.sandbox
      }
    ),
    watchClaims: vi.fn(),
    watchSandboxes: vi.fn(),
    reviewToken: vi.fn()
  }
  return { api, state }
}

/** The Sandbox as a watch reports it, optionally carrying a rollout's drain request. */
function observed(mode: 'Running' | 'Suspended', requested?: string): Sandbox {
  return {
    metadata: {
      name: 'sb-1',
      uid: 'sandbox-uid-1',
      ...(requested ? { annotations: { [DRAIN_REQUESTED_ANNOTATION]: requested } } : {})
    },
    spec: { operatingMode: mode }
  }
}

/** A watch a test drives by hand, so events land in a decided order rather than a raced one. */
function watchSource() {
  const queue: ResourceEvent<Sandbox>[] = []
  let wake: (() => void) | undefined
  return {
    push(event: ResourceEvent<Sandbox>) {
      queue.push(event)
      wake?.()
    },
    async *stream(): AsyncGenerator<ResourceEvent<Sandbox>> {
      for (;;) {
        while (queue.length > 0) yield queue.shift()!
        await new Promise<void>((resolve) => (wake = resolve))
      }
    }
  }
}

/** Enough of a bound channel for `launch()` to attach a session to. */
function stubConnection(generation = 1, workspaceRoot?: string): ShimConnection {
  return {
    binding: { agentId: 'agent-a', generation, grants: ['acp'], podName: 'p', podUid: 'u' },
    issuedCredential: 'cred',
    ...(workspaceRoot ? { workspaceRoot } : {}),
    send: () => {},
    onFrame: () => {},
    close: () => {}
  } as unknown as ShimConnection
}

const launchRequest = { command: 'x', args: [], env: { AC_AGENT_ID: 'agent-a' }, cwd: '/agent' } as never

function driver(api: ReturnType<typeof fakeApi>['api'], overrides: Record<string, unknown> = {}) {
  const records: SpawnRecord[] = []
  const clock = new FakeClock()
  let generation = 0
  const customConnect = overrides.connectChannel as
    ((record: SpawnRecord, podIp: string, timeoutMs: number) => Promise<ShimConnection>) | undefined
  const instance = new K8sDriver({
    api: api as never,
    orgId: 'org-1',
    warmPoolName: 'ac-runtime-standard-pool',
    clock,
    log: { info: () => {}, warn: () => {}, debug: () => {} },
    ...overrides,
    connectChannel: async (record: SpawnRecord, podIp: string, timeoutMs: number) => {
      records.push(record)
      return customConnect ? await customConnect(record, podIp, timeoutMs) : stubConnection(++generation)
    }
  })
  return { instance, records, clock }
}

describe('cluster spawn driver', () => {
  it('creates a claim that carries the pool and labels but no per-agent env', async () => {
    const { api, state } = fakeApi()
    const { instance } = driver(api)
    await instance.ensureSandbox('agent-a')
    expect(state.created).toHaveLength(1)
    const claim = state.created[0]!
    expect(claim.metadata.name).toBe('agent-agent-a')
    expect(claim.spec?.warmPoolRef?.name).toBe('ac-runtime-standard-pool')
    expect(claim.spec?.additionalPodMetadata?.labels?.[AC_LABEL_AGENT]).toBe('agent-a')
    // A claim carrying env or volumeClaimTemplates bypasses warm-pool adoption, so identity
    // travels over the handshake instead. This asserts the shape stays clean.
    expect((claim.spec as Record<string, unknown>).env).toBeUndefined()
    expect((claim.spec as Record<string, unknown>).volumeClaimTemplates).toBeUndefined()
  })

  it('dials the ready pod IP with a launch record naming that pod', async () => {
    const { api } = fakeApi()
    const connectChannel = vi.fn(async (record: SpawnRecord) => stubConnection(record.generation))
    const { instance, records } = driver(api, { connectChannel })
    expect(await instance.ensureSandbox('agent-a')).toMatchObject({ sandboxName: 'sb-1' })
    // ensureSandbox alone dials nothing: the backing pod is not ready yet.
    expect(records).toEqual([])

    await instance.launch(launchRequest)
    // The uid comes from the Sandbox object; the claim status carries only a name.
    expect(records).toEqual([
      {
        agentId: 'agent-a',
        sandboxUid: 'sandbox-uid-1',
        generation: 1,
        grants: ['acp', 'materialize', 'exec', 'read', 'tunnel'],
        podName: 'sb-1'
      }
    ])
    expect(connectChannel).toHaveBeenCalledWith(expect.objectContaining({ podName: 'sb-1' }), '10.0.0.8', 90_000)
  })

  it('names the ADOPTED warm-pool pod, not the Sandbox, when one was adopted', async () => {
    // An adopted pod's pool-generated name is the identity TokenReview must return.
    const { api } = fakeApi()
    api.getSandbox = async () => ({
      metadata: { name: 'sb-1', uid: 'sandbox-uid-1', annotations: { 'agents.x-k8s.io/pod-name': 'pool-xyz-7' } },
      spec: { operatingMode: 'Running' },
      status: { conditions: [{ type: 'Ready', status: 'True' }], podIPs: ['10.0.0.9'] }
    })
    const { instance, records } = driver(api)
    await instance.launch(launchRequest)
    expect(records.at(-1)?.podName).toBe('pool-xyz-7')
  })

  it('increments the generation per launch so a departed incarnation cannot act', async () => {
    const { api } = fakeApi()
    const { instance, records } = driver(api)
    await instance.launch(launchRequest)
    instance.forgetLaunch('agent-a')
    await instance.launch(launchRequest)
    expect(records.map((record) => record.generation)).toEqual([1, 2])
  })

  it('is idempotent: an existing launch is reused rather than re-claimed', async () => {
    const { api, state } = fakeApi()
    const { instance } = driver(api)
    await instance.ensureSandbox('agent-a')
    await instance.ensureSandbox('agent-a')
    expect(state.created).toHaveLength(1)
  })

  it('skips the mode write when the sandbox is already where it should be', async () => {
    const { api, state } = fakeApi({ mode: 'Running' })
    const { instance } = driver(api)
    await instance.ensureSandbox('agent-a')
    await instance.wake('agent-a')
    expect(state.modeWrites).toEqual([])
  })

  it('re-reads and retries when the guarded write is rejected', async () => {
    const { api, state } = fakeApi({ mode: 'Running' })
    state.rejectNextModeWrites = 2
    const { instance } = driver(api)
    await instance.ensureSandbox('agent-a')
    await instance.suspend('agent-a')
    // The rejection does not say what the state became, so the only correct response is to
    // look again — three attempts, the third landing.
    expect(state.modeWrites).toHaveLength(3)
    expect(state.sandbox.spec?.operatingMode).toBe('Suspended')
  })

  it('gives up after a bounded number of rejections instead of looping forever', async () => {
    const { api, state } = fakeApi({ mode: 'Running' })
    state.rejectNextModeWrites = 99
    const { instance } = driver(api)
    await instance.ensureSandbox('agent-a')
    // A permanently invalid patch must not spin: the error is deliberately unclaimed about
    // its cause, so a caller that retried forever would never learn otherwise.
    await expect(instance.suspend('agent-a')).rejects.toThrow(/would not accept/)
    expect(state.modeWrites).toHaveLength(5)
  })

  it('does not hand a resumed sandbox the session its departed pod already closed', async () => {
    // A lost session is terminal and `attach()` is a no-op once closed, while a CACHED launch
    // keeps its generation — so a re-bind that matched generations re-attached the dead session
    // and handed the runtime a channel that could never serve a request. Losing the channel has
    // to end the launch, which is what makes the next turn claim a fresh generation.
    const { api } = fakeApi()
    const { instance } = driver(api, {
      connectChannel: async (record: SpawnRecord) => stubConnection(record.generation)
    })
    await instance.ensureBoundChannel('agent-a')
    expect(instance.sessionFor('agent-a')?.isAttached()).toBe(true)

    instance.onChannelLost('agent-a', 'pod deleted')
    expect(instance.sessionFor('agent-a')).toBeUndefined()

    await instance.ensureBoundChannel('agent-a')
    expect(instance.sessionFor('agent-a')?.isAttached()).toBe(true)
  })

  it('suspends an idle agent, keeps its claim, and resumes it at a new generation', async () => {
    const { api, state } = fakeApi()
    const { instance, records } = driver(api, {
      connectChannel: async (record: SpawnRecord) => stubConnection(record.generation)
    })
    await instance.ensureBoundChannel('agent-a')

    expect(await instance.suspendIfIdle('agent-a')).toBe('suspended')
    expect(state.modeWrites).toEqual([{ desired: 'Suspended', observed: 'Running' }])
    // The pod is what goes: the claim (and with it the workspace volume) is untouched.
    expect(state.deleted).toEqual([])

    await instance.ensureBoundChannel('agent-a')
    expect(state.modeWrites.at(-1)).toEqual({ desired: 'Running', observed: 'Suspended' })
    expect(records.map((record) => record.generation)).toEqual([1, 2])
    expect(instance.sessionFor('agent-a')?.isAttached()).toBe(true)
  })

  it('declines to suspend a sandbox that work still holds, rather than waiting for it', async () => {
    const { api, state } = fakeApi()
    const { instance } = driver(api)
    let outcome: string | undefined
    await instance.withSandbox('agent-a', async () => {
      outcome = await instance.suspendIfIdle('agent-a')
    })
    // The caller is a periodic sweep, so the next pass finds it quiet. Waiting here would hold a
    // decision open across the very turn that makes it wrong.
    expect(outcome).toBe('busy')
    expect(state.modeWrites).toEqual([])
    expect(await instance.suspendIfIdle('agent-never-launched')).toBe('absent')
  })

  it('makes work admitted DURING a suspend wait for it, then resume, instead of losing its pod', async () => {
    // `busy` counts holders; it does not exclude them. A dispatch that arrives while the suspend
    // is mid-write would otherwise acquire the same launch, have its pod deleted underneath it,
    // and then find the launch forgotten by the suspend's own success path.
    const { api, state } = fakeApi()
    let releaseWrite: () => void = () => {}
    const held = new Promise<void>((resolve) => (releaseWrite = resolve))
    const setOperatingMode = api.setOperatingMode
    api.setOperatingMode = (async (name: string, desired: string, observed: string) => {
      if (desired === 'Suspended') await held
      return setOperatingMode(name as never, desired as never, observed as never)
    }) as never
    const { instance, records } = driver(api, {
      connectChannel: async (record: SpawnRecord) => stubConnection(record.generation)
    })
    await instance.ensureBoundChannel('agent-a')

    const suspending = instance.suspendIfIdle('agent-a')
    let bound = false
    const binding = instance.ensureBoundChannel('agent-a').then(() => (bound = true))
    await Promise.resolve()
    // The gate is closed before the first await, so the arriving work is waiting rather than
    // holding a sandbox whose pod is about to go.
    expect(bound).toBe(false)

    releaseWrite()
    expect(await suspending).toBe('suspended')
    await binding
    // It resumed the instance it waited for, at a fresh generation — the pod that comes back is a
    // new one, and binding it against the old generation is what this ordering prevents.
    expect(state.modeWrites.map((write) => write.desired)).toEqual(['Suspended', 'Running'])
    expect(records.map((record) => record.generation)).toEqual([1, 2])
    expect(instance.sessionFor('agent-a')?.isAttached()).toBe(true)
  })

  it('does not wake an instance while a drain request is pending', async () => {
    const { api, state } = fakeApi({ mode: 'Suspended' })
    const { instance } = driver(api)
    await instance.ensureSandbox('agent-a')
    instance.onSandboxObserved(observed('Suspended', 'rollout-7/image:v2'))
    expect(instance.isDraining('agent-a')).toBe(true)
    await instance.wake('agent-a')
    // One arriving message must not revive the image the rollout is replacing; the message
    // queues instead.
    expect(state.modeWrites).toEqual([])

    instance.onSandboxObserved(observed('Suspended'))
    expect(instance.isDraining('agent-a')).toBe(false)
    await instance.wake('agent-a')
    expect(state.modeWrites).toEqual([{ desired: 'Running', observed: 'Suspended' }])
  })

  it('suspends an idle sandbox as soon as a drain is requested, launch or no launch', async () => {
    // Nothing bound it in this process — the daemon restarted, or the agent has been quiet — and
    // that instance is exactly the one a rollout is waiting on. Suspension is what lets it swap
    // the image, so it comes off the observation itself rather than off the next launch.
    const { api, state } = fakeApi({ mode: 'Running' })
    const { instance } = driver(api)
    instance.onSandboxObserved(observed('Running', 'rollout-7/image:v2'))
    await vi.waitFor(() => expect(state.modeWrites).toEqual([{ desired: 'Suspended', observed: 'Running' }]))
  })

  it('waits for the work on a draining sandbox to end before suspending it', async () => {
    const { api, state } = fakeApi({ mode: 'Running' })
    const { instance } = driver(api)
    await instance.launch(launchRequest)
    instance.onSandboxObserved(observed('Running', 'rollout-7/image:v2'))
    await Promise.resolve()
    // A live runtime keeps its pod: the rollout waits for the turn rather than the daemon
    // killing it, and gives up on its own deadline if it never goes quiet.
    expect(state.modeWrites).toEqual([])

    // The runtime is gone, so the sandbox is idle — which is when the pending drain lands.
    instance.onChannelLost('agent-a', 'shim channel gone')
    await vi.waitFor(() => expect(state.modeWrites).toEqual([{ desired: 'Suspended', observed: 'Running' }]))
  })

  it('holds the sandbox across workspace preparation, not merely across the bind', async () => {
    // Cold preparation clones, pulls and materializes IN the pod, over the shim, between the bind
    // and the launch it is preparing for. A hold that ended with the bind would leave that whole
    // stretch drainable, and the suspend would pull the pod out from under an admitted turn.
    const { api, state } = fakeApi({ mode: 'Running' })
    const { instance } = driver(api)
    let finishPreparing!: () => void
    const preparing = new Promise<void>((resolve) => (finishPreparing = resolve))
    const held = instance.withSandbox('agent-a', async () => {
      await instance.ensureBoundChannel('agent-a')
      await preparing
    })
    await vi.waitFor(() => expect(instance.currentLaunch('agent-a')).toBeDefined())
    instance.onSandboxObserved(observed('Running', 'rollout-7/image:v2'))
    await Promise.resolve()
    expect(state.modeWrites).toEqual([])

    finishPreparing()
    await held
    await vi.waitFor(() => expect(state.modeWrites).toEqual([{ desired: 'Suspended', observed: 'Running' }]))
  })

  it('refuses to take a lease on a sandbox that is already draining', async () => {
    // The preparation has not started yet, so the drain wins the decision — fast, and by type.
    const { api } = fakeApi({ mode: 'Running' })
    const { instance } = driver(api)
    await instance.ensureSandbox('agent-a')
    instance.onSandboxObserved(observed('Suspended', 'rollout-7/image:v2'))
    await expect(instance.withSandbox('agent-a', async () => 'prepared')).rejects.toThrow(/draining/)
  })

  it('takes drain requests off the watch and converges on each snapshot', async () => {
    const { api } = fakeApi({ mode: 'Running' })
    const source = watchSource()
    api.watchSandboxes = vi.fn(() => source.stream()) as never
    const { instance } = driver(api)
    await instance.ensureSandbox('agent-a')
    instance.startSandboxWatch()
    source.push({ kind: 'modified', object: observed('Running', 'rollout-7/image:v2') })
    await vi.waitFor(() => expect(instance.isDraining('agent-a')).toBe(true))

    // A snapshot is the whole truth: a watch gap can drop a request's removal, so a sandbox the
    // re-LIST no longer reports must not stay held down forever.
    source.push({ kind: 'synced', items: [] })
    await vi.waitFor(() => expect(instance.isDraining('agent-a')).toBe(false))
    instance.stopSandboxWatch()
  })

  it('orders concurrent wake and suspend decisions so the newer one wins', async () => {
    // A guarded write protects competing WRITES, but it cannot protect a decision that
    // performs no write: a later wake reading Running would return while an earlier suspend
    // patch was still in flight, and the older write would land last and reverse it.
    const { api, state } = fakeApi({ mode: 'Running' })
    let releaseFirst!: () => void
    const gate = new Promise<void>((resolve) => (releaseFirst = resolve))
    let calls = 0
    const original = api.setOperatingMode
    api.setOperatingMode = vi.fn(async (name: string, desired: never, observed: never) => {
      calls += 1
      if (calls === 1) await gate
      return original(name, desired, observed)
    }) as never
    const { instance } = driver(api)
    await instance.ensureSandbox('agent-a')

    const suspending = instance.suspend('agent-a')
    const waking = instance.wake('agent-a')
    releaseFirst()
    await Promise.all([suspending, waking])

    // The wake was decided second, so it must be the state that survives.
    expect(state.sandbox.spec?.operatingMode).toBe('Running')
    expect(state.modeWrites.map((write) => write.desired)).toEqual(['Suspended', 'Running'])
  })

  it('refuses to launch while a drain request is pending, instead of waiting out a timeout', async () => {
    const { api } = fakeApi({ mode: 'Suspended' })
    const { instance } = driver(api)
    await instance.ensureSandbox('agent-a')
    instance.onSandboxObserved(observed('Suspended', 'rollout-1/img'))
    // wake() holds the sandbox down deliberately, so launching would block until the readiness
    // deadline elapsed. Failing fast says what is actually happening.
    await expect(instance.launch({ command: 'x', args: [], env: { AC_AGENT_ID: 'agent-a' } })).rejects.toThrow(
      /draining/
    )
  })

  it('resolves a suspended claim without waiting for readiness first', async () => {
    // After a daemon restart the claim still names its Sandbox, but suspension deleted the
    // pod — so requiring Ready here would block the only call that could bring it back.
    const { api } = fakeApi({ mode: 'Suspended', ready: false })
    const { instance, records } = driver(api)
    const launch = await instance.ensureSandbox('agent-a')
    expect(launch.sandboxName).toBe('sb-1')
    // And it did NOT publish: nothing may be authorized against a pod that does not exist yet.
    expect(records).toEqual([])
  })

  it('remembers where the bound pod mounts its workspace, until the agent goes away', async () => {
    const { api } = fakeApi()
    let generation = 0
    const { instance } = driver(api, {
      connectChannel: async () => stubConnection(++generation, '/agent')
    })
    // Unknown before any bind: the daemon cannot name a path on a machine it has not heard from.
    expect(instance.workspaceRootFor('agent-a')).toBeUndefined()
    await instance.launch(launchRequest)
    expect(instance.workspaceRootFor('agent-a')).toBe('/agent')
    // A renewal reporting a root keeps it current on the replacement connection too.
    instance.onChannelBound(stubConnection(generation, '/mnt/agent'))
    expect(instance.workspaceRootFor('agent-a')).toBe('/mnt/agent')
    await instance.removeAgent('agent-a')
    expect(instance.workspaceRootFor('agent-a')).toBeUndefined()
  })

  it('keeps no workspace root from a legacy shim that reports none', async () => {
    const { api } = fakeApi()
    const { instance } = driver(api)
    await instance.launch(launchRequest)
    expect(instance.workspaceRootFor('agent-a')).toBeUndefined()
  })

  it('forgets a custom root when the replacement pod reports none, rather than keeping a stale mount', async () => {
    // An image rollback puts a shim that reports nothing on the agent's next pod. Retaining the
    // previous incarnation's root would send it a path only the OLD image mounted, which is the
    // failure this reporting exists to remove — the fallback has to become reachable again.
    const { api } = fakeApi()
    let generation = 0
    const { instance } = driver(api, {
      connectChannel: async () => stubConnection(++generation, '/mnt/agent')
    })
    await instance.launch(launchRequest)
    expect(instance.workspaceRootFor('agent-a')).toBe('/mnt/agent')
    instance.onChannelBound(stubConnection(generation))
    expect(instance.workspaceRootFor('agent-a')).toBeUndefined()
  })

  it('deletes the claim when an agent goes away', async () => {
    const { api, state } = fakeApi()
    const { instance } = driver(api)
    await instance.ensureSandbox('agent-a')
    await instance.removeAgent('agent-a')
    expect(state.deleted).toEqual(['agent-agent-a'])
    expect(instance.currentLaunch('agent-a')).toBeUndefined()
  })

  it('refuses to launch without an agent id in the runtime environment', async () => {
    const { api } = fakeApi()
    const { instance } = driver(api)
    await expect(instance.launch({ command: 'claude-code-acp', args: [], env: {} })).rejects.toThrow(/AC_AGENT_ID/)
  })
})
