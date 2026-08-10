import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { ShimBindingRegistry, type SpawnRecord } from '../src/shim/binding.js'
import { ShimListener, type PodIdentityVerifier } from '../src/shim/listener.js'
import { ShimClient, type ShimTransport } from '../src/shim/client.js'
import {
  SHIM_SUBPROTOCOL,
  SHIM_TOKEN_AUDIENCE,
  SHIM_WS_PATH,
  parseShimFrame,
  type ShimBound,
  type ShimFrame
} from '../src/shim/protocol.js'

/** The five security invariants of the shim channel, each with the negative case that
 *  would pass if its enforcement were removed:
 *   1. mutual authentication — an unverifiable token binds nothing;
 *   2. binding identity — only a pod this daemon launched can bind;
 *   3. per-operation capability — a granted channel is not a blanket permission;
 *   4. replay fence — a frame from a previous pod generation is refused;
 *   5. no long-lived credential — what the shim holds is short-lived and re-obtained. */

const listeners: ShimListener[] = []
const sockets: WebSocket[] = []

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close()
  await Promise.all(listeners.splice(0).map((listener) => listener.stop()))
})

function record(overrides: Partial<SpawnRecord> = {}): SpawnRecord {
  return { agentId: 'agent-a', sandboxUid: 'sandbox-uid-1', generation: 3, grants: ['materialize'], ...overrides }
}

function verifier(result: Awaited<ReturnType<PodIdentityVerifier['reviewToken']>>): PodIdentityVerifier {
  return { reviewToken: vi.fn(async () => result) }
}

async function listener(deps: {
  verifier: PodIdentityVerifier
  spawnRecordForPod?: (pod: { name: string; uid: string }) => SpawnRecord | undefined
  now?: () => number
  credentialTtlMs?: number
}): Promise<{ instance: ShimListener; endpoint: string }> {
  const instance = new ShimListener({
    verifier: deps.verifier,
    spawnRecordForPod: deps.spawnRecordForPod ?? (() => record()),
    now: deps.now ?? (() => Date.now()),
    ...(deps.credentialTtlMs !== undefined ? { credentialTtlMs: deps.credentialTtlMs } : {}),
    log: { info: () => {}, warn: () => {} }
  })
  listeners.push(instance)
  const port = await instance.start(0, '127.0.0.1')
  return { instance, endpoint: `ws://127.0.0.1:${port}` }
}

