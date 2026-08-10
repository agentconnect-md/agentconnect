import { afterEach, describe, expect, it, vi } from 'vitest'
import { Backoff, ClientTransport, FakeClock } from '@agentconnect.md/connection'
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
  clock?: FakeClock
  credentialTtlMs?: number
}): Promise<{ instance: ShimListener; endpoint: string }> {
  const instance = new ShimListener({
    verifier: deps.verifier,
    spawnRecordForPod: deps.spawnRecordForPod ?? (() => record()),
    now: deps.now ?? (() => Date.now()),
    ...(deps.clock ? { clock: deps.clock } : {}),
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
    expect(client.frames[0]).toMatchObject({ type: 'shim/rejected' })
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
    // Same wire answer as an unauthenticated token, deliberately (see the probing test).
    expect(client.frames[0]).toMatchObject({ type: 'shim/rejected' })
  })

  it('gives the same coarse rejection shape for both failures, so it cannot be probed', async () => {
    const unauthenticated = await listener({ verifier: verifier({ authenticated: false }) })
    const unknownPod = await listener({
      verifier: verifier({ authenticated: true, podName: 'p', podUid: 'u' }),
      spawnRecordForPod: () => undefined
    })
    const seen: string[] = []
    for (const target of [unauthenticated, unknownPod]) {
      const client = await rawConnect(target.endpoint)
      client.send({ type: 'shim/hello', token: 't' })
      await waitFor(() => client.frames.length > 0)
      const frame = client.frames[0] as { type: string; reason: string; message: string }
      expect(frame.type).toBe('shim/rejected')
      seen.push(`${frame.reason}|${frame.message}`)
      expect(frame.message).not.toMatch(/pod-uid|token-|agent-a/)
    }
    // Byte-identical on the wire. Sending the precise reason would let a caller tell
    // "token not accepted" from "pod not recognized" and probe for launched pods.
    expect(new Set(seen).size).toBe(1)
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

  it('closes a second hello arriving while the first is still being reviewed', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const { endpoint } = await listener({
      verifier: {
        reviewToken: async () => {
          await gate
          return { authenticated: true, podName: 'p', podUid: 'u' }
        }
      }
    })
    const client = await rawConnect(endpoint)
    client.send({ type: 'shim/hello', token: 't' })
    // Without single-flight this would bind twice and leave a stale connection entry.
    client.send({ type: 'shim/hello', token: 't' })
    const { code } = await client.closed
    expect(code).toBe(4400)
    release()
  })

  it('closes the channel when the credential expires, so the peer cannot hold a dead one', async () => {
    const clock = new FakeClock()
    const { endpoint } = await listener({
      verifier: verifier({ authenticated: true, podName: 'p', podUid: 'u' }),
      now: () => clock.now(),
      clock,
      credentialTtlMs: 60_000
    })
    const client = await rawConnect(endpoint)
    client.send({ type: 'shim/hello', token: 't' })
    await waitFor(() => client.frames.length > 0)
    clock.advance(60_001)
    const { reason } = await client.closed
    expect(reason).toBe('credential expired')
  })

  it('refuses an older generation binding after a newer one, without disturbing it', async () => {
    // The overlap case: generation 4 has bound, then the terminating generation-3 pod
    // reconnects (or its slower TokenReview lands late). Replacing here would hand the
    // channel back to the sandbox that is going away.
    let generation = 4
    let podUid = 'pod-uid-new'
    const { instance, endpoint } = await listener({
      verifier: { reviewToken: async () => ({ authenticated: true, podName: 'p', podUid }) },
      spawnRecordForPod: () => record({ generation })
    })
    const newer = await rawConnect(endpoint)
    newer.send({ type: 'shim/hello', token: 't' })
    await waitFor(() => newer.frames.length > 0)
    const held = newer.frames[0] as ShimBound

    generation = 3
    podUid = 'pod-uid-old'
    const older = await rawConnect(endpoint)
    older.send({ type: 'shim/hello', token: 't' })
    await waitFor(() => older.frames.length > 0)
    expect(older.frames[0]).toMatchObject({ type: 'shim/rejected' })

    // Generation 4 is untouched: still the only connection, still authorized.
    expect(instance.connectionsFor('agent-a')).toHaveLength(1)
    expect(instance.connectionsFor('agent-a')[0]?.binding.generation).toBe(4)
    expect(
      instance.authorize({ credential: held.sessionCredential, generation: 4, capability: 'materialize' }).ok
    ).toBe(true)
  })

  it('issues nothing when the socket closes while its token review is in flight', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const clock = new FakeClock()
    const { instance, endpoint } = await listener({
      verifier: {
        reviewToken: async () => {
          await gate
          return { authenticated: true, podName: 'p', podUid: 'u' }
        }
      },
      now: () => clock.now(),
      clock
    })
    // A live binding for the same agent, which the late continuation must not supersede.
    const live = await rawConnect(endpoint)
    const abandoned = await rawConnect(endpoint)
    abandoned.send({ type: 'shim/hello', token: 't' })
    abandoned.socket.close()
    await abandoned.closed
    release()
    // Give the continuation a turn to run before asserting it did nothing.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(instance.connectionsFor('agent-a')).toHaveLength(0)

    // And the endpoint still works afterwards, so the guard did not wedge it.
    live.send({ type: 'shim/hello', token: 't' })
    await waitFor(() => live.frames.length > 0)
    expect(live.frames[0]).toMatchObject({ type: 'shim/bound' })
    expect(instance.connectionsFor('agent-a')).toHaveLength(1)
  })

  it('survives the superseded socket closing after a same-pod renewal has bound', async () => {
    // The teardown-ownership race: renewal stores credential B under the same pod UID, and
    // the superseded socket A closes afterwards. Revoking "whatever this pod holds" from
    // A's late close deleted B, so renewal looked successful and then silently died.
    const { instance, endpoint } = await listener({
      verifier: verifier({ authenticated: true, podName: 'runtime-abc', podUid: 'pod-uid-1' })
    })
    const first = await rawConnect(endpoint)
    first.send({ type: 'shim/hello', token: 't' })
    await waitFor(() => first.frames.length > 0)
    const a = first.frames[0] as ShimBound

    // Same pod, same generation: a credential rotation, not a relaunch.
    const second = await rawConnect(endpoint)
    second.send({ type: 'shim/hello', token: 't' })
    await waitFor(() => second.frames.length > 0)
    const b = second.frames[0] as ShimBound
    expect(b.sessionCredential).not.toBe(a.sessionCredential)
    await waitFor(
      () => instance.authorize({ credential: b.sessionCredential, generation: 3, capability: 'materialize' }).ok
    )

    // Now A finishes closing, after B is live.
    first.socket.close()
    await first.closed
    await new Promise((resolve) => setTimeout(resolve, 30))

    // B must still authorize, and be the one live channel.
    expect(instance.authorize({ credential: b.sessionCredential, generation: 3, capability: 'materialize' }).ok).toBe(
      true
    )
    expect(instance.authorize({ credential: a.sessionCredential, generation: 3, capability: 'materialize' }).ok).toBe(
      false
    )
    expect(instance.connectionsFor('agent-a')).toHaveLength(1)
    expect(instance.connectionsFor('agent-a')[0]?.issuedCredential).toBe(b.sessionCredential)
  })

  it('expiry of a superseded channel does not revoke the renewed credential', async () => {
    // Same ordering hazard through the expiry backstop rather than a socket close.
    const clock = new FakeClock()
    const { instance, endpoint } = await listener({
      verifier: verifier({ authenticated: true, podName: 'runtime-abc', podUid: 'pod-uid-1' }),
      now: () => clock.now(),
      clock,
      credentialTtlMs: 60_000
    })
    const first = await rawConnect(endpoint)
    first.send({ type: 'shim/hello', token: 't' })
    await waitFor(() => first.frames.length > 0)
    const a = first.frames[0] as ShimBound

    clock.advance(30_000)
    const second = await rawConnect(endpoint)
    second.send({ type: 'shim/hello', token: 't' })
    await waitFor(() => second.frames.length > 0)
    const b = second.frames[0] as ShimBound

    // A's expiry deadline comes due while B is live and nowhere near its own.
    clock.advance(30_001)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(instance.authorize({ credential: b.sessionCredential, generation: 3, capability: 'materialize' }).ok).toBe(
      true
    )
  })

  it('re-binds a rescheduled pod under a NEW uid and drops the previous credential (invariants 4, 5)', async () => {
    // Resume, first bind and eviction are indistinguishable to the protocol: each new pod
    // presents its own token. Crucially the replacement pod has a DIFFERENT uid — keying
    // supersession on the pod would leave the evicted incarnation's credential live, which
    // is exactly the replay the fence exists to stop.
    let generation = 3
    let podUid = 'pod-uid-1'
    const { instance, endpoint } = await listener({
      verifier: { reviewToken: async () => ({ authenticated: true, podName: `runtime-${podUid}`, podUid }) },
      spawnRecordForPod: () => record({ generation })
    })
    const first = await rawConnect(endpoint)
    first.send({ type: 'shim/hello', token: 't' })
    await waitFor(() => first.frames.length > 0)
    const before = first.frames[0] as ShimBound

    generation = 4
    podUid = 'pod-uid-2'
    const second = await rawConnect(endpoint)
    second.send({ type: 'shim/hello', token: 't' })
    await waitFor(() => second.frames.length > 0)
    const after = second.frames[0] as ShimBound

    expect(after.generation).toBe(4)
    expect(after.sessionCredential).not.toBe(before.sessionCredential)
    // The superseded credential authorizes nothing, so a frame replayed from the previous
    // incarnation cannot act — at its OWN generation, which is the case that matters.
    expect(
      instance.authorize({ credential: before.sessionCredential, generation: 3, capability: 'materialize' })
    ).toEqual({ ok: false, failure: 'unknown_credential' })
    // And the dead channel is gone rather than lingering as a bindable connection.
    await waitFor(() => instance.connectionsFor('agent-a').length === 1)
    expect(instance.connectionsFor('agent-a')[0]?.binding.podUid).toBe('pod-uid-2')
  })
})

