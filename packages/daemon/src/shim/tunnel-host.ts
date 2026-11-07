import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer, type IncomingMessage } from 'node:http'
import { connect as dialTcp, createServer, type AddressInfo, type Server, type Socket } from 'node:net'
import { dirname, join } from 'node:path'
import { getCACertificates } from 'node:tls'
import type { ShimEvent } from './protocol.js'
import {
  isProxyTunnel,
  MAX_CODEHOST_STREAMS,
  MAX_IN_FLIGHT_FRAMES,
  MAX_PROVIDER_STREAMS,
  MAX_TUNNEL_CHUNK_BYTES,
  SANDBOX_TUNNEL_PATHS,
  TunnelPayloadSchema,
  type ProxyTunnelName,
  type TunnelListening,
  type TunnelName,
  type TunnelPayload
} from './tunnel.js'

/**
 * A cap on concurrently proxied connections, per pod.
 *
 * The runtime is the untrusted party and it is the one that opens these: a loop that connects
 * without reading would otherwise mint an unbounded number of daemon-side sockets, each pinned
 * by a stream the daemon cannot know is abandoned. The helper protocols served here are
 * one-connection-per-invocation and short, so a low ceiling is invisible in normal use.
 */
const MAX_TUNNEL_STREAMS = 32

/** Refused rather than queued: a caller that would exceed the cap has its socket destroyed, so
 *  the failure surfaces in the pod (where the client can report it) rather than as a stall. */
export class TunnelRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TunnelRefusedError'
  }
}

/** The one loopback proxy a shim serves for both proxy tunnels, so a session needs a single `HTTPS_PROXY`. */
interface ProxyListener {
  server: Server
  port: number
  token: string
  /** `host:port` authorities forwarded into each tunnel, lower-cased; code-host routes are matched first. */
  routes: Record<ProxyTunnelName, Set<string>>
}

interface HostStream {
  socket: Socket
  tunnel: TunnelName
  /** Chunks emitted and acknowledged, on a stream whose daemon acknowledges them. */
  flow?: Flow
}

/** `held` is what a read brought past the window, sent as acks make room. */
interface Flow {
  sent: number
  acked: number
  held?: Buffer
}

interface ConnectAuthority {
  host: string
  port: number
  /** `host:port`, lower-cased, an IPv6 host bracketed. */
  key: string
}

/** A CONNECT target's host and port; undefined for anything but a plain `host:port`. */
export function connectAuthority(target: string | undefined): ConnectAuthority | undefined {
  const match = /^(?:\[([0-9a-fA-F:.]+)\]|([A-Za-z0-9.-]+)):(\d{1,5})$/.exec(target ?? '')
  if (!match) return undefined
  const port = Number(match[3])
  if (port < 1 || port > 65_535) return undefined
  const host = (match[1] ?? match[2]!).toLowerCase()
  return { host, port, key: `${match[1] ? `[${host}]` : host}:${port}` }
}

/** Whether a Proxy-Authorization header carries this listener's token as its Basic password. */
function proxyAuthorized(header: string | undefined, token: string): boolean {
  const [scheme, encoded] = (header ?? '').trim().split(/\s+/)
  if (scheme?.toLowerCase() !== 'basic' || !encoded) return false
  const decoded = Buffer.from(encoded, 'base64').toString('utf8')
  const presented = Buffer.from(decoded.slice(decoded.indexOf(':') + 1))
  const expected = Buffer.from(token)
  return presented.length === expected.length && timingSafeEqual(presented, expected)
}

function refuseConnect(socket: Socket, status: number, reason: string): void {
  const challenge = status === 407 ? 'Proxy-Authenticate: Basic realm="agentconnect"\r\n' : ''
  socket.end(`HTTP/1.1 ${status} ${reason}\r\n${challenge}Content-Length: 0\r\nConnection: close\r\n\r\n`)
}

export interface TunnelHostDeps {
  /** Emit an event on a stream the shim owns. Goes through the client so a chunk produced while
   *  the channel is rebinding is buffered rather than lost, exactly like ACP output. */
  emit: (streamId: string, event: ShimEvent['event']) => void
  /** Where each tunnel is served. The image's fixed map unless the entrypoint or a test names another root. */
  socketPathFor?: (tunnel: TunnelName) => string
  /** The helper tunnels' (`gitcred`, `mcp`) shared cap. */
  maxStreams?: number
  maxCodehostStreams?: number
  maxProviderStreams?: number
  log?: { info: (m: string) => void; warn: (m: string) => void }
}

