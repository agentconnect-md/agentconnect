/**
 * `createDaemonWsServer` (design §4.1) — the daemon socket EDGE mount.
 *
 * A raw `ws.WebSocketServer({ noServer: true })` is attached to Fastify's
 * underlying `http.Server` via the `upgrade` event (the daemon socket has a
 * long-lived actor lifecycle and explicit subprotocol negotiation we own
 * directly; REST and the daemon WS still share one port and one process).
 *
 * Negotiation (protocol §1): only `agentconnect.v1` is accepted; a client that
 * does not offer it is refused with an HTTP `400` (the `4400` close intent) before
 * the WS handshake completes. On accept, the live socket is wrapped in a
 * {@link WsTransport} and handed to the SAME {@link DaemonConnection} FSM the
 * in-memory protocol tests drive — so the wire path and the test path are one.
 */
import { WebSocketServer, type WebSocket } from 'ws'
import type { FastifyInstance } from 'fastify'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { MAX_FRAME_BYTES } from './codec.js'
import { WsTransport } from './transport.js'
import { DaemonConnection } from './connection.js'
import { FrameRouter } from './handlers/index.js'
import { attachKeepalive } from './keepalive.js'
import type { DaemonWsDeps } from './deps.js'

export const SUBPROTOCOL = 'agentconnect.v1'
const DEFAULT_WS_PATH = '/daemon/ws'

export interface DaemonWsServerDeps extends DaemonWsDeps {
  /** Frame dispatch table; defaults to the standard `FrameRouter`. */
  router?: FrameRouter
}

export function createDaemonWsServer(app: FastifyInstance, deps: DaemonWsServerDeps): WebSocketServer {
  const wsPath = deps.config.WS_PATH ?? DEFAULT_WS_PATH
  const router = deps.router ?? new FrameRouter()

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_FRAME_BYTES, // §1 size cap → close 1009 on overflow
    // Accept ONLY agentconnect.v1; returning false rejects the negotiation.
    handleProtocols: (protocols: Set<string>) => (protocols.has(SUBPROTOCOL) ? SUBPROTOCOL : false)
  })

  // WS-level ping/pong so a half-open daemon socket (peer gone without a FIN) is
  // detected and evicted within ~2 intervals, instead of lingering 'READY' and
  // receiving control-plane requests it can never answer. Cadence = 2× the app
  // heartbeat, so a daemon that has genuinely gone quiet still gets a couple of
  // heartbeat windows before a ping sweep touches it.
  const trackAlive = attachKeepalive(wss, deps.config.HEARTBEAT_SEC * 2 * 1000)

  app.server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    let pathname: string
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    } catch {
      socket.destroy()
      return
    }
    if (pathname !== wsPath) return // not ours — let other upgrade handlers see it

    // Pre-check the subprotocol so a mismatch is a clean 400 (the 4400 intent),
    // never a silently-accepted socket (protocol §1).
    const offered = (req.headers['sec-websocket-protocol'] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (!offered.includes(SUBPROTOCOL)) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }

    wss.handleUpgrade(req, socket, head, (raw: WebSocket) => {
      trackAlive(raw) // arm the ping/pong liveness sweep for this socket
      const remoteAddr = req.socket.remoteAddress ?? 'unknown'
      new DaemonConnection(new WsTransport(raw, remoteAddr), deps, router).start()
    })
  })

  return wss
}
