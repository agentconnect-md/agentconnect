import { createConnection, type Socket } from 'node:net'
import type { ShimCapability, ShimEvent } from './protocol.js'
import {
  ACK_EVERY_FRAMES,
  isProxyTunnel,
  MAX_CODEHOST_STREAMS,
  MAX_IN_FLIGHT_FRAMES,
  MAX_PROVIDER_STREAMS,
  MAX_TUNNEL_CHUNK_BYTES,
  TunnelListeningSchema,
  type ProxyTunnelName,
  type TunnelListening,
  type TunnelListenOptions,
  type TunnelName
} from './tunnel.js'

/** Silence after which a stream ends, per tunnel (`null` for none): agent and codehost carry finite exchanges, while mcp's bridge idles between tool calls for a whole session and is bounded by its channel. */
const STREAM_IDLE_MS: Readonly<Record<TunnelName, number | null>> = {
  agent: 5 * 60_000,
  mcp: null,
  codehost: 5 * 60_000,
  // A model stream can sit silent for minutes while the model thinks, and a client keeps its connection for the next turn.
  provider: 30 * 60_000
}

/** This side's own cap on concurrent helper (`agent`, `mcp`) streams per agent, protecting the daemon from a shim that does not enforce its own. */
const MAX_TUNNEL_STREAMS = 32

/** Each stream budget's cap: the helpers share one, and each proxy tunnel has its own. */
const STREAM_CAPS: Readonly<Record<ProxyTunnelName | 'helpers', number>> = {
  helpers: MAX_TUNNEL_STREAMS,
  codehost: MAX_CODEHOST_STREAMS,
  provider: MAX_PROVIDER_STREAMS
}

/** The budget a tunnel's streams count against. */
function streamBudget(tunnel: TunnelName): ProxyTunnelName | 'helpers' {
  return isProxyTunnel(tunnel) ? tunnel : 'helpers'
}

export interface TunnelProxyDeps {
  /** The agent's logical channel. Requests carry its credential and generation, so a frame from
   *  a superseded incarnation is refused on the far side. */
  session: {
    agentId: string
    request: (capability: ShimCapability, payload: unknown) => Promise<unknown>
    onEvent: (listener: (event: ShimEvent) => void) => void
    offEvent: (listener: (event: ShimEvent) => void) => void
    onAttach: (listener: () => void) => void
    offAttach: (listener: () => void) => void
    onLost: (listener: (reason: string) => void) => void
  }
  /** This daemon's own socket for a tunnel, or undefined when it serves none — an unserved
   *  tunnel must be refused rather than dialled somewhere plausible. */
  socketPathFor: (tunnel: TunnelName) => string | undefined
  /** Bytes written to the daemon socket before any pod byte, naming this pod to the server (the agent channel's window binding). */
  greeting?: (tunnel: TunnelName) => Buffer | undefined
  /** What a `listen` carries beside the name: `codehost`'s or `provider`'s routes and the CA its sessions trust. */
  listenOptions?: (tunnel: TunnelName) => TunnelListenOptions | undefined
  /** Dials a local unix socket. Injected so a test can stand in for the daemon's server. */
  dial?: (path: string) => Socket
  log: { info: (m: string) => void; warn: (m: string) => void }
}

interface ProxyStream {
  socket: Socket
  tunnel: TunnelName
  timer?: NodeJS.Timeout
  inFlight: number
  /** Shim chunks written out and acknowledged, on a stream whose shim takes acks; `sending` while one ack is in flight. */
  acks?: { received: number; acked: number; sending: boolean }
}

/**
 * The daemon-side half of the tunnel: one local socket per connection a sandbox reports.
 *
 * The direction is what shapes this. A tunnel exists because a process INSIDE the pod wants a
 * daemon-side server, and shim requests only ever flow daemon → shim — so the pod announces the
 * connection as an event and the daemon answers by dialling its own end. Nothing here inspects
 * what it forwards: authorization for these servers is per-agent and lives in the servers
 * themselves (the agent channel's capability), exactly as it does for a runtime that shares the daemon's
 * filesystem.
 */