/**
 * The in-pod half of the tunnel: a unix socket per granted tunnel, and a proxied byte stream
 * per connection made to one.
 *
 * It holds no policy and reads nothing it forwards. The daemon decides which tunnels exist and
 * which of its own sockets each reaches; this side only knows that something in the pod
 * connected and that its bytes belong to a stream id.
 *
 * Listeners outlive the channel deliberately. The channel reconnects at half the credential TTL, and
 * a listener torn down on every renewal would break any client that happened to be mid-request
 * — so `listen` is idempotent and the socket belongs to the pod's lifetime.
 */
export class TunnelHost {
  private readonly servers = new Map<TunnelName, Server>()
  private readonly streams = new Map<string, HostStream>()
  /** Tunnels whose daemon acknowledges chunks, as its latest `listen` said; only their streams are paused. */
  private readonly acked = new Set<TunnelName>()
  private readonly socketPathFor: (tunnel: TunnelName) => string
  private readonly maxStreams: number
  private readonly maxProxyStreams: Record<ProxyTunnelName, number>
  private proxy?: Promise<ProxyListener>
  /** The CA each proxy tunnel's latest listen carried, all of which the trust bundle holds. */
  private readonly authorities = new Map<ProxyTunnelName, string>()
  /** Connections the proxy listener sent straight out, which never touch the channel. */
  private readonly direct = new Set<Socket>()
  private closed = false

  constructor(private readonly deps: TunnelHostDeps) {
    this.socketPathFor = deps.socketPathFor ?? ((tunnel) => SANDBOX_TUNNEL_PATHS[tunnel])
    this.maxStreams = deps.maxStreams ?? MAX_TUNNEL_STREAMS
    this.maxProxyStreams = {
      codehost: deps.maxCodehostStreams ?? MAX_CODEHOST_STREAMS,
      provider: deps.maxProviderStreams ?? MAX_PROVIDER_STREAMS
    }
  }

  /** Serve one authorized `tunnel` request. Unknown ops fail the schema rather than this method. */
  async handle(payload: unknown): Promise<unknown> {
    const parsed: TunnelPayload = TunnelPayloadSchema.parse(payload)
    if (parsed.op === 'listen') {
      const listening = isProxyTunnel(parsed.tunnel)
        ? await this.listenProxy(parsed.tunnel, parsed.routes, parsed.ca)
        : ({ socketPath: await this.listen(parsed.tunnel) } satisfies TunnelListening)
      if (parsed.acks) this.acked.add(parsed.tunnel)
      else this.acked.delete(parsed.tunnel)
      return { ...listening, acks: true } satisfies TunnelListening
    }
    const stream = this.streams.get(parsed.streamId)
    if (parsed.op === 'ack') {
      // An unknown id is ordinary, as for a close: the stream may have ended as the ack was in flight.
      if (stream?.flow) this.acknowledge(parsed.streamId, stream, stream.flow, parsed.received)
      return null
    }
    const socket = stream?.socket
    if (parsed.op === 'close') {
      // An unknown id is ordinary here: the connection may have ended on its own as the close
      // was in flight, and reporting that as a failure would make every race look like a bug.
      if (socket) this.end(parsed.streamId, socket)
      return null
    }
    if (!socket) throw new TunnelRefusedError(`unknown tunnel stream ${parsed.streamId}`)
    const chunk = Buffer.from(parsed.chunk, 'base64')
    await new Promise<void>((resolve, reject) => {
      socket.write(chunk, (err) => (err ? reject(err) : resolve()))
    })
    return null
  }

  /** Stop serving. Called on shim shutdown; the pod is going away with it. */
  close(): void {
    this.closed = true
    for (const [streamId, { socket }] of [...this.streams]) {
      this.streams.delete(streamId)
      socket.destroy()
    }
    for (const socket of [...this.direct]) socket.destroy()
    this.direct.clear()
    for (const [tunnel, server] of [...this.servers]) {
      this.servers.delete(tunnel)
      server.close()
      rmSync(this.socketPathFor(tunnel), { force: true })
    }
    void this.proxy?.then((listener) => listener.server.close()).catch(() => undefined)
    this.proxy = undefined
  }

