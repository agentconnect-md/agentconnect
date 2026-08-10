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
  private readonly clock: Clock
  private readonly backoff: Backoff

  constructor(private readonly deps: ShimClientDeps) {
    this.clock = deps.clock ?? systemClock
    this.backoff = deps.backoff ?? new Backoff()
  }

  binding(): ShimBound | undefined {
    return this.bound
  }

  /** Dial and bind, retrying with backoff until stopped. Resolves on first binding. */
  async start(): Promise<ShimBound> {
    for (;;) {
      if (this.stopped) throw new Error('shim: stopped before binding')
      try {
        return await this.connectOnce()
      } catch (err) {
        if (this.stopped) throw err
        const delay = this.backoff.next()
        this.deps.log?.warn(`shim: bind failed, retrying in ${delay}ms (${(err as Error).message})`)
        await new Promise<void>((resolve) => this.clock.setTimeout(resolve, delay))
      }
    }
  }

  stop(): void {
    this.stopped = true
    this.bound = undefined
    this.transport?.close(1000, 'shim stopping')
    this.transport = undefined
  }

  private async connectOnce(): Promise<ShimBound> {
    const token = (this.deps.readToken ?? (() => readFileSync(SHIM_IDENTITY_TOKEN_PATH, 'utf8').trim()))()
    const transport = await this.deps.dial(this.deps.endpoint, {
      subprotocol: SHIM_SUBPROTOCOL,
      path: SHIM_WS_PATH
    })
    this.transport = transport
    return await new Promise<ShimBound>((resolve, reject) => {
      let settled = false
      const fail = (message: string): void => {
        if (settled) return
        settled = true
        reject(new Error(message))
      }
      transport.onClose((code, reason) => {
        this.bound = undefined
        if (this.transport === transport) this.transport = undefined
        fail(`connection closed (${code}${reason ? ` ${reason}` : ''})`)
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
            resolve(frame)
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
