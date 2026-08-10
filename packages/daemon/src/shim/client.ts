import { readFileSync } from 'node:fs'
import { Backoff, systemClock, type Clock } from '@agentconnect.md/connection'
import {
  SHIM_IDENTITY_TOKEN_PATH,
  SHIM_SUBPROTOCOL,
  SHIM_WS_PATH,
  parseShimFrame,
  type ShimBound,
  type ShimCapability,
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
  /** Handles an authorized request from the daemon. The channels land in #814 / #815. */
  handle?: (capability: ShimCapability, payload: unknown) => Promise<unknown>
  clock?: Clock
  backoff?: Backoff
  log?: { info: (m: string) => void; warn: (m: string) => void }
}

/**
 * The in-sandbox arm. It holds no policy: it proves which pod it is, then executes the
 * operations the daemon authorizes. Everything it carries is short-lived and re-obtained
 * by re-handshaking, so a compromised sandbox yields no lasting credential.
 *
 * It re-reads the projected token on every dial. The kubelet rotates that token and
 * invalidates it when the pod goes away, which is what makes first bind, resume from
 * suspension, and eviction indistinguishable here: each new pod simply presents its own.
 */
export class ShimClient {
  private transport?: ShimTransport
  private bound?: ShimBound
  private stopped = false
  /** The channel in service. Every transport callback compares against this before
   *  mutating shared state: a delayed close from a transport being replaced must not tear
   *  down the healthy replacement that already bound. */
  private channel?: Channel
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
   * dropped socket re-dials with backoff, and the credential is renewed by re-handshaking
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
              // A planned renewal is not a failure: re-dial at once, and keep the backoff
              // counter clean so a later genuine drop starts from its base delay.
              this.backoff.reset()
              continue
            }
            // A drop IS a failure signal, so it goes through backoff — the daemon may be
            // rolling, and hammering it with immediate re-dials is what backoff prevents.
            const delay = this.backoff.next()
            this.deps.log?.warn(`shim: channel dropped, re-dialing in ${delay}ms`)
            await new Promise<void>((settle) => this.clock.setTimeout(settle, delay))
          } catch (err) {
            if (this.stopped) {
              if (!ready) reject(err)
              return
            }
            const delay = this.backoff.next()
            this.deps.log?.warn(`shim: channel lost, re-dialing in ${delay}ms (${(err as Error).message})`)
            await new Promise<void>((settle) => this.clock.setTimeout(settle, delay))
          }
        }
      })()
    })
  }

  stop(): void {
    this.stopped = true
    this.bound = undefined
    this.channel?.end?.('lost')
    this.transport?.close(1000, 'shim stopping')
    this.transport = undefined
    this.channel = undefined
  }

  /**
   * Resolve when the channel needs rebuilding: the socket closed, or the credential is
   * close enough to expiry to renew. Renewing at half the lifetime leaves a full half as
   * margin for a slow TokenReview or a re-dial.
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
    const token = (this.deps.readToken ?? (() => readFileSync(SHIM_IDENTITY_TOKEN_PATH, 'utf8').trim()))()
    const transport = await this.deps.dial(this.deps.endpoint, {
      subprotocol: SHIM_SUBPROTOCOL,
      path: SHIM_WS_PATH
    })
    this.transport = transport
    const channel: Channel = { transport }
    this.channel = channel
    return await new Promise<{ bound: ShimBound; channel: typeof channel }>((resolve, reject) => {
      let settled = false
      const fail = (message: string): void => {
        if (settled) return
        settled = true
        reject(new Error(message))
      }
      transport.onClose((code, reason) => {
        // Scoped to THIS transport. A close arriving late from a transport we already
        // replaced (a close-handshake timeout, say) must not clear the binding or end the
        // channel of the replacement that has since bound.
        if (this.channel !== channel) return
        this.bound = undefined
        if (this.transport === transport) this.transport = undefined
        // Before binding this fails the dial; after binding it ends the channel so the
        // supervision loop re-dials instead of leaving the process alive but detached.
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
        if (frame.type === 'shim/bound') {
          this.bound = frame
          this.backoff.reset()
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
      })
      // The token is the whole proof; nothing else about this pod is asserted.
      transport.send(JSON.stringify({ type: 'shim/hello', token } satisfies Extract<ShimFrame, { type: 'shim/hello' }>))
    })
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
      const payload = await (this.deps.handle ?? (async () => undefined))(request.capability, request.payload)
      transport.send(JSON.stringify({ type: 'shim/response', id: request.id, ok: true, payload }))
    } catch (err) {
      transport.send(
        JSON.stringify({ type: 'shim/response', id: request.id, ok: false, error: (err as Error).message })
      )
    }
  }
}
