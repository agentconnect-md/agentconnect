/**
 * `createRelayBrowserServer` (shared-bot-relay.md §7.2 / §10) — the relay's
 * browser-facing webchat WS edge, a `noServer` `ws.WebSocketServer` on the relay's
 * Fastify `http.Server` at {@link RELAY_WEBCHAT_WS_PATH}.
 *
 * A browser can't set headers on a WS handshake, so it presents the CP-minted webchat
 * token as `?token=` (+ a compatibility `?conversation_id=` echo). The relay holds no
 * DB, so it delegates verification to the CP via `rc/verify(webchat-token)` — resolving
 * the user, conversation, agent, and the agent's CURRENT daemon placement — BEFORE
 * completing the handshake. The verified conversation binding is authoritative.
 * On accept the socket becomes a {@link RelayBrowserConnection} bridged to that daemon.
 * (Mirrors the old CP webchat gateway, which stays as a fallback until it retires in A4b.)
 *
 * No subprotocol is negotiated (a browser `new WebSocket(url)` offers none), matching
 * the CP webchat gateway (which stays as a fallback until it retires in milestone A4b).
 */
import { WebSocketServer, type WebSocket } from 'ws'
import type { FastifyInstance } from 'fastify'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { MAX_FRAME_BYTES, type RcVerifyResult } from '@agentconnect.md/protocol'
import { WsServerTransport, attachKeepalive } from '@agentconnect.md/connection'
import { RelayBrowserConnection } from './relay-browser-connection.js'
import type { WebchatRouter } from './webchat-router.js'
import type { RelayDaemonServer } from './relay-daemon-server.js'
import type { Logger } from './log.js'

export const RELAY_WEBCHAT_WS_PATH = '/webchat'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface RelayBrowserServerDeps {
  /** Delegate webchat-token verification to the CP (`RelayCpClient.verify`). */
  verify: (kind: 'webchat-token', token: string) => Promise<RcVerifyResult>
  /** The daemon-facing server — resolves a live rd/* connection to the target daemon. */
  daemons: RelayDaemonServer
  /** chatId → browser index; the daemon's rd/chat is delivered here. */
  router: WebchatRouter
  log: Logger
  keepaliveMs?: number
}

function refuse(socket: Duplex, status: number, msg: string): void {
  socket.write(`HTTP/1.1 ${status} ${msg}\r\nConnection: close\r\n\r\n`)
  socket.destroy()
}

export function createRelayBrowserServer(app: FastifyInstance, deps: RelayBrowserServerDeps): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES })
  const trackAlive = attachKeepalive(wss, deps.keepaliveMs ?? 30_000)

  app.server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    let url: URL
    try {
      url = new URL(req.url ?? '/', 'http://localhost')
    } catch {
      socket.destroy()
      return
    }
    if (url.pathname !== RELAY_WEBCHAT_WS_PATH) return // not ours

    const token = url.searchParams.get('token')
    if (!token) return refuse(socket, 401, 'Unauthorized')
    const rawConv = url.searchParams.get('conversation_id')
    const requestedConversationId = rawConv && UUID_RE.test(rawConv) ? rawConv.toLowerCase() : undefined

    // Verify + resolve placement BEFORE handleUpgrade, so a rejected browser never
    // completes the handshake (mirrors the old CP webchat gateway).
    void (async () => {
      let result: RcVerifyResult
      try {
        result = await deps.verify('webchat-token', token)
      } catch {
        return refuse(socket, 503, 'Verify Unavailable') // relay↔CP link down → retryable
      }
      if (!result.ok || !result.agentId || !result.daemonId || !result.conversationId) {
        return refuse(socket, 401, 'Unauthorized')
      }
      const { agentId, daemonId } = result
      const conversationId = result.conversationId.toLowerCase()
      // `conversation_id` is only a compatibility echo. The signed CP verdict is
      // authoritative; rejecting a mismatch prevents a valid token for one
      // conversation from being replayed against another session key.
      if (!UUID_RE.test(conversationId) || (rawConv !== null && requestedConversationId !== conversationId)) {
        return refuse(socket, 401, 'Unauthorized')
      }
      const user = result.user ?? 'webchat'
      // The verified roster (webchat-multi-agents.md §6.2). A pre-roster CP omits
      // it — degrade to the singular primary binding (the single-agent shape).
      const participants = result.participants?.length ? result.participants : [{ agentId, daemonId, primary: true }]
      // Cache the roster ON THE ROUTER (not only the connection): a completed
      // reply's context fan-out must survive the browser closing mid-turn.
      deps.router.rememberRoster(
        conversationId,
        participants.map((p) => ({ agentId: p.agentId, ...(p.daemonId ? { daemonId: p.daemonId } : {}) }))
      )

      wss.handleUpgrade(req, socket, head, (raw: WebSocket) => {
        trackAlive(raw)
        const remoteAddr = req.socket.remoteAddress ?? 'unknown'
        new RelayBrowserConnection(new WsServerTransport(raw, remoteAddr), {
          chatId: conversationId,
          agentId,
          participants,
          user,
          // The stable principal travels beside the display handle: the daemon keys the
          // durable transcript row on it, so a later profile rename cannot orphan old rows.
          ...(result.userId ? { userId: result.userId } : {}),
          ...(result.userPicture ? { userPicture: result.userPicture } : {}),
          // Session-targeted continuation: verdict-only, never browser input.
          ...(result.targetSessionId ? { targetSessionId: result.targetSessionId } : {}),
          ...(result.remoteMcp ? { remoteMcp: result.remoteMcp } : {}),
          daemonConnFor: (id) => deps.daemons.get(id),
          rendezvousDaemonConn: () => deps.daemons.rendezvousCandidate(),
          register: (c, sink) => deps.router.register(c, sink),
          unregister: (c, sink) => deps.router.unregister(c, sink),
          log: deps.log
        }).start()
      })
    })()
  })

  return wss
}
