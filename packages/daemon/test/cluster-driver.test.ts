import { describe, expect, it, vi } from 'vitest'
import { FakeClock } from '@agentconnect.md/connection'
import { ClusterSpawnDriver, DRAIN_REQUESTED_ANNOTATION, AC_LABEL_AGENT } from '../src/k8s/cluster-driver.js'
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

function driver(api: ReturnType<typeof fakeApi>['api'], overrides: Record<string, unknown> = {}) {
  const records: SpawnRecord[] = []
  const clock = new FakeClock()
  const instance = new ClusterSpawnDriver({
    api: api as never,
    orgId: 'org-1',
    warmPoolName: 'ac-runtime-standard-pool',
    awaitChannel: async () => ({}) as ShimConnection,
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

  it('publishes a spawn record before a shim could bind, keyed on the Sandbox metadata uid', async () => {
    const { api } = fakeApi()
    const { instance, records } = driver(api)
    await instance.ensureSandbox('agent-a')
    // The uid comes from the Sandbox object; the claim status carries only a name.
    expect(records).toEqual([
      {
        agentId: 'agent-a',
        sandboxUid: 'sandbox-uid-1',
        generation: 1,
        grants: ['materialize', 'exec', 'read', 'tunnel']
      }
    ])
  })

  it('increments the generation per launch so a departed incarnation cannot act', async () => {
    const { api } = fakeApi()
    const { instance, records } = driver(api)
    await instance.ensureSandbox('agent-a')
    instance.forgetLaunch('agent-a')
    await instance.ensureSandbox('agent-a')
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
