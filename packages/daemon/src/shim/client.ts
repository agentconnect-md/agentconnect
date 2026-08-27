import { readFileSync } from 'node:fs'
import { Backoff, systemClock, type Clock, type TimerHandle } from '@agentconnect.md/connection'
import { AcpRunner, type ResolveCommand } from './acp-runner.js'

/** Bounded so a long outage cannot grow the buffer without limit. */
const MAX_BUFFERED_EVENTS = 2_000
const HANDSHAKE_TIMEOUT_MS = 10_000
import {
  SHIM_IDENTITY_TOKEN_PATH,
  SHIM_SUBPROTOCOL,
  SHIM_WS_PATH,
  parseShimFrame,
  type ShimBound,
  type ShimCapability,
  type ShimEvent,
  type ShimFeature,
  type ShimFrame
} from './protocol.js'

export interface ShimTransport {
  send(text: string): void
  onMessage(cb: (text: string) => void): void
  onClose(cb: (code: number, reason: string) => void): void
  close(code: number, reason: string): void
}

/** One dial's channel. `ended` records a close that arrived before the supervision loop
 *  armed `end`, so the wait cannot miss it and park forever. */
interface Channel {
  transport: ShimTransport
  end?: (reason: 'renew' | 'lost') => void
  ended?: 'renew' | 'lost'
}

export interface ShimClientDeps {
  endpoint: string
  /** Dial the daemon. Injected so tests need no real WebSocket. */
  dial: (url: string, opts: { subprotocol: string; path: string }) => Promise<ShimTransport>
  /** Reads the projected token. Injected for tests; defaults to the mounted path. */
  readToken?: () => string
  /** Handles an authorized non-ACP request from the daemon (materialize / exec / read /
   *  tunnel). The ACP capability is served by the built-in runner instead. */
  handle?: (
    capability: ShimCapability,
    payload: unknown,
    abort?: AbortSignal,
    context?: { agentId: string; generation: number }
  ) => Promise<unknown>
  /** Resolves executables in THIS filesystem for the ACP runner. */
  resolveCommand?: ResolveCommand
  /** Pod environment the ACP runner consults for provider fill-ins (SANDBOX_PROVIDER_ENV). */
  podEnv?: Record<string, string | undefined>
  /** This pod's workspace mount, reported in the hello so the daemon builds pod paths on it. */
  workspaceRoot?: string
  /** Versioned optional surfaces this shim image can accept. */
  features?: ShimFeature[]
  clock?: Clock
  backoff?: Backoff
  log?: { info: (m: string) => void; warn: (m: string) => void }
}

/**
 * The in-sandbox arm. It holds no policy: it proves which pod it is, then executes the
 * operations the daemon authorizes. Everything it carries is short-lived and re-obtained
 * by re-handshaking, so a compromised sandbox yields no lasting credential.
 *
 * It re-reads the projected token on every accepted connection. The kubelet rotates that token and
 * invalidates it when the pod goes away, which is what makes first bind, resume from
 * suspension, and eviction indistinguishable here: each new pod simply presents its own.
 */
export class ShimClient {
  /** ACP streams by the request id that opened them; each emits many events. */
  private readonly acpStreams = new Map<string, AcpRunner>()
  // In-flight non-ACP work, so a cancel frame kills the child instead of only unblocking the
  // daemon's wait. Keyed by request id and TIED TO ITS TRANSPORT: the daemon fails pending
  // requests whenever a socket goes (including the routine half-TTL renewal), and work whose
  // reply has nowhere to go must die with it — otherwise a clone, whose budget outlasts a
  // renewal, keeps running and holding locks while the daemon retries over the new socket.
  // ACP streams deliberately survive a renewal and are tracked separately.
  private readonly inFlight = new Map<string, { transport: ShimTransport; controller: AbortController }>()
  /** Events produced while no transport is attached. A renewal closes the old socket before
   *  the replacement binds, and ACP bytes cannot simply be dropped — losing a fragment
   *  corrupts the protocol — so they wait here and flush on the next bind. */
  private readonly pendingEvents: string[] = []
  private transport?: ShimTransport
  private bound?: ShimBound
  private stopped = false
  /** Settles an in-flight `connectOnce` handshake, so `stop()` leaves no timer behind. */
  private abortHandshake?: () => void
  /** The channel in service. Every transport callback compares against this before
   *  mutating shared state: a delayed close from a transport being replaced must not tear
   *  down the healthy replacement that already bound. */
  private channel?: Channel
  private highestBinding?: { agentId: string; generation: number }
  private readonly clock: Clock
  private readonly backoff: Backoff

  constructor(private readonly deps: ShimClientDeps) {
    this.clock = deps.clock ?? systemClock
    this.backoff = deps.backoff ?? new Backoff()
  }

