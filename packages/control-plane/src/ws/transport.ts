/**
 * Transport seam (design §4.2) — the no-real-socket boundary.
 *
 * Every byte in/out of a `DaemonConnection` passes through `Transport`. The
 * connection actor depends ONLY on this interface, so tests inject an in-memory
 * pair (`test/fakes/daemon-stub.ts`) and drive the whole protocol with zero
 * sockets. {@link WsTransport} is the production impl wrapping a live
 * `ws.WebSocket`, attached by the gateway (design §4.1).
 */
import type { WebSocket } from 'ws'

export interface Transport {
  /** Send one JSON envelope (already serialized) to the peer. */
  send(text: string): void
  /** Register the inbound-frame callback (one JSON envelope per call). A callback may return the
   *  dispatch it started; a live socket ignores it, an in-memory fake awaits it as a test barrier. */
  onMessage(cb: (text: string) => void | Promise<void>): void
  /** Register the close callback. */
  onClose(cb: (code: number, reason: string) => void): void
  /** Close the connection with a WS close code + reason. */
  close(code: number, reason: string): void
  /** The negotiated subprotocol (always `agentconnect.v1` for a valid daemon). */
  readonly subprotocol: string
  /** Remote address (advisory; used for audit / ClientCtx). */
  readonly remoteAddr: string
}

/**
 * Production `Transport` over a live `ws.WebSocket`. Bridges the raw socket's
 * `message`/`close` events into the connection FSM and serializes outbound frames
 * as UTF-8 text. Binary frames are ignored (the protocol is JSON text only,
 * §1). The negotiated `subprotocol` is read off the accepted socket.
 */
export class WsTransport implements Transport {
  readonly subprotocol: string
  readonly remoteAddr: string

  constructor(
    private readonly ws: WebSocket,
    remoteAddr: string
  ) {
    this.subprotocol = ws.protocol
    this.remoteAddr = remoteAddr
  }

  send(text: string): void {
    this.ws.send(text)
  }

  onMessage(cb: (text: string) => void): void {
    this.ws.on('message', (data: unknown, isBinary?: boolean) => {
      if (isBinary) return // JSON text frames only (§1)
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