/** Raw client: sends exactly what a test dictates, including out-of-protocol frames. */
async function rawConnect(endpoint: string): Promise<{
  socket: WebSocket
  frames: ShimFrame[]
  closed: Promise<{ code: number; reason: string }>
  send: (frame: unknown) => void
}> {
  const socket = new WebSocket(`${endpoint}${SHIM_WS_PATH}`, [SHIM_SUBPROTOCOL])
  sockets.push(socket)
  const frames: ShimFrame[] = []
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    socket.on('close', (code, reason) => resolve({ code, reason: reason.toString() }))
  )
  socket.on('message', (data) => {
    const frame = parseShimFrame(data.toString())
    if (frame) frames.push(frame)
  })
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  return { socket, frames, closed, send: (frame) => socket.send(JSON.stringify(frame)) }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition not met in time')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('shim handshake', () => {
  it('binds a pod whose token verifies against a spawn record, and issues only then', async () => {
    const review = verifier({ authenticated: true, podName: 'runtime-abc', podUid: 'pod-uid-1' })
    const { endpoint } = await listener({ verifier: review })
    const client = await rawConnect(endpoint)
    client.send({ type: 'shim/hello', token: 'projected-token' })
    await waitFor(() => client.frames.length > 0)
    const bound = client.frames[0] as ShimBound
    expect(bound.type).toBe('shim/bound')
    expect(bound.agentId).toBe('agent-a')
    expect(bound.generation).toBe(3)
    expect(bound.grants).toEqual(['materialize'])
    expect(bound.sessionCredential).toMatch(/^[\w-]{20,}$/)
    // The audience is what makes handing over the pod's own token safe: a token minted
    // for anything else must not authenticate here.
    expect(review.reviewToken).toHaveBeenCalledWith('projected-token', [SHIM_TOKEN_AUDIENCE])
  })

  it('rejects an unauthenticated token without binding anything (invariant 1)', async () => {
    const { endpoint } = await listener({
      verifier: verifier({ authenticated: false, error: 'audiences is not valid for this token' })
    })
    const client = await rawConnect(endpoint)
    client.send({ type: 'shim/hello', token: 'wrong-audience' })
    await waitFor(() => client.frames.length > 0)
    expect(client.frames[0]).toMatchObject({ type: 'shim/rejected', reason: 'unauthenticated' })
    const { code } = await client.closed
    expect(code).toBe(4403)
  })

  it('rejects an authenticated pod this daemon did not launch (invariant 2)', async () => {
    // A sibling sandbox in the same org: its token is genuine and the namespace lets it
    // reach this port, but no spawn record matches, so it binds to nothing.
    const { endpoint } = await listener({
      verifier: verifier({ authenticated: true, podName: 'someone-elses-pod', podUid: 'pod-uid-9' }),
      spawnRecordForPod: (pod) => (pod.uid === 'pod-uid-1' ? record() : undefined)
    })
    const client = await rawConnect(endpoint)
    client.send({ type: 'shim/hello', token: 'genuine-but-unrelated' })
    await waitFor(() => client.frames.length > 0)
    expect(client.frames[0]).toMatchObject({ type: 'shim/rejected', reason: 'unknown_pod' })
  })

  it('gives the same coarse rejection shape for both failures, so it cannot be probed', async () => {
    const unauthenticated = await listener({ verifier: verifier({ authenticated: false }) })
    const unknownPod = await listener({
      verifier: verifier({ authenticated: true, podName: 'p', podUid: 'u' }),
      spawnRecordForPod: () => undefined
    })
    for (const target of [unauthenticated, unknownPod]) {
      const client = await rawConnect(target.endpoint)
      client.send({ type: 'shim/hello', token: 't' })
      await waitFor(() => client.frames.length > 0)
      const frame = client.frames[0] as { type: string; message: string }
      expect(frame.type).toBe('shim/rejected')
      // The reason distinguishes them for our own logs, but the message never names a
      // pod, a token, or which check ran.
      expect(frame.message).not.toMatch(/pod-uid|token-|agent-a/)
    }
  })

  it('refuses an upgrade that does not offer the shim subprotocol', async () => {
    const { endpoint } = await listener({ verifier: verifier({ authenticated: true, podName: 'p', podUid: 'u' }) })
    const socket = new WebSocket(`${endpoint}${SHIM_WS_PATH}`)
    sockets.push(socket)
    await expect(
      new Promise<void>((resolve, reject) => {
        socket.once('open', () => resolve())
        socket.once('error', reject)
      })
    ).rejects.toThrow()
  })

  it('closes on a request arriving before a binding exists', async () => {
    const { endpoint } = await listener({ verifier: verifier({ authenticated: true, podName: 'p', podUid: 'u' }) })
    const client = await rawConnect(endpoint)
    client.send({
      type: 'shim/request',
      id: '11111111-1111-4111-8111-111111111111',
      sessionCredential: 'guessed',
      generation: 3,
      capability: 'materialize',
      payload: {}
    })
    const { code } = await client.closed
    expect(code).toBe(4403)
  })

  it('closes on a malformed frame rather than tolerating it', async () => {
    const { endpoint } = await listener({ verifier: verifier({ authenticated: true, podName: 'p', podUid: 'u' }) })
    const client = await rawConnect(endpoint)
    client.socket.send('{not json')
    const { code } = await client.closed
    expect(code).toBe(4400)
  })

  it('re-binds a rebuilt pod and drops the previous credential (invariants 4, 5)', async () => {
    // Resume, first bind and eviction are indistinguishable to the protocol: each new pod
    // presents its own token. What must not survive is the old pod's credential.
    let generation = 3
    const { instance, endpoint } = await listener({
      verifier: verifier({ authenticated: true, podName: 'runtime-abc', podUid: 'pod-uid-1' }),
      spawnRecordForPod: () => record({ generation })
    })
    const first = await rawConnect(endpoint)
    first.send({ type: 'shim/hello', token: 't' })
    await waitFor(() => first.frames.length > 0)
    const before = first.frames[0] as ShimBound

    generation = 4
    const second = await rawConnect(endpoint)
    second.send({ type: 'shim/hello', token: 't' })
    await waitFor(() => second.frames.length > 0)
    const after = second.frames[0] as ShimBound

    expect(after.generation).toBe(4)
    expect(after.sessionCredential).not.toBe(before.sessionCredential)
    // The superseded credential authorizes nothing, so a frame replayed from the previous
    // incarnation cannot act.
    expect(
      instance.authorize({ credential: before.sessionCredential, generation: 3, capability: 'materialize' })
    ).toEqual({ ok: false, failure: 'unknown_credential' })
  })
})