  binding(): ShimBound | undefined {
    return this.bound
  }

  /**
   * Run the channel for the pod's lifetime, resolving once the FIRST binding succeeds so a
   * caller can wait for readiness. The supervision loop keeps running after that: a
   * dropped socket reconnects with backoff, and the credential is renewed by re-handshaking
   * before it expires.
   *
   * Both halves matter. Returning after the first bind and stopping there left a live
   * executable permanently disconnected after any close, and let the daemon-side credential
   * expire under a perfectly healthy pod — a channel that works for ten minutes and then
   * silently never again.
   */
  start(): Promise<ShimBound> {
    return new Promise<ShimBound>((resolve, reject) => {
      let ready = false
      void (async () => {
        for (;;) {
          if (this.stopped) {
            if (!ready) reject(new Error('shim: stopped before binding'))
            return
          }
          try {
            const { bound, channel } = await this.connectOnce()
            if (!ready) {
              ready = true
              resolve(bound)
            }
            // connectOnce resolves at binding; wait here for the channel to end, whether
            // from a close or from the renewal deadline coming due.
            const reason = await this.runUntilRebindNeeded(bound, channel)
            if (reason === 'renew') {
              // A planned renewal is not a failure: reconnect at once, and keep the backoff
              // counter clean so a later genuine drop starts from its base delay.
              this.backoff.reset()
              continue
            }
            // A drop IS a failure signal, so it goes through backoff — the daemon may be
            // rolling, and hammering it with immediate reconnects is what backoff prevents.
            const delay = this.backoff.next()
            this.deps.log?.warn(`shim: channel dropped, reconnecting in ${delay}ms`)
            await new Promise<void>((settle) => this.clock.setTimeout(settle, delay))
          } catch (err) {
            if (this.stopped) {
              if (!ready) reject(err)
              return
            }
            const delay = this.backoff.next()
            this.deps.log?.warn(`shim: channel lost, reconnecting in ${delay}ms (${(err as Error).message})`)
            await new Promise<void>((settle) => this.clock.setTimeout(settle, delay))
          }
        }
      })()
    })
  }

  stop(): void {
    this.stopped = true
    this.abortHandshake?.()
    if (this.transport) this.abortTransportWork(this.transport, 'shim stopping')
    this.bound = undefined
    this.channel?.end?.('lost')
    this.transport?.close(1000, 'shim stopping')
    this.transport = undefined
    this.channel = undefined
  }

  /**
   * Resolve when the channel needs rebuilding: the socket closed, or the credential is
   * close enough to expiry to renew. Renewing at half the lifetime leaves a full half as
   * margin for a slow TokenReview or a reconnect.
   */
  private runUntilRebindNeeded(bound: ShimBound, channel: Channel): Promise<'renew' | 'lost'> {
    if (channel.ended) {
      if (this.channel === channel) this.channel = undefined
      if (this.transport === channel.transport) this.transport = undefined
      this.bound = undefined
      return Promise.resolve(channel.ended)
    }
    return new Promise<'renew' | 'lost'>((resolve) => {
      const renewInMs = Math.max(1_000, Math.floor((bound.expiresInSeconds * 1000) / 2))
      const timer = this.clock.setTimeout(() => {
        this.deps.log?.info('shim: renewing the session credential before it expires')
        finish('renew')
      }, renewInMs)
      const finish = (reason: 'renew' | 'lost'): void => {
        this.clock.clearTimeout(timer)
        if (this.channel !== channel) return
        this.channel = undefined
        channel.transport.close(1000, reason === 'renew' ? 'rebinding' : 'channel lost')
        if (this.transport === channel.transport) this.transport = undefined
        this.bound = undefined
        resolve(reason)
      }
      channel.end = finish
    })
  }

