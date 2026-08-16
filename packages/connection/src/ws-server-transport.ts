/**
 * Accept-side WS transport — the production {@link Transport} over a live
 * `ws.WebSocket` the server ACCEPTED (vs {@link ClientTransport} which dials
 * out). A per-socket connection FSM depends only on the interface, so tests
 * inject an in-memory pair.
 *
 * Bridges the raw socket's `message`/`close` events into the FSM and serializes
 * outbound frames as UTF-8 text; binary frames are ignored (JSON text only,
 * protocol §1). Adds `remoteAddr` for audit/logging. Shared by the relay's
 * daemon-facing `rd/*` server (and reusable by the CP gateways).
 */
import type { WebSocket } from 'ws'
import type { Transport } from './ws-client-transport.js'

/** A {@link Transport} that also exposes the peer address (accept side). */
export interface ServerTransport extends Transport {
  readonly remoteAddr: string
}

export class WsServerTransport implements ServerTransport {
  readonly subprotocol: string
  readonly remoteAddr: string

  constructor(
    private readonly ws: WebSocket,
    remoteAddr: string
  ) {
    this.subprotocol = ws.protocol
    this.remoteAddr = remoteAddr
    // An unlistened 'error' (oversized frame, reset) crashes the process; terminate() folds it into close.
    ws.on('error', () => ws.terminate())
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
