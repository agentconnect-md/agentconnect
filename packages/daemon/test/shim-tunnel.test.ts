import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createConnection, createServer, Socket, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Backoff, FakeClock } from '@agentconnect.md/connection'
import { startK8sRuntimePlane, type K8sRuntimePlane } from '../src/k8s/runtime-plane.js'
import { ShimClient, type ShimTransport } from '../src/shim/client.js'
import { ShimServer } from '../src/shim/server.js'
import { TunnelHost } from '../src/shim/tunnel-host.js'
import { TunnelProxy } from '../src/shim/tunnel-proxy.js'
import { K8sApiError } from '@agentconnect.md/k8s-client'
import type { Sandbox, SandboxClaim } from '../src/k8s/sandbox-api.js'
import { fakeGenerations } from './fake-generations.js'
import type { ShimEvent } from '../src/shim/protocol.js'
import type { TunnelName } from '../src/shim/tunnel.js'
import { waitBudget } from './wait-support.js'

/**
 * The credential tunnel, end to end over real sockets.
 *
 * It is tested here rather than as two unit suites because the whole feature IS the join: the
 * daemon's git-credential helper socket exists on the daemon's filesystem, the git that needs it
 * runs in another pod, and every part of that was already present — the capability, the grant, the
 * frames — with nothing connecting them. A test of either half in isolation passes on a channel
 * that carries no byte.
 *
 * The direction is what the assertions are really about: a tunnel connection is opened by a
 * process INSIDE the pod, while shim requests only flow daemon → shim, so the pod has to announce
 * it and the daemon has to answer by dialling its own end.
 */

const planes: K8sRuntimePlane[] = []
const clients: ShimClient[] = []
const servers: Server[] = []
const shimServers: ShimServer[] = []
const hosts: TunnelHost[] = []
const sockets: Socket[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy()
  for (const host of hosts.splice(0)) host.close()
  for (const client of clients.splice(0)) client.stop()
  for (const plane of planes.splice(0)) await plane.stop()
  for (const server of shimServers.splice(0)) await server.stop()
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ac-tunnel-'))
  dirs.push(dir)
  return dir
}

/** A Sandbox that binds, is Ready, and names its pod. */
function fakeApi() {
  const sandbox = {
    metadata: { name: 'sb-1', uid: 'sandbox-uid-1', annotations: { 'agents.x-k8s.io/pod-name': 'pool-pod-9' } },
    spec: { operatingMode: 'Running' as const },
    status: { conditions: [{ type: 'Ready', status: 'True' }], podIPs: ['127.0.0.1'] }
  } satisfies Sandbox
  let claim: SandboxClaim | undefined
  return {
    ensureClaim: async (input: SandboxClaim & { metadata: { name: string } }) => {
      const created = claim === undefined
      claim = { ...input, status: { sandbox: { name: 'sb-1' } } }
      return { claim, created }
    },
    getClaim: async () => {
      if (!claim) throw new K8sApiError(404, 'NotFound', 'no claim')
      return claim
    },
    deleteClaim: async () => undefined,
    getSandbox: async () => sandbox,
    setOperatingMode: async () => sandbox,
    watchClaims: vi.fn(),
    reviewToken: async () => ({ authenticated: true, podName: 'pool-pod-9', podUid: 'pod-uid-1' })
  }
}

/** The daemon's own server behind the tunnel — gitcred.sock's stand-in. */
function daemonSideServer(onData: (chunk: Buffer, socket: Socket) => void): string {
  const dir = scratchDir()
  const path = join(dir, 'gitcred.sock')
  const server = createServer((socket) => {
    socket.on('data', (chunk: Buffer) => onData(chunk, socket))
    socket.on('error', () => undefined)
  })
  servers.push(server)
  server.listen(path)
  return path
}

interface Cluster {
  plane: K8sRuntimePlane
  /** Where the pod serves the tunnel — the in-image path, redirected into a temp dir. */
  podSocketPath: string
  warnings: string[]
  /** The SHIM's clock: advancing it past half the credential TTL performs a real renewal. */
  shimClock: FakeClock
  bindCount: () => number
}

/**
 * A plane, a real shim client with a real {@link TunnelHost}, and a bound channel.
 *
 * The client's `handle` mirrors `src/shim/index.ts`: tunnels are served by the host, everything
 * else would go to the exec handler. The in-pod path is redirected because the image's
 * `/run/agentconnect` is not writable in a test process.
 */
