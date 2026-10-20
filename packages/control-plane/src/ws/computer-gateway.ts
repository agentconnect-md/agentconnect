// The Computer channel's socket edge: a third `noServer` server on the CP's http.Server, discriminated by path.
import { WebSocketServer, type WebSocket } from 'ws'
import type { FastifyInstance } from 'fastify'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { attachKeepalive, WsServerTransport } from '@agentconnect.md/connection'
import { COMPUTER_CP_SUBPROTOCOL, MAX_FRAME_BYTES } from '@agentconnect.md/protocol'
import { ComputerConnection, type ComputerConnDeps } from './computer-connection.js'

export interface ComputerWsServerDeps extends ComputerConnDeps {
  /** Every path the channel answers on: the internal `/api/v1` one and its public `/v1` alias. */
  paths: readonly string[]
}

export function createComputerWsServer(app: FastifyInstance, deps: ComputerWsServerDeps): WebSocketServer {
  const paths = new Set(deps.paths)
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_FRAME_BYTES,
    handleProtocols: (protocols: Set<string>) =>
      protocols.has(COMPUTER_CP_SUBPROTOCOL) ? COMPUTER_CP_SUBPROTOCOL : false
  })
  // Half-open sweep at 2× the heartbeat, like the daemon and relay gateways.
  const trackAlive = attachKeepalive(wss, deps.heartbeatSec * 2 * 1000)

  app.server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    let pathname: string
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    } catch {
      socket.destroy()
      return
    }
    if (!paths.has(pathname)) return
    const offered = (req.headers['sec-websocket-protocol'] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (!offered.includes(COMPUTER_CP_SUBPROTOCOL)) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (raw: WebSocket) => {
      trackAlive(raw)
      new ComputerConnection(new WsServerTransport(raw, req.socket.remoteAddress ?? 'unknown'), deps).start()
    })
  })
  return wss
}
