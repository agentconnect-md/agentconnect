import { describe, expect, it, vi } from 'vitest'
import { FakeClock } from '@agentconnect.md/connection'
import { K8sDriver, DRAIN_REQUESTED_ANNOTATION, AC_LABEL_AGENT } from '../src/k8s/driver.js'
import { OperatingModeRejectedError } from '../src/k8s/sandbox-api.js'
import { K8sApiError } from '../src/k8s/http.js'
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
      status: { conditions: [{ type: 'Ready', status: options.ready === false ? 'False' : 'True' }] }
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
  const instance = new K8sDriver({
    api: api as never,
    orgId: 'org-1',
    warmPoolName: 'ac-runtime-standard-pool',
    awaitChannel: async () => stubConnection(++generation),
    publishSpawnRecord: (record) => records.push(record),
    clock,
    log: { info: () => {}, warn: () => {}, debug: () => {} },
    ...overrides
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

  it('publishes a spawn record naming the POD, as soon as the Sandbox names one', async () => {
    // The record is how a dialing pod is resolved back to its launch, and a TokenReview yields
    // only a pod name and uid — so a record that does not name the pod cannot be found at all.
    // It is published when the pod is first named rather than at claim time, because at claim
    // time the name still belongs to the previous incarnation.
    const { api } = fakeApi()
    const { instance, records } = driver(api)
    expect(await instance.ensureSandbox('agent-a')).toMatchObject({ sandboxName: 'sb-1' })
    // ensureSandbox alone publishes nothing: no pod is bound yet.
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
  })

  it('names the ADOPTED warm-pool pod, not the Sandbox, when one was adopted', async () => {
    // Our normal path is warm-pool adoption, and an adopted pod carries a pool-generated name
    // that has nothing to do with the Sandbox's. Falling back to the Sandbox name there would
    // publish a record no dialing pod could ever match.
    const { api } = fakeApi()
    api.getSandbox = async () => ({
      metadata: { name: 'sb-1', uid: 'sandbox-uid-1', annotations: { 'agents.x-k8s.io/pod-name': 'pool-xyz-7' } },
      spec: { operatingMode: 'Running' },
      status: { conditions: [{ type: 'Ready', status: 'True' }] }
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

  it('does not wake an instance while a drain request is pending', async () => {
    const { api, state } = fakeApi({ mode: 'Suspended' })
    const { instance } = driver(api)
    await instance.ensureSandbox('agent-a')
    instance.onSandboxObserved('agent-a', { [DRAIN_REQUESTED_ANNOTATION]: 'rollout-7/image:v2' })
    expect(instance.isDraining('agent-a')).toBe(true)
    await instance.wake('agent-a')
    // One arriving message must not revive the image the rollout is replacing; the message
    // queues instead.
    expect(state.modeWrites).toEqual([])

    instance.onSandboxObserved('agent-a', {})
    expect(instance.isDraining('agent-a')).toBe(false)
    await instance.wake('agent-a')
    expect(state.modeWrites).toEqual([{ desired: 'Running', observed: 'Suspended' }])
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
    instance.onSandboxObserved('agent-a', { [DRAIN_REQUESTED_ANNOTATION]: 'rollout-1/img' })
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
      awaitChannel: async () => stubConnection(++generation, '/agent')
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
      awaitChannel: async () => stubConnection(++generation, '/mnt/agent')
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
