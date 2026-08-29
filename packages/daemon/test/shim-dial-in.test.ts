import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Backoff, ClientTransport, DEFAULT_BACKOFF_BASE_MS } from '@agentconnect.md/connection'
import { MAX_FRAME_BYTES } from '@agentconnect.md/protocol'
import { WebSocket } from 'ws'
import { ShimDialer, STARTUP_DIAL_BACKOFF, type ShimDialerDeps } from '../src/shim/dialer.js'
import { ShimServer } from '../src/shim/server.js'
import { ShimSession } from '../src/shim/session.js'
import { noopClusterMetrics, type ClusterMetrics } from '../src/metrics/cluster-metrics.js'
import type { SpawnRecord } from '../src/shim/binding.js'
import type { ShimTransport } from '../src/shim/client.js'
import type { PodIdentityVerifier, ShimConnection } from '../src/shim/connection.js'
import {
  SHIM_SUBPROTOCOL,
  SHIM_TOKEN_AUDIENCE,
  SHIM_WS_PATH,
  parseShimFrame,
  type ShimDialHello,
  type ShimFrame
} from '../src/shim/protocol.js'
import { shimFixtures } from './fakes/shim-sandbox.js'
import { runVirtual, VirtualClock } from './fakes/virtual-clock.js'
import { ClusterSkillHandler } from '../src/shim/skill-handler.js'
import { ClusterSkillClient } from '../src/shim/skill-client.js'

// Zero-jitter millisecond backoff so reconnect tests never sleep real seconds.
const fastBackoff = (): Backoff => new Backoff({ baseMs: 5, jitter: () => 0 })

/** A retry delay far past every dial deadline here, so a refusal test observes exactly one attempt. */
const pausedBackoff = (): Backoff => new Backoff({ baseMs: 10_000, jitter: () => 0 })

const quiet = { info: () => {}, warn: () => {} }

