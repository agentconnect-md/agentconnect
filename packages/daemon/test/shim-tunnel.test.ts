import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
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
import type { Sandbox, SandboxClaim, SandboxFence } from '../src/k8s/sandbox-api.js'
import { fakeGenerations } from './fake-generations.js'
import { fenceFakeSandbox } from './fake-sandbox-fence.js'
import type { ShimEvent } from '../src/shim/protocol.js'
import {
  ACK_EVERY_FRAMES,
  MAX_CODEHOST_STREAMS,
  MAX_IN_FLIGHT_FRAMES,
  MAX_PROVIDER_STREAMS,
  MAX_TUNNEL_CHUNK_BYTES,
  type TunnelName
} from '../src/shim/tunnel.js'
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
const proxies: TunnelProxy[] = []
const sockets: Socket[] = []
const dirs: string[] = []
/** The routes the provider listen carries, which a test changes to see the listen asked again. */
let providerRoutes = ['api.anthropic.com:443']

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy()
  for (const host of hosts.splice(0)) host.close()
  for (const proxy of proxies.splice(0)) proxy.stop('test over')
  for (const client of clients.splice(0)) client.stop()
  for (const plane of planes.splice(0)) await plane.stop()
  for (const server of shimServers.splice(0)) await server.stop()
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A short directory for sockets, since a unix socket path is capped near 104 bytes and the platform temp dir can be long. */
function socketDir(): string {
  const dir = mkdtempSync('/tmp/actb-')
  dirs.push(dir)
  return dir
}

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
    fenceSandbox: async (_name: string, fence: SandboxFence) => fenceFakeSandbox(sandbox, fence),
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