export class TunnelProxy {
  private readonly streams = new Map<string, ProxyStream>()
  private readonly listening = new Map<TunnelName, TunnelListening | undefined>()
  /** The options each tunnel was last listened with, so changed routes are sent again. */
  private readonly listenedWith = new Map<TunnelName, string>()
  private readonly onEvent = (event: ShimEvent): void => this.accept(event)
  private readonly onAttach = (): void => this.dropUnaccountedStreams()
  private stopped = false

  constructor(private readonly deps: TunnelProxyDeps) {
    deps.session.onEvent(this.onEvent)
    // The pod's listener and its live client connections outlive a physical channel — the shim
    // reconnects at half the credential TTL — but a frame that was travelling when the socket was
    // replaced does not. See dropUnaccountedStreams.
    deps.session.onAttach(this.onAttach)
    // A lost channel takes every stream with it: the pod that held the other end is gone, and a
    // local socket kept open would hold a daemon-side server session for a client that cannot
    // return.
    deps.session.onLost((reason) => this.stop(reason))
  }

  /** On a renewal, end each stream with a frame in flight, whose bytes may be lost or would duplicate on a resend (a corrupt request for the agent channel, a corrupt TLS record for codehost); an idle stream is untouched. */
  private dropUnaccountedStreams(): void {
    for (const [streamId, entry] of [...this.streams]) {
      if (entry.inFlight === 0) continue
      this.close(streamId, 'the sandbox channel was renewed while a frame was in flight')
    }
  }

  /**
   * Ask the pod to serve a tunnel, once per pod incarnation.
   *
   * Idempotent on this side too: the request itself is idempotent, but a repeated `ensure` for
   * every session preparation would still cost a round trip on the launch path.
   */
  async ensure(tunnel: TunnelName): Promise<void> {
    if (this.stopped) throw new Error(`agent ${this.deps.session.agentId} has no live shim channel`)
    const options = this.deps.listenOptions?.(tunnel)
    // A proxy tunnel is asked again when its routes changed, as when a provider slot moved to another endpoint.
    if (this.listening.has(tunnel) && this.listenedWith.get(tunnel) === JSON.stringify(options ?? null)) return
    if (!this.deps.socketPathFor(tunnel)) {
      throw new Error(`this daemon serves no ${tunnel} socket to tunnel into the sandbox`)
    }
    if (isProxyTunnel(tunnel) && !options) throw new Error(`this agent has no ${tunnel} routes to tunnel`)
    const reply = TunnelListeningSchema.safeParse(
      await this.deps.session.request('tunnel', { op: 'listen', tunnel, ...options, acks: true })
    )
    // A session is pointed at the proxy listener by what its reply reports, so one without it is not served.
    if (isProxyTunnel(tunnel) && !reply.data?.proxy) throw new Error(`the sandbox reported no ${tunnel} listener`)
    this.listening.set(tunnel, reply.success ? reply.data : undefined)
    this.listenedWith.set(tunnel, JSON.stringify(options ?? null))
    this.deps.log.info(
      `tunnel: agent ${this.deps.session.agentId} serves ${tunnel} in its sandbox` +
        (reply.success ? ` at ${reply.data.socketPath}` : '')
    )
  }

  /** Drop every stream. The proxy is finished; a later `ensure` must build a new one. */
  stop(reason: string): void {
    if (this.stopped) return
    this.stopped = true
    this.deps.session.offEvent(this.onEvent)
    this.deps.session.offAttach(this.onAttach)
    for (const streamId of [...this.streams.keys()]) this.close(streamId, reason)
    this.listening.clear()
    this.listenedWith.clear()
  }

  /** Open streams: all of them, or only those on one budget (a proxy tunnel's, or the helpers' shared one). */
  streamCount(budget?: ProxyTunnelName | 'helpers'): number {
    if (budget === undefined) return this.streams.size
    let count = 0
    for (const { tunnel } of this.streams.values()) if (streamBudget(tunnel) === budget) count += 1
    return count
  }

  isStopped(): boolean {
    return this.stopped
  }

