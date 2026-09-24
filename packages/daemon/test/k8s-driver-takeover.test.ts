import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeClock } from '@agentconnect.md/connection'
import { K8sHttp } from '@agentconnect.md/k8s-client'
import { closeFakeApiServers, fakeApiServer } from '@agentconnect.md/k8s-client/testing'
import { K8sDriver } from '../src/k8s/driver.js'
import { SANDBOX_LAUNCH_GENERATION, SandboxApi } from '../src/k8s/sandbox-api.js'
import { LocalStore } from '../src/store/local-store.js'
import type { SpawnRecord } from '../src/shim/binding.js'
import type { ShimConnection } from '../src/shim/connection.js'

// Two members share a store and cluster; only the current holder may suspend the Sandbox.

const AGENT = 'agent-a'
const CLAIM = `agent-${AGENT}`

afterEach(async () => {
  await closeFakeApiServers()
})

/** An in-process API server holding one claim and one Sandbox whose mode a JSON Patch moves. */
async function cluster() {
  const state = {
    claim: undefined as Record<string, unknown> | undefined,
    mode: 'Running' as 'Running' | 'Suspended',
    ready: true,
    modeWrites: [] as string[],
    resourceVersion: 1,
    annotations: {} as Record<string, string>
  }
  const sandbox = () => ({
    metadata: {
      name: 'sb-1',
      uid: 'sandbox-uid-1',
      resourceVersion: String(state.resourceVersion),
      annotations: { ...state.annotations }
    },
    spec: {
      operatingMode: state.mode,
      podTemplate: { spec: { containers: [{ name: 'runtime', image: 'runtime:1' }] } }
    },
    status: { conditions: [{ type: 'Ready', status: state.ready ? 'True' : 'False' }], podIPs: ['10.0.0.8'] }
  })
  const { config } = await fakeApiServer(({ method, url, body, headers }) => {
    const path = url.pathname
    if (path.endsWith('/sandboxclaims') && method === 'POST') {
      if (state.claim) return { status: 409, json: { kind: 'Status', reason: 'AlreadyExists' } }
      state.claim = { metadata: { name: CLAIM, uid: 'claim-uid-1' }, status: { sandbox: { name: 'sb-1' } } }
      return { json: state.claim }
    }
    if (path.endsWith(`/sandboxclaims/${CLAIM}`)) {
      if (method === 'DELETE') {
        state.claim = undefined
        return { json: {} }
      }
      if (!state.claim) return { status: 404, json: { kind: 'Status', reason: 'NotFound' } }
      return { json: state.claim }
    }
    if (path.endsWith('/sandboxwarmpools/pool')) return { json: { spec: { sandboxTemplateRef: { name: 'tpl' } } } }
    if (path.endsWith('/sandboxtemplates/tpl')) {
      return { json: { spec: { podTemplate: { spec: { containers: [{ name: 'runtime', image: 'runtime:1' }] } } } } }
    }
    if (path.endsWith('/sandboxes/sb-1')) {
      if (method === 'PATCH') {
        if (headers['content-type'] === 'application/merge-patch+json') {
          const patch = JSON.parse(body) as {
            metadata: { resourceVersion: string; annotations: Record<string, string> }
          }
          if (patch.metadata.resourceVersion !== String(state.resourceVersion)) {
            return { status: 409, json: { kind: 'Status', reason: 'Conflict' } }
          }
          Object.assign(state.annotations, patch.metadata.annotations)
          state.resourceVersion++
          return { json: sandbox() }
        }
        const ops = JSON.parse(body) as Array<{ op: string; path: string; value: unknown }>
        const values: Record<string, string | undefined> = {
          '/metadata/uid': 'sandbox-uid-1',
          '/metadata/annotations/agentconnect.md~1launch-generation': state.annotations[SANDBOX_LAUNCH_GENERATION],
          '/spec/operatingMode': state.mode,
          '/spec/podTemplate/spec/containers/0/name': 'runtime',
          '/spec/podTemplate/spec/containers/0/image': 'runtime:1'
        }
        if (ops.some((op) => op.op === 'test' && values[op.path] !== op.value)) {
          return { status: 422, json: { kind: 'Status', reason: 'Invalid' } }
        }
        const replace = ops.find((op) => op.op === 'replace' && op.path === '/spec/operatingMode')
        if (replace) {
          state.mode = replace.value as 'Running' | 'Suspended'
          state.modeWrites.push(state.mode)
          state.resourceVersion++
        }
      }
      return { json: sandbox() }
    }
    return { status: 404, json: { kind: 'Status', reason: 'NotFound' } }
  })
  const api = new SandboxApi(new K8sHttp(config), 'agent-sandboxes')
  return { api, state }
}