  private async connectOnce(): Promise<{ bound: ShimBound; channel: Channel }> {
    const transport = await this.deps.dial(this.deps.endpoint, {
      subprotocol: SHIM_SUBPROTOCOL,
      path: SHIM_WS_PATH
    })
    this.transport = transport
    const channel: Channel = { transport }
    this.channel = channel
    return await new Promise<{ bound: ShimBound; channel: typeof channel }>((resolve, reject) => {
      let settled = false
      let expected: { agentId: string; generation: number } | undefined
      let handshakeTimer: TimerHandle | undefined
      const clearHandshakeTimer = (): void => {
        if (handshakeTimer !== undefined) this.clock.clearTimeout(handshakeTimer)
        handshakeTimer = undefined
      }
      const fail = (message: string): void => {
        if (settled) return
        settled = true
        clearHandshakeTimer()
        this.abortHandshake = undefined
        reject(new Error(message))
      }
      // `stop()` cancels this timer. It must NOT settle the promise: the transport close `stop()`
      // performs already does that through onClose, and rejecting here too lands on a promise the
      // supervision loop may have stopped awaiting. Left armed, the timer outlives the stopped
      // client and rejects into nobody — which under a shared test registry surfaces as an
      // unhandled rejection long after the test that built the client finished.
      this.abortHandshake = clearHandshakeTimer
      handshakeTimer = this.clock.setTimeout(() => {
        transport.close(4408, 'binding timeout')
        fail('binding timed out')
      }, HANDSHAKE_TIMEOUT_MS)
      transport.onClose((code, reason) => {
        // Unconditionally, and before the channel guard below: this transport's work is dead
        // whichever channel is current, because its replies had this socket as their only route.
        this.abortTransportWork(transport, `channel closed (${code})`)
        // Scoped to THIS transport. A close arriving late from a transport we already
        // replaced (a close-handshake timeout, say) must not clear the binding or end the
        // channel of the replacement that has since bound.
        if (this.channel !== channel) return
        this.bound = undefined
        if (this.transport === transport) this.transport = undefined
        // Before binding this fails the dial; after binding it ends the channel so the
        // supervision loop reconnects instead of leaving the process alive but detached.
        fail(`connection closed (${code}${reason ? ` ${reason}` : ''})`)
        // A close can land between binding and the loop arming `end`. Recording it means
        // the wait below observes it instead of parking on a channel that is already gone.
        if (channel.end) channel.end('lost')
        else channel.ended = 'lost'
      })
      transport.onMessage((text) => {
        const frame = parseShimFrame(text)
        if (!frame) {
          transport.close(4400, 'malformed frame')
          return
        }
        if (frame.type === 'shim/hello') {
          if (expected || this.bound) {
            transport.close(4400, 'unexpected hello')
            return
          }
          const highest = this.highestBinding
          if (highest && (highest.agentId !== frame.agentId || frame.generation < highest.generation)) {
            transport.close(4403, 'stale generation')
            return
          }
          expected = { agentId: frame.agentId, generation: frame.generation }
          const token = (this.deps.readToken ?? (() => readFileSync(SHIM_IDENTITY_TOKEN_PATH, 'utf8').trim()))()
          transport.send(
            JSON.stringify({
              type: 'shim/identity',
              token,
              ...(this.deps.workspaceRoot ? { workspaceRoot: this.deps.workspaceRoot } : {}),
              ...(this.deps.features?.length ? { features: this.deps.features } : {})
            } satisfies Extract<ShimFrame, { type: 'shim/identity' }>)
          )
          return
        }
        if (frame.type === 'shim/bound') {
          if (!expected || expected.agentId !== frame.agentId || expected.generation !== frame.generation) {
            transport.close(4403, 'binding mismatch')
            fail('binding did not match the daemon hello')
            return
          }
          this.bound = frame
          this.highestBinding = { agentId: frame.agentId, generation: frame.generation }
          this.backoff.reset()
          clearHandshakeTimer()
          // A live stream's output resumes here rather than being lost with the old socket.
          this.flushPendingEvents(transport)
          if (!settled) {
            settled = true
            this.deps.log?.info(`shim: bound as ${frame.agentId} generation ${frame.generation}`)
            resolve({ bound: frame, channel })
          }
          return
        }
        if (frame.type === 'shim/rejected') {
          fail(`rejected: ${frame.reason}`)
          transport.close(4403, frame.reason)
          return
        }
        if (frame.type === 'shim/request') void this.serve(transport, frame)
        if (frame.type === 'shim/cancel') this.cancel(frame)
      })
    })
  }

  /**
   * The ACP stream: one request opens it, then many events flow until the runtime exits.
   *
   * The opening request is still acknowledged with a single response so the caller knows the
   * runtime started (or why it did not); the recurring traffic goes out as `shim/event`
   * frames keyed by that request id, because one-shot correlation cannot express continuous
   * stdout and a terminal exit.
   */
  private async serveAcp(
    transport: ShimTransport,
    request: Extract<ShimFrame, { type: 'shim/request' }>
  ): Promise<void> {
    const payload = request.payload as { op?: string; streamId?: string }
    // A chunk or close names the stream it belongs to; only `open` creates one.
    const streamId = payload?.op === 'open' ? request.id : (payload?.streamId ?? '')
    if (payload?.op === 'open') {
      const runner = new AcpRunner({
        // Deliberately NOT the transport that handled `open`: renewal closes that socket, and
        // a captured reference would send every later byte into it.
        emit: (event) => this.emitEvent(streamId, event),
        ...(this.deps.resolveCommand ? { resolveCommand: this.deps.resolveCommand } : {}),
        ...(this.deps.podEnv ? { podEnv: this.deps.podEnv } : {}),
        ...(this.deps.log ? { log: this.deps.log } : {})
      })
      this.acpStreams.set(streamId, runner)
      await runner.apply(request.payload)
      transport.send(JSON.stringify({ type: 'shim/response', id: request.id, ok: true, payload: { streamId } }))
      return
    }
    const runner = this.acpStreams.get(streamId)
    if (!runner) {
      transport.send(JSON.stringify({ type: 'shim/response', id: request.id, ok: false, error: 'unknown acp stream' }))
      return
    }
    await runner.apply(request.payload)
    if (payload.op === 'close') this.acpStreams.delete(streamId)
    transport.send(JSON.stringify({ type: 'shim/response', id: request.id, ok: true }))
  }