/** bind() can refuse (a newer generation holds the channel); these cases expect success. */
function mustBind(
  bindings: ShimBindingRegistry,
  spawn: SpawnRecord,
  pod: { name: string; uid: string }
): { credential: string } {
  const result = bindings.bind(spawn, pod)
  if (!result.ok) throw new Error(`unexpected bind refusal: ${result.reason}`)
  return { credential: result.credential }
}

describe('shim binding registry', () => {
  const clock = { value: 1_000 }
  const registry = (): ShimBindingRegistry => new ShimBindingRegistry(() => clock.value, 60_000)

  it('rejects a lower generation instead of replacing the current binding', () => {
    clock.value = 1_000
    const bindings = registry()
    const newer = bindings.bind(record({ generation: 4 }), { name: 'p-new', uid: 'u-new' })
    const older = bindings.bind(record({ generation: 3 }), { name: 'p-old', uid: 'u-old' })
    expect(older).toEqual({ ok: false, reason: 'superseded_generation', current: 4 })
    // The newer binding is untouched — not merely "not replaced", but still authorized.
    expect(
      newer.ok && bindings.authorize({ credential: newer.credential, generation: 4, capability: 'materialize' }).ok
    ).toBe(true)
    expect(bindings.size()).toBe(1)
  })

  it('allows the same generation from the same pod: renewal and reconnect do not relaunch', () => {
    // The generation counts pod launches, but a half-TTL credential renewal and a reconnect
    // after a dropped socket both happen inside one pod. Refusing equality here stranded a
    // healthy pod permanently unbindable.
    clock.value = 1_000
    const bindings = registry()
    const first = mustBind(bindings, record({ generation: 3 }), { name: 'p', uid: 'u' })
    const renewed = mustBind(bindings, record({ generation: 3 }), { name: 'p', uid: 'u' })
    expect(renewed.credential).not.toBe(first.credential)
    expect(bindings.authorize({ credential: renewed.credential, generation: 3, capability: 'materialize' }).ok).toBe(
      true
    )
    // The rotated-away credential stops working, so a renewal is still a replacement.
    expect(bindings.authorize({ credential: first.credential, generation: 3, capability: 'materialize' }).ok).toBe(
      false
    )
    expect(bindings.size()).toBe(1)
  })

  it('refuses the same generation from a DIFFERENT pod, which is the ambiguous case', () => {
    clock.value = 1_000
    const bindings = registry()
    const held = mustBind(bindings, record({ generation: 3 }), { name: 'p1', uid: 'u1' })
    expect(bindings.bind(record({ generation: 3 }), { name: 'p2', uid: 'u2' })).toEqual({
      ok: false,
      reason: 'generation_claimed_by_another_pod',
      current: 3
    })
    expect(bindings.authorize({ credential: held.credential, generation: 3, capability: 'materialize' }).ok).toBe(true)
  })

  it('refuses a stale generation even with a live credential (invariant 4)', () => {
    const bindings = registry()
    const { credential } = mustBind(bindings, record({ generation: 7 }), { name: 'p', uid: 'u' })
    expect(bindings.authorize({ credential, generation: 7, capability: 'materialize' }).ok).toBe(true)
    expect(bindings.authorize({ credential, generation: 6, capability: 'materialize' })).toEqual({
      ok: false,
      failure: 'stale_generation'
    })
  })

  it('refuses a capability the launch was not granted (invariant 3)', () => {
    const bindings = registry()
    const { credential } = mustBind(bindings, record({ grants: ['materialize'] }), { name: 'p', uid: 'u' })
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
    const { credential } = mustBind(bindings, record(), { name: 'p', uid: 'u' })
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
    const a = mustBind(bindings, record({ agentId: 'agent-a' }), { name: 'pa', uid: 'ua' })
    const b = mustBind(bindings, record({ agentId: 'agent-b', grants: ['exec'] }), { name: 'pb', uid: 'ub' })
    expect(bindings.authorize({ credential: a.credential, generation: 3, capability: 'exec' }).ok).toBe(false)
    const resolved = bindings.authorize({ credential: b.credential, generation: 3, capability: 'exec' })
    expect(resolved.ok && resolved.binding.agentId).toBe('agent-b')
  })

  it('revokes by agent across pod incarnations', () => {
    const bindings = registry()
    clock.value = 1_000
    const first = mustBind(bindings, record(), { name: 'p1', uid: 'u1' })
    const second = mustBind(bindings, record({ generation: 4 }), { name: 'p2', uid: 'u2' })
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

  it('re-dials after the channel drops instead of staying alive but detached', async () => {
    const clock = new FakeClock()
    const dials: Array<{ send: (t: string) => void; close: (c: number, r: string) => void }> = []
    let onMessage: ((text: string) => void) | undefined
    let onClose: ((code: number, reason: string) => void) | undefined
    const client = new ShimClient({
      endpoint: 'ws://daemon:9000',
      dial: async () => {
        const transport: ShimTransport = {
          send: () => {},
          onMessage: (cb) => (onMessage = cb),
          onClose: (cb) => (onClose = cb),
          close: () => {}
        }
        dials.push(transport)
        return transport
      },
      readToken: () => 't',
      clock,
      backoff: new Backoff({ jitter: () => 0 }),
      log: { info: () => {}, warn: () => {} }
    })
    const bind = (generation: number) =>
      onMessage?.(
        JSON.stringify({
          type: 'shim/bound',
          sessionCredential: `cred-${generation}`,
          expiresInSeconds: 600,
          agentId: 'agent-a',
          generation,
          grants: ['materialize']
        })
      )
    const started = client.start()
    await waitFor(() => dials.length === 1)
    bind(3)
    await started

    // The pod is healthy; the socket simply dropped. Previously this left the executable
    // running with no channel and no retry.
    onClose?.(1006, 'abnormal closure')
    // The loop parks on a clock-driven backoff; advancing releases it.
    await waitFor(() => client.binding() === undefined)
    clock.advance(60_000)
    await waitFor(() => dials.length === 2)
    bind(4)
    await waitFor(() => client.binding()?.generation === 4)
    client.stop()
  })

  it('re-handshakes before the credential expires rather than going stale', async () => {
    const clock = new FakeClock()
    let dials = 0
    let onMessage: ((text: string) => void) | undefined
    const client = new ShimClient({
      endpoint: 'ws://daemon:9000',
      dial: async () => {
        dials += 1
        return { send: () => {}, onMessage: (cb) => (onMessage = cb), onClose: () => {}, close: () => {} }
      },
      readToken: () => 't',
      clock,
      backoff: new Backoff({ jitter: () => 0 }),
      log: { info: () => {}, warn: () => {} }
    })
    const started = client.start()
    await waitFor(() => dials === 1)
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
    // Renewal at half the lifetime: a daemon-side credential must never expire under a
    // healthy pod, which is what made the channel silently die after ten minutes.
    clock.advance(300_000)
    await waitFor(() => dials === 2)
    client.stop()
  })

  it('ignores a delayed close from a transport that has already been replaced', async () => {
    // Renewal closes transport A and binds B. If A's close event lands late — a
    // close-handshake timeout, say — it must not clear B's binding or end B's channel.
    const clock = new FakeClock()
    const closers: Array<(code: number, reason: string) => void> = []
    const messagers: Array<(text: string) => void> = []
    const client = new ShimClient({
      endpoint: 'ws://daemon:9000',
      dial: async () => ({
        send: () => {},
        onMessage: (cb) => messagers.push(cb),
        onClose: (cb) => closers.push(cb),
        close: () => {}
      }),
      readToken: () => 't',
      clock,
      backoff: new Backoff({ jitter: () => 0 }),
      log: { info: () => {}, warn: () => {} }
    })
    const bind = (index: number, generation: number, credential = `cred-${generation}`) =>
      messagers[index]?.(
        JSON.stringify({
          type: 'shim/bound',
          sessionCredential: credential,
          expiresInSeconds: 600,
          agentId: 'agent-a',
          generation,
          grants: ['materialize']
        })
      )
    const started = client.start()
    await waitFor(() => messagers.length === 1)
    bind(0, 3)
    await started

    clock.advance(300_000) // renewal deadline: A is closed, B is dialed
    await waitFor(() => messagers.length === 2)
    // Same generation: a renewal does not relaunch the pod. The replacement is identified
    // by its credential, not by a bumped generation.
    bind(1, 3, 'cred-renewed')
    await waitFor(() => client.binding()?.sessionCredential === 'cred-renewed')

    // A's delayed close arrives now.
    closers[0]?.(1006, 'late close from the replaced transport')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(client.binding()?.sessionCredential).toBe('cred-renewed')
    expect(messagers).toHaveLength(2) // no spurious third dial
    client.stop()
  })

  it('backs off after a drop but re-dials a planned renewal at once', async () => {
    const clock = new FakeClock()
    let dials = 0
    const closers: Array<(code: number, reason: string) => void> = []
    const messagers: Array<(text: string) => void> = []
    const client = new ShimClient({
      endpoint: 'ws://daemon:9000',
      dial: async () => {
        dials += 1
        return {
          send: () => {},
          onMessage: (cb) => messagers.push(cb),
          onClose: (cb) => closers.push(cb),
          close: () => {}
        }
      },
      readToken: () => 't',
      clock,
      backoff: new Backoff({ jitter: () => 0 }),
      log: { info: () => {}, warn: () => {} }
    })
    const bind = (index: number, generation: number, credential = `c${index}`) =>
      messagers[index]?.(
        JSON.stringify({
          type: 'shim/bound',
          sessionCredential: credential,
          expiresInSeconds: 600,
          agentId: 'agent-a',
          generation,
          grants: ['materialize']
        })
      )
    const started = client.start()
    // Wait for the transport's callbacks, not the dial counter: the counter increments
    // before connectOnce registers them, so binding on it fires into an empty slot.
    await waitFor(() => messagers.length === 1)
    bind(0, 3)
    await started

    // A renewal is not a failure: it re-dials without waiting out a backoff delay.
    clock.advance(300_000)
    await waitFor(() => messagers.length === 2)
    expect(dials).toBe(2)
    bind(1, 3)
    await waitFor(() => client.binding()?.sessionCredential === 'c1')

    // A drop IS a failure signal, so the next dial waits for the backoff delay. The daemon
    // may be rolling, and immediate re-dials are what backoff exists to prevent.
    expect(closers).toHaveLength(2)
    closers[1]?.(1006, 'dropped')
    await waitFor(() => client.binding() === undefined)
    // Let the loop arm its backoff timer, then assert it has NOT re-dialed: a drop must
    // wait out the delay, because the daemon may be rolling and immediate re-dials are
    // exactly what backoff prevents.
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(dials).toBe(2)
    clock.advance(60_000)
    await waitFor(() => messagers.length === 3)
    expect(dials).toBe(3)
    expect(dials).toBe(3)
    client.stop()
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

describe('shim renewal, end to end', () => {
  it('renews and reconnects at an UNCHANGED generation, against the real listener', async () => {
    // The case the client-only tests masked by synthesizing a new generation: the pod never
    // relaunches, so SpawnRecord.generation stays put across a credential renewal and a
    // reconnect. This drives the real ShimClient against the real ShimListener over a real
    // socket, so nothing about the generation is stubbed.
    const clock = new FakeClock()
    const { instance, endpoint } = await listener({
      verifier: verifier({ authenticated: true, podName: 'runtime-abc', podUid: 'pod-uid-1' }),
      now: () => clock.now(),
      clock,
      credentialTtlMs: 600_000
    })
    const clientClock = new FakeClock()
    const client = new ShimClient({
      endpoint,
      dial: (url, opts) =>
        ClientTransport.dial(url, { subprotocol: opts.subprotocol, path: opts.path }) as Promise<ShimTransport>,
      readToken: () => 'projected-token',
      clock: clientClock,
      backoff: new Backoff({ jitter: () => 0 }),
      log: { info: () => {}, warn: () => {} }
    })
    try {
      const first = await client.start()
      expect(first.generation).toBe(3)
      await waitFor(() => instance.connectionsFor('agent-a').length === 1)

      // Renewal at half the advertised lifetime, with the generation unchanged.
      clientClock.advance(300_000)
      await waitFor(
        () => client.binding() !== undefined && client.binding()?.sessionCredential !== first.sessionCredential
      )
      const renewed = client.binding()!
      expect(renewed.generation).toBe(3)
      // Exactly one live channel, and the new credential is the one that authorizes.
      await waitFor(() => instance.connectionsFor('agent-a').length === 1)
      expect(
        instance.authorize({ credential: renewed.sessionCredential, generation: 3, capability: 'materialize' }).ok
      ).toBe(true)
      expect(
        instance.authorize({ credential: first.sessionCredential, generation: 3, capability: 'materialize' }).ok
      ).toBe(false)

      // And a reconnect after the daemon drops the channel, also at generation 3.
      instance.connectionsFor('agent-a')[0]?.close('simulated drop')
      await waitFor(() => client.binding() === undefined)
      clientClock.advance(60_000)
      await waitFor(() => client.binding() !== undefined)
      expect(client.binding()?.generation).toBe(3)
      await waitFor(() => instance.connectionsFor('agent-a').length === 1)
    } finally {
      client.stop()
    }
  }, 20_000)
})