const fixtures = shimFixtures()
const { dialers, sandbox, servers } = fixtures
const sockets: WebSocket[] = []

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close()
  await fixtures.cleanup()
})

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition not met in time')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function record(generation = 1): SpawnRecord {
  return {
    agentId: 'agent-a',
    sandboxUid: 'sandbox-uid-1',
    generation,
    grants: ['materialize'],
    podName: 'sandbox-pod-1'
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

/** The sandbox side of one scripted dial: what the shim was sent, and how the daemon closed. */
interface ScriptedPeer {
  received: ShimFrame[]
  closed?: { code: number; reason: string }
  /** Answer the daemon on this socket — including frames a real shim would never send. */
  reply: (frame: unknown) => void
}

/** A raw socket to the shim port, used where the assertion IS the close code. */
async function rawDial(port: number): Promise<{
  socket: WebSocket
  frames: string[]
  closed: Promise<{ code: number; reason: string }>
}> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${SHIM_WS_PATH}`, [SHIM_SUBPROTOCOL])
  sockets.push(socket)
  const frames: string[] = []
  socket.on('message', (data: Buffer) => frames.push(data.toString()))
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    socket.on('close', (code, reason) => resolve({ code, reason: reason.toString() }))
  )
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  return { socket, frames, closed }
}

/** Dials for real, recording how the peer closed on us — the close code IS the fence's answer. */
function recordingDial(closes: Array<{ code: number; reason: string }>): NonNullable<ShimDialerDeps['dial']> {
  return async (url, opts) => {
    const transport = (await ClientTransport.dial(url, opts)) as ShimTransport
    transport.onClose((code, reason) => closes.push({ code, reason }))
    return transport
  }
}

/** A dialer on an in-memory sandbox: `answer` plays the shim, so handshakes run on virtual time with no I/O. */
function scriptedDialer(deps: {
  answer: (hello: ShimDialHello, peer: ScriptedPeer) => void
  verifier: PodIdentityVerifier
  clock: VirtualClock
  metrics?: ClusterMetrics
  warnings?: string[]
  /** Dials refused before the sandbox answers — a pod whose container started but whose shim is not listening. */
  refusals?: number
  /** Injected backoff; `'shipped'` runs the real per-phase policies instead of {@link pausedBackoff}. */
  backoff?: NonNullable<ShimDialerDeps['backoff']> | 'shipped'
  onConnection?: (connection: ShimConnection) => void
}): { dialer: ShimDialer; peers: ScriptedPeer[] } {
  const peers: ScriptedPeer[] = []
  let refusals = deps.refusals ?? 0
  const dial: NonNullable<ShimDialerDeps['dial']> = async () => {
    if (refusals-- > 0) throw new Error('connect ECONNREFUSED')
    let onMessage: (text: string) => void = () => {}
    let onClose: (code: number, reason: string) => void = () => {}
    const peer: ScriptedPeer = {
      received: [],
      reply: (frame) => queueMicrotask(() => onMessage(JSON.stringify(frame)))
    }
    peers.push(peer)
    const transport: ShimTransport = {
      send: (text) => {
        const frame = parseShimFrame(text)
        if (!frame) return
        peer.received.push(frame)
        if (frame.type === 'shim/hello' && 'agentId' in frame) deps.answer(frame, peer)
      },
      onMessage: (cb) => (onMessage = cb),
      onClose: (cb) => (onClose = cb),
      close: (code, reason) => {
        peer.closed ??= { code, reason }
        queueMicrotask(() => onClose(code, reason))
      }
    }
    return transport
  }
  const dialer = new ShimDialer({
    verifier: deps.verifier,
    dial,
    clock: deps.clock,
    now: () => deps.clock.now(),
    ...(deps.backoff === 'shipped' ? {} : { backoff: deps.backoff ?? pausedBackoff }),
    ...(deps.metrics ? { metrics: deps.metrics } : {}),
    ...(deps.onConnection ? { onConnection: deps.onConnection } : {}),
    log: { info: () => {}, warn: (message) => deps.warnings?.push(message) }
  })
  dialers.push(dialer)
  return { dialer, peers }
}

/** The dial has no socket, so its endpoint is only ever echoed back into the fake. */
const SCRIPTED_ENDPOINT = 'ws://sandbox.invalid'
const REQUEST_ID = '11111111-1111-4111-8111-111111111111'

describe('sandbox shim dial-in', () => {
  it('lets the daemon dial a pod IP, TokenReviews its identity, and serves a granted request', async () => {
    const served: unknown[] = []
    const { endpoint } = await sandbox({
      handle: async (_capability, payload) => {
        served.push(payload)
        return { written: true }
      }
    })
    const reviewToken = vi.fn(async () => ({
      authenticated: true,
      podName: 'sandbox-pod-1',
      podUid: 'pod-uid-1'
    }))
    const dialer = new ShimDialer({
      verifier: { reviewToken },
      log: { info: () => {}, warn: () => {} }
    })
    dialers.push(dialer)

    const connection = await dialer.connect(endpoint, record(), 5_000)
    const session = new ShimSession('agent-a', 1, {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout)
    })
    session.attach(connection)

    await expect(session.request('materialize', { path: 'config.json' })).resolves.toEqual({ written: true })
    expect(served).toEqual([{ path: 'config.json' }])
    expect(reviewToken).toHaveBeenCalledWith('projected-token', [SHIM_TOKEN_AUDIENCE])
    expect(connection.binding).toMatchObject({ podName: 'sandbox-pod-1', podUid: 'pod-uid-1', generation: 1 })
    expect(connection.workspaceRoot).toBe('/agent')
    expect(
      dialer.authorize({
        credential: connection.issuedCredential,
        generation: 1,
        capability: 'materialize'
      }).ok
    ).toBe(true)
  })

  it('waits for the replacement connection while a bound channel is reconnecting', async () => {
    // Both reconnect loops run on injected zero-jitter backoffs, so the redial and the
    // sandbox re-attach race each other every run instead of sleeping jittered seconds.
    //
    // The dial's own `onConnection` hook is what the redial is awaited on. Waiting inside
    // `connect()` instead would put the supervised redial in a race with that call's real
    // wall-clock binding deadline, which is what made this flaky on a loaded runner (#938):
    // the assertion here is about ordering, so it must not be timed against one.
    const bound: ShimConnection[] = []
    const { endpoint } = await sandbox({ backoff: fastBackoff() })
    const dialer = new ShimDialer({
      verifier: {
        reviewToken: async () => ({ authenticated: true, podName: 'sandbox-pod-1', podUid: 'pod-uid-1' })
      },
      backoff: fastBackoff,
      onConnection: (connection) => void bound.push(connection),
      log: { info: () => {}, warn: () => {} }
    })
    dialers.push(dialer)

    const first = await dialer.connect(endpoint, record(), 8_000)
    await waitFor(() => bound.length === 1)
    first.close('force reconnect')
    await waitFor(() => bound.length === 2, 30_000)

    // Already bound, so this resolves from the dial's current connection rather than waiting.
    const replacement = await dialer.connect(endpoint, record(), 8_000)
    expect(replacement).toBe(bound[1])
    expect(replacement).not.toBe(first)
    expect(dialer.connectionsFor('agent-a')).toEqual([replacement])
  }, 40_000)

  it('installs and removes a skill through the real channel across a reconnect', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ac-shim-channel-skills-'))
    const workspace = join(root, 'workspace')
    await mkdir(workspace)
    const handler = new ClusterSkillHandler({
      stagingRoot: join(root, 'staging'),
      workspaceRoot: workspace,
      stateRoot: join(root, 'state')
    })
    const bound: ShimConnection[] = []
    const session = new ShimSession('agent-a', 1, {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout)
    })
    const { endpoint } = await sandbox({
      workspaceRoot: workspace,
      features: ['cluster-skills-v1'],
      backoff: fastBackoff(),
      handle: (capability, payload, abort, context) =>
        capability === 'skills' ? handler.handle(payload, abort, context) : Promise.resolve(undefined)
    })
    const dialer = new ShimDialer({
      verifier: {
        reviewToken: async () => ({ authenticated: true, podName: 'sandbox-pod-1', podUid: 'pod-uid-1' })
      },
      backoff: fastBackoff,
      onConnection: (connection) => {
        bound.push(connection)
        session.attach(connection)
      },
      log: quiet
    })
    dialers.push(dialer)
    const spawn: SpawnRecord = { ...record(), grants: ['skills'] }
    await dialer.connect(endpoint, spawn, 8_000)
    await waitFor(() => session.isAttached())

    const content = Buffer.from('---\nname: channel-skill\ndescription: fixture\n---\n# Channel\n')
    const authority = {
      groupId: 'g',
      term: '1',
      daemonId: 'd',
      agentId: 'agent-a',
      workspaceIncarnation: 'claim',
      shimGeneration: 1
    }
    const client = new ClusterSkillClient(session)
    const operationId = randomUUID()
    const file = {
      sourceId: 'managed:channel',
      path: 'SKILL.md',
      size: content.length,
      sha256: createHash('sha256').update(content).digest('hex')
    }
    const begin = await client.begin({ operationId, authority, skillsAgentId: 'codex', files: [file] })
    await client.upload(operationId, begin.handle, file, content)
    const applied = await client.reconcile({
      operationId,
      handle: begin.handle,
      authority,
      priorRoots: [],
      replayKey: 'a'.repeat(64),
      allowDesiredAdoption: false,
      sources: [{ sourceId: file.sourceId, sourceKind: 'managed', selections: ['channel-skill'] }]
    })
    expect(applied.roots).toHaveLength(1)

    bound[0]!.close('force reconnect')
    await waitFor(() => bound.length === 2, 30_000)
    const removeId = randomUUID()
    const remove = await client.begin({ operationId: removeId, authority, skillsAgentId: 'codex', files: [] })
    await expect(
      client.reconcile({
        operationId: removeId,
        handle: remove.handle,
        authority,
        priorRoots: applied.roots,
        replayKey: 'b'.repeat(64),
        allowDesiredAdoption: false,
        sources: []
      })
    ).resolves.toMatchObject({ roots: [], conflicts: [] })
  }, 120_000)

  it('replays frames that arrived while the accepted daemon socket was still unclaimed', async () => {
    const server = new ShimServer()
    servers.push(server)
    const port = await server.start(0, '127.0.0.1')
    const daemonSide = await ClientTransport.dial(`ws://127.0.0.1:${port}`, {
      subprotocol: SHIM_SUBPROTOCOL,
      path: SHIM_WS_PATH
    })
    // The hello lands before the channel FSM attaches — the queued-across-backoff case. The
    // settle below is the only real wait left in this file, and it is a one-directional one:
    // too short and the frame takes the live path instead of the replayed one, which weakens
    // what is covered but can never fail the assertion, so a slow runner is safe here.
    daemonSide.send(JSON.stringify({ type: 'shim/hello', agentId: 'agent-a', generation: 1 }))
    await new Promise((resolve) => setTimeout(resolve, 50))
    const accepted = await server.nextTransport()
    const seen: string[] = []
    accepted.onMessage((text) => seen.push(text))
    await waitFor(() => seen.length === 1)
    expect(JSON.parse(seen[0]!)).toMatchObject({ type: 'shim/hello', agentId: 'agent-a', generation: 1 })
    daemonSide.close(1000, 'done')
  })

  it('times out an accepted socket whose identity verification never completes', async () => {
    const { endpoint } = await sandbox()
    const dialer = new ShimDialer({
      verifier: { reviewToken: () => new Promise(() => {}) },
      log: { info: () => {}, warn: () => {} }
    })
    dialers.push(dialer)

    await expect(dialer.connect(endpoint, record(), 25)).rejects.toThrow(/binding timed out/)
    expect(dialer.connectionsFor('agent-a')).toEqual([])
  })
})