  /** Emit an event for a stream the shim owns but the ACP runner does not — a tunnel connection,
   *  whose bytes have to survive a rebind for exactly the same reason ACP output does. */
  emit(streamId: string, event: ShimEvent['event']): void {
    this.emitEvent(streamId, event)
  }

  /** Send an event on whichever transport is currently bound, or hold it until one is. */
  private emitEvent(streamId: string, event: ShimEvent['event']): void {
    const text = JSON.stringify({ type: 'shim/event', streamId, event })
    if (event.kind === 'exit') this.acpStreams.delete(streamId)
    const transport = this.transport
    if (transport && this.bound) {
      transport.send(text)
      return
    }
    if (this.pendingEvents.length >= MAX_BUFFERED_EVENTS) {
      // Dropping ACP bytes silently would corrupt the stream, so fail it loudly instead.
      this.deps.log?.warn(`shim: buffered ${MAX_BUFFERED_EVENTS} events with no channel — failing stream ${streamId}`)
      this.pendingEvents.length = 0
      void this.acpStreams.get(streamId)?.close(0)
      this.acpStreams.delete(streamId)
      this.pendingEvents.push(
        JSON.stringify({
          type: 'shim/event',
          streamId,
          event: { kind: 'exit', code: null, signal: null, error: 'channel unavailable too long' }
        })
      )
      return
    }
    this.pendingEvents.push(text)
  }

  /** Flush events produced while the channel was down, oldest first. */
  private flushPendingEvents(transport: ShimTransport): void {
    if (this.pendingEvents.length === 0) return
    this.deps.log?.info(`shim: flushing ${this.pendingEvents.length} event(s) buffered across a rebind`)
    for (const text of this.pendingEvents.splice(0)) transport.send(text)
  }

  private async serve(transport: ShimTransport, request: Extract<ShimFrame, { type: 'shim/request' }>): Promise<void> {
    const bound = this.bound
    // A request that does not match the credential and generation we were issued is not
    // ours to serve: the daemon would refuse it too, and answering would be a second,
    // weaker enforcement point.
    if (!bound || request.sessionCredential !== bound.sessionCredential || request.generation !== bound.generation) {
      transport.send(JSON.stringify({ type: 'shim/response', id: request.id, ok: false, error: 'not bound' }))
      return
    }
    if (!bound.grants.includes(request.capability)) {
      transport.send(JSON.stringify({ type: 'shim/response', id: request.id, ok: false, error: 'not granted' }))
      return
    }
    try {
      if (request.capability === 'acp') {
        await this.serveAcp(transport, request)
        return
      }
      const controller = new AbortController()
      this.inFlight.set(request.id, { transport, controller })
      try {
        const handle = this.deps.handle ?? (async () => undefined)
        const payload = await handle(request.capability, request.payload, controller.signal, {
          agentId: bound.agentId,
          generation: bound.generation
        })
        transport.send(JSON.stringify({ type: 'shim/response', id: request.id, ok: true, payload }))
      } finally {
        this.inFlight.delete(request.id)
      }
    } catch (err) {
      transport.send(
        JSON.stringify({ type: 'shim/response', id: request.id, ok: false, error: (err as Error).message })
      )
    }
  }

  // Fenced exactly like a request: a replayed cancel from a previous incarnation must not be able
  // to kill this one's work, so the credential and generation are checked before anything is
  // aborted. An unknown id is normal — the work may have finished as the cancel arrived.
  // Abort every non-ACP request whose reply would have gone to this transport, and forget them.
  private abortTransportWork(transport: ShimTransport, reason: string): void {
    for (const [id, entry] of [...this.inFlight]) {
      if (entry.transport !== transport) continue
      this.inFlight.delete(id)
      entry.controller.abort(new Error(reason))
    }
  }

  private cancel(frame: Extract<ShimFrame, { type: 'shim/cancel' }>): void {
    const bound = this.bound
    if (!bound || frame.sessionCredential !== bound.sessionCredential || frame.generation !== bound.generation) return
    this.inFlight.get(frame.id)?.controller.abort(new Error(frame.reason ?? 'cancelled by daemon'))
    void this.acpStreams.get(frame.id)?.close(5_000)
  }
}
