import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { FastifyInstance } from 'fastify'
import { WebSocketServer } from 'ws'
import { attachKeepalive } from '@agentconnect.md/connection'
import {
  AhpAttachmentAuthorization,
  AhpMessageText,
  API_AHP_V1_FEATURE,
  AHP_GRANT_MAX_AGE_MS,
  AHP_MAX_MESSAGE_BYTES,
  AHP_WEBSOCKET_PROTOCOL,
  AHP_WEBCHAT_TOKEN_PREFIX,
  type AhpMode,
  type RcVerifyResult,
  type RdAhpClose
} from '@agentconnect.md/protocol'
import type { RelayDaemonConnection } from './relay-daemon-connection.js'

const ENDPOINT = /^\/ahp\/agents\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i
const MAX_ATTACHMENTS = 256
const MAX_BUFFER_BYTES = 1024 * 1024
type CredentialKind = 'ahp-client-key' | 'webchat-token'
export interface AhpServerDeps {
  mode(): AhpMode
  verify(credential: string, agentId: string, kind: CredentialKind): Promise<RcVerifyResult>
  daemon(daemonId: string): RelayDaemonConnection | undefined
  now?: () => number
}

function credentialOf(req: IncomingMessage): { credential: string; kind: CredentialKind } | undefined {
  const protocols = (req.headers['sec-websocket-protocol'] ?? '').split(',').map((value) => value.trim())
  const tickets = protocols.filter((value) => value.startsWith(AHP_WEBCHAT_TOKEN_PREFIX))
  if (tickets.length) {
    if (tickets.length !== 1 || req.headers.authorization || !protocols.includes(AHP_WEBSOCKET_PROTOCOL)) return
    const encoded = tickets[0]!.slice(AHP_WEBCHAT_TOKEN_PREFIX.length)
    if (!/^[A-Za-z0-9_-]{1,12000}$/.test(encoded)) return
    const token = Buffer.from(encoded, 'base64url').toString('utf8')
    if (!token || Buffer.from(token).toString('base64url') !== encoded) return
    return { credential: token, kind: 'webchat-token' }
  }
  const match = /^Bearer ([^\s]{1,8192})$/i.exec(req.headers.authorization ?? '')
  return match ? { credential: match[1]!, kind: 'ahp-client-key' } : undefined
}

function authorizationOf(result: RcVerifyResult, agentId: string, kind: CredentialKind, started: number, now: number) {
  if (!result.ok || result.agentId !== agentId || !result.daemonId || !result.apiProtocols?.includes('ahp')) return
  if (kind === 'webchat-token' && !result.conversationId) return
  const parsed = AhpAttachmentAuthorization.safeParse({
    orgId: result.orgId,
    agentId: result.agentId,
    userId: result.userId,
    user: result.user,
    callerRole: result.callerRole,
    callerApproves: result.callerApproves,
    ...(result.conversationId ? { conversationId: result.conversationId } : {}),
    ...(result.targetSessionId ? { targetSessionId: result.targetSessionId } : {}),
    grant: result.ahpGrant
  })
  if (!parsed.success) return
  const expires = parsed.data.grant.expiresAtMs
  if (expires <= now || expires > now + AHP_GRANT_MAX_AGE_MS) return
  parsed.data.grant.expiresAtMs = Math.min(expires, started + AHP_GRANT_MAX_AGE_MS)
  if (parsed.data.grant.expiresAtMs <= now) return
  return { authorization: parsed.data, daemonId: result.daemonId }
}

function refuse(socket: Duplex, status: 400 | 401 | 503): void {
  if (socket.destroyed) return
  const message = status === 400 ? 'Bad Request' : status === 401 ? 'Unauthorized' : 'Service Unavailable'
  socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
}