/** k8s-daemon-pool §7: what the daemon accepts as proof that the socket it dialed is the pod it launched. */
describe('dial-in identity handshake', () => {
  it('fails the dial when the shim answers with anything but its identity', async () => {
    const clock = new VirtualClock()
    const warnings: string[] = []
    const reviewToken = vi.fn(async () => ({ authenticated: true, podName: 'sandbox-pod-1', podUid: 'pod-uid-1' }))
    const { dialer, peers } = scriptedDialer({
      // A well-formed frame that is not the identity: a peer skipping straight to traffic.
      answer: (_hello, peer) => peer.reply({ type: 'shim/response', id: REQUEST_ID, ok: true }),
      verifier: { reviewToken },
      clock,
      warnings
    })

    await expect(runVirtual(clock, dialer.connect(SCRIPTED_ENDPOINT, record(), 500))).rejects.toThrow(
      /could not connect to sandbox shim/
    )
    expect(peers).toHaveLength(1)
    expect(peers[0]!.closed).toEqual({ code: 4403, reason: 'not bound' })
    expect(warnings.some((line) => line.includes('shim did not present its identity'))).toBe(true)
    // Nothing was reviewed, because nothing was presented.
    expect(reviewToken).not.toHaveBeenCalled()
    expect(dialer.connectionsFor('agent-a')).toEqual([])
  })

  it('refuses a dial whose TokenReview does not authenticate, and counts it as an identity failure', async () => {
    const clock = new VirtualClock()
    const counted = countingMetrics()
    const { dialer, peers } = scriptedDialer({
      answer: (_hello, peer) => peer.reply({ type: 'shim/identity', token: 'not-a-valid-token' }),
      verifier: { reviewToken: async () => ({ authenticated: false, error: 'token has been invalidated' }) },
      clock,
      metrics: counted.metrics
    })

    await expect(runVirtual(clock, dialer.connect(SCRIPTED_ENDPOINT, record(), 500))).rejects.toThrow(
      /could not connect to sandbox shim/
    )
    // An API-server identity failure is not this daemon fencing a launch, so both counters move.
    expect(counted.tokenReviews()).toBe(1)
    expect(counted.rejections).toEqual(['unauthenticated'])
    expect(peers[0]!.received.at(-1)).toEqual({
      type: 'shim/rejected',
      reason: 'unauthenticated',
      message: 'not accepted'
    })
    expect(peers[0]!.closed).toEqual({ code: 4403, reason: 'unauthenticated' })
    expect(dialer.connectionsFor('agent-a')).toEqual([])
  })

  it('refuses a shim whose reviewed identity names a pod other than the one dialed', async () => {
    // A sibling sandbox answering on the dialed address: a pod IP is reusable, so the launch record decides.
    const clock = new VirtualClock()
    const counted = countingMetrics()
    const warnings: string[] = []
    const { dialer, peers } = scriptedDialer({
      answer: (_hello, peer) => peer.reply({ type: 'shim/identity', token: 'genuine-token-of-another-pod' }),
      verifier: { reviewToken: async () => ({ authenticated: true, podName: 'sandbox-pod-2', podUid: 'pod-uid-2' }) },
      clock,
      metrics: counted.metrics,
      warnings
    })

    await expect(runVirtual(clock, dialer.connect(SCRIPTED_ENDPOINT, record(), 500))).rejects.toThrow(
      /could not connect to sandbox shim/
    )
    expect(counted.rejections).toEqual(['unknown_pod'])
    // The token itself was accepted, so the identity counter must stay clear.
    expect(counted.tokenReviews()).toBe(0)
    expect(peers[0]!.received.at(-1)).toMatchObject({ type: 'shim/rejected', reason: 'unknown_pod' })
    expect(
      warnings.some((line) => line.includes('dialed pod sandbox-pod-1 presented identity for sandbox-pod-2'))
    ).toBe(true)
    expect(dialer.connectionsFor('agent-a')).toEqual([])
  })

  it('authenticates only a token minted for the shim audience, and asks for no other', async () => {
    // Audience separation is what makes handing over the pod's own token safe; the verifier models that rule.
    const mintedForShim = 'token-for-the-shim-hop'
    const audiences: string[][] = []
    const verifier: PodIdentityVerifier = {
      reviewToken: async (token, requested) => {
        audiences.push(requested)
        return requested.includes(SHIM_TOKEN_AUDIENCE) && token === mintedForShim
          ? { authenticated: true, podName: 'sandbox-pod-1', podUid: 'pod-uid-1' }
          : { authenticated: false, error: 'audiences is not valid for this token' }
      }
    }

    const boundClock = new VirtualClock()
    const scoped = scriptedDialer({
      answer: (_hello, peer) => peer.reply({ type: 'shim/identity', token: mintedForShim }),
      verifier,
      clock: boundClock
    })
    const connection = await runVirtual(boundClock, scoped.dialer.connect(SCRIPTED_ENDPOINT, record(), 500))
    expect(connection.binding).toMatchObject({ podName: 'sandbox-pod-1', podUid: 'pod-uid-1', generation: 1 })

    // Same pod, same verifier, a token minted for a different hop: it authenticates nothing here.
    const refusedClock = new VirtualClock()
    const counted = countingMetrics()
    const crossHop = scriptedDialer({
      answer: (_hello, peer) => peer.reply({ type: 'shim/identity', token: 'token-for-another-hop' }),
      verifier,
      clock: refusedClock,
      metrics: counted.metrics
    })
    await expect(runVirtual(refusedClock, crossHop.dialer.connect(SCRIPTED_ENDPOINT, record(), 500))).rejects.toThrow(
      /could not connect to sandbox shim/
    )
    expect(counted.rejections).toEqual(['unauthenticated'])
    expect(crossHop.dialer.connectionsFor('agent-a')).toEqual([])
    // And this hop never widened what it asked for, on either dial.
    expect(audiences).toEqual([[SHIM_TOKEN_AUDIENCE], [SHIM_TOKEN_AUDIENCE]])
  })

  it('supersedes the older launch dial and drops the credential it issued', async () => {
    const clock = new VirtualClock()
    const { dialer, peers } = scriptedDialer({
      answer: (_hello, peer) => peer.reply({ type: 'shim/identity', token: 'projected-token' }),
      verifier: { reviewToken: async () => ({ authenticated: true, podName: 'sandbox-pod-1', podUid: 'pod-uid-1' }) },
      clock
    })

    const first = await runVirtual(clock, dialer.connect(SCRIPTED_ENDPOINT, record(1), 500))
    const second = await runVirtual(clock, dialer.connect(SCRIPTED_ENDPOINT, record(2), 500))

    expect(second.binding.generation).toBe(2)
    expect(dialer.connectionsFor('agent-a')).toEqual([second])
    expect(peers[0]!.closed).toEqual({ code: 4000, reason: 'superseded by a newer launch' })
    // The superseded launch authorizes nothing at its OWN generation, which is the replay case.
    expect(dialer.authorize({ credential: first.issuedCredential, generation: 1, capability: 'materialize' })).toEqual({
      ok: false,
      failure: 'unknown_credential'
    })
    expect(dialer.authorize({ credential: second.issuedCredential, generation: 2, capability: 'materialize' }).ok).toBe(
      true
    )
  })
})

