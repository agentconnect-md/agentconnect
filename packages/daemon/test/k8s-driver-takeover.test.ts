import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeClock } from '@agentconnect.md/connection'
import { K8sHttp } from '@agentconnect.md/k8s-client'
import { closeFakeApiServers, fakeApiServer } from '@agentconnect.md/k8s-client/testing'
import { K8sDriver } from '../src/k8s/driver.js'
import { SandboxApi } from '../src/k8s/sandbox-api.js'
import { LocalStore } from '../src/store/local-store.js'
import type { SpawnRecord } from '../src/shim/binding.js'
import type { ShimConnection } from '../src/shim/connection.js'

/**
 * Two pool members, one shared store, one cluster: what a member may do to an agent's sandbox is
 * scoped to WHILE it serves that agent. An ex-holder forgets the launch when the duty leaves and
 * never suspends the pod its successor is using; the successor re-derives the launch from the
 * cluster on takeover, so a Running pod always has exactly one member that owns its idleness.
 */

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
    modeWrites: [] as string[]
  }
  const sandbox = () => ({
    metadata: { name: 'sb-1', uid: 'sandbox-uid-1' },
    spec: {
      operatingMode: state.mode,
      podTemplate: { spec: { containers: [{ name: 'runtime', image: 'runtime:1' }] } }
    },
    status: { conditions: [{ type: 'Ready', status: 'True' }], podIPs: ['10.0.0.8'] }
  })
  const { config } = await fakeApiServer(({ method, url, body }) => {
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
        // Both the mode write and the guarded resume test the mode first, then replace it.
        const ops = JSON.parse(body) as Array<{ op: string; path: string; value: unknown }>
        const test = ops.find((op) => op.op === 'test' && op.path === '/spec/operatingMode')
        if (test && test.value !== state.mode) return { status: 422, json: { kind: 'Status', reason: 'Invalid' } }
        const replace = ops.find((op) => op.op === 'replace' && op.path === '/spec/operatingMode')
        if (replace) {
          state.mode = replace.value as 'Running' | 'Suspended'
          state.modeWrites.push(state.mode)
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