/** The daemon's own server behind the tunnel — agent.sock's stand-in. */
function daemonSideServer(onData: (chunk: Buffer, socket: Socket) => void): string {
  const dir = scratchDir()
  const path = join(dir, 'agent.sock')
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
  const podSocketPath = join(scratchDir(), 'pod-agent.sock')
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
    tunnelsFor: () => options.tunnels ?? ['agent'],
    tunnelSocketPath: (tunnel) => (tunnel === 'agent' ? options.daemonSocketPath : undefined),
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
function proxyUnderTest(
  options: { stall?: (payload: unknown) => boolean; hold?: (payload: unknown) => boolean } = {}
): {
  instance: TunnelProxy
  dialled: string[]
  sent: unknown[]
  /** Settles held frames in send order: `ack` acknowledges, `fail` rejects. */
  held: Array<{ ack: () => void; fail: (error: Error) => void }>
  announce: (event: ShimEvent['event'], streamId: string) => void
  /** Fire the session's attach signal — what a credential renewal produces. */
  reattach: () => void
  socketFor: (streamId: string) => Socket | undefined
} {
  const dialled: string[] = []
  const sent: unknown[] = []
  const held: Array<{ ack: () => void; fail: (error: Error) => void }> = []
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
        if (options.hold?.(payload)) {
          return await new Promise((resolve, reject) => held.push({ ack: () => resolve({}), fail: reject }))
        }
        const named = (payload as { tunnel?: string }).tunnel
        if (named === 'codehost' || named === 'provider')
          return { socketPath: '127.0.0.1:1', proxy: { port: 1, token: 'x'.repeat(32), trustBundle: '/rt/trust.pem' } }
        return { socketPath: '/run/agentconnect/agent.sock' }
      },
      onEvent: (listener) => listeners.push(listener),
      offEvent: () => undefined,
      onAttach: (listener) => attachListeners.push(listener),
      offAttach: () => undefined,
      onLost: () => undefined
    },
    socketPathFor: (tunnel) => `/daemon/${tunnel}.sock`,
    listenOptions: (tunnel) =>
      tunnel === 'codehost'
        ? { routes: ['github.com:443'], ca: 'example certificate' }
        : tunnel === 'provider'
          ? { routes: providerRoutes, ca: 'example certificate' }
          : undefined,
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
    held,
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
    await proxy.instance.ensure('agent')

    const streamId = randomUUID()
    proxy.announce({ kind: 'connect', tunnel: 'agent' }, streamId)
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

  it('pauses a stream past its in-flight window and resumes it as the pod acknowledges', async () => {
    // An 8 MiB reply used to become ~256 concurrent shim requests; the window bounds what one stream has outstanding.
    const isData = (payload: unknown): boolean => (payload as { op?: string }).op === 'data'
    const proxy = proxyUnderTest({ hold: isData })
    await proxy.instance.ensure('agent')
    const streamId = randomUUID()
    proxy.announce({ kind: 'connect', tunnel: 'agent' }, streamId)
    const socket = proxy.socketFor(streamId)!

    socket.emit('data', Buffer.alloc(MAX_IN_FLIGHT_FRAMES * MAX_TUNNEL_CHUNK_BYTES))
    expect(proxy.sent.filter(isData)).toHaveLength(MAX_IN_FLIGHT_FRAMES)
    expect(socket.isPaused()).toBe(true)

    proxy.held.shift()!.ack()
    await vi.waitFor(() => expect(socket.isPaused()).toBe(false))
    expect(proxy.instance.streamCount()).toBe(1)
  })

  it('still ends a paused stream whose frame is not delivered, sending nothing again', async () => {
    const isData = (payload: unknown): boolean => (payload as { op?: string }).op === 'data'
    const proxy = proxyUnderTest({ hold: isData })
    await proxy.instance.ensure('agent')
    const streamId = randomUUID()
    proxy.announce({ kind: 'connect', tunnel: 'agent' }, streamId)
    proxy.socketFor(streamId)!.emit('data', Buffer.alloc(MAX_IN_FLIGHT_FRAMES * MAX_TUNNEL_CHUNK_BYTES))

    proxy.held.shift()!.fail(new Error('socket replaced'))
    await vi.waitFor(() => expect(proxy.instance.streamCount()).toBe(0))
    for (const frame of proxy.held.splice(0)) frame.ack()
    await vi.waitFor(() =>
      expect(proxy.sent).toContainEqual(
        expect.objectContaining({ op: 'close', streamId, error: expect.stringContaining('could not be delivered') })
      )
    )
    expect(proxy.sent.filter(isData)).toHaveLength(MAX_IN_FLIGHT_FRAMES)
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
    expect(warnings.join('\n')).toMatch(/no agent socket/)
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

    await proxy.instance.ensure('agent')
    const streamId = randomUUID()
    proxy.announce({ kind: 'connect', tunnel: 'agent' }, streamId)
    expect(proxy.dialled).toEqual(['/daemon/agent.sock'])
    expect(proxy.instance.streamCount()).toBe(1)

    // The same id again: refused, and the stream that owns it survives.
    proxy.announce({ kind: 'connect', tunnel: 'agent' }, streamId)
    expect(proxy.dialled).toEqual(['/daemon/agent.sock'])
    expect(proxy.instance.streamCount()).toBe(1)
    expect(proxy.sent.at(-1)).toEqual(expect.objectContaining({ op: 'close', streamId }))
  })

  it('keeps an mcp stream through an idle window that ends an agent one', async () => {
    // The two tunnels have opposite shapes, so one deadline cannot fit both. A credential stream is
    // one request and its reply, and silence past a few minutes means no answer is coming. The
    // harness's MCP bridge holds ONE connection for the life of an ACP session and is idle between
    // tool calls — ending that is the agent quietly losing its tools mid-session.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const proxy = proxyUnderTest()
      await proxy.instance.ensure('agent')
      await proxy.instance.ensure('mcp')
      const credential = randomUUID()
      const bridge = randomUUID()
      proxy.announce({ kind: 'connect', tunnel: 'agent' }, credential)
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

  it('caps codehost streams on their own budget, so they cannot take the helper tunnels’ slots', async () => {
    const proxy = proxyUnderTest()
    await proxy.instance.ensure('codehost')
    await proxy.instance.ensure('agent')
    expect(proxy.sent[0]).toEqual({
      op: 'listen',
      tunnel: 'codehost',
      routes: ['github.com:443'],
      ca: 'example certificate',
      acks: true
    })
    expect(proxy.instance.listeningAt('codehost')?.proxy?.port).toBe(1)
    for (let i = 0; i < MAX_CODEHOST_STREAMS; i += 1)
      proxy.announce({ kind: 'connect', tunnel: 'codehost' }, randomUUID())
    expect(proxy.instance.streamCount('codehost')).toBe(MAX_CODEHOST_STREAMS)
    expect(proxy.dialled.every((path) => path === '/daemon/codehost.sock')).toBe(true)

    const refused = randomUUID()
    proxy.announce({ kind: 'connect', tunnel: 'codehost' }, refused)
    expect(proxy.instance.streamCount('codehost')).toBe(MAX_CODEHOST_STREAMS)
    expect(proxy.sent.at(-1)).toEqual(expect.objectContaining({ op: 'close', streamId: refused }))

    // A full codehost budget leaves the helpers theirs.
    proxy.announce({ kind: 'connect', tunnel: 'agent' }, randomUUID())
    expect(proxy.instance.streamCount('helpers')).toBe(1)
  })

  it('caps provider streams on a budget of their own, wider than codehost’s', async () => {
    const proxy = proxyUnderTest()
    await proxy.instance.ensure('codehost')
    await proxy.instance.ensure('provider')
    await proxy.instance.ensure('agent')
    expect(MAX_PROVIDER_STREAMS).toBeGreaterThan(MAX_CODEHOST_STREAMS)
    for (let i = 0; i < MAX_PROVIDER_STREAMS; i += 1)
      proxy.announce({ kind: 'connect', tunnel: 'provider' }, randomUUID())
    expect(proxy.instance.streamCount('provider')).toBe(MAX_PROVIDER_STREAMS)
    expect(new Set(proxy.dialled)).toEqual(new Set(['/daemon/provider.sock']))
    const refused = randomUUID()
    proxy.announce({ kind: 'connect', tunnel: 'provider' }, refused)
    expect(proxy.instance.streamCount('provider')).toBe(MAX_PROVIDER_STREAMS)
    expect(proxy.sent.at(-1)).toEqual(expect.objectContaining({ op: 'close', streamId: refused }))
    // A full provider budget leaves codehost and the helpers theirs.
    proxy.announce({ kind: 'connect', tunnel: 'codehost' }, randomUUID())
    proxy.announce({ kind: 'connect', tunnel: 'agent' }, randomUUID())
    expect(proxy.instance.streamCount('codehost')).toBe(1)
    expect(proxy.instance.streamCount('helpers')).toBe(1)
  })

  it('keeps a quiet provider stream through an idle window that ends a codehost one', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const proxy = proxyUnderTest()
      await proxy.instance.ensure('codehost')
      await proxy.instance.ensure('provider')
      const clone = randomUUID()
      const model = randomUUID()
      proxy.announce({ kind: 'connect', tunnel: 'codehost' }, clone)
      proxy.announce({ kind: 'connect', tunnel: 'provider' }, model)
      vi.advanceTimersByTime(10 * 60_000)
      expect(proxy.sent).toContainEqual(expect.objectContaining({ op: 'close', streamId: clone }))
      expect(proxy.instance.streamCount('provider')).toBe(1)
      vi.advanceTimersByTime(25 * 60_000)
      expect(proxy.instance.streamCount('provider')).toBe(0)
      expect(proxy.sent).toContainEqual(expect.objectContaining({ op: 'close', streamId: model }))
    } finally {
      vi.useRealTimers()
    }
  })

  it('asks a shim again when a provider tunnel’s routes changed, and not otherwise', async () => {
    providerRoutes = ['api.anthropic.com:443']
    try {
      const proxy = proxyUnderTest()
      await proxy.instance.ensure('provider')
      await proxy.instance.ensure('provider')
      expect(proxy.sent.filter((frame) => (frame as { op: string }).op === 'listen')).toHaveLength(1)
      providerRoutes = ['llm.example.test:443']
      await proxy.instance.ensure('provider')
      expect(proxy.sent.at(-1)).toMatchObject({ op: 'listen', tunnel: 'provider', routes: ['llm.example.test:443'] })
    } finally {
      providerRoutes = ['api.anthropic.com:443']
    }
  })

  it('serves no codehost tunnel on a shim that reports no listener for it', async () => {
    // An older shim refuses the name outright; one that answers without a listener must not be pointed at either.
    const sessionRequest = vi.fn(async () => ({ socketPath: '127.0.0.1:1' }))
    const bare = new TunnelProxy({
      session: {
        agentId: 'agent-a',
        request: sessionRequest,
        onEvent: () => undefined,
        offEvent: () => undefined,
        onAttach: () => undefined,
        offAttach: () => undefined,
        onLost: () => undefined
      },
      socketPathFor: () => '/daemon/codehost.sock',
      listenOptions: () => ({ routes: ['github.com:443'], ca: 'example certificate' }),
      log: { info: () => {}, warn: () => {} }
    })
    await expect(bare.ensure('codehost')).rejects.toThrow(/no codehost listener/)
    expect(bare.serves('codehost')).toBe(false)
  })

  it('ends an idle codehost stream, as it does an agent one', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const proxy = proxyUnderTest()
      await proxy.instance.ensure('codehost')
      const streamId = randomUUID()
      proxy.announce({ kind: 'connect', tunnel: 'codehost' }, streamId)
      vi.advanceTimersByTime(10 * 60_000)
      expect(proxy.instance.streamCount()).toBe(0)
      expect(proxy.sent).toContainEqual(expect.objectContaining({ op: 'close', streamId }))
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

/** The daemon's server for a transfer: once `total` bytes arrive it answers with their SHA-256. */
function hashingServer(total: number): string {
  const path = join(socketDir(), 'daemon.sock')
  const server = createServer((socket) => {
    const hash = createHash('sha256')
    let received = 0
    socket.on('data', (chunk: Buffer) => {
      hash.update(chunk)
      received += chunk.length
      if (received === total) socket.write(hash.digest('hex'))
    })
    socket.on('error', () => undefined)
  })
  servers.push(server)
  server.listen(path)
  return path
}

/** A real proxy and host joined in memory; `legacy` strips the ack fields an older peer neither sends nor reads. */
async function tunnelPair(
  daemonSocketPath: string,
  options: { legacy?: 'shim' | 'holder'; failAcks?: number } = {}
): Promise<{ podPath: string; requests: Array<{ op?: string }>; maxOutstanding: () => number; proxy: TunnelProxy }> {
  const podPath = join(socketDir(), 'pod.sock')
  const listeners: Array<(event: ShimEvent) => void> = []
  const requests: Array<{ op?: string }> = []
  let emitted = 0
  let acked = 0
  let maxOutstanding = 0
  let failAcks = options.failAcks ?? 0
  const host = new TunnelHost({
    emit: (streamId, event) => {
      if (event.kind === 'chunk') maxOutstanding = Math.max(maxOutstanding, ++emitted - acked)
      queueMicrotask(() => {
        for (const listener of listeners) listener({ type: 'shim/event', streamId, event })
      })
    },
    socketPathFor: () => podPath
  })
  hosts.push(host)
  const strip = (value: unknown): unknown => {
    if (!value || typeof value !== 'object') return value
    const { acks: _acks, ...rest } = value as Record<string, unknown>
    return rest
  }
  const proxy = new TunnelProxy({
    session: {
      agentId: 'agent-a',
      request: async (_capability, payload) => {
        const frame = payload as { op?: string; received?: number }
        requests.push(frame)
        if (frame.op === 'ack' && options.legacy === 'shim') throw new Error('invalid tunnel payload')
        if (frame.op === 'ack' && failAcks > 0) {
          failAcks -= 1
          throw new Error('shim channel renewed')
        }
        // Counted before the host applies it, since the host sends what the ack makes room for synchronously.
        if (frame.op === 'ack') acked = Math.max(acked, frame.received!)
        const reply = await host.handle(options.legacy && frame.op === 'listen' ? strip(payload) : payload)
        return options.legacy ? strip(reply) : reply
      },
      onEvent: (listener) => listeners.push(listener),
      offEvent: () => undefined,
      onAttach: () => undefined,
      offAttach: () => undefined,
      onLost: () => undefined
    },
    socketPathFor: () => daemonSocketPath,
    log: { info: () => {}, warn: () => {} }
  })
  proxies.push(proxy)
  await proxy.ensure('agent')
  return { podPath, requests, maxOutstanding: () => maxOutstanding, proxy }
}

/** Write `bytes` from inside the pod and resolve with the daemon server's digest of what it received. */
async function transfer(podPath: string, bytes: Buffer): Promise<string> {
  const client = inPodClient(podPath)
  client.socket.write(bytes)
  await vi.waitFor(() => expect(client.received()).toHaveLength(64), waitBudget(20_000))
  return client.received()
}

const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

describe('shim-side tunnel flow control', () => {
  it('pauses a shim-side stream at its window and resumes it as the daemon acknowledges', async () => {
    // A large push through the codehost tunnel used to be read as fast as the runtime wrote it and queued on the channel.
    const chunks: string[] = []
    let streamId = ''
    const path = join(socketDir(), 'pod.sock')
    const host = new TunnelHost({
      emit: (id, event) => {
        if (event.kind === 'connect') streamId = id
        if (event.kind === 'chunk') chunks.push(event.data)
      },
      socketPathFor: () => path
    })
    hosts.push(host)
    expect(await host.handle({ op: 'listen', tunnel: 'agent', acks: true })).toEqual(
      expect.objectContaining({ acks: true })
    )
    inPodClient(path)
    await vi.waitFor(() => expect(streamId).not.toBe(''))
    const socket = (host as unknown as { streams: Map<string, { socket: Socket }> }).streams.get(streamId)!.socket

    // One read far past the window, as a Linux socket delivers: the window's worth goes out and the rest is held.
    const frames = 3 * MAX_IN_FLIGHT_FRAMES
    const bytes = randomBytes(frames * MAX_TUNNEL_CHUNK_BYTES)
    socket.emit('data', bytes)
    expect(chunks).toHaveLength(MAX_IN_FLIGHT_FRAMES)
    expect(socket.isPaused()).toBe(true)

    await host.handle({ op: 'ack', streamId, received: ACK_EVERY_FRAMES })
    expect(chunks).toHaveLength(MAX_IN_FLIGHT_FRAMES + ACK_EVERY_FRAMES)
    expect(socket.isPaused()).toBe(true)

    // A repeated or overstated ack is harmless: acks are cumulative and capped at what was sent.
    await host.handle({ op: 'ack', streamId, received: ACK_EVERY_FRAMES })
    expect(chunks).toHaveLength(MAX_IN_FLIGHT_FRAMES + ACK_EVERY_FRAMES)
    while (chunks.length < frames) {
      const before = chunks.length
      await host.handle({ op: 'ack', streamId, received: Number.MAX_SAFE_INTEGER })
      expect(chunks.length - before).toBeLessThanOrEqual(MAX_IN_FLIGHT_FRAMES)
      expect(chunks.length).toBeGreaterThan(before)
    }
    expect(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk, 'base64')))).toEqual(bytes)
    await host.handle({ op: 'ack', streamId, received: frames })
    expect(socket.isPaused()).toBe(false)
  })

  it('keeps a shim-side stream unpaused for a daemon that never acknowledges', async () => {
    const chunks: string[] = []
    const path = join(socketDir(), 'pod.sock')
    const host = new TunnelHost({
      emit: (_id, event) => (event.kind === 'chunk' ? chunks.push(event.data) : undefined),
      socketPathFor: () => path
    })
    hosts.push(host)
    await host.handle({ op: 'listen', tunnel: 'agent' })
    const bytes = randomBytes(3 * MAX_IN_FLIGHT_FRAMES * MAX_TUNNEL_CHUNK_BYTES)
    inPodClient(path).socket.write(bytes)
    await vi.waitFor(() => expect(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk, 'base64')))).toEqual(bytes))
  })

  it('carries a large upload intact, bounded by the window, between current peers', async () => {
    const bytes = randomBytes(4 * 1024 * 1024)
    const pair = await tunnelPair(hashingServer(bytes.length))
    expect(await transfer(pair.podPath, bytes)).toBe(digest(bytes))
    expect(pair.requests.filter((frame) => frame.op === 'ack').length).toBeGreaterThan(0)
    expect(pair.maxOutstanding()).toBeLessThanOrEqual(MAX_IN_FLIGHT_FRAMES)
  })

  it.each(['shim', 'holder'] as const)(
    'carries a large upload intact with an older %s, sending no ack',
    async (legacy) => {
      const bytes = randomBytes(1024 * 1024)
      const pair = await tunnelPair(hashingServer(bytes.length), { legacy })
      expect(await transfer(pair.podPath, bytes)).toBe(digest(bytes))
      expect(pair.requests.filter((frame) => frame.op === 'ack')).toEqual([])
    }
  )

  it('resends an acknowledgement a renewal lost, with no further chunk to prompt it', async () => {
    const sent: Array<{ op?: string; received?: number }> = []
    const listeners: Array<(event: ShimEvent) => void> = []
    let failAcks = 1
    const proxy = new TunnelProxy({
      session: {
        agentId: 'agent-a',
        request: async (_capability, payload) => {
          const frame = payload as { op?: string; received?: number }
          sent.push(frame)
          if (frame.op === 'ack' && failAcks-- > 0) throw new Error('shim channel renewed')
          return frame.op === 'listen' ? { socketPath: '/run/agentconnect/agent.sock', acks: true } : null
        },
        onEvent: (listener) => listeners.push(listener),
        offEvent: () => undefined,
        onAttach: () => undefined,
        offAttach: () => undefined,
        onLost: () => undefined
      },
      socketPathFor: () => hashingServer(Number.MAX_SAFE_INTEGER),
      log: { info: () => {}, warn: () => {} }
    })
    proxies.push(proxy)
    await proxy.ensure('agent')
    const streamId = randomUUID()
    const announce = (event: ShimEvent['event']): void => {
      for (const listener of listeners) listener({ type: 'shim/event', streamId, event })
    }
    announce({ kind: 'connect', tunnel: 'agent' })
    // Exactly one ack's worth: the shim, paused at its window, sends nothing more until this one lands.
    for (let i = 0; i < ACK_EVERY_FRAMES; i += 1) announce({ kind: 'chunk', data: Buffer.from('x').toString('base64') })

    await vi.waitFor(() =>
      expect(sent.filter((frame) => frame.op === 'ack')).toEqual([
        { op: 'ack', streamId, received: ACK_EVERY_FRAMES },
        { op: 'ack', streamId, received: ACK_EVERY_FRAMES }
      ])
    )
    expect(proxy.streamCount()).toBe(1)
  })

  it('ends a stream whose acknowledgement is lost twice, rather than leave it paused', async () => {
    const pair = await tunnelPair(hashingServer(Number.MAX_SAFE_INTEGER), { failAcks: 2 })
    const client = inPodClient(pair.podPath)
    // Far more than the window, so the client is still writing into a paused stream when it ends.
    client.socket.write(randomBytes(64 * MAX_IN_FLIGHT_FRAMES * MAX_TUNNEL_CHUNK_BYTES))
    await vi.waitFor(() => expect(client.ended()).toBe(true), waitBudget(10_000))
    expect(pair.requests).toContainEqual(
      expect.objectContaining({ op: 'close', error: expect.stringContaining('acknowledgement could not be delivered') })
    )
  })

  it('carries a large upload intact through a real shim channel', async () => {
    const bytes = randomBytes(1024 * 1024)
    const { podSocketPath } = await clusterWithTunnel({ daemonSocketPath: hashingServer(bytes.length) })
    expect(await transfer(podSocketPath, bytes)).toBe(digest(bytes))
  }, 40_000)
})
