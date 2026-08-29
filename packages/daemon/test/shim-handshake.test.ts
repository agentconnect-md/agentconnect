import { afterEach, describe, expect, it, vi } from 'vitest'
import { Backoff, FakeClock } from '@agentconnect.md/connection'
import { ShimBindingRegistry, type SpawnRecord } from '../src/shim/binding.js'
import { noopClusterMetrics, type ClusterMetrics } from '../src/metrics/cluster-metrics.js'
import type { PodIdentityVerifier, ShimConnection } from '../src/shim/connection.js'
import { ShimDialer, type ShimDialerDeps } from '../src/shim/dialer.js'
import { ShimClient, type ShimTransport } from '../src/shim/client.js'
import { SHIM_TOKEN_AUDIENCE, parseShimFrame, type ShimDialHello, type ShimFrame } from '../src/shim/protocol.js'
import { shimFixtures } from './fakes/shim-sandbox.js'
import { runVirtual, settle, VirtualClock } from './fakes/virtual-clock.js'

/** The five security invariants of the shim channel, each with the negative case that
 *  would pass if its enforcement were removed:
 *   1. mutual authentication — an unverifiable token binds nothing;
 *   2. binding identity — only the pod this daemon dialed can bind;
 *   3. per-operation capability — a granted channel is not a blanket permission;
 *   4. replay fence — a frame from a previous pod generation is refused;
 *   5. no long-lived credential — what the shim holds is short-lived and re-obtained. */

const fixtures = shimFixtures()
const { dialers } = fixtures

afterEach(async () => {
  await fixtures.cleanup()
})

function record(overrides: Partial<SpawnRecord> = {}): SpawnRecord {
  return {
    agentId: 'agent-a',
    sandboxUid: 'sandbox-uid-1',
    generation: 3,
    grants: ['materialize'],
    podName: 'runtime-abc',
    ...overrides
  }
}

