import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { FakeClock } from '@agentconnect.md/connection'
import { K8sDriver } from '../src/k8s/driver.js'
import { AC_LABEL_AGENT, AC_LABEL_ORG } from '../src/k8s/sandbox-identity.js'
import { LocalStore } from '../src/store/local-store.js'
import { fakeGenerations } from './fake-generations.js'
import { GuardedResumeRejectedError, OperatingModeRejectedError } from '../src/k8s/sandbox-api.js'
import { K8sApiError } from '@agentconnect.md/k8s-client'
import type { Sandbox, SandboxClaim, SandboxWarmPool } from '../src/k8s/sandbox-api.js'
import type { SpawnRecord } from '../src/shim/binding.js'
import type { ShimConnection } from '../src/shim/connection.js'

/** A SandboxApi stand-in whose object state a test drives directly. */
function fakeApi(options: { ready?: boolean; mode?: 'Running' | 'Suspended'; templateImage?: string } = {}) {
  const state = {
    claims: new Map<string, SandboxClaim>(),
    sandbox: {
      metadata: { name: 'sb-1', uid: 'sandbox-uid-1' },
      spec: {
        operatingMode: options.mode ?? 'Running',
        podTemplate: {
          spec: {
            containers: [
              { name: 'sidecar', image: 'sidecar:1' },
              { name: 'runtime', image: 'runtime:old' }
            ]
          }
        }
      },
      status: {
        conditions: [{ type: 'Ready', status: options.ready === false ? 'False' : 'True' }],
        podIPs: ['10.0.0.8']
      }
    } as Sandbox,
    modeWrites: [] as Array<{ desired: string; observed: string }>,
    resumeWrites: [] as Array<{
      containerIndex: number
      observedName: string
      observedImage: string
      targetImage: string
    }>,
    rejectNextModeWrites: 0,
    beforeResume: undefined as (() => void) | undefined,
    templateImage: options.templateImage ?? 'runtime:new',
    created: [] as SandboxClaim[],
    deleted: [] as string[]
  }
  const api = {
    ensureClaim: vi.fn(async (claim: SandboxClaim & { metadata: { name: string } }) => {
      state.created.push(claim)
      state.claims.set(claim.metadata.name, { ...claim, status: { sandbox: { name: 'sb-1' } } })
      return { claim: state.claims.get(claim.metadata.name)!, created: true }
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
    getWarmPool: vi.fn(async (): Promise<SandboxWarmPool> => ({
      spec: { sandboxTemplateRef: { name: 'runtime-template' } }
    })),
    getSandboxTemplate: vi.fn(async () => ({
      spec: {
        podTemplate: { spec: { containers: [{ name: 'runtime', image: state.templateImage }] } }
      }
    })),
    resumeWithRuntimeImage: vi.fn(
      async (
        _name: string,
        image: { containerIndex: number; observedName: string; observedImage: string; targetImage: string }
      ) => {
        state.resumeWrites.push(image)
        state.beforeResume?.()
        const containers = state.sandbox.spec?.podTemplate?.spec?.containers ?? []
        const current = containers[image.containerIndex]
        if (
          state.sandbox.spec?.operatingMode !== 'Suspended' ||
          current?.name !== image.observedName ||
          current.image !== image.observedImage
        ) {
          throw new GuardedResumeRejectedError('sb-1', new K8sApiError(422, 'Invalid', 'guard rejected'))
        }
        const nextContainers = containers.map((container, index) =>
          index === image.containerIndex ? { ...container, image: image.targetImage } : container
        )
        state.sandbox = {
          ...state.sandbox,
          spec: {
            ...state.sandbox.spec,
            operatingMode: 'Running',
            podTemplate: { ...state.sandbox.spec?.podTemplate, spec: { containers: nextContainers } }
          }
        }
        return state.sandbox
      }
    ),
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
  const infos: string[] = []
  const clock = new FakeClock()
  let generation = 0
  const customConnect = overrides.connectChannel as
    ((record: SpawnRecord, podIp: string, timeoutMs: number) => Promise<ShimConnection>) | undefined
  const instance = new K8sDriver({
    api: api as never,
    orgForAgent: () => 'org-1',
    warmPoolName: 'ac-runtime-standard-pool',
    generations: fakeGenerations(),
    clock,
    log: { info: (message: string) => infos.push(message), warn: () => {}, debug: () => {} },
    ...overrides,
    connectChannel: async (record: SpawnRecord, podIp: string, timeoutMs: number) => {
      records.push(record)
      return customConnect ? await customConnect(record, podIp, timeoutMs) : stubConnection(++generation)
    }
  })
  return { instance, records, clock, infos }
}

describe('cluster spawn driver', () => {
  it('creates a claim that carries the pool and labels but no per-agent env', async () => {
    const { api, state } = fakeApi()
    const { instance } = driver(api)
    await instance.ensureSandbox('agent-a')
    expect(state.created).toHaveLength(1)
    const claim = state.created[0]!
    expect(claim.metadata!.name).toBe('agent-agent-a')
    expect(claim.spec?.warmPoolRef?.name).toBe('ac-runtime-standard-pool')
    expect(claim.spec?.additionalPodMetadata?.labels?.[AC_LABEL_AGENT]).toBe('agent-a')
    expect(claim.spec?.additionalPodMetadata?.labels?.[AC_LABEL_ORG]).toBe('org-1')
    // A claim carrying env or volumeClaimTemplates bypasses warm-pool adoption, so identity
    // travels over the handshake instead. This asserts the shape stays clean.
    expect((claim.spec as Record<string, unknown>).env).toBeUndefined()
    expect((claim.spec as Record<string, unknown>).volumeClaimTemplates).toBeUndefined()
  })

  it('resolves the organization independently for each agent claim', async () => {
    const { api, state } = fakeApi()
    const { instance } = driver(api, {
      orgForAgent: (agentId: string) => (agentId === 'agent-a' ? 'org-a' : 'org-b')
    })
    await instance.ensureSandbox('agent-a')
    await instance.ensureSandbox('agent-b')
    expect(state.created.map((claim) => claim.spec?.additionalPodMetadata?.labels?.[AC_LABEL_ORG])).toEqual([
      'org-a',
      'org-b'
    ])
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
        grants: ['acp', 'materialize', 'exec', 'read', 'tunnel', 'automerge', 'skills'],
        podName: 'sb-1'
      }
    ])
    expect(connectChannel).toHaveBeenCalledWith(expect.objectContaining({ podName: 'sb-1' }), '10.0.0.8', 90_000)
  })

  it('names the ADOPTED warm-pool pod, not the Sandbox, when one was adopted', async () => {
    // An adopted pod's pool-generated name is the identity TokenReview must return.
    const { api } = fakeApi()
    api.getSandbox = vi.fn(async (): Promise<Sandbox> => ({
      metadata: { name: 'sb-1', uid: 'sandbox-uid-1', annotations: { 'agents.x-k8s.io/pod-name': 'pool-xyz-7' } },
      spec: { operatingMode: 'Running' },
      status: { conditions: [{ type: 'Ready', status: 'True' }], podIPs: ['10.0.0.9'] }
    }))
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
    expect(api.getWarmPool).not.toHaveBeenCalled()
    expect(api.getSandboxTemplate).not.toHaveBeenCalled()
  })

  it('resumes a suspended sandbox with the current template image', async () => {
    const { api, state } = fakeApi({ mode: 'Suspended' })
    const sandboxUid = state.sandbox.metadata?.uid
    const { instance, infos } = driver(api)
    await instance.ensureSandbox('agent-a')

    await instance.wake('agent-a')

    expect(api.getWarmPool).toHaveBeenCalledWith('ac-runtime-standard-pool')
    expect(api.getSandboxTemplate).toHaveBeenCalledWith('runtime-template')
    expect(state.resumeWrites).toEqual([
      {
        containerIndex: 1,
        observedName: 'runtime',
        observedImage: 'runtime:old',
        targetImage: 'runtime:new'
      }
    ])
    expect(state.sandbox.spec?.podTemplate?.spec?.containers?.[1]?.image).toBe('runtime:new')
    expect(state.sandbox.spec?.operatingMode).toBe('Running')
    expect(state.sandbox.metadata?.uid).toBe(sandboxUid)
    expect(state.deleted).toEqual([])
    expect(infos.filter((message) => message.includes('runtime:old') && message.includes('runtime:new'))).toHaveLength(
      1
    )
    expect(infos).not.toContain('cluster: sandbox sb-1 → Running')
  })

  it('uses the guarded resume when the suspended sandbox already has the template image', async () => {
    const { api, state } = fakeApi({ mode: 'Suspended', templateImage: 'runtime:old' })
    const { instance, infos } = driver(api)
    await instance.ensureSandbox('agent-a')

    await instance.wake('agent-a')

    expect(state.resumeWrites).toEqual([
      {
        containerIndex: 1,
        observedName: 'runtime',
        observedImage: 'runtime:old',
        targetImage: 'runtime:old'
      }
    ])
    expect(infos).toContain('cluster: sandbox sb-1 → Running')
    expect(infos.filter((message) => message.includes('runtime:old → runtime:old'))).toEqual([])
  })

  it('re-reads the sandbox and template when the observed image changes before resume', async () => {
    const { api, state } = fakeApi({ mode: 'Suspended' })
    state.beforeResume = () => {
      state.beforeResume = undefined
      const containers = state.sandbox.spec?.podTemplate?.spec?.containers ?? []
      state.sandbox = {
        ...state.sandbox,
        spec: {
          ...state.sandbox.spec,
          podTemplate: {
            ...state.sandbox.spec?.podTemplate,
            spec: {
              containers: containers.map((container) =>
                container.name === 'runtime' ? { ...container, image: 'runtime:raced' } : container
              )
            }
          }
        }
      }
    }
    const { instance, infos } = driver(api)
    await instance.ensureSandbox('agent-a')

    await instance.wake('agent-a')

    expect(state.resumeWrites.map((write) => write.observedImage)).toEqual(['runtime:old', 'runtime:raced'])
    expect(api.getWarmPool).toHaveBeenCalledTimes(2)
    expect(api.getSandboxTemplate).toHaveBeenCalledTimes(2)
    expect(
      state.sandbox.spec?.podTemplate?.spec?.containers?.find((container) => container.name === 'runtime')?.image
    ).toBe('runtime:new')
    expect(infos.filter((message) => message.includes('runtime image'))).toHaveLength(1)
  })

  it('re-resolves the runtime index after a concurrent container reorder without changing the sidecar', async () => {
    const { api, state } = fakeApi({ mode: 'Suspended' })
    state.beforeResume = () => {
      state.beforeResume = undefined
      const containers = state.sandbox.spec?.podTemplate?.spec?.containers ?? []
      state.sandbox = {
        ...state.sandbox,
        spec: {
          ...state.sandbox.spec,
          podTemplate: { ...state.sandbox.spec?.podTemplate, spec: { containers: [...containers].reverse() } }
        }
      }
    }
    const { instance } = driver(api)
    await instance.ensureSandbox('agent-a')

    await instance.wake('agent-a')

    expect(state.resumeWrites.map((write) => write.containerIndex)).toEqual([1, 0])
    expect(
      state.sandbox.spec?.podTemplate?.spec?.containers?.find((container) => container.name === 'sidecar')?.image
    ).toBe('sidecar:1')
  })

  it('uses a newly read template target after a guarded resume rejection', async () => {
    const { api, state } = fakeApi({ mode: 'Suspended' })
    state.beforeResume = () => {
      state.beforeResume = undefined
      state.templateImage = 'runtime:newer'
      const runtime = state.sandbox.spec?.podTemplate?.spec?.containers?.[1]
      if (runtime) runtime.image = 'runtime:raced'
    }
    const { instance } = driver(api)
    await instance.ensureSandbox('agent-a')

    await instance.wake('agent-a')

    expect(state.resumeWrites.map((write) => write.targetImage)).toEqual(['runtime:new', 'runtime:newer'])
    expect(state.sandbox.spec?.podTemplate?.spec?.containers?.[1]?.image).toBe('runtime:newer')
  })

  it.each([
    ['missing pool template reference', async () => ({ spec: {} }), /has no sandboxTemplateRef\.name/],
    [
      'empty pool template reference',
      async () => ({ spec: { sandboxTemplateRef: { name: ' ' } } }),
      /has no sandboxTemplateRef\.name/
    ],
    [
      'non-canonical pool template reference',
      async () => ({ spec: { sandboxTemplateRef: { name: ' runtime-template ' } } }),
      /has invalid sandboxTemplateRef\.name/
    ]
  ])('blocks resume for %s', async (_label, pool, expected) => {
    const { api } = fakeApi({ mode: 'Suspended' })
    api.getWarmPool.mockImplementation(pool)
    const { instance } = driver(api)
    await instance.ensureSandbox('agent-a')
    await expect(instance.wake('agent-a')).rejects.toThrow(expected)
  })

  it('blocks resume when the sandbox has no runtime container', async () => {
    const { api, state } = fakeApi({ mode: 'Suspended' })
    state.sandbox.spec!.podTemplate!.spec!.containers = [{ name: 'sidecar', image: 'sidecar:1' }]
    const { instance } = driver(api)
    await instance.ensureSandbox('agent-a')
    await expect(instance.wake('agent-a')).rejects.toThrow(/sandbox sb-1 has no runtime container/)
  })

  it('blocks resume when the sandbox has duplicate runtime containers', async () => {
    const { api, state } = fakeApi({ mode: 'Suspended' })
    state.sandbox.spec!.podTemplate!.spec!.containers!.push({ name: 'runtime', image: 'runtime:duplicate' })
    const { instance } = driver(api)
    await instance.ensureSandbox('agent-a')
    await expect(instance.wake('agent-a')).rejects.toThrow(/sandbox sb-1 has multiple runtime containers/)
  })

  it.each([
    [[], /runtime container has no image/],
    [[{ name: 'runtime', image: ' ' }], /runtime container has no image/],
    [[{ name: 'runtime', image: ' runtime:new ' }], /runtime container has invalid image/],
    [
      [
        { name: 'runtime', image: 'runtime:new' },
        { name: 'runtime', image: 'runtime:duplicate' }
      ],
      /multiple runtime containers/
    ]
  ])('blocks resume for an invalid template runtime container %#', async (containers, expected) => {
    const { api } = fakeApi({ mode: 'Suspended' })
    api.getSandboxTemplate.mockResolvedValue({ spec: { podTemplate: { spec: { containers } } } })
    const { instance } = driver(api)
    await instance.ensureSandbox('agent-a')
    await expect(instance.wake('agent-a')).rejects.toThrow(expected)
  })

  it('blocks resume when the sandbox runtime image is non-canonical', async () => {
    const { api, state } = fakeApi({ mode: 'Suspended' })
    state.sandbox.spec!.podTemplate!.spec!.containers![1]!.image = ' runtime:old '
    const { instance } = driver(api)
    await instance.ensureSandbox('agent-a')
    await expect(instance.wake('agent-a')).rejects.toThrow(/sandbox sb-1 runtime container has invalid image/)
  })

  it.each([
    ['warm pool', 'getWarmPool', 404, 'NotFound'],
    ['warm pool', 'getWarmPool', 403, 'Forbidden'],
    ['template', 'getSandboxTemplate', 404, 'NotFound'],
    ['template', 'getSandboxTemplate', 403, 'Forbidden']
  ] as const)('fails closed when the %s read returns %s', async (_resource, method, status, reason) => {
    const { api, state } = fakeApi({ mode: 'Suspended' })
    api[method].mockRejectedValue(new K8sApiError(status, reason, `${reason} read`))
    const { instance } = driver(api)
    await instance.ensureSandbox('agent-a')
    const error = await instance.wake('agent-a').catch((err: unknown) => err)
    expect(error).toBeInstanceOf(K8sApiError)
    expect((error as K8sApiError).status).toBe(status)
    expect(state.resumeWrites).toEqual([])
  })

  it('stops after five guarded resume rejections and retains the Kubernetes cause', async () => {
    const { api, state } = fakeApi({ mode: 'Suspended' })
    let revision = 0
    state.beforeResume = () => {
      revision += 1
      const runtime = state.sandbox.spec?.podTemplate?.spec?.containers?.find(
        (container) => container.name === 'runtime'
      )
      if (runtime) runtime.image = `runtime:raced-${revision}`
    }
    const { instance, infos } = driver(api)
    await instance.ensureSandbox('agent-a')

    const error = await instance.wake('agent-a').catch((err: unknown) => err)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toMatch(/guarded mode\/image resume was rejected after 5 attempts/)
    expect((error as Error & { cause?: unknown }).cause).toBeInstanceOf(K8sApiError)
    expect(state.resumeWrites).toHaveLength(5)
    expect(infos.filter((message) => message.includes('runtime image'))).toEqual([])
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
    expect(state.resumeWrites).toHaveLength(1)
    expect(state.sandbox.spec?.operatingMode).toBe('Running')
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
    expect(state.modeWrites.map((write) => write.desired)).toEqual(['Suspended'])
    expect(state.resumeWrites).toHaveLength(1)
    expect(records.map((record) => record.generation)).toEqual([1, 2])
    expect(instance.sessionFor('agent-a')?.isAttached()).toBe(true)
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
    expect(state.modeWrites.map((write) => write.desired)).toEqual(['Suspended'])
    expect(state.resumeWrites).toHaveLength(1)
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

  it('keeps the last reported workspace root across a channel loss and an idle suspension', async () => {
    // Pinned as it stands, not as it ought to be: neither path clears the root, because the next
    // bind overwrites it (or deletes it when the replacement shim reports none). Callers read it
    // only after a bind, so the staleness is unobservable — but it is deliberate, not incidental.
    const { api } = fakeApi()
    let root: string | undefined = '/agent'
    let generation = 0
    const { instance } = driver(api, {
      connectChannel: async () => stubConnection(++generation, root)
    })
    await instance.ensureBoundChannel('agent-a')
    expect(instance.workspaceRootFor('agent-a')).toBe('/agent')

    instance.onChannelLost('agent-a', 'pod deleted')
    expect(instance.sessionFor('agent-a')).toBeUndefined()
    expect(instance.workspaceRootFor('agent-a')).toBe('/agent')

    await instance.ensureBoundChannel('agent-a')
    expect(await instance.suspendIfIdle('agent-a')).toBe('suspended')
    expect(instance.workspaceRootFor('agent-a')).toBe('/agent')

    // Only the next bind moves it, and a shim reporting none takes it away.
    root = undefined
    await instance.ensureBoundChannel('agent-a')
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

  /** A connection whose pod side answers every shim/request, recording the order it served them. */
  function answeringConnection(served: Array<{ capability: string; payload: unknown }>, refuse?: string) {
    const listeners: Array<(text: string) => void> = []
    return {
      binding: { agentId: 'agent-a', generation: 1, grants: ['acp'], podName: 'p', podUid: 'u' },
      issuedCredential: 'cred',
      send: (frame: { type: string; id: string; capability?: string; payload?: unknown }) => {
        if (frame.type !== 'shim/request') return
        served.push({ capability: frame.capability!, payload: frame.payload })
        const reply =
          refuse && frame.capability === refuse
            ? { type: 'shim/response', id: frame.id, ok: false, error: 'sink refused' }
            : { type: 'shim/response', id: frame.id, ok: true, payload: { streamId: 's-1' } }
        for (const listener of listeners) listener(JSON.stringify(reply))
      },
      onFrame: (listener: (text: string) => void) => listeners.push(listener),
      close: () => {}
    } as unknown as ShimConnection
  }

  it('materializes the launch files in the pod before opening the runtime', async () => {
    const served: Array<{ capability: string; payload: unknown }> = []
    const { api } = fakeApi()
    const { instance } = driver(api, { connectChannel: async () => answeringConnection(served) })
    const files = [{ root: '/run/agentconnect/git', relPath: ['agent-a.gitconfig'], content: '[credential]\n' }]
    await instance.launch({ ...(launchRequest as object), files } as never)
    expect(served.map((request) => request.capability)).toEqual(['materialize', 'acp'])
    expect(served[0]!.payload).toEqual({
      op: 'write',
      root: '/run/agentconnect/git',
      relPath: ['agent-a.gitconfig'],
      content: '[credential]\n'
    })
  })

  it('fails the launch when a file cannot be materialized, releasing the hold', async () => {
    const served: Array<{ capability: string; payload: unknown }> = []
    const { api } = fakeApi()
    const { instance } = driver(api, { connectChannel: async () => answeringConnection(served, 'materialize') })
    const files = [{ root: '/run/agentconnect/git', relPath: ['agent-a.gitconfig'], content: 'x' }]
    await expect(instance.launch({ ...(launchRequest as object), files } as never)).rejects.toThrow(/sink refused/)
    // Fail-closed: the runtime was never asked to open against env pointing at a file that is not there.
    expect(served.map((request) => request.capability)).toEqual(['materialize'])
  })
})

/**
 * The pool moves an agent between members on every rollout while its sandbox pod stays up, and
 * that pod's shim refuses any generation below the highest it has ever bound. A per-process
 * counter therefore breaks the successor permanently: it dials 1 against a pod already bound at
 * 2, is closed with `stale generation`, and every turn ends in a launch timeout until the pod is
 * recycled. The sequence has to come from state the members share.
 */
describe('cluster launch generations', () => {
  function storeFile(): string {
    return join(mkdtempSync(join(tmpdir(), 'ac-generations-')), 'state.db')
  }

  it('continues the sequence when a successor member takes an agent over', async () => {
    const store = await LocalStore.open(storeFile())
    const { api } = fakeApi()
    const memberA = driver(api, { generations: store })
    expect((await memberA.instance.ensureSandbox('agent-a')).generation).toBe(1)
    // A dial that timed out forgets the launch, so the same member re-claims at a fresh generation.
    memberA.instance.forgetLaunch('agent-a')
    expect((await memberA.instance.ensureSandbox('agent-a')).generation).toBe(2)
    // The rollout: a different member process, the same sandbox pod, the same shared store.
    const memberB = driver(api, { generations: store })
    expect((await memberB.instance.ensureSandbox('agent-a')).generation).toBe(3)
    await store.close()
  })

  it('resumes the sequence from the store after the member process restarts', async () => {
    const path = storeFile()
    const first = await LocalStore.open(path)
    const before = driver(fakeApi().api, { generations: first })
    expect((await before.instance.ensureSandbox('agent-a')).generation).toBe(1)
    await first.close()
    const reopened = await LocalStore.open(path)
    const after = driver(fakeApi().api, { generations: reopened })
    expect((await after.instance.ensureSandbox('agent-a')).generation).toBe(2)
    await reopened.close()
  })

  it('counts each agent independently, so churn on one pod does not skip generations on another', async () => {
    const store = await LocalStore.open(storeFile())
    const { api } = fakeApi()
    const { instance } = driver(api, { generations: store })
    expect((await instance.ensureSandbox('agent-a')).generation).toBe(1)
    instance.forgetLaunch('agent-a')
    expect((await instance.ensureSandbox('agent-a')).generation).toBe(2)
    expect((await instance.ensureSandbox('agent-b')).generation).toBe(1)
    await store.close()
  })

  it('does not consume a generation when the cached launch answers', async () => {
    const store = await LocalStore.open(storeFile())
    const { api } = fakeApi()
    const { instance } = driver(api, { generations: store })
    await instance.ensureSandbox('agent-a')
    // Re-attach, not re-launch: the shim binding registry treats an equal generation from the
    // same pod as a reconnect, and burning a number here would fence out the live channel.
    expect((await instance.ensureSandbox('agent-a')).generation).toBe(1)
    expect(await store.nextSandboxGeneration('agent-a')).toBe(2)
    await store.close()
  })
})