function stubConnection(record: SpawnRecord): ShimConnection {
  return {
    binding: {
      agentId: record.agentId,
      generation: record.generation,
      grants: record.grants,
      podName: 'p',
      podUid: 'u'
    },
    issuedCredential: 'cred',
    send: () => {},
    onFrame: () => {},
    close: () => {}
  } as unknown as ShimConnection
}

function member(api: SandboxApi, store: LocalStore, clock: FakeClock) {
  const dialed: SpawnRecord[] = []
  const revoked: string[] = []
  const driver = new K8sDriver({
    api,
    orgForAgent: () => 'org-1',
    warmPoolName: 'pool',
    generations: store,
    clock,
    connectChannel: async (record) => {
      dialed.push(record)
      return stubConnection(record)
    },
    revokeChannel: (agentId) => revoked.push(agentId),
    log: { info: () => {}, warn: () => {}, debug: () => {} }
  })
  return { driver, dialed, revoked }
}

async function sharedStore(): Promise<LocalStore> {
  return await LocalStore.open(join(mkdtempSync(join(tmpdir(), 'ac-takeover-')), 'state.db'))
}

describe('sandbox launches follow the duty', () => {
  it.each(['before', 'after'] as const)(
    'keeps a disconnected pod reclaimable when acquisition fails %s fencing',
    async (failure) => {
      const { api, state } = await cluster()
      const store = await sharedStore()
      const { driver } = member(api, store, new FakeClock())
      await driver.ensureBoundChannel(AGENT)
      const candidates = driver.launched()
      driver.onChannelLost(AGENT, 'reconnect window elapsed')
      expect(driver.currentLaunch(AGENT)).toBeUndefined()
      expect(driver.sessionFor(AGENT)).toBeUndefined()
      expect(driver.launched()).toEqual(candidates)
      const fence = api.fenceSandbox.bind(api)
      vi.spyOn(api, 'fenceSandbox').mockImplementationOnce(async (...args) => {
        if (failure === 'after') await fence(...args)
        throw new Error('API unavailable')
      })
      await expect(driver.ensureSandbox(AGENT)).rejects.toThrow('API unavailable')
      expect(driver.launched()).toEqual(candidates)
      if (failure === 'after') expect(await driver.suspendIfIdle(AGENT)).toBe('absent')
      expect(await driver.suspendIfIdle(AGENT)).toBe('suspended')
      expect(state.mode).toBe('Suspended')
      expect(state.claim).toBeDefined()
      expect(driver.launched()).toEqual([])
      await store.close()
    }
  )

  it('rebinds a disconnected pod at a fresh generation before querying its watchers', async () => {
    const { api, state } = await cluster()
    const store = await sharedStore()
    const { driver, dialed } = member(api, store, new FakeClock())
    await driver.ensureBoundChannel(AGENT)
    driver.onChannelLost(AGENT, 'reconnect window elapsed')
    const ensure = vi.spyOn(api, 'ensureClaim')
    expect((await driver.bindLaunched(AGENT))?.isAttached()).toBe(true)
    expect(dialed.map((record) => record.generation)).toEqual([1, 2])
    expect(ensure).not.toHaveBeenCalled()
    expect(driver.launched()).toHaveLength(1)
    expect(state.modeWrites).toEqual([])
    expect(state.mode).toBe('Running')
    await store.close()
  })

  it('reclaims an unready disconnected pod after losing a successful fencing reply', async () => {
    const { api, state } = await cluster()
    const store = await sharedStore()
    const clock = new FakeClock()
    const { driver, dialed } = member(api, store, clock)
    await driver.ensureBoundChannel(AGENT)
    driver.onChannelLost(AGENT, 'reconnect window elapsed')
    state.ready = false
    const fence = api.fenceSandbox.bind(api)
    vi.spyOn(api, 'fenceSandbox').mockImplementationOnce(async (...args) => {
      await fence(...args)
      throw new Error('API unavailable')
    })
    await expect(driver.ensureSandbox(AGENT)).rejects.toThrow('API unavailable')
    clock.advance(driver.podUpTimeoutMs)
    expect(await driver.suspendIfStalled(AGENT)).toBe('absent')
    clock.advance(driver.podUpTimeoutMs)
    expect(await driver.suspendIfStalled(AGENT)).toBe('suspended')
    expect(state.mode).toBe('Suspended')
    expect(state.claim).toBeDefined()
    expect(driver.launched()).toEqual([])
    expect(dialed).toHaveLength(1)
    await store.close()
  })

  it.each(['read', 'write'] as const)('rejects an old suspension paused at the %s across takeover', async (pauseAt) => {
    const { api, state } = await cluster()
    const store = await sharedStore()
    const clock = new FakeClock()
    const a = member(api, store, clock)
    const b = member(api, store, clock)
    await a.driver.ensureBoundChannel(AGENT)
    let pause!: () => void
    const paused = new Promise<void>((resolve) => (pause = resolve))
    let resume!: () => void
    const resumed = new Promise<void>((resolve) => (resume = resolve))
    if (pauseAt === 'read') {
      const get = api.getSandbox.bind(api)
      vi.spyOn(api, 'getSandbox').mockImplementationOnce(async (...args) => {
        const snapshot = await get(...args)
        pause()
        await resumed
        return snapshot
      })
    } else {
      const set = api.setOperatingMode.bind(api)
      vi.spyOn(api, 'setOperatingMode').mockImplementationOnce(async (...args) => {
        pause()
        await resumed
        return await set(...args)
      })
    }
    const oldSuspension = a.driver.suspendIfIdle(AGENT)
    const rejected = expect(oldSuspension).rejects.toThrow(/left this member/)
    await paused
    a.driver.release(AGENT)
    await b.driver.adopt(AGENT)
    await b.driver.ensureBoundChannel(AGENT)
    resume()
    await rejected
    expect(state.mode).toBe('Running')
    expect(state.modeWrites).toEqual([])
    expect(b.driver.sessionFor(AGENT)?.isAttached()).toBe(true)
    await store.close()
  })

  it('shares launch publication across simultaneous acquisitions of the same pod', async () => {
    const { api } = await cluster()
    const store = await sharedStore()
    const { driver } = member(api, store, new FakeClock())
    const launches = await Promise.all([driver.ensureSandbox(AGENT), driver.ensureSandbox(AGENT)])
    expect(launches[0]).toBe(launches[1])
    expect(launches[0]!.generation).toBe(1)
    const release = driver.retainLaunched(AGENT)!
    expect(await driver.suspendIfIdle(AGENT)).toBe('busy')
    release()
    expect(await driver.suspendIfIdle(AGENT)).toBe('suspended')
    await store.close()
  })

  it('an ex-holder forgets its launch and cannot suspend the pod its successor serves', async () => {
    const { api, state } = await cluster()
    const store = await sharedStore()
    const clock = new FakeClock()
    const a = member(api, store, clock)
    const b = member(api, store, clock)
    await a.driver.ensureBoundChannel(AGENT)
    expect(a.driver.launched().map((l) => l.agentId)).toEqual([AGENT])
    expect(a.driver.sessionFor(AGENT)?.isAttached()).toBe(true)

    // The duty moves: A stops serving the agent, B takes it over from the cluster.
    a.driver.release(AGENT)
    expect(a.driver.launched()).toEqual([])
    expect(a.driver.sessionFor(AGENT)).toBeUndefined()
    expect(a.revoked).toEqual([AGENT])
    expect(await b.driver.adopt(AGENT)).toMatchObject({ sandboxName: 'sb-1', sandboxUid: 'sandbox-uid-1' })

    // A's idle sweep now has nothing to act on, however idle the agent looks from A.
    expect(await a.driver.suspendIfIdle(AGENT)).toBe('absent')
    expect(state.mode).toBe('Running')
    expect(state.modeWrites).toEqual([])
    await store.close()
  })

  it('the new holder re-derives the launch from the cluster and can suspend it when idle', async () => {
    const { api, state } = await cluster()
    const store = await sharedStore()
    const clock = new FakeClock()
    const a = member(api, store, clock)
    const b = member(api, store, clock)
    const bound = await a.driver.ensureSandbox(AGENT)
    a.driver.release(AGENT)

    clock.advance(5_000)
    const adopted = await b.driver.adopt(AGENT)
    // Nothing was created: the claim and its Sandbox are the ones A left behind.
    expect(adopted).toMatchObject({ sandboxName: bound.sandboxName, sandboxUid: bound.sandboxUid })
    // Idleness is anchored at the takeover, so the pod gets a full window from B's clock.
    expect(adopted?.since).toBe(clock.now())
    // The generation continues from the shared store, so B's later dial fences A's out.
    expect(adopted!.generation).toBeGreaterThan(bound.generation)
    expect(b.driver.launched()).toEqual([{ subject: AGENT, agentId: AGENT, since: clock.now() }])

    expect(await b.driver.suspendIfIdle(AGENT)).toBe('suspended')
    expect(state.mode).toBe('Suspended')
    expect(b.driver.launched()).toEqual([])
    await store.close()
  })

  it('takes over nothing for a suspended or unclaimed agent — the next turn claims as before', async () => {
    const { api, state } = await cluster()
    const store = await sharedStore()
    const clock = new FakeClock()
    const b = member(api, store, clock)
    expect(await b.driver.adopt(AGENT)).toBeUndefined()
    expect(b.driver.launched()).toEqual([])

    const a = member(api, store, clock)
    await a.driver.ensureSandbox(AGENT)
    expect(await a.driver.suspendIfIdle(AGENT)).toBe('suspended')
    a.driver.release(AGENT)
    expect(state.mode).toBe('Suspended')
    expect(await b.driver.adopt(AGENT)).toBeUndefined()
    // The ordinary launch path still resumes it.
    await b.driver.ensureBoundChannel(AGENT)
    expect(state.mode).toBe('Running')
    expect(b.dialed).toHaveLength(1)
    await store.close()
  })

  it('an acquisition in flight when the agent leaves records nothing', async () => {
    const { api } = await cluster()
    const store = await sharedStore()
    const clock = new FakeClock()
    const a = member(api, store, clock)
    const acquiring = a.driver.ensureSandbox(AGENT)
    a.driver.release(AGENT)
    await expect(acquiring).rejects.toThrow(/left this member/)
    expect(a.driver.launched()).toEqual([])
    await store.close()
  })

  it('a concurrent turn waits for the takeover rather than racing it', async () => {
    const { api } = await cluster()
    const store = await sharedStore()
    const clock = new FakeClock()
    const a = member(api, store, clock)
    await a.driver.ensureSandbox(AGENT)
    a.driver.release(AGENT)
    const b = member(api, store, clock)
    const [adopted, acquired] = await Promise.all([b.driver.adopt(AGENT), b.driver.ensureSandbox(AGENT)])
    expect(acquired).toBe(adopted)
    expect(b.driver.launched()).toHaveLength(1)
    await store.close()
  })

  it('a single member keeps its own launch across the same calls', async () => {
    const { api, state } = await cluster()
    const store = await sharedStore()
    const clock = new FakeClock()
    const a = member(api, store, clock)
    const launch = await a.driver.ensureSandbox(AGENT)
    expect(await a.driver.adopt(AGENT)).toBe(launch)
    expect(a.driver.launched()).toEqual([{ subject: AGENT, agentId: AGENT, since: launch.since }])
    expect(await a.driver.suspendIfIdle(AGENT)).toBe('suspended')
    expect(state.mode).toBe('Suspended')
    await store.close()
  })
})