function verifier(result: Awaited<ReturnType<PodIdentityVerifier['reviewToken']>>): PodIdentityVerifier {
  return { reviewToken: vi.fn(async () => result) }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition not met in time')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** Records only what these tests assert on; the rest is a no-op. */
function countingMetrics(): { metrics: ClusterMetrics; rejections: string[]; tokenReviews: () => number } {
  const rejections: string[] = []
  let tokenReviews = 0
  return {
    rejections,
    tokenReviews: () => tokenReviews,
    metrics: {
      ...noopClusterMetrics,
      handshakeRejected: (reason) => rejections.push(reason),
      tokenReviewRejected: () => (tokenReviews += 1)
    }
  }
}

/** The sandbox side of one scripted dial, including answers a real shim would never give. */
interface ScriptedPeer {
  received: ShimFrame[]
  closed?: { code: number; reason: string }
  reply: (frame: unknown) => void
  /** Answer with something that is not a frame at all. */
  replyRaw: (text: string) => void
  /** The pod went away mid-handshake, rather than the daemon closing on it. */
  drop: (code: number, reason: string) => void
}

/** A retry delay far past every dial deadline here, so a refusal test observes exactly one attempt. */
const pausedBackoff = (): Backoff => new Backoff({ baseMs: 10_000, jitter: () => 0 })

/** The dial has no socket, so its endpoint is only ever echoed back into the fake. */
const SCRIPTED_ENDPOINT = 'ws://sandbox.invalid'

/** A dialer on an in-memory sandbox: `answer` plays the shim, so handshakes run on virtual time. */
function scriptedDialer(deps: {
  answer: (hello: ShimDialHello, peer: ScriptedPeer) => void
  verifier: PodIdentityVerifier
  clock: VirtualClock
  metrics?: ClusterMetrics
  credentialTtlMs?: number
  log?: ShimDialerDeps['log']
}): { dialer: ShimDialer; peers: ScriptedPeer[] } {
  const peers: ScriptedPeer[] = []
  const dial: NonNullable<ShimDialerDeps['dial']> = async () => {
    let onMessage: (text: string) => void = () => {}
    let onClose: (code: number, reason: string) => void = () => {}
    const peer: ScriptedPeer = {
      received: [],
      reply: (frame) => queueMicrotask(() => onMessage(JSON.stringify(frame))),
      replyRaw: (text) => queueMicrotask(() => onMessage(text)),
      drop: (code, reason) => {
        peer.closed ??= { code, reason }
        queueMicrotask(() => onClose(code, reason))
      }
    }
    peers.push(peer)
    return {
      send: (text) => {
        const frame = parseShimFrame(text)
        if (!frame) return
        peer.received.push(frame)
        if (frame.type === 'shim/hello') deps.answer(frame, peer)
      },
      onMessage: (cb) => (onMessage = cb),
      onClose: (cb) => (onClose = cb),
      close: (code, reason) => {
        peer.closed ??= { code, reason }
        queueMicrotask(() => onClose(code, reason))
      }
    }
  }
  const dialer = new ShimDialer({
    verifier: deps.verifier,
    dial,
    clock: deps.clock,
    now: () => deps.clock.now(),
    backoff: pausedBackoff,
    ...(deps.metrics ? { metrics: deps.metrics } : {}),
    ...(deps.credentialTtlMs !== undefined ? { credentialTtlMs: deps.credentialTtlMs } : {}),
    log: deps.log ?? { info: () => {}, warn: () => {} }
  })
  dialers.push(dialer)
  return { dialer, peers }
}

/** Answers every daemon hello with a fixed projected token, which is what a healthy shim does. */
function presents(token = 'projected-token', features?: string[]) {
  return (_hello: ShimDialHello, peer: ScriptedPeer): void =>
    peer.reply({ type: 'shim/identity', token, ...(features ? { features } : {}) })
}

describe('session attachment', () => {
  it('delivers an event ONCE when the same connection is attached twice', async () => {
    // Preparing a workspace binds the channel and launching binds it again, getting the same
    // connection back. `onFrame` only appends and never removes, so a second attach registered a
    // second listener and every ACP chunk and event arrived twice.
    const { ShimSession } = await import('../src/shim/session.js')
    const frameListeners: Array<(text: string) => void> = []
    const connection = {
      binding: { agentId: 'agent-a', generation: 3, grants: ['acp'], podName: 'p', podUid: 'u' },
      issuedCredential: 'cred',
      send: () => {},
      onFrame: (listen: (text: string) => void) => frameListeners.push(listen),
      close: () => {}
    } as never

    const session = new ShimSession('agent-a', 3, {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout)
    })
    session.attach(connection)
    session.attach(connection)

    const seen: string[] = []
    session.onEvent((event) => {
      if (event.event.kind === 'chunk') seen.push(event.event.data)
    })
    const streamId = '11111111-1111-4111-8111-111111111111'
    const frame = JSON.stringify({
      type: 'shim/event',
      streamId,
      event: { kind: 'chunk', data: 'aGk=' }
    })
    for (const listen of frameListeners) listen(frame)
    expect(seen).toEqual(['aGk='])
  })
})