/** How long a supervised dial waits between attempts, which is not one question but two. */
describe('dial pacing', () => {
  const bindsAsPodOne: PodIdentityVerifier = {
    reviewToken: async () => ({ authenticated: true, podName: 'sandbox-pod-1', podUid: 'pod-uid-1' })
  }

  it('retries a refused first dial on a startup-sized delay, not a reconnect-sized one', async () => {
    // A pod reports Ready when its container process starts, so the first dial of a resume is
    // routinely refused while the shim is still binding its port — a wait measured in hundreds
    // of milliseconds, which the shared reconnect base turned into a guaranteed 1-2s per wake.
    const clock = new VirtualClock()
    const warnings: string[] = []
    const { dialer, peers } = scriptedDialer({
      refusals: 1,
      answer: (_hello, peer) => peer.reply({ type: 'shim/identity', token: 'projected-token' }),
      verifier: bindsAsPodOne,
      clock,
      backoff: 'shipped',
      warnings
    })

    const startedAt = clock.now()
    // Horizon over any first retry this could produce and far under the dial deadline, so a
    // regression to the coarse default is fired and fails an assertion instead of the test timeout.
    const connection = await runVirtual(clock, dialer.connect(SCRIPTED_ENDPOINT, record(), 30_000), 2_500)

    expect(connection.binding).toMatchObject({ podName: 'sandbox-pod-1', generation: 1 })
    // The refused dial never reached a peer, so the bind is the second attempt.
    expect(peers).toHaveLength(1)
    const delays = warnings.map((line) => Number(/retrying in (\d+)ms/.exec(line)?.[1]))
    expect(delays).toHaveLength(1)
    expect(delays[0]).toBeGreaterThanOrEqual(STARTUP_DIAL_BACKOFF.baseMs ?? DEFAULT_BACKOFF_BASE_MS)
    // Sub-200ms is the property: base plus its 0-100% jitter must stay far below the shared default.
    expect(delays[0]).toBeLessThan(200)
    expect(clock.now() - startedAt).toBeLessThan(200)
  })

  it('keeps the coarse shared delay for a reconnect once a channel has bound', async () => {
    // A peer that went away after answering is the case the shared default is right for: the pod
    // is not starting, something ended an established channel, and redialing it hard helps nobody.
    const clock = new VirtualClock()
    const bound: ShimConnection[] = []
    let resolveRebound: () => void = () => {}
    const rebound = new Promise<void>((resolve) => (resolveRebound = resolve))
    const { dialer } = scriptedDialer({
      answer: (_hello, peer) => peer.reply({ type: 'shim/identity', token: 'projected-token' }),
      verifier: bindsAsPodOne,
      clock,
      backoff: 'shipped',
      onConnection: (connection) => {
        bound.push(connection)
        if (bound.length === 2) resolveRebound()
      }
    })

    const first = await runVirtual(clock, dialer.connect(SCRIPTED_ENDPOINT, record(), 30_000), 900)
    const droppedAt = clock.now()
    first.close('force reconnect')
    // Horizon above the coarse delay and under the dial deadline: only the reconnect wait is skipped.
    await runVirtual(clock, rebound, 5_000)

    expect(bound).toHaveLength(2)
    expect(bound[1]).not.toBe(first)
    expect(clock.now() - droppedAt).toBeGreaterThanOrEqual(DEFAULT_BACKOFF_BASE_MS)
  })
})

