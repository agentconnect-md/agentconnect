/**
 * Dial-out WS transport seam — the no-real-socket boundary a client FSM depends
 * on, so tests inject a fake. {@link ClientTransport} is the production impl: it
 * DIALS OUT (the daemon/relay connects to its peer, never the reverse), resolves
 * once the socket is open, and arms a receive-idle watchdog to detect a half-open
 * peer. Wire-agnostic: the subprotocol and dial path are passed in, so the same
 * transport serves the daemon↔CP, relay↔CP, and relay↔daemon wires.
 */
import WebSocket from 'ws'
import { MAX_FRAME_BYTES } from '@agentconnect.md/protocol'

// ws has NO default handshake timeout: against a black-holing host a dial can
// hang past the OS connect timeout (or forever if TCP connects but the 101 never
// arrives), stalling the reconnect loop on one attempt.
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000
// rx-idle watchdog: self-ping this often, and terminate if nothing has arrived
// from the peer for IDLE_MS. The heartbeat is send-only, so a half-open socket
// (peer gone without a FIN) is otherwise invisible until the OS TCP timeout
// (~minutes). The peer auto-pongs, so the self-ping alone refreshes liveness.
const DEFAULT_SELF_PING_MS = 15_000
const DEFAULT_RX_IDLE_MS = 45_000

/** The slice of a `ws` socket the rx-idle watchdog drives (structural, so tests fake it). */
export interface WatchdogSocket {
  on(event: string, listener: (...args: unknown[]) => void): unknown
  ping(): void
  terminate(): void
  readonly readyState: number
  readonly OPEN: number
}

/** Injectable timer/clock seams so the watchdog is unit-testable with fake time. */
export interface WatchdogTimers {
  now?: () => number
  setInterval?: (fn: () => void, ms: number) => { unref?: () => void }
  clearInterval?: (handle: unknown) => void
}

/**
 * Arm a receive-idle watchdog on an open socket: every `selfPingMs` send a ping
 * (the peer auto-pongs, which counts as inbound), and if NOTHING has arrived for
 * `idleMs`, `terminate()` the socket — routing a dead half-open connection into
 * the normal `close` → reconnect path. Any inbound frame (message/ping/pong)
 * resets the idle clock. Cleared on `close`. Kept off the FSM's injected Clock so
 * it never perturbs the fake-clock client tests.
 */
export function armRxWatchdog(ws: WatchdogSocket, opts: { selfPingMs: number; idleMs: number } & WatchdogTimers): void {
  const now = opts.now ?? (() => Date.now())
  const setIv = opts.setInterval ?? ((fn, ms) => globalThis.setInterval(fn, ms))
  const clearIv =
    opts.clearInterval ?? ((h) => globalThis.clearInterval(h as ReturnType<typeof globalThis.setInterval>))

  let lastRx = now()
  const touch = (): void => {
    lastRx = now()
  }
  ws.on('message', touch)
  ws.on('ping', touch)
  ws.on('pong', touch)

  const timer = setIv(() => {
    if (now() - lastRx > opts.idleMs) {
      ws.terminate()
      return
    }
    if (ws.readyState === ws.OPEN) ws.ping()
  }, opts.selfPingMs)
  if (typeof timer.unref === 'function') timer.unref()
  ws.on('close', () => clearIv(timer))
}

/** The transport contract a client FSM talks to (production or fake). */
export interface Transport {
  send(text: string): void
  onMessage(cb: (text: string) => void): void
  onClose(cb: (code: number, reason: string) => void): void
  close(code: number, reason: string): void
  readonly subprotocol: string
}

/** Dial options — the wire-specific bits a caller pins per client. */
export interface DialOpts {
  /** The single subprotocol offered on the upgrade (e.g. `agentconnect.rc.v1`). */
  subprotocol: string
  /** The WS path the URL is normalized to end with (e.g. `/api/v1/relays/ws`). */
  path: string
  handshakeTimeoutMs?: number
  selfPingMs?: number
  idleMs?: number
}

export class ClientTransport implements Transport {
  get subprotocol(): string {
    return this.ws.protocol
  }

  private constructor(
    private readonly ws: WebSocket,
    selfPingMs: number,
    idleMs: number
  ) {
    // Detect a half-open peer socket (gone without a FIN) and force a reconnect,
    // instead of silently queueing heartbeats until the OS TCP timeout.
    armRxWatchdog(ws, { selfPingMs, idleMs })
  }

  /**
   * Dial `<url normalized to end in opts.path>` with `opts.subprotocol`.
   * Resolves once the socket is open; rejects on any error before open
   * (refused, bad handshake/subprotocol → HTTP 400).
   */
  static dial(url: string, opts: DialOpts): Promise<Transport> {
    const wsUrl = url.endsWith(opts.path) ? url : url.replace(/\/+$/, '') + opts.path
    const selfPingMs = opts.selfPingMs ?? DEFAULT_SELF_PING_MS
    const idleMs = opts.idleMs ?? DEFAULT_RX_IDLE_MS
    return new Promise<Transport>((resolve, reject) => {
      const ws = new WebSocket(wsUrl, [opts.subprotocol], {
        maxPayload: MAX_FRAME_BYTES,
        handshakeTimeout: opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS
      })
      const onPreOpenError = (err: Error): void => {
        ws.removeAllListeners()
        reject(err)
      }
      ws.once('error', onPreOpenError)
      ws.once('open', () => {
        ws.removeListener('error', onPreOpenError)
        // Post-open socket errors (ETIMEDOUT on a half-open connection after the
        // peer dies without a FIN, an oversized frame, a mid-stream reset) MUST
        // NOT surface as an unhandled 'error' event — that crashes the process
        // (only unhandledRejection is trapped). Fold them into the close path:
        // terminate() emits 'close', and the client FSM reconnects from there.
        ws.on('error', () => ws.terminate())
        resolve(new ClientTransport(ws, selfPingMs, idleMs))
      })
    })
  }

  send(text: string): void {
    this.ws.send(text)
  }
  onMessage(cb: (text: string) => void): void {
    this.ws.on('message', (data: unknown, isBinary?: boolean) => {
      if (isBinary) return // JSON text frames only (protocol §1)
      cb(typeof data === 'string' ? data : String(data))
    })
  }
  onClose(cb: (code: number, reason: string) => void): void {
    this.ws.on('close', (code: number, reason: Buffer) => cb(code, reason.toString()))
  }
  close(code: number, reason: string): void {
    this.ws.close(code, reason)
  }
}