describe('shim feature negotiation', () => {
  it('does not send the skills grant to a legacy shim', async () => {
    const clock = new VirtualClock()
    const { dialer, peers } = scriptedDialer({
      answer: presents(),
      verifier: verifier({ authenticated: true, podName: 'runtime-abc', podUid: 'pod-uid-1' }),
      clock
    })
    const connection = await runVirtual(
      clock,
      dialer.connect(SCRIPTED_ENDPOINT, record({ grants: ['materialize', 'skills'] as never }), 500)
    )
    expect(connection.binding.grants).toEqual(['materialize'])
    expect(peers[0]!.received.at(-1)).toMatchObject({ type: 'shim/bound', grants: ['materialize'] })
  })

  it('sends the skills grant when the shim advertises cluster-skills-v1', async () => {
    const clock = new VirtualClock()
    const { dialer } = scriptedDialer({
      answer: presents('projected-token', ['cluster-skills-v1']),
      verifier: verifier({ authenticated: true, podName: 'runtime-abc', podUid: 'pod-uid-1' }),
      clock
    })
    const connection = await runVirtual(
      clock,
      dialer.connect(SCRIPTED_ENDPOINT, record({ grants: ['materialize', 'skills'] as never }), 500)
    )
    expect(connection.binding.grants).toEqual(['materialize', 'skills'])
  })

  it('withholds the widened skills grant until the shim advertises cluster-skills-v2', async () => {
    const grantsFor = async (features: string[]): Promise<string[]> => {
      const clock = new VirtualClock()
      const { dialer } = scriptedDialer({
        answer: presents('projected-token', features),
        verifier: verifier({ authenticated: true, podName: 'runtime-abc', podUid: 'pod-uid-1' }),
        clock
      })
      const connection = await runVirtual(
        clock,
        dialer.connect(SCRIPTED_ENDPOINT, record({ grants: ['skills', 'skills-wide'] as never }), 500)
      )
      return connection.binding.grants
    }
    expect(await grantsFor(['cluster-skills-v1'])).toEqual(['skills'])
    expect(await grantsFor(['cluster-skills-v1', 'cluster-skills-v2'])).toEqual(['skills', 'skills-wide'])
  })
})

describe('handshake operability counters', () => {
  it('counts the unavailable rejection it sends, rather than sending one silently', async () => {
    // Every reason the daemon SENDS must have a counter, or a dashboard shows a healthy handshake
    // rate while pods are being turned away.
    const clock = new VirtualClock()
    const counted = countingMetrics()
    const { dialer, peers } = scriptedDialer({
      answer: presents(),
      verifier: {
        reviewToken: async () => {
          throw new Error('token review unavailable')
        }
      },
      clock,
      metrics: counted.metrics
    })

    await expect(runVirtual(clock, dialer.connect(SCRIPTED_ENDPOINT, record(), 500))).rejects.toThrow(
      /could not connect to sandbox shim/
    )
    expect(peers[0]!.received.at(-1)).toMatchObject({ type: 'shim/rejected', reason: 'unavailable' })
    expect(counted.rejections).toEqual(['unavailable'])
  })

  it('counts a malformed frame rather than only closing the socket', async () => {
    const clock = new VirtualClock()
    const counted = countingMetrics()
    const { dialer, peers } = scriptedDialer({
      answer: (_hello, peer) => peer.replyRaw('{not a frame'),
      verifier: verifier({ authenticated: true, podName: 'runtime-abc', podUid: 'pod-uid-1' }),
      clock,
      metrics: counted.metrics
    })

    await expect(runVirtual(clock, dialer.connect(SCRIPTED_ENDPOINT, record(), 500))).rejects.toThrow(
      /could not connect to sandbox shim/
    )
    expect(counted.rejections).toEqual(['malformed'])
    expect(peers[0]!.closed).toEqual({ code: 4400, reason: 'malformed frame' })
  })

  it('never writes the presented token or the issued credential into a log line', async () => {
    // The hygiene requirement, checked rather than asserted in a comment: these two strings are
    // the whole authorization surface, and a log is the one place they leak without anyone
    // noticing until the logs are already somewhere else.
    const lines: string[] = []
    const log = { info: (m: string) => lines.push(m), warn: (m: string) => lines.push(m) }
    const token = 'TOKEN-c8f2a1d4e7b9'

    const boundClock = new VirtualClock()
    const accepted = scriptedDialer({
      answer: presents(token),
      verifier: verifier({ authenticated: true, podName: 'runtime-abc', podUid: 'pod-uid-1' }),
      clock: boundClock,
      log
    })
    const connection = await runVirtual(boundClock, accepted.dialer.connect(SCRIPTED_ENDPOINT, record(), 500))
    const credential = connection.issuedCredential
    expect(credential.length).toBeGreaterThan(8)

    // And a rejection path too, which is where a diagnostic is most tempting to over-share:
    // the API server echoes the token straight back into its own error string.
    const refusedClock = new VirtualClock()
    const refused = scriptedDialer({
      answer: presents(token),
      verifier: verifier({ authenticated: false, error: `token ${token} was not accepted` }),
      clock: refusedClock,
      log
    })
    await expect(runVirtual(refusedClock, refused.dialer.connect(SCRIPTED_ENDPOINT, record(), 500))).rejects.toThrow(
      /could not connect to sandbox shim/
    )

    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      expect(line).not.toContain(token)
      expect(line).not.toContain(credential)
    }
  })
})