describe('shim binding registry', () => {
  const clock = { value: 1_000 }
  const registry = (): ShimBindingRegistry => new ShimBindingRegistry(() => clock.value, 60_000)

  it('refuses a stale generation even with a live credential (invariant 4)', () => {
    const bindings = registry()
    const { credential } = bindings.bind(record({ generation: 7 }), { name: 'p', uid: 'u' })
    expect(bindings.authorize({ credential, generation: 7, capability: 'materialize' }).ok).toBe(true)
    expect(bindings.authorize({ credential, generation: 6, capability: 'materialize' })).toEqual({
      ok: false,
      failure: 'stale_generation'
    })
  })

  it('refuses a capability the launch was not granted (invariant 3)', () => {
    const bindings = registry()
    const { credential } = bindings.bind(record({ grants: ['materialize'] }), { name: 'p', uid: 'u' })
    // Holding the channel is not holding every operation on it: one runtime must not be
    // able to reach a capability its own launch never received.
    expect(bindings.authorize({ credential, generation: 3, capability: 'exec' })).toEqual({
      ok: false,
      failure: 'capability_not_granted'
    })
    expect(bindings.authorize({ credential, generation: 3, capability: 'tunnel' })).toEqual({
      ok: false,
      failure: 'capability_not_granted'
    })
  })

  it('expires a credential rather than honouring it indefinitely (invariant 5)', () => {
    clock.value = 1_000
    const bindings = registry()
    const { credential } = bindings.bind(record(), { name: 'p', uid: 'u' })
    clock.value = 61_001
    expect(bindings.authorize({ credential, generation: 3, capability: 'materialize' })).toEqual({
      ok: false,
      failure: 'expired_credential'
    })
    // And it is dropped, so a later clock rewind cannot revive it.
    clock.value = 1_000
    expect(bindings.authorize({ credential, generation: 3, capability: 'materialize' }).ok).toBe(false)
  })

  it('does not leak one agent credential to another agent (invariant 3)', () => {
    const bindings = registry()
    clock.value = 1_000
    const a = bindings.bind(record({ agentId: 'agent-a' }), { name: 'pa', uid: 'ua' })
    const b = bindings.bind(record({ agentId: 'agent-b', grants: ['exec'] }), { name: 'pb', uid: 'ub' })
    expect(bindings.authorize({ credential: a.credential, generation: 3, capability: 'exec' }).ok).toBe(false)
    const resolved = bindings.authorize({ credential: b.credential, generation: 3, capability: 'exec' })
    expect(resolved.ok && resolved.binding.agentId).toBe('agent-b')
  })

  it('revokes by agent across pod incarnations', () => {
    const bindings = registry()
    clock.value = 1_000
    const first = bindings.bind(record(), { name: 'p1', uid: 'u1' })
    const second = bindings.bind(record({ generation: 4 }), { name: 'p2', uid: 'u2' })
    bindings.revokeAgent('agent-a')
    expect(bindings.size()).toBe(0)
    expect(bindings.authorize({ credential: first.credential, generation: 3, capability: 'materialize' }).ok).toBe(
      false
    )
    expect(bindings.authorize({ credential: second.credential, generation: 4, capability: 'materialize' }).ok).toBe(
      false
    )
  })
})