async function clusterWithTunnel(
  options: {
    daemonSocketPath?: string
    tunnels?: TunnelName[]
    maxStreams?: number
    credentialTtlMs?: number
    /** Withhold a daemon→pod `data` frame from the host, so one is in flight on demand. */
    holdData?: () => Promise<void>
  } = {}
): Promise<Cluster> {
  const warnings: string[] = []
  const shimClock = new FakeClock()
  const podSocketPath = join(scratchDir(), 'pod-gitcred.sock')
  const shimServer = new ShimServer()
  const shimPort = await shimServer.start(0, '127.0.0.1')
  shimServers.push(shimServer)
  const plane = await startK8sRuntimePlane({
    orgForAgent: () => 'org-1',
    warmPoolName: 'pool',
    generations: fakeGenerations(),
    sandboxNamespace: 'agent-sandboxes',
    memberId: 'member-a',
    shimPort,
    readyTimeoutMs: 15_000,
    api: fakeApi() as never,
    tunnelsFor: () => options.tunnels ?? ['gitcred'],
    tunnelSocketPath: (tunnel) => (tunnel === 'gitcred' ? options.daemonSocketPath : undefined),
    ...(options.credentialTtlMs === undefined ? {} : { credentialTtlMs: options.credentialTtlMs }),
    log: { info: () => {}, warn: (message) => warnings.push(message), debug: () => {} }
  })
  planes.push(plane)
  let binds = 0
  const onBound = plane.driver.onChannelBound.bind(plane.driver)
  plane.driver.onChannelBound = (connection) => {
    binds += 1
    onBound(connection)
  }

  const ensuring = plane.ensureChannel('agent-a')
  const host = new TunnelHost({
    emit: (streamId, event) => client.emit(streamId, event),
    socketPathFor: () => podSocketPath,
    ...(options.maxStreams === undefined ? {} : { maxStreams: options.maxStreams })
  })
  hosts.push(host)
  const client = new ShimClient({
    endpoint: 'accepted-daemon-channel',
    dial: () => shimServer.nextTransport() as Promise<ShimTransport>,
    readToken: () => 'projected-token',
    handle: async (capability, payload) => {
      if (capability !== 'tunnel') throw new Error(`unexpected capability ${capability}`)
      // Held BEFORE the host applies it: the frame has reached the pod's shim but not its socket,
      // which is exactly the state a renewal makes unknowable.
      if (options.holdData && (payload as { op?: string }).op === 'data') await options.holdData()
      return await host.handle(payload)
    },
    clock: shimClock,
    backoff: new Backoff({ jitter: () => 0 }),
    log: { info: () => {}, warn: () => {} }
  })
  clients.push(client)
  void client.start()
  await ensuring
  return { plane, podSocketPath, warnings, shimClock, bindCount: () => binds }
}

/**
 * A proxy wired to a stub channel, for the branches only a lying shim can reach.
 *
 * The dial is stubbed to an unconnected socket rather than a real one: what these assert is which
 * announcements produce a dial at all, and a socket that fails asynchronously would race that.
 */
function proxyUnderTest(options: { stall?: (payload: unknown) => boolean } = {}): {
  instance: TunnelProxy
  dialled: string[]
  sent: unknown[]
  announce: (event: ShimEvent['event'], streamId: string) => void
  /** Fire the session's attach signal — what a credential renewal produces. */
  reattach: () => void
  socketFor: (streamId: string) => Socket | undefined
} {
  const dialled: string[] = []
  const sent: unknown[] = []
  const listeners: Array<(event: ShimEvent) => void> = []
  const attachListeners: Array<() => void> = []
  const dialledSockets = new Map<string, Socket>()
  let lastDialled: Socket | undefined
  const instance = new TunnelProxy({
    session: {
      agentId: 'agent-a',
      request: async (_capability, payload) => {
        sent.push(payload)
        // A frame the channel never settles: what an in-flight request looks like when the socket
        // it was written to is replaced underneath.
        if (options.stall?.(payload)) return await new Promise(() => {})
        return { socketPath: '/run/agentconnect/gitcred.sock' }
      },
      onEvent: (listener) => listeners.push(listener),
      offEvent: () => undefined,
      onAttach: (listener) => attachListeners.push(listener),
      offAttach: () => undefined,
      onLost: () => undefined
    },
    socketPathFor: (tunnel) => (tunnel === 'gitcred' ? '/daemon/gitcred.sock' : '/daemon/mcp.sock'),
    dial: (path) => {
      dialled.push(path)
      const socket = new Socket()
      sockets.push(socket)
      lastDialled = socket
      return socket
    },
    log: { info: () => {}, warn: () => {} }
  })
  return {
    instance,
    dialled,
    sent,
    announce: (event, streamId) => {
      for (const listener of listeners) listener({ type: 'shim/event', streamId, event })
      if (event.kind === 'connect' && lastDialled) dialledSockets.set(streamId, lastDialled)
    },
    reattach: () => {
      for (const listener of attachListeners) listener()
    },
    socketFor: (streamId) => dialledSockets.get(streamId)
  }
}