describe('shim handshake', () => {
  it('binds a pod whose token verifies, and asks only for the shim audience (invariants 1, 2)', async () => {
    const clock = new VirtualClock()
    const review = verifier({ authenticated: true, podName: 'runtime-abc', podUid: 'pod-uid-1' })
    const { dialer, peers } = scriptedDialer({ answer: presents(), verifier: review, clock })

    const connection = await runVirtual(clock, dialer.connect(SCRIPTED_ENDPOINT, record(), 500))
    expect(connection.binding).toMatchObject({ agentId: 'agent-a', generation: 3, podUid: 'pod-uid-1' })
    expect(connection.binding.grants).toEqual(['materialize'])
    expect(connection.issuedCredential).toMatch(/^[\w-]{20,}$/)
    // The daemon announced the launch it expects to bind before the pod proved anything.
    expect(peers[0]!.received[0]).toEqual({ type: 'shim/hello', agentId: 'agent-a', generation: 3 })
    // The audience is what makes handing over the pod's own token safe: a token minted
    // for anything else must not authenticate here.
    expect(review.reviewToken).toHaveBeenCalledWith('projected-token', [SHIM_TOKEN_AUDIENCE])
  })

  it('discloses nothing about the launch in either refusal it sends', async () => {
    // The refusal a half-trusted pod reads must not become a description of what the daemon
    // launched. The reason is coarse by design and the message carries no identifier at all.
    const seen: Array<{ reason: string; message: string }> = []
    for (const review of [
      { authenticated: false } as const,
      { authenticated: true, podName: 'someone-elses-pod', podUid: 'pod-uid-9' } as const
    ]) {
      const clock = new VirtualClock()
      const { dialer, peers } = scriptedDialer({ answer: presents(), verifier: verifier(review), clock })
      await expect(runVirtual(clock, dialer.connect(SCRIPTED_ENDPOINT, record(), 500))).rejects.toThrow(
        /could not connect to sandbox shim/
      )
      const frame = peers[0]!.received.at(-1) as { type: string; reason: string; message: string }
      expect(frame.type).toBe('shim/rejected')
      seen.push({ reason: frame.reason, message: frame.message })
      expect(dialer.connectionsFor('agent-a')).toEqual([])
    }
    // Byte-identical messages: naming which check failed would describe the launch record.
    expect(seen.map((entry) => entry.message)).toEqual(['not accepted', 'not accepted'])
    for (const entry of seen) expect(entry.message).not.toMatch(/pod-uid|TOKEN|agent-a|runtime-abc/)
  })

  it('closes a second identity arriving while the first is still being reviewed', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const clock = new VirtualClock()
    const { dialer, peers } = scriptedDialer({
      answer: (_hello, peer) => {
        // Without single-flight this would bind twice and leave a stale credential behind.
        peer.reply({ type: 'shim/identity', token: 'first' })
        peer.reply({ type: 'shim/identity', token: 'second' })
      },
      verifier: {
        reviewToken: async () => {
          await gate
          return { authenticated: true, podName: 'runtime-abc', podUid: 'pod-uid-1' }
        }
      },
      clock
    })

    const pending = dialer.connect(SCRIPTED_ENDPOINT, record(), 500)
    void pending.catch(() => undefined)
    await waitFor(() => peers[0]?.closed !== undefined)
    expect(peers[0]!.closed).toEqual({ code: 4400, reason: 'already binding' })
    release()
    dialer.stop()
    await expect(pending).rejects.toThrow()
  })

  it('closes the channel when the credential expires, so the peer cannot hold a dead one (invariant 5)', async () => {
    const clock = new VirtualClock()
    const { dialer, peers } = scriptedDialer({
      answer: presents(),
      verifier: verifier({ authenticated: true, podName: 'runtime-abc', podUid: 'pod-uid-1' }),
      clock,
      credentialTtlMs: 60_000
    })

    await runVirtual(clock, dialer.connect(SCRIPTED_ENDPOINT, record(), 500))
    expect(peers[0]!.closed).toBeUndefined()
    // The backstop under the shim's own re-handshake: if it never comes, the channel goes.
    clock.fireNext(120_000)
    await settle()
    expect(peers[0]!.closed).toEqual({ code: 4000, reason: 'credential expired' })
  })

  it('issues nothing when the pod goes away while its token review is in flight', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const clock = new VirtualClock()
    const { dialer, peers } = scriptedDialer({
      answer: presents(),
      verifier: {
        reviewToken: async () => {
          await gate
          return { authenticated: true, podName: 'runtime-abc', podUid: 'pod-uid-1' }
        }
      },
      clock
    })

    const pending = dialer.connect(SCRIPTED_ENDPOINT, record(), 500)
    void pending.catch(() => undefined)
    await waitFor(() => peers.length === 1)
    peers[0]!.drop(1006, 'pod evicted')
    release()
    // Give the continuation a turn to run before asserting it did nothing.
    await settle()
    expect(peers[0]!.received.some((frame) => frame.type === 'shim/bound')).toBe(false)
    expect(dialer.connectionsFor('agent-a')).toEqual([])
    dialer.stop()
    await expect(pending).rejects.toThrow()
  })
})