// The relay binds credentials and placement; JSON-RPC content remains opaque on the data plane.
export function createAhpServer(app: FastifyInstance, deps: AhpServerDeps) {
  const now = deps.now ?? Date.now
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: AHP_MAX_MESSAGE_BYTES,
    perMessageDeflate: false,
    handleProtocols: (protocols) => (protocols.has(AHP_WEBSOCKET_PROTOCOL) ? AHP_WEBSOCKET_PROTOCOL : false)
  })
  const trackAlive = attachKeepalive(wss, 30_000)
  const active = new Set<() => void>()
  let pending = 0
  let stopped = false
  const upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    let url: URL
    try {
      url = new URL(req.url ?? '/', 'http://localhost')
    } catch {
      return
    }
    if (!url.pathname.startsWith('/ahp/')) return
    const match = ENDPOINT.exec(url.pathname)
    if (!match || url.search) return refuse(socket, 400)
    if (stopped || deps.mode() !== 'on' || wss.clients.size + pending >= MAX_ATTACHMENTS) return refuse(socket, 503)
    const credential = credentialOf(req)
    if (!credential) return refuse(socket, 401)
    const agentId = match[1]!.toLowerCase()
    const attachmentId = randomUUID()
    pending++
    void (async () => {
      let conn: RelayDaemonConnection | undefined
      let attempted = false
      let handedOff = false
      const detach = (reason: RdAhpClose['reason']) => {
        if (!attempted) return
        try {
          conn?.sendAhp({ attachmentId, reason })
        } catch {
          // A lost carrier already removes its host attachments.
        }
      }
      try {
        const started = now()
        const verdict = authorizationOf(
          await deps.verify(credential.credential, agentId, credential.kind),
          agentId,
          credential.kind,
          started,
          now()
        )
        if (socket.destroyed) return
        if (!verdict) return refuse(socket, 401)
        conn = deps.daemon(verdict.daemonId)
        const current = () =>
          !stopped &&
          deps.mode() === 'on' &&
          deps.daemon(verdict.daemonId) === conn &&
          conn?.state === 'READY' &&
          conn.supports(API_AHP_V1_FEATURE)
        if (!current()) return refuse(socket, 503)
        attempted = true
        if (!(await conn!.authorizeAhp({ attachmentId, authorization: verdict.authorization }, true)))
          return refuse(socket, 503)
        if (socket.destroyed) return
        if (!current()) return refuse(socket, 503)
        if (verdict.authorization.grant.expiresAtMs <= now()) return refuse(socket, 401)
        wss.handleUpgrade(req, socket, head, (ws) => {
          handedOff = true
          trackAlive(ws)
          let closed = false
          let authorization = verdict.authorization
          let expiry: ReturnType<typeof setTimeout> | undefined
          let renewal: ReturnType<typeof setTimeout> | undefined
          let remove = () => {}
          let removeLost = () => {}
          const close = (reason: RdAhpClose['reason'], notify = true) => {
            if (closed) return
            closed = true
            clearTimeout(expiry)
            clearTimeout(renewal)
            remove()
            removeLost()
            active.delete(shutdown)
            if (notify) detach(reason)
            ws.close(
              reason === 'unauthorized'
                ? 4401
                : reason === 'invalid_message'
                  ? 1008
                  : reason === 'client_closed'
                    ? 1000
                    : 1013,
              reason
            )
          }
          const shutdown = () => close('unavailable')
          const valid = () => {
            if (!current()) {
              close('unavailable')
              return false
            }
            if (authorization.grant.expiresAtMs <= now()) {
              close('unauthorized')
              return false
            }
            return !closed
          }
          const arm = () => {
            clearTimeout(expiry)
            clearTimeout(renewal)
            expiry = setTimeout(() => close('unauthorized'), Math.max(0, authorization.grant.expiresAtMs - now()))
            renewal = setTimeout(() => void renew(), Math.max(1000, authorization.grant.expiresAtMs - now() - 5000))
          }
          const renew = async () => {
            if (!valid()) return
            try {
              const checkedAt = now()
              const next = authorizationOf(
                await deps.verify(credential.credential, agentId, credential.kind),
                agentId,
                credential.kind,
                checkedAt,
                now()
              )
              if (!valid()) return
              if (
                !next ||
                next.daemonId !== verdict.daemonId ||
                ['orgId', 'agentId', 'userId', 'conversationId', 'targetSessionId'].some(
                  (key) =>
                    next.authorization[key as keyof AhpAttachmentAuthorization] !==
                    authorization[key as keyof AhpAttachmentAuthorization]
                )
              )
                return close('unauthorized')
              if (!(await conn!.authorizeAhp({ attachmentId, authorization: next.authorization })))
                return close('unauthorized')
              if (!valid()) return
              authorization = next.authorization
              arm()
            } catch {
              close('unauthorized')
            }
          }
          active.add(shutdown)
          remove = conn!.listenAhp(attachmentId, (event) => {
            if ('reason' in event) return close(event.reason, false)
            if (!valid()) return
            if (!AhpMessageText.safeParse(event.message).success) return close('invalid_message')
            if (ws.bufferedAmount + Buffer.byteLength(event.message) > MAX_BUFFER_BYTES) return close('overloaded')
            ws.send(event.message, (error) => {
              if (error) close('unavailable')
            })
          })
          removeLost = conn!.onceClosed(() => close('unavailable', false))
          ws.on('message', (data, binary) => {
            if (!valid()) return
            const message = data.toString()
            if (binary || !AhpMessageText.safeParse(message).success) return close('invalid_message')
            try {
              conn!.sendAhp({ attachmentId, message })
            } catch {
              close('overloaded')
            }
          })
          ws.on('close', () => close('client_closed'))
          ws.on('error', () => close('unavailable'))
          arm()
          wss.emit('connection', ws, req)
        })
      } catch {
        refuse(socket, 503)
      } finally {
        pending--
        if (!handedOff) detach('unavailable')
      }
    })()
  }
  app.server.on('upgrade', upgrade)
  return {
    wss,
    close() {
      stopped = true
      app.server.removeListener('upgrade', upgrade)
      for (const close of active) close()
      wss.close()
    }
  }
}