/** An in-pod client, as the credential helper will be: connect, write, read the reply. */
function inPodClient(path: string): { socket: Socket; received: () => string; ended: () => boolean } {
  const socket = createConnection(path)
  sockets.push(socket)
  let text = ''
  let ended = false
  socket.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')))
  socket.on('close', () => (ended = true))
  socket.on('error', () => (ended = true))
  return { socket, received: () => text, ended: () => ended }
}

describe('the shim tunnel', () => {
  it('carries an in-pod client through to the daemon-side socket and back', async () => {
    // The failure this exists to prevent: the daemon's helper socket is unreachable from the pod,
    // so a private-repo clone asks a credential helper that answers on a machine it is not on.
    const asked: string[] = []
    const daemonSocketPath = daemonSideServer((chunk, socket) => {
      asked.push(chunk.toString('utf8'))
      socket.write('{"ok":true,"password":"token"}\n')
    })
    const { podSocketPath } = await clusterWithTunnel({ daemonSocketPath })

    const helper = inPodClient(podSocketPath)
    helper.socket.write('{"op":"get","agentId":"agent-a"}\n')

    await vi.waitFor(() => expect(helper.received()).toContain('"password":"token"'), waitBudget(10_000))
    // And the daemon's server saw the request verbatim: nothing on the path interprets the bytes.
    expect(asked).toEqual(['{"op":"get","agentId":"agent-a"}\n'])
  })

  it('ends the in-pod connection when the daemon-side server hangs up', async () => {
    // A helper whose socket neither answers nor closes hangs the git operation that spawned it,
    // and git has no deadline of its own — so the hang-up has to travel.
    const daemonSocketPath = daemonSideServer((_chunk, socket) => socket.end())
    const { podSocketPath } = await clusterWithTunnel({ daemonSocketPath })

    const helper = inPodClient(podSocketPath)
    helper.socket.write('ask\n')
    await vi.waitFor(() => expect(helper.ended()).toBe(true), waitBudget(10_000))
  })

  it('keeps a live connection working across a real credential renewal', async () => {
    // The pod's listener and its open connections belong to the POD, not to a channel: the shim
    // reconnects at half the credential TTL, and a helper that was mid-conversation must not care.
    const daemonSocketPath = daemonSideServer((chunk, socket) => socket.write(`echo:${chunk.toString('utf8')}`))
    const { podSocketPath, shimClock, bindCount } = await clusterWithTunnel({
      daemonSocketPath,
      credentialTtlMs: 600_000
    })

    const helper = inPodClient(podSocketPath)
    helper.socket.write('before\n')
    await vi.waitFor(() => expect(helper.received()).toContain('echo:before'), waitBudget(10_000))

    const bindsBefore = bindCount()
    shimClock.advance(300_000)
    await vi.waitFor(() => expect(bindCount()).toBeGreaterThan(bindsBefore), waitBudget(15_000))

    // Same in-pod connection, same daemon-side socket, after the channel underneath was replaced.
    helper.socket.write('after\n')
    await vi.waitFor(() => expect(helper.received()).toContain('echo:after'), waitBudget(10_000))
    expect(helper.ended()).toBe(false)
  }, 40_000)

  it('ends an interrupted stream through the real renewal, so the pod client sees EOF', async () => {
    // The production ordering, which a stubbed session cannot show: the old listener announced
    // a new connection BEFORE sending `shim/bound`, so the daemon's cleanup of an interrupted
    // stream reached a shim that had no binding yet and was refused as `not bound` — with the
    // stream already dropped on this side, leaving the in-pod client waiting on nothing.
    let replied = false
    let release = (): void => undefined
    const held = new Promise<void>((resolve) => (release = resolve))
    const daemonSocketPath = daemonSideServer((_chunk, socket) => {
      replied = true
      socket.write('{"ok":true,"password":"token"}\n')
    })
    const { podSocketPath, shimClock, bindCount } = await clusterWithTunnel({
      daemonSocketPath,
      credentialTtlMs: 600_000,
      holdData: () => held
    })

    const helper = inPodClient(podSocketPath)
    helper.socket.write('{"op":"get"}\n')
    // The daemon has answered and its reply frame is in flight but unapplied.
    await vi.waitFor(() => expect(replied).toBe(true), waitBudget(10_000))

    const bindsBefore = bindCount()
    shimClock.advance(300_000)
    await vi.waitFor(() => expect(bindCount()).toBeGreaterThan(bindsBefore), waitBudget(15_000))

    // The close has to LAND on the new channel: git has no deadline of its own, so a rejected
    // cleanup is a helper that hangs until the idle timer.
    await vi.waitFor(() => expect(helper.ended()).toBe(true), waitBudget(15_000))
    release()
  }, 60_000)

  it('ends a stream whose frame was in flight when the channel was replaced', async () => {
    // The other half of a renewal. `ShimSession.attach` aborts the requests on the socket it
    // replaced, and that abort means a REPLY was lost — not whether the request landed. Re-sending
    // could duplicate bytes inside a request/response protocol, so the stream ends instead and the
    // in-pod client sees EOF. Left open, git would instead wait out the five-minute idle timer.
    const proxy = proxyUnderTest({ stall: (payload) => (payload as { op?: string }).op === 'data' })
    await proxy.instance.ensure('gitcred')

    const streamId = randomUUID()
    proxy.announce({ kind: 'connect', tunnel: 'gitcred' }, streamId)
    expect(proxy.instance.streamCount()).toBe(1)

    // A reply from the daemon's server, whose delivery frame never settles.
    proxy.socketFor(streamId)!.emit('data', Buffer.from('reply'))
    await vi.waitFor(() => expect(proxy.sent.some((p) => (p as { op?: string }).op === 'data')).toBe(true))

    proxy.reattach()
    expect(proxy.instance.streamCount()).toBe(0)
    // And the pod is told, on the channel that just bound, so its client stops waiting.
    await vi.waitFor(() =>
      expect(proxy.sent).toContainEqual(
        expect.objectContaining({ op: 'close', streamId, error: expect.stringContaining('renewed') })
      )
    )
  })

  it('splits a reply larger than one frame instead of dropping it', async () => {
    // 32 KiB per chunk: a single frame is capped at 256 KiB and base64 expands by a third, so a
    // large write has to arrive in pieces — and it has to arrive INTACT and in order.
    const payload = 'x'.repeat(200 * 1024)
    const daemonSocketPath = daemonSideServer((_chunk, socket) => socket.write(payload))
    const { podSocketPath } = await clusterWithTunnel({ daemonSocketPath })

    const helper = inPodClient(podSocketPath)
    helper.socket.write('ask\n')
    await vi.waitFor(() => expect(helper.received().length).toBe(payload.length), waitBudget(15_000))
    expect(helper.received()).toBe(payload)
  }, 40_000)

  it('opens no tunnel for an agent the daemon named none for', async () => {
    // The policy is the daemon's: an agent with no GitHub-App workspace has no business with a
    // credential socket, and a listener it never asked for is one more thing in the pod to reach.
    const daemonSocketPath = daemonSideServer(() => undefined)
    const { podSocketPath } = await clusterWithTunnel({ daemonSocketPath, tunnels: [] })

    const helper = inPodClient(podSocketPath)
    // Nothing is listening in the pod, so the connection fails rather than reaching the daemon.
    await vi.waitFor(() => expect(helper.ended()).toBe(true), waitBudget(10_000))
  })

  it('refuses to serve a tunnel this daemon has no socket for', async () => {
    // Better than dialling something plausible: an unserved tunnel names a socket the daemon does
    // not own, and guessing one would be a path traversal with extra steps.
    const { podSocketPath, warnings } = await clusterWithTunnel({ daemonSocketPath: undefined })
    const helper = inPodClient(podSocketPath)
    await vi.waitFor(() => expect(helper.ended()).toBe(true), waitBudget(10_000))
    expect(warnings.join('\n')).toMatch(/no gitcred socket/)
  })

  it('refuses a connect the daemon never authorized, whoever minted the stream id', async () => {
    // The half-trusted side mints tunnel stream ids and announces them, so this side re-checks
    // every bound the shim already applies: an unauthorized tunnel would dial a daemon socket on
    // the sandbox's say-so, and a re-announced id would strand the socket indexed under it.
    const proxy = proxyUnderTest()

    const foreign = randomUUID()
    proxy.announce({ kind: 'connect', tunnel: 'mcp' }, foreign)
    expect(proxy.dialled).toEqual([])
    expect(proxy.sent).toEqual([expect.objectContaining({ op: 'close', streamId: foreign })])

    await proxy.instance.ensure('gitcred')
    const streamId = randomUUID()
    proxy.announce({ kind: 'connect', tunnel: 'gitcred' }, streamId)
    expect(proxy.dialled).toEqual(['/daemon/gitcred.sock'])
    expect(proxy.instance.streamCount()).toBe(1)

    // The same id again: refused, and the stream that owns it survives.
    proxy.announce({ kind: 'connect', tunnel: 'gitcred' }, streamId)
    expect(proxy.dialled).toEqual(['/daemon/gitcred.sock'])
    expect(proxy.instance.streamCount()).toBe(1)
    expect(proxy.sent.at(-1)).toEqual(expect.objectContaining({ op: 'close', streamId }))
  })

  it('keeps an mcp stream through an idle window that ends a gitcred one', async () => {
    // The two tunnels have opposite shapes, so one deadline cannot fit both. A credential stream is
    // one request and its reply, and silence past a few minutes means no answer is coming. The
    // harness's MCP bridge holds ONE connection for the life of an ACP session and is idle between
    // tool calls — ending that is the agent quietly losing its tools mid-session.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const proxy = proxyUnderTest()
      await proxy.instance.ensure('gitcred')
      await proxy.instance.ensure('mcp')
      const credential = randomUUID()
      const bridge = randomUUID()
      proxy.announce({ kind: 'connect', tunnel: 'gitcred' }, credential)
      proxy.announce({ kind: 'connect', tunnel: 'mcp' }, bridge)
      expect(proxy.instance.streamCount()).toBe(2)

      vi.advanceTimersByTime(10 * 60_000)

      expect(proxy.instance.streamCount()).toBe(1)
      expect(proxy.sent).toContainEqual(expect.objectContaining({ op: 'close', streamId: credential }))
      expect(proxy.sent).not.toContainEqual(expect.objectContaining({ op: 'close', streamId: bridge }))
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses tunnel data for a stream the pod never opened', async () => {
    // The mirror of the above, on the other side: the daemon is the trusted half here, and a
    // stream id it made up must not become a write into whatever socket happens to be indexed.
    const host = new TunnelHost({ emit: () => undefined, socketPathFor: () => join(scratchDir(), 'x.sock') })
    hosts.push(host)
    await expect(
      host.handle({ op: 'data', streamId: randomUUID(), chunk: Buffer.from('x').toString('base64') })
    ).rejects.toThrow(/unknown tunnel stream/)
    // A close for one, by contrast, is ordinary: the connection may have ended as it arrived.
    await expect(host.handle({ op: 'close', streamId: randomUUID() })).resolves.toBeNull()
  })

  it('refuses connections past the stream cap rather than minting unbounded daemon sockets', async () => {
    // The runtime is the untrusted party and it is the one opening these. A connect loop that
    // never reads would otherwise pin one daemon-side socket per iteration.
    const daemonSocketPath = daemonSideServer(() => undefined)
    const { podSocketPath } = await clusterWithTunnel({ daemonSocketPath, maxStreams: 2 })

    const held = [inPodClient(podSocketPath), inPodClient(podSocketPath)]
    await vi.waitFor(() => expect(held.every((client) => !client.ended())).toBe(true), waitBudget(5_000))
    const refused = inPodClient(podSocketPath)
    await vi.waitFor(() => expect(refused.ended()).toBe(true), waitBudget(10_000))
    // The two that were already open are untouched: the cap sheds new work, not live work.
    expect(held.every((client) => !client.ended())).toBe(true)
  })
})