  /** Whether the pod serves `tunnel` on this live proxy. */
  serves(tunnel: TunnelName): boolean {
    return !this.stopped && this.listening.has(tunnel)
  }

  /** What the pod reported serving `tunnel` at, while this proxy is live. */
  listeningAt(tunnel: TunnelName): TunnelListening | undefined {
    return this.stopped ? undefined : this.listening.get(tunnel)
  }

  private accept(event: ShimEvent): void {
    const entry = this.streams.get(event.streamId)
    if (event.event.kind === 'connect') {
      // Only for a tunnel this proxy asked the pod to serve: an unsolicited `connect` names a
      // socket the daemon never authorized for this agent, whoever minted the stream id.
      if (!this.listening.has(event.event.tunnel)) {
        this.refuse(event.streamId, `tunnel ${event.event.tunnel} was not authorized for this sandbox`)
        return
      }
      // The sandbox mints these ids, so both bounds are re-checked on this side even though the
      // shim applies its own. A re-announced id would strand the socket already indexed under it,
      // and a shim that simply keeps announcing would mint daemon sockets without limit.
      if (entry) {
        this.refuse(event.streamId, 'that tunnel stream is already open')
        return
      }
      // Each proxy tunnel has its own budget, so a burst of clones or model streams cannot take the helpers' slots or each other's.
      const budget = streamBudget(event.event.tunnel)
      const cap = STREAM_CAPS[budget]
      if (this.streamCount(budget) >= cap) {
        this.refuse(event.streamId, `${cap} ${budget === 'helpers' ? 'tunnel' : budget} streams are already open`)
        return
      }
      this.open(event.streamId, event.event.tunnel)
      return
    }
    // ACP streams share the event channel, so an event for an id this proxy does not own is
    // somebody else's and not an error.
    if (!entry) return
    if (event.event.kind === 'chunk') {
      entry.timer?.refresh()
      const acks = entry.acks
      if (!acks) {
        entry.socket.write(Buffer.from(event.event.data, 'base64'))
        return
      }
      // Counted once written out, so a slow daemon-side server holds the shim's window too.
      entry.socket.write(Buffer.from(event.event.data, 'base64'), (err) => {
        if (err || this.streams.get(event.streamId) !== entry) return
        acks.received += 1
        void this.acknowledge(event.streamId, entry)
      })
      return
    }
    // The pod reported its own end closing, so it needs no close frame back — only the local
    // socket has to go.
    this.discard(event.streamId)
  }

  private open(streamId: string, tunnel: TunnelName): void {
    const path = this.deps.socketPathFor(tunnel)
    if (!path) {
      this.refuse(streamId, `this daemon serves no ${tunnel} socket`)
      return
    }
    const dial = this.deps.dial ?? ((target: string) => createConnection(target))
    let socket: Socket
    try {
      socket = dial(path)
    } catch (err) {
      this.refuse(streamId, `could not reach the ${tunnel} socket: ${(err as Error).message}`)
      return
    }
    // Written before any pod byte can be, so the server reads the pod's identity from this proxy, never from the pod.
    const greeting = this.deps.greeting?.(tunnel)
    if (greeting) socket.write(greeting)
    const idleMs = STREAM_IDLE_MS[tunnel]
    const timer = idleMs === null ? undefined : setTimeout(() => this.close(streamId, `idle for ${idleMs}ms`), idleMs)
    timer?.unref?.()
    const acks = this.listening.get(tunnel)?.acks ? { received: 0, acked: 0, sending: false } : undefined
    this.streams.set(streamId, { socket, tunnel, ...(timer ? { timer } : {}), inFlight: 0, ...(acks ? { acks } : {}) })
    socket.on('data', (data: Buffer) => {
      const entry = this.streams.get(streamId)
      if (!entry) return
      entry.timer?.refresh()
      for (let offset = 0; offset < data.length; offset += MAX_TUNNEL_CHUNK_BYTES) {
        const slice = data.subarray(offset, offset + MAX_TUNNEL_CHUNK_BYTES)
        void this.deliver(streamId, { op: 'data', streamId, chunk: slice.toString('base64') })
      }
      // Stop reading until the pod acknowledges enough, so a large transfer is not one burst of requests.
      if (entry.inFlight >= MAX_IN_FLIGHT_FRAMES) entry.socket.pause()
    })
    socket.on('error', (err) => this.close(streamId, err.message))
    socket.on('close', () => this.close(streamId))
  }

