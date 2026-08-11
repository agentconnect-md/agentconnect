import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, rmSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { dirname } from 'node:path'
import type { ShimEvent } from './protocol.js'
import {
  MAX_TUNNEL_CHUNK_BYTES,
  SANDBOX_TUNNEL_PATHS,
  TunnelPayloadSchema,
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

export interface TunnelHostDeps {
  /** Emit an event on a stream the shim owns. Goes through the client so a chunk produced while
   *  the channel is rebinding is buffered rather than lost, exactly like ACP output. */
  emit: (streamId: string, event: ShimEvent['event']) => void
  /** Where each tunnel is served. The image's fixed map unless a test names another root. */
  socketPathFor?: (tunnel: TunnelName) => string
  maxStreams?: number
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
 * Listeners outlive the channel deliberately. The shim re-dials at half the credential TTL, and
 * a listener torn down on every renewal would break any client that happened to be mid-request
 * — so `listen` is idempotent and the socket belongs to the pod's lifetime.
 */
export class TunnelHost {
  private readonly servers = new Map<TunnelName, Server>()
  private readonly streams = new Map<string, Socket>()
  private readonly socketPathFor: (tunnel: TunnelName) => string
  private readonly maxStreams: number
  private closed = false

  constructor(private readonly deps: TunnelHostDeps) {
    this.socketPathFor = deps.socketPathFor ?? ((tunnel) => SANDBOX_TUNNEL_PATHS[tunnel])
    this.maxStreams = deps.maxStreams ?? MAX_TUNNEL_STREAMS
  }

  /** Serve one authorized `tunnel` request. Unknown ops fail the schema rather than this method. */
  async handle(payload: unknown): Promise<unknown> {
    const parsed: TunnelPayload = TunnelPayloadSchema.parse(payload)
    if (parsed.op === 'listen') return { socketPath: await this.listen(parsed.tunnel) }
    const socket = this.streams.get(parsed.streamId)
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
    for (const [streamId, socket] of [...this.streams]) {
      this.streams.delete(streamId)
      socket.destroy()
    }
    for (const [tunnel, server] of [...this.servers]) {
      this.servers.delete(tunnel)
      server.close()
      rmSync(this.socketPathFor(tunnel), { force: true })
    }
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

  private accept(tunnel: TunnelName, socket: Socket): void {
    if (this.streams.size >= this.maxStreams) {
      this.deps.log?.warn(`shim: refusing a ${tunnel} connection — ${this.maxStreams} streams already open`)
      socket.destroy()
      return
    }
    const streamId = randomUUID()
    this.streams.set(streamId, socket)
    // Announced BEFORE any byte is read, so the daemon has dialled its end (or refused) before
    // the first chunk arrives — chunks for a stream it never saw open have nowhere to go.
    this.deps.emit(streamId, { kind: 'connect', tunnel })
    socket.on('data', (data: Buffer) => {
      // Sliced rather than sent whole: one chunk travels in one frame, and a client is free to
      // write more in a single flush than a frame can carry. Not flow-controlled — an event
      // carries no acknowledgement — which suits the request/response helper protocols this
      // serves; a tunnel carrying bulk transfer would need per-stream acks to pause the socket.
      for (let offset = 0; offset < data.length; offset += MAX_TUNNEL_CHUNK_BYTES) {
        const slice = data.subarray(offset, offset + MAX_TUNNEL_CHUNK_BYTES)
        this.deps.emit(streamId, { kind: 'chunk', data: slice.toString('base64') })
      }
    })
    socket.on('error', (err) => this.finish(streamId, socket, err.message))
    // `close` rather than `end`: a half-open peer that stops reading still ends the stream, and
    // the daemon side must learn about it or its own socket leaks.
    socket.on('close', () => this.finish(streamId, socket))
  }

  private finish(streamId: string, socket: Socket, error?: string): void {
    if (this.streams.get(streamId) !== socket) return
    this.streams.delete(streamId)
    socket.destroy()
    this.deps.emit(streamId, { kind: 'exit', code: error ? 1 : 0, signal: null, ...(error ? { error } : {}) })
  }

  // Unregistered first, so the `close` this produces does not report an exit the daemon already
  // knows about; `end` rather than `destroy` so a client mid-read still sees the daemon's EOF.
  private end(streamId: string, socket: Socket): void {
    this.streams.delete(streamId)
    socket.end()
  }
}