describe('shim client', () => {
  it('presents the projected token and reports the binding it was issued', async () => {
    const sent: unknown[] = []
    let onMessage: ((text: string) => void) | undefined
    const transport: ShimTransport = {
      send: (text) => sent.push(JSON.parse(text)),
      onMessage: (cb) => (onMessage = cb),
      onClose: () => {},
      close: () => {}
    }
    const client = new ShimClient({
      endpoint: 'ws://daemon:9000',
      dial: async () => transport,
      readToken: () => 'rotating-token',
      log: { info: () => {}, warn: () => {} }
    })
    const started = client.start()
    await waitFor(() => sent.length > 0)
    expect(sent[0]).toEqual({ type: 'shim/hello', token: 'rotating-token' })
    onMessage?.(
      JSON.stringify({
        type: 'shim/bound',
        sessionCredential: 'cred-1',
        expiresInSeconds: 600,
        agentId: 'agent-a',
        generation: 3,
        grants: ['materialize']
      })
    )
    const bound = await started
    expect(bound.agentId).toBe('agent-a')
    expect(client.binding()?.sessionCredential).toBe('cred-1')
  })

  it('refuses to serve a request whose credential or generation is not its own', async () => {
    const sent: any[] = []
    let onMessage: ((text: string) => void) | undefined
    const transport: ShimTransport = {
      send: (text) => sent.push(JSON.parse(text)),
      onMessage: (cb) => (onMessage = cb),
      onClose: () => {},
      close: () => {}
    }
    const handle = vi.fn(async () => 'executed')
    const client = new ShimClient({
      endpoint: 'ws://daemon:9000',
      dial: async () => transport,
      readToken: () => 't',
      handle,
      log: { info: () => {}, warn: () => {} }
    })
    const started = client.start()
    await waitFor(() => sent.length > 0)
    onMessage?.(
      JSON.stringify({
        type: 'shim/bound',
        sessionCredential: 'cred-1',
        expiresInSeconds: 600,
        agentId: 'agent-a',
        generation: 3,
        grants: ['materialize']
      })
    )
    await started

    const request = (overrides: Record<string, unknown>) =>
      onMessage?.(
        JSON.stringify({
          type: 'shim/request',
          id: '22222222-2222-4222-8222-222222222222',
          sessionCredential: 'cred-1',
          generation: 3,
          capability: 'materialize',
          payload: {},
          ...overrides
        })
      )

    request({ sessionCredential: 'stolen' })
    await waitFor(() => sent.length > 1)
    expect(sent.at(-1)).toMatchObject({ ok: false, error: 'not bound' })

    request({ generation: 2 })
    await waitFor(() => sent.length > 2)
    expect(sent.at(-1)).toMatchObject({ ok: false, error: 'not bound' })

    request({ capability: 'exec' })
    await waitFor(() => sent.length > 3)
    expect(sent.at(-1)).toMatchObject({ ok: false, error: 'not granted' })
    // None of the three reached the handler: the shim re-checks rather than trusting that
    // the daemon already did, so a compromised daemon-side path is not the only gate.
    expect(handle).not.toHaveBeenCalled()

    request({})
    await waitFor(() => sent.length > 4)
    expect(sent.at(-1)).toMatchObject({ ok: true, payload: 'executed' })
    client.stop()
  })
})