/** The other side of §7: what the in-sandbox listener refuses before anything is authenticated. */
describe('shim listener hardening', () => {
  it('refuses a second daemon connection while one is active, disclosing nothing', async () => {
    const served: unknown[] = []
    const { endpoint } = await sandbox({
      handle: async (_capability, payload) => {
        served.push(payload)
        return { written: true }
      }
    })
    const dialer = new ShimDialer({
      verifier: {
        reviewToken: async () => ({ authenticated: true, podName: 'sandbox-pod-1', podUid: 'pod-uid-1' })
      },
      log: quiet
    })
    dialers.push(dialer)
    const connection = await dialer.connect(endpoint, record(), 5_000)

    // NetworkPolicy admits the whole pool namespace, so the single-slot rule is what stops a second daemon.
    const port = Number(new URL(endpoint).port)
    const intruder = await rawDial(port)
    expect(await intruder.closed).toEqual({ code: 4403, reason: 'unavailable' })
    // Not one frame: no projected token, no binding, nothing that says what runs in this pod.
    expect(intruder.frames).toEqual([])

    // And the active channel is undisturbed rather than displaced.
    const session = new ShimSession('agent-a', 1, {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout)
    })
    session.attach(connection)
    await expect(session.request('materialize', { path: 'config.json' })).resolves.toEqual({ written: true })
    expect(served).toEqual([{ path: 'config.json' }])
    expect(dialer.connectionsFor('agent-a')).toEqual([connection])
  })

  it('drops the dial when the sandbox sends an oversized frame before authenticating', async () => {
    const server = new ShimServer()
    servers.push(server)
    const port = await server.start(0, '127.0.0.1')
    const accepted = server.nextTransport()
    const closes: Array<{ code: number; reason: string }> = []
    const dialer = new ShimDialer({
      verifier: {
        reviewToken: async () => ({ authenticated: true, podName: 'sandbox-pod-1', podUid: 'pod-uid-1' })
      },
      dial: recordingDial(closes),
      backoff: pausedBackoff,
      log: quiet
    })
    dialers.push(dialer)
    // Left pending: the assertion is what happens to the socket, not a deadline this test times.
    const pending = dialer.connect(`ws://127.0.0.1:${port}`, record(), 30_000)
    void pending.catch(() => undefined)

    // Instead of its identity, 256 KiB + 1 of it: an unproved peer must not choose what the daemon buffers.
    const shimSide = await accepted
    shimSide.send('x'.repeat(MAX_FRAME_BYTES + 1))

    await waitFor(() => closes.length > 0)
    // Torn down rather than closed politely: the frame never became a message at all.
    expect(closes.map((close) => close.code)).toEqual([1006])
    expect(dialer.connectionsFor('agent-a')).toEqual([])
    dialer.stop()
    await expect(pending).rejects.toThrow(/daemon shutting down/)
  })

  it('survives an oversized frame from an unauthenticated peer and accepts the next daemon', async () => {
    // The accept-side mirror of the case above: an unlistened 'error' here ends the shim process.
    const server = new ShimServer()
    servers.push(server)
    const port = await server.start(0, '127.0.0.1')
    const intruder = await rawDial(port)
    intruder.socket.send('x'.repeat(MAX_FRAME_BYTES + 1))
    await intruder.closed
    // Not one frame: an unproved peer learns nothing about what runs in this pod.
    expect(intruder.frames).toEqual([])

    // The shim tears its side down before the peer observes the close, so its single slot is free.
    const daemonSide = await ClientTransport.dial(`ws://127.0.0.1:${port}`, {
      subprotocol: SHIM_SUBPROTOCOL,
      path: SHIM_WS_PATH
    })
    daemonSide.send(JSON.stringify({ type: 'shim/hello', agentId: 'agent-a', generation: 1 }))
    const accepted = await server.nextTransport()
    const seen: string[] = []
    accepted.onMessage((text) => seen.push(text))
    await waitFor(() => seen.length === 1)
    expect(JSON.parse(seen[0]!)).toMatchObject({ type: 'shim/hello', agentId: 'agent-a', generation: 1 })
    daemonSide.close(1000, 'done')
  })

  it('refuses a dial announcing a generation or an agent below the one it already bound', async () => {
    const { endpoint } = await sandbox({ backoff: fastBackoff() })
    const verifier: PodIdentityVerifier = {
      reviewToken: async () => ({ authenticated: true, podName: 'sandbox-pod-1', podUid: 'pod-uid-1' })
    }
    const held = new ShimDialer({ verifier, backoff: fastBackoff, log: quiet })
    dialers.push(held)
    await held.connect(endpoint, record(2), 8_000)
    // Free the shim's single slot without advancing the highest generation it has bound.
    held.stop()

    for (const stale of [record(1), { ...record(2), agentId: 'agent-b' }]) {
      const closes: Array<{ code: number; reason: string }> = []
      const dialer = new ShimDialer({ verifier, dial: recordingDial(closes), backoff: fastBackoff, log: quiet })
      dialers.push(dialer)
      // Left pending: the assertion is the shim's answer, not a deadline this test would time.
      const pending = dialer.connect(endpoint, stale, 30_000)
      void pending.catch(() => undefined)
      await waitFor(() => closes.some((close) => close.code === 4403 && close.reason === 'stale generation'))
      expect(dialer.connectionsFor(stale.agentId)).toEqual([])
      dialer.stop()
      await expect(pending).rejects.toThrow(/daemon shutting down/)
    }
  })
})
