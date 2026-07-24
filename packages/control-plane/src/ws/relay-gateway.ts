/**
 * `createRelayWsServer` (shared-bot-relay.md §8) — the relay socket EDGE mount, a
 * second `noServer` `ws.WebSocketServer` on the same Fastify `http.Server` as the
 * daemon gateway, discriminated purely by pathname in its own `upgrade`
 * listener.
 *
 * Negotiation: only `agentconnect.rc.v1` is accepted; a client not offering it is
 * refused with HTTP 400 before the handshake completes. On accept the socket is
 * wrapped in a {@link WsTransport} and handed to a {@link RelayConnection} FSM —
 * the SAME per-socket actor the (later) in-memory tests drive.
 *
 * Auth is frame-based (first `rc/auth`), like the daemon gateway — nothing is
 * checked at the HTTP upgrade beyond subprotocol.
 */
import { WebSocketServer, type WebSocket } from 'ws'
import type { FastifyInstance } from 'fastify'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { RELAY_CP_SUBPROTOCOL } from '@agentconnect.md/protocol'
import { MAX_FRAME_BYTES } from './codec.js'
import { WsTransport } from './transport.js'
import { attachKeepalive } from './keepalive.js'
import { RelayConnection, type RelayConnDeps } from './relay-connection.js'

export interface RelayWsServerDeps extends RelayConnDeps {
  config: {
    /** The path the relay control socket is mounted at (default `/api/v1/relays/ws`). */
    RELAY_WS_PATH: string
    /** App heartbeat cadence — the ping/pong sweep runs at 2× this. */
    HEARTBEAT_SEC: number
  }
}

export function createRelayWsServer(app: FastifyInstance, deps: RelayWsServerDeps): WebSocketServer {
  const wsPath = deps.config.RELAY_WS_PATH

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_FRAME_BYTES,
    handleProtocols: (protocols: Set<string>) => (protocols.has(RELAY_CP_SUBPROTOCOL) ? RELAY_CP_SUBPROTOCOL : false)
  })

  // Half-open sweep at 2× the app heartbeat (same cadence as the daemon gateway).
  const trackAlive = attachKeepalive(wss, deps.config.HEARTBEAT_SEC * 2 * 1000)

  app.server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    let pathname: string
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    } catch {
      socket.destroy()
      return
    }
    if (pathname !== wsPath) return // not ours — let the daemon or another upgrade handler see it

    const offered = (req.headers['sec-websocket-protocol'] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (!offered.includes(RELAY_CP_SUBPROTOCOL)) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }

    wss.handleUpgrade(req, socket, head, (raw: WebSocket) => {
      trackAlive(raw)
      const remoteAddr = req.socket.remoteAddress ?? 'unknown'
      new RelayConnection(new WsTransport(raw, remoteAddr), deps).start()
    })
  })

  return wss
}