describe('shim dial startup budget', () => {
  /** A shim that answers the daemon's hello, once a dial finally gets a socket. */
  function healthyTransport(): ShimTransport {
    let deliver: (text: string) => void = () => {}
    return {
      send: (text) => {
        if (parseShimFrame(text)?.type === 'shim/hello')
          queueMicrotask(() => deliver(JSON.stringify({ type: 'shim/identity', token: 'projected-token' })))
      },
      onMessage: (cb) => (deliver = cb),
      onClose: () => {},
      close: () => {}
    }
  }

  function dialerRecordingHandshakes(clock: VirtualClock, failFirst: number, handshakes: Array<number | undefined>) {
    let attempts = 0
    const dialer = new ShimDialer({
      verifier: verifier({ authenticated: true, podName: 'runtime-abc', podUid: 'pod-uid-1' }),
      clock,
      now: () => clock.now(),
      backoff: () => new Backoff({ baseMs: 10, jitter: () => 0 }),
      dial: async (_url, opts) => {
        handshakes.push(opts.handshakeTimeoutMs)
        // What an unconverged network path produces: no refusal, just a handshake nobody answers.
        if (attempts++ < failFirst) throw new Error('Opening handshake has timed out')
        return healthyTransport()
      },
      log: { info: () => {}, warn: () => {} }
    })
    dialers.push(dialer)
    return dialer
  }

  it('bounds every pre-bind handshake and doubles it, rather than paying the transport default', async () => {
    // Unbounded, a dropped SYN costs the transport's full 10s and the ~100ms startup pacing never runs.
    const clock = new VirtualClock()
    const handshakes: Array<number | undefined> = []
    const dialer = dialerRecordingHandshakes(clock, 2, handshakes)

    const connection = await runVirtual(clock, dialer.connect(SCRIPTED_ENDPOINT, record(), 60_000))
    expect(connection.binding.agentId).toBe('agent-a')
    // Doubling, not a fixed floor: a slow-but-live handshake must still be allowed to finish.
    expect(handshakes).toEqual([1_000, 2_000, 4_000])
  })

  it('never bounds an attempt above the budget its caller gave', async () => {
    const clock = new VirtualClock()
    const handshakes: Array<number | undefined> = []
    const dialer = dialerRecordingHandshakes(clock, 0, handshakes)

    await runVirtual(clock, dialer.connect(SCRIPTED_ENDPOINT, record(), 250))
    expect(handshakes).toEqual([250])
  })
})