  private async listen(tunnel: TunnelName): Promise<string> {
    if (this.closed) throw new TunnelRefusedError('shim is shutting down')
    const path = this.socketPathFor(tunnel)
    if (this.servers.has(tunnel)) return path
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    // A socket left by a previous incarnation of this pod's shim makes listen() throw with
    // EADDRINUSE; nothing else can legitimately own this path.
    rmSync(path, { force: true })
    const server = createServer((socket) => this.accept(tunnel, socket))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(path, () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
    try {
      // The runtime user is the only intended client and it is this process's own user.
      chmodSync(path, 0o600)
    } catch {
      /* best-effort */
    }
    server.on('error', (err) => this.deps.log?.warn(`shim: tunnel ${tunnel} socket error: ${err.message}`))
    this.servers.set(tunnel, server)
    this.deps.log?.info(`shim: serving tunnel ${tunnel} at ${path}`)
    return path
  }

  /** Serve `codehost` and `provider` as one loopback HTTP proxy on an ephemeral port, since a host shim shares the machine's loopback with other shims. */
  private async listenProxy(
    tunnel: ProxyTunnelName,
    routes: string[] | undefined,
    ca: string | undefined
  ): Promise<TunnelListening> {
    if (this.closed) throw new TunnelRefusedError('shim is shutting down')
    if (!routes?.length || !ca) throw new TunnelRefusedError(`a ${tunnel} listener needs its routes and authority`)
    this.authorities.set(tunnel, ca)
    const trustBundle = this.writeTrustBundle()
    this.proxy ??= this.startProxy().catch((error: unknown) => {
      this.proxy = undefined
      throw error
    })
    const listener = await this.proxy
    // Replaced on every listen, so the latest launch's routes are the ones honored.
    listener.routes[tunnel] = new Set(routes.map((route) => route.toLowerCase()))
    this.deps.log?.info(`shim: serving tunnel ${tunnel} on 127.0.0.1:${listener.port} for ${routes.length} routes`)
    return {
      socketPath: `127.0.0.1:${listener.port}`,
      proxy: { port: listener.port, token: listener.token, trustBundle }
    }
  }

  /** This machine's roots plus the daemon's CA, beside the shim's runtime files: SSL_CERT_FILE replaces a client's roots, so the CA alone would break every other host. */
  private writeTrustBundle(): string {
    const path = join(dirname(this.socketPathFor('codehost')), 'codehost-trust.pem')
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const authorities = [...this.authorities.values()]
    const roots = [...getCACertificates('default'), ...getCACertificates('system'), ...authorities].map((pem) =>
      pem.trim()
    )
    const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`
    writeFileSync(temporary, `${[...new Set(roots)].join('\n')}\n`, { mode: 0o600 })
    renameSync(temporary, path)
    return path
  }

  private async startProxy(): Promise<ProxyListener> {
    const server = createHttpServer((_request, response) => {
      // Only CONNECT is proxied: a session's HTTPS clients tunnel, and nothing here forwards plain HTTP.
      response.writeHead(405, { connection: 'close', 'content-length': '0' })
      response.end()
    })
    const listener: ProxyListener = {
      server,
      port: 0,
      token: randomBytes(24).toString('base64url'),
      routes: { codehost: new Set(), provider: new Set() }
    }
    server.on('connect', (request: IncomingMessage, socket: Socket, head: Buffer) =>
      this.proxyConnect(listener, request, socket, head)
    )
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
    server.on('error', (err) => this.deps.log?.warn(`shim: proxy listener error: ${err.message}`))
    listener.port = (server.address() as AddressInfo).port
    return listener
  }

  /** A code-host or provider CONNECT goes into its tunnel as the daemon's proxy expects it; any other host is reached directly, as the session would without a proxy. */
  private proxyConnect(listener: ProxyListener, request: IncomingMessage, socket: Socket, head: Buffer): void {
    socket.on('error', () => socket.destroy())
    if (this.closed) return refuseConnect(socket, 503, 'Service Unavailable')
    if (!proxyAuthorized(request.headers['proxy-authorization'], listener.token))
      return refuseConnect(socket, 407, 'Proxy Authentication Required')
    const authority = connectAuthority(request.url)
    if (!authority) return refuseConnect(socket, 400, 'Bad Request')
    const tunnel = (['codehost', 'provider'] as const).find((name) => listener.routes[name].has(authority.key))
    if (!tunnel) return this.connectDirect(authority, socket, head)
    const cap = this.maxProxyStreams[tunnel]
    if (this.streamCount(tunnel) >= cap) {
      this.deps.log?.warn(`shim: refusing a ${tunnel} connection — ${cap} streams already open`)
      return refuseConnect(socket, 503, 'Service Unavailable')
    }
    // A clean CONNECT for the daemon's proxy, so no client header (this listener's credential among them) leaves the machine.
    const connect = Buffer.from(`CONNECT ${authority.key} HTTP/1.1\r\nHost: ${authority.key}\r\n\r\n`)
    this.open(tunnel, socket, head.length > 0 ? Buffer.concat([connect, head]) : connect)
  }

  private connectDirect(authority: ConnectAuthority, socket: Socket, head: Buffer): void {
    const upstream = dialTcp({ host: authority.host, port: authority.port })
    let connected = false
    this.direct.add(socket)
    upstream.once('connect', () => {
      connected = true
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length > 0) upstream.write(head)
      socket.pipe(upstream)
      upstream.pipe(socket)
    })
    upstream.on('error', () => (connected ? socket.destroy() : refuseConnect(socket, 502, 'Bad Gateway')))
    upstream.on('close', () => {
      if (connected) socket.destroy()
    })
    socket.on('close', () => {
      this.direct.delete(socket)
      upstream.destroy()
    })
  }

  private accept(tunnel: TunnelName, socket: Socket): void {
    if (this.streamCount('helpers') >= this.maxStreams) {
      this.deps.log?.warn(`shim: refusing a ${tunnel} connection — ${this.maxStreams} streams already open`)
      socket.destroy()
      return
    }
    this.open(tunnel, socket)
  }

  /** Open streams on one proxy tunnel's budget, or on the helpers' shared one. */
  private streamCount(budget: ProxyTunnelName | 'helpers'): number {
    let count = 0
    for (const { tunnel } of this.streams.values())
      if ((isProxyTunnel(tunnel) ? tunnel : 'helpers') === budget) count += 1
    return count
  }

  private open(tunnel: TunnelName, socket: Socket, preface?: Buffer): void {
    const streamId = randomUUID()
    const flow = this.acked.has(tunnel) ? { flow: { sent: 0, acked: 0 } } : {}
    this.streams.set(streamId, { socket, tunnel, ...flow })
    // Announced BEFORE any byte is read, so the daemon has dialled its end (or refused) before
    // the first chunk arrives — chunks for a stream it never saw open have nowhere to go.
    this.deps.emit(streamId, { kind: 'connect', tunnel })
    if (preface) this.forward(streamId, preface)
    socket.on('data', (data: Buffer) => this.forward(streamId, data))
    socket.on('error', (err) => this.finish(streamId, socket, err.message))
    // `close` rather than `end`: a half-open peer that stops reading still ends the stream, and
    // the daemon side must learn about it or its own socket leaks.
    socket.on('close', () => this.finish(streamId, socket))
  }

  // Sliced, one chunk per frame; a stream whose daemon acknowledges chunks sends up to its window and holds the rest.
  private forward(streamId: string, data: Buffer): void {
    const stream = this.streams.get(streamId)
    if (!stream) return
    const flow = stream.flow
    if (!flow) {
      for (let offset = 0; offset < data.length; offset += MAX_TUNNEL_CHUNK_BYTES) {
        const slice = data.subarray(offset, offset + MAX_TUNNEL_CHUNK_BYTES)
        this.deps.emit(streamId, { kind: 'chunk', data: slice.toString('base64') })
      }
      return
    }
    flow.held = flow.held ? Buffer.concat([flow.held, data]) : data
    this.release(streamId, stream, flow)
  }

  /** Send held bytes while the window has room, reading the socket again only once nothing is held. */
  private release(streamId: string, stream: HostStream, flow: Flow): void {
    let offset = 0
    const held = flow.held ?? Buffer.alloc(0)
    while (offset < held.length && flow.sent - flow.acked < MAX_IN_FLIGHT_FRAMES) {
      const slice = held.subarray(offset, offset + MAX_TUNNEL_CHUNK_BYTES)
      this.deps.emit(streamId, { kind: 'chunk', data: slice.toString('base64') })
      flow.sent += 1
      offset += slice.length
    }
    flow.held = offset < held.length ? held.subarray(offset) : undefined
    if (flow.held || flow.sent - flow.acked >= MAX_IN_FLIGHT_FRAMES) stream.socket.pause()
    else if (stream.socket.isPaused()) stream.socket.resume()
  }

  /** Apply a cumulative ack, never past what was sent, and release what the window now has room for. */
  private acknowledge(streamId: string, stream: HostStream, flow: Flow, received: number): void {
    flow.acked = Math.max(flow.acked, Math.min(received, flow.sent))
    this.release(streamId, stream, flow)
  }

  private finish(streamId: string, socket: Socket, error?: string): void {
    if (this.streams.get(streamId)?.socket !== socket) return
    this.streams.delete(streamId)
    socket.destroy()
    this.deps.emit(streamId, { kind: 'exit', code: error ? 1 : 0, signal: null, ...(error ? { error } : {}) })
  }

  // Unregistered first so its `close` reports no exit; `end` keeps the daemon's EOF, and resuming discards a paused client's unsent bytes so it can close.
  private end(streamId: string, socket: Socket): void {
    this.streams.delete(streamId)
    socket.end()
    socket.resume()
  }
}