  /** Tell the pod its connection is going nowhere, so the client sees EOF instead of a stall. */
  private refuse(streamId: string, reason: string): void {
    this.deps.log.warn(`tunnel: refusing a connection from agent ${this.deps.session.agentId} — ${reason}`)
    void this.send({ op: 'close', streamId, error: reason.slice(0, 200) })
  }

  /** End a stream this side is giving up on, and tell the pod so its client sees EOF. */
  private close(streamId: string, reason?: string): void {
    if (!this.discard(streamId)) return
    void this.send({ op: 'close', streamId, ...(reason ? { error: reason.slice(0, 200) } : {}) })
  }

  /** Local teardown only. Returns whether this call was the one that owned the stream. */
  private discard(streamId: string): boolean {
    const entry = this.streams.get(streamId)
    if (!entry) return false
    this.streams.delete(streamId)
    if (entry.timer) clearTimeout(entry.timer)
    entry.socket.destroy()
    return true
  }

  /**
   * Send a stream's bytes, and end the stream if they cannot be accounted for.
   *
   * The undelivered case is NOT recoverable by re-sending: a rejection can mean the frame never
   * left, or that it landed and only its acknowledgement was lost, and re-sending the second case
   * duplicates bytes inside a request/response protocol. So the stream ends and the in-pod client
   * sees EOF — a failure it can report — rather than waiting on a reply that is not coming.
   */
  private async deliver(streamId: string, payload: unknown): Promise<void> {
    const entry = this.streams.get(streamId)
    if (!entry || this.stopped) return
    entry.inFlight += 1
    try {
      await this.deps.session.request('tunnel', payload)
      const current = this.streams.get(streamId)
      if (!current) return
      current.inFlight -= 1
      if (current.inFlight < MAX_IN_FLIGHT_FRAMES && current.socket.isPaused()) current.socket.resume()
    } catch (err) {
      const message = (err as Error).message
      this.deps.log.warn(`tunnel: agent ${this.deps.session.agentId} frame not delivered (${message})`)
      this.close(streamId, `a frame could not be delivered to the sandbox (${message})`)
    }
  }

  /** Tell the shim how many of its chunks are written out; cumulative, so one resend covers a renewal, and a second loss ends the stream rather than hang it paused. */
  private async acknowledge(streamId: string, entry: ProxyStream, resend = false): Promise<void> {
    const acks = entry.acks
    if (!acks || acks.sending || this.stopped) return
    if (!resend && acks.received - acks.acked < ACK_EVERY_FRAMES) return
    const received = acks.received
    acks.sending = true
    try {
      await this.deps.session.request('tunnel', { op: 'ack', streamId, received })
    } catch (err) {
      acks.sending = false
      if (this.streams.get(streamId) !== entry) return
      const message = (err as Error).message
      if (!resend) return await this.acknowledge(streamId, entry, true)
      this.deps.log.warn(`tunnel: agent ${this.deps.session.agentId} ack not delivered (${message})`)
      this.close(streamId, `an acknowledgement could not be delivered to the sandbox (${message})`)
      return
    }
    acks.sending = false
    acks.acked = Math.max(acks.acked, received)
    // Chunks written while this ack was in flight may already make up the next one.
    if (this.streams.get(streamId) === entry) await this.acknowledge(streamId, entry)
  }

  // Best-effort by design: a hang-up for a stream this side has already dropped. It cannot be
  // retried into anything better, and a channel that will not carry it has failed the stream in
  // the pod's own view too.
  private async send(payload: unknown): Promise<void> {
    if (this.stopped) return
    try {
      await this.deps.session.request('tunnel', payload)
    } catch (err) {
      this.deps.log.warn(`tunnel: agent ${this.deps.session.agentId} frame not delivered (${(err as Error).message})`)
    }
  }
}