describe('workspace root reporting', () => {
  async function boundWith(workspaceRoot?: string): Promise<{ workspaceRoot?: string }> {
    const clock = new VirtualClock()
    const { dialer } = scriptedDialer({
      answer: (_hello, peer) =>
        peer.reply({ type: 'shim/identity', token: 'projected-token', ...(workspaceRoot ? { workspaceRoot } : {}) }),
      verifier: verifier({ authenticated: true, podName: 'runtime-abc', podUid: 'pod-uid-1' }),
      clock
    })
    return await runVirtual(clock, dialer.connect(SCRIPTED_ENDPOINT, record(), 500))
  }

  it('carries a normalized absolute root onto the bound connection', async () => {
    expect((await boundWith('/agent//')).workspaceRoot).toBe('/agent')
  })

  it('leaves the root unset for an identity that reports none', async () => {
    expect((await boundWith()).workspaceRoot).toBeUndefined()
  })

  it('ignores a non-absolute root rather than building pod paths on it', async () => {
    expect((await boundWith('workspace')).workspaceRoot).toBeUndefined()
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
  /** The daemon hello the client waits for before it proves anything. */
  function hello(generation = 3, agentId = 'agent-a'): string {
    return JSON.stringify({ type: 'shim/hello', agentId, generation })
  }

  function boundFrame(generation: number, sessionCredential = `cred-${generation}`): string {
    return JSON.stringify({
      type: 'shim/bound',
      sessionCredential,
      expiresInSeconds: 600,
      agentId: 'agent-a',
      generation,
      grants: ['materialize']
    })
  }

  it('presents the projected token only after the daemon names the launch it expects', async () => {
    const sent: unknown[] = []
    let onMessage: ((text: string) => void) | undefined
    const transport: ShimTransport = {
      send: (text) => sent.push(JSON.parse(text)),
      onMessage: (cb) => (onMessage = cb),
      onClose: () => {},
      close: () => {}
    }
    const client = new ShimClient({
      endpoint: 'accepted-daemon-channel',
      dial: async () => transport,
      readToken: () => 'rotating-token',
      log: { info: () => {}, warn: () => {} }
    })
    const started = client.start()
    await waitFor(() => onMessage !== undefined)
    // Nothing is volunteered to an unannounced peer: the token goes out only in answer.
    expect(sent).toEqual([])
    onMessage?.(hello())
    await waitFor(() => sent.length > 0)
    expect(sent[0]).toEqual({ type: 'shim/identity', token: 'rotating-token' })
    onMessage?.(boundFrame(3, 'cred-1'))
    const bound = await started
    expect(bound.agentId).toBe('agent-a')
    expect(client.binding()?.sessionCredential).toBe('cred-1')
    client.stop()
  })

  it('reports its workspace mount in the identity when configured', async () => {
    // The daemon cannot name a path on a machine it is not on; this field is where it learns one.
    const sent: unknown[] = []
    let onMessage: ((text: string) => void) | undefined
    const transport: ShimTransport = {
      send: (text) => sent.push(JSON.parse(text)),
      onMessage: (cb) => (onMessage = cb),
      onClose: () => {},
      close: () => {}
    }
    const client = new ShimClient({
      endpoint: 'accepted-daemon-channel',
      dial: async () => transport,
      readToken: () => 't',
      workspaceRoot: '/agent',
      log: { info: () => {}, warn: () => {} }
    })
    void client.start()
    await waitFor(() => onMessage !== undefined)
    onMessage?.(hello())
    await waitFor(() => sent.length > 0)
    expect(sent[0]).toEqual({ type: 'shim/identity', token: 't', workspaceRoot: '/agent' })
    client.stop()
  })

  it('refuses a bound frame that does not match the launch the daemon announced', async () => {
    // The binding the shim accepts is the one it was told to expect; anything else is a channel
    // it has no business serving, whatever credential comes attached.
    const closes: Array<{ code: number; reason: string }> = []
    let onMessage: ((text: string) => void) | undefined
    const client = new ShimClient({
      endpoint: 'accepted-daemon-channel',
      dial: async () => ({
        send: () => {},
        onMessage: (cb) => (onMessage = cb),
        onClose: () => {},
        close: (code, reason) => closes.push({ code, reason })
      }),
      readToken: () => 't',
      log: { info: () => {}, warn: () => {} }
    })
    void client.start().catch(() => undefined)
    await waitFor(() => onMessage !== undefined)
    onMessage?.(hello(3))
    onMessage?.(boundFrame(4))
    await waitFor(() => closes.length > 0)
    expect(closes[0]).toEqual({ code: 4403, reason: 'binding mismatch' })
    expect(client.binding()).toBeUndefined()
    client.stop()
  })

  it('refuses a daemon announcing a generation below the one it already bound (invariant 4)', async () => {
    const clock = new FakeClock()
    const messagers: Array<(text: string) => void> = []
    const closes: Array<{ code: number; reason: string }> = []
    const client = new ShimClient({
      endpoint: 'accepted-daemon-channel',
      dial: async () => ({
        send: () => {},
        onMessage: (cb) => messagers.push(cb),
        onClose: () => {},
        close: (code, reason) => closes.push({ code, reason })
      }),
      readToken: () => 't',
      clock,
      backoff: new Backoff({ jitter: () => 0 }),
      log: { info: () => {}, warn: () => {} }
    })
    const started = client.start()
    await waitFor(() => messagers.length === 1)
    messagers[0]?.(hello(4))
    messagers[0]?.(boundFrame(4))
    await started

    // The renewal deadline frees the slot; a daemon that then claims an older launch is refused.
    clock.advance(300_000)
    await waitFor(() => messagers.length === 2)
    messagers[1]?.(hello(3))
    await waitFor(() => closes.some((close) => close.reason === 'stale generation'))
    expect(closes.at(-1)).toEqual({ code: 4403, reason: 'stale generation' })
    client.stop()
  })

  it('re-dials after the channel drops instead of staying alive but detached', async () => {
    const clock = new FakeClock()
    const messagers: Array<(text: string) => void> = []
    let onClose: ((code: number, reason: string) => void) | undefined
    const client = new ShimClient({
      endpoint: 'accepted-daemon-channel',
      dial: async () => ({
        send: () => {},
        onMessage: (cb) => messagers.push(cb),
        onClose: (cb) => (onClose = cb),
        close: () => {}
      }),
      readToken: () => 't',
      clock,
      backoff: new Backoff({ jitter: () => 0 }),
      log: { info: () => {}, warn: () => {} }
    })
    const bind = (index: number, generation: number): void => {
      messagers[index]?.(hello(generation))
      messagers[index]?.(boundFrame(generation))
    }
    const started = client.start()
    await waitFor(() => messagers.length === 1)
    bind(0, 3)
    await started

    // The pod is healthy; the socket simply dropped. Previously this left the executable
    // running with no channel and no retry.
    onClose?.(1006, 'abnormal closure')
    // The loop parks on a clock-driven backoff; advancing releases it.
    await waitFor(() => client.binding() === undefined)
    clock.advance(60_000)
    await waitFor(() => messagers.length === 2)
    bind(1, 4)
    await waitFor(() => client.binding()?.generation === 4)
    client.stop()
  })

  it('re-handshakes before the credential expires rather than going stale', async () => {
    const clock = new FakeClock()
    let dials = 0
    const messagers: Array<(text: string) => void> = []
    const client = new ShimClient({
      endpoint: 'accepted-daemon-channel',
      dial: async () => {
        dials += 1
        return { send: () => {}, onMessage: (cb) => messagers.push(cb), onClose: () => {}, close: () => {} }
      },
      readToken: () => 't',
      clock,
      backoff: new Backoff({ jitter: () => 0 }),
      log: { info: () => {}, warn: () => {} }
    })
    const started = client.start()
    await waitFor(() => messagers.length === 1)
    messagers[0]?.(hello())
    messagers[0]?.(boundFrame(3, 'cred-1'))
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
      endpoint: 'accepted-daemon-channel',
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
    const bind = (index: number, generation: number, credential?: string): void => {
      messagers[index]?.(hello(generation))
      messagers[index]?.(boundFrame(generation, credential))
    }
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
      endpoint: 'accepted-daemon-channel',
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
    const bind = (index: number, generation: number, credential = `c${index}`): void => {
      messagers[index]?.(hello(generation))
      messagers[index]?.(boundFrame(generation, credential))
    }
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
    client.stop()
  })

  it('refuses to serve a request whose credential or generation is not its own', async () => {
    const sent: Array<Record<string, unknown>> = []
    let onMessage: ((text: string) => void) | undefined
    const transport: ShimTransport = {
      send: (text) => sent.push(JSON.parse(text) as Record<string, unknown>),
      onMessage: (cb) => (onMessage = cb),
      onClose: () => {},
      close: () => {}
    }
    const handle = vi.fn(async () => 'executed')
    const client = new ShimClient({
      endpoint: 'accepted-daemon-channel',
      dial: async () => transport,
      readToken: () => 't',
      handle,
      log: { info: () => {}, warn: () => {} }
    })
    const started = client.start()
    await waitFor(() => onMessage !== undefined)
    onMessage?.(hello())
    await waitFor(() => sent.length > 0)
    onMessage?.(boundFrame(3, 'cred-1'))
    await started

    const request = (overrides: Record<string, unknown>): void =>
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
  it('renews and reconnects at an UNCHANGED generation, against the real dialer', async () => {
    // The case the client-only tests masked by synthesizing a new generation: the pod never
    // relaunches, so SpawnRecord.generation stays put across a credential renewal and a
    // reconnect. This drives the real ShimClient against the real ShimDialer over a real
    // socket, so nothing about the generation is stubbed.
    const clientClock = new FakeClock()
    const { endpoint } = await fixtures.sandbox({ clock: clientClock, backoff: new Backoff({ jitter: () => 0 }) })
    const dialer = fixtures.dialer({
      verifier: { reviewToken: async () => ({ authenticated: true, podName: 'runtime-abc', podUid: 'pod-uid-1' }) },
      backoff: () => new Backoff({ baseMs: 5, jitter: () => 0 }),
      credentialTtlMs: 600_000,
      log: { info: () => {}, warn: () => {} }
    })

    const first = await dialer.connect(endpoint, record(), 10_000)
    expect(first.binding.generation).toBe(3)

    // Renewal at half the advertised lifetime, with the generation unchanged. The shim's own
    // deadlines run on a fake clock, so the test nudges it rather than waiting five minutes —
    // repeatedly, because the timer is armed a turn after the daemon considers itself bound.
    const advanceUntil = async (done: () => boolean): Promise<void> => {
      for (let attempt = 0; attempt < 200 && !done(); attempt++) {
        clientClock.advance(300_000)
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      expect(done()).toBe(true)
    }
    const replaced = (previous: ShimConnection) => (): boolean => {
      const current = dialer.connectionsFor('agent-a')[0]
      return current !== undefined && current !== previous
    }
    await advanceUntil(replaced(first))
    const renewed = dialer.connectionsFor('agent-a')[0]!
    expect(renewed.binding.generation).toBe(3)
    // Exactly one live channel, and the new credential is the one that authorizes.
    expect(dialer.connectionsFor('agent-a')).toHaveLength(1)
    expect(
      dialer.authorize({ credential: renewed.issuedCredential, generation: 3, capability: 'materialize' }).ok
    ).toBe(true)
    expect(dialer.authorize({ credential: first.issuedCredential, generation: 3, capability: 'materialize' }).ok).toBe(
      false
    )

    // And a reconnect after the daemon drops the channel, also at generation 3. The shim parks on
    // its own clock-driven backoff, so the test releases it rather than waiting the delay out.
    renewed.close('simulated drop')
    await advanceUntil(replaced(renewed))
    expect(dialer.connectionsFor('agent-a')[0]?.binding.generation).toBe(3)
  })
})
