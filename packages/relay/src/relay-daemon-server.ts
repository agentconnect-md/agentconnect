/**
 * `createRelayDaemonServer` (shared-bot-relay.md §7.2) — the relay's daemon-facing
 * `rd/*` WS edge, a `noServer` `ws.WebSocketServer` on the relay's Fastify
 * `http.Server` at {@link RELAY_DAEMON_WS_PATH}.
 *
 * Negotiation: only `agentconnect.rd.v1` is accepted (HTTP 400 otherwise). Each
 * accepted socket becomes a {@link RelayDaemonConnection}; authenticated daemons are
 * tracked by daemonId so `rc/daemon-revoke` (from the CP, via the relay's CP client)
 * can immediately drop them (§9 revocation loop), and so the browser webchat gateway can find
 * a daemon's connection to bridge a turn onto (`rd/msg`, PR 3).
 */
import { WebSocketServer, type WebSocket } from 'ws'
import type { FastifyInstance } from 'fastify'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { MAX_FRAME_BYTES, RELAY_DAEMON_SUBPROTOCOL, RELAY_DAEMON_WS_PATH } from '@agentconnect.md/protocol'
import { WsServerTransport, attachKeepalive, type Clock } from '@agentconnect.md/connection'
import { RelayDaemonConnection, type RelayDaemonConnDeps } from './relay-daemon-connection.js'

/** Close code the CP-driven revoke uses (the daemon reconnects, then re-verify decides). */
const CLOSE_REVOKED = 4409

export interface RelayDaemonServerDeps {
  verify: RelayDaemonConnDeps['verify']
  relayId: RelayDaemonConnDeps['relayId']
  clock: Clock
  /** Route an inbound `rd/chat` back to the browser for its chatId (webchat, PR 3). */
  onChat: RelayDaemonConnDeps['onChat']
  /** Route an inbound cross-daemon `rd/agentmsg` (agent-collaboration P2). */
  onAgentMsg: RelayDaemonConnDeps['onAgentMsg']
  log: RelayDaemonConnDeps['log']
  /** Half-open ping/pong sweep cadence (ms). */
  keepaliveMs?: number
}

export interface RelayDaemonServer {
  readonly wss: WebSocketServer
  /** Drop every `rd/*` connection for `daemonId` (on a CP `rc/daemon-revoke`). */
  revoke(daemonId: string): void
  /** A live `rd/*` connection to `daemonId`, if this relay holds one — the browser
   *  gateway routes a webchat turn onto it. Returns any of the (normally one) sockets. */
  get(daemonId: string): RelayDaemonConnection | undefined
  /** Number of authenticated daemon connections (observability / tests). */
  size(): number
}

export function createRelayDaemonServer(app: FastifyInstance, deps: RelayDaemonServerDeps): RelayDaemonServer {
  const byDaemon = new Map<string, Set<RelayDaemonConnection>>()

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_FRAME_BYTES,
    handleProtocols: (protocols: Set<string>) =>
      protocols.has(RELAY_DAEMON_SUBPROTOCOL) ? RELAY_DAEMON_SUBPROTOCOL : false
  })
  const trackAlive = attachKeepalive(wss, deps.keepaliveMs ?? 30_000)

  const connDeps: RelayDaemonConnDeps = {
    verify: deps.verify,
    relayId: deps.relayId,
    clock: deps.clock,
    onChat: deps.onChat,
    onAgentMsg: deps.onAgentMsg,
    log: deps.log,
    onReady: (daemonId, conn) => {
      const set = byDaemon.get(daemonId) ?? new Set()
      set.add(conn)
      byDaemon.set(daemonId, set)
    },
    onClosed: (daemonId, conn) => {
      const set = byDaemon.get(daemonId)
      if (!set) return
      set.delete(conn)
      if (set.size === 0) byDaemon.delete(daemonId)
    }
  }

  app.server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    let pathname: string
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    } catch {
      socket.destroy()
      return
    }
    if (pathname !== RELAY_DAEMON_WS_PATH) return // not ours

    const offered = (req.headers['sec-websocket-protocol'] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (!offered.includes(RELAY_DAEMON_SUBPROTOCOL)) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }

    wss.handleUpgrade(req, socket, head, (raw: WebSocket) => {
      trackAlive(raw)
      const remoteAddr = req.socket.remoteAddress ?? 'unknown'
      new RelayDaemonConnection(new WsServerTransport(raw, remoteAddr), connDeps).start()
    })
  })

  return {
    wss,
    revoke(daemonId: string): void {
      const set = byDaemon.get(daemonId)
      if (!set) return
      // Copy first: close() → onClosed mutates the set mid-iteration.
      for (const conn of [...set]) conn.close(CLOSE_REVOKED, 'daemon credential revoked')
    },
    get(daemonId: string): RelayDaemonConnection | undefined {
      return byDaemon.get(daemonId)?.values().next().value
    },
    size(): number {
      let n = 0
      for (const set of byDaemon.values()) n += set.size
      return n
    }
  }
}
