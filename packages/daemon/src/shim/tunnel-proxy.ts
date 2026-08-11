import { createConnection, type Socket } from 'node:net'
import type { ShimCapability, ShimEvent } from './protocol.js'
import { MAX_TUNNEL_CHUNK_BYTES, TunnelListeningSchema, type TunnelName } from './tunnel.js'

/** A connection reached its deadline without the daemon-side server answering. Bounded because a
 *  stream nobody closes holds one of the pod's few tunnel slots. */
const STREAM_IDLE_MS = 5 * 60_000

/** This side's own ceiling on concurrent streams per agent. The shim enforces one too; that one
 *  protects the pod, and this one protects the daemon from a shim that does not. */
const MAX_TUNNEL_STREAMS = 32

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
  /** Dials a local unix socket. Injected so a test can stand in for the daemon's server. */
  dial?: (path: string) => Socket
  log: { info: (m: string) => void; warn: (m: string) => void }
}

/**
 * The daemon-side half of the tunnel: one local socket per connection a sandbox reports.
 *
 * The direction is what shapes this. A tunnel exists because a process INSIDE the pod wants a
 * daemon-side server, and shim requests only ever flow daemon → shim — so the pod announces the
 * connection as an event and the daemon answers by dialling its own end. Nothing here inspects
 * what it forwards: authorization for these servers is per-agent and lives in the servers
 * themselves (gitcred's capability), exactly as it does for a runtime that shares the daemon's
 * filesystem.
 */
export class TunnelProxy {
  private readonly streams = new Map<string, { socket: Socket; timer: NodeJS.Timeout; inFlight: number }>()
  private readonly listening = new Set<TunnelName>()
  private readonly onEvent = (event: ShimEvent): void => this.accept(event)
  private readonly onAttach = (): void => this.dropUnaccountedStreams()
  private stopped = false

  constructor(private readonly deps: TunnelProxyDeps) {
    deps.session.onEvent(this.onEvent)
    // The pod's listener and its live client connections outlive a physical channel — the shim
    // re-dials at half the credential TTL — but a frame that was travelling when the socket was
    // replaced does not. See dropUnaccountedStreams.
    deps.session.onAttach(this.onAttach)
    // A lost channel takes every stream with it: the pod that held the other end is gone, and a
    // local socket kept open would hold a daemon-side server session for a client that cannot
    // return.
    deps.session.onLost((reason) => this.stop(reason))
  }

  /**
   * End every stream whose delivery stopped being accountable, at the moment a replacement channel
   * binds.
   *
   * A renewal aborts the requests in flight on the socket it replaced, and that abort says a REPLY
   * was lost — not whether the request itself ever landed. So the bytes of an in-flight `data`
   * frame are in an unknown state, and neither choice is safe to make silently: re-sending can
   * duplicate them, and these tunnels carry request/response protocols where a duplicated fragment
   * is a corrupt request rather than a retry.
   *
   * Terminating instead makes the in-pod client see EOF at once. For gitcred that is git reporting
   * an authentication failure it can be retried — the alternative, leaving the stream open on a
   * reply that will never arrive, is git waiting out {@link STREAM_IDLE_MS}.
   *
   * A stream that was idle across the renewal is untouched: nothing was in doubt, and its next
   * frame travels on the new socket.
   */
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
    if (this.listening.has(tunnel)) return
    if (!this.deps.socketPathFor(tunnel)) {
      throw new Error(`this daemon serves no ${tunnel} socket to tunnel into the sandbox`)
    }
    const reply = TunnelListeningSchema.safeParse(await this.deps.session.request('tunnel', { op: 'listen', tunnel }))
    this.listening.add(tunnel)
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
  }

  streamCount(): number {
    return this.streams.size
  }

  isStopped(): boolean {
    return this.stopped
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
      if (this.streams.size >= MAX_TUNNEL_STREAMS) {
        this.refuse(event.streamId, `${MAX_TUNNEL_STREAMS} tunnel streams are already open`)
        return
      }
      this.open(event.streamId, event.event.tunnel)
      return
    }
    // ACP streams share the event channel, so an event for an id this proxy does not own is
    // somebody else's and not an error.
    if (!entry) return
    if (event.event.kind === 'chunk') {
      entry.timer.refresh()
      entry.socket.write(Buffer.from(event.event.data, 'base64'))
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
    const timer = setTimeout(() => this.close(streamId, `idle for ${STREAM_IDLE_MS}ms`), STREAM_IDLE_MS)
    timer.unref?.()
    this.streams.set(streamId, { socket, timer, inFlight: 0 })
    socket.on('data', (data: Buffer) => {
      const entry = this.streams.get(streamId)
      if (!entry) return
      entry.timer.refresh()
      for (let offset = 0; offset < data.length; offset += MAX_TUNNEL_CHUNK_BYTES) {
        const slice = data.subarray(offset, offset + MAX_TUNNEL_CHUNK_BYTES)
        void this.deliver(streamId, { op: 'data', streamId, chunk: slice.toString('base64') })
      }
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
    clearTimeout(entry.timer)
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
      if (current) current.inFlight -= 1
    } catch (err) {
      const message = (err as Error).message
      this.deps.log.warn(`tunnel: agent ${this.deps.session.agentId} frame not delivered (${message})`)
      this.close(streamId, `a frame could not be delivered to the sandbox (${message})`)
    }
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
