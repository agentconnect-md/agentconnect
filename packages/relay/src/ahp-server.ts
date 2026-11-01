import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { FastifyInstance } from 'fastify'
import { WebSocketServer, type RawData, type WebSocket } from 'ws'
import { z } from 'zod'
import { attachKeepalive, WireError } from '@agentconnect.md/connection'
import {
  AhpAttachmentAuthorization,
  AhpMessageText,
  API_AHP_HANDSHAKE_V1_FEATURE,
  API_AHP_V1_FEATURE,
  AHP_GRANT_MAX_AGE_MS,
  AHP_MAX_MESSAGE_BYTES,
  AHP_WEBSOCKET_PROTOCOL,
  AHP_WEBCHAT_TOKEN_PREFIX,
  type AhpHandshake,
  type AhpMode,
  type RcVerifyResult,
  type RdAhpClose,
  type RdAhpMessage
} from '@agentconnect.md/protocol'
import type { RelayDaemonConnection } from './relay-daemon-connection.js'

const ENDPOINT = /^\/ahp\/agents\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i
const HOST = /^[a-z0-9.-]{1,253}(?::[0-9]{1,5})?$/i
const MAX_ATTACHMENTS = 256
const MAX_PREAUTH = 64
const MAX_HELD_EVENTS = 16
const MAX_BUFFER_BYTES = 1024 * 1024
const ROOT = 'ahp-root://'
const AUTH_REQUIRED = -32007
const NOT_FOUND = -32008
const UNSUPPORTED_VERSION = -32005
const INVALID_PARAMS = -32602
const INTERNAL_ERROR = -32603
// VS Code restores its subscriptions and settings before `authenticate`, so the window is bounded mainly by bytes.
const PREAUTH = { deadlineMs: 30_000, maxMessages: 128, maxBytes: MAX_BUFFER_BYTES }
// The AS scope that grants AHP alone (control-plane `AHP_SCOPE`); `authenticate` takes such a token or a personal key.
const OAUTH_SCOPES = ['ahp']
const identifier = z.string().min(1).max(256)
const PreauthRequest = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([identifier, z.number().finite()]).optional(),
  method: identifier,
  params: z.unknown().optional()
})
const InitializeParams = z.object({
  channel: z.literal(ROOT),
  clientId: identifier,
  protocolVersions: z.array(identifier).min(1).max(16),
  initialSubscriptions: z.array(z.string().min(1).max(1024)).max(128).optional()
})
const AuthenticateParams = z.object({
  channel: z.literal(ROOT),
  resource: z.string().max(2048),
  token: z.string().regex(/^[^\s]{1,8192}$/)
})
type CredentialKind = 'ahp-client-key' | 'webchat-token'
// `resource` is the endpoint advertised to the client, which an OAuth token's grant must name.
type Credential = { credential: string; kind: CredentialKind; resource?: string }
type DaemonEvent = RdAhpMessage | RdAhpClose
export interface AhpServerDeps {
  mode(): AhpMode
  verify(credential: string, agentId: string, kind: CredentialKind, resource?: string): Promise<RcVerifyResult>
  daemon(daemonId: string): RelayDaemonConnection | undefined
  now?: () => number
  authorizationServer?: string
  log?: { warn(message: string): void }
  preauth?: { deadlineMs: number; maxMessages: number; maxBytes?: number }
}
interface Opened {
  conn: RelayDaemonConnection
  daemonId: string
  authorization: AhpAttachmentAuthorization
  held: DaemonEvent[]
  current(): boolean
  detach(reason: RdAhpClose['reason']): void
}

function protocolsOf(req: IncomingMessage): string[] {
  return (req.headers['sec-websocket-protocol'] ?? '').split(',').map((value) => value.trim())
}

function credentialOf(req: IncomingMessage): Credential | undefined {
  const protocols = protocolsOf(req)
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

// An `authenticate` request on a bound socket, which the relay answers itself.
function reauthenticationOf(message: string): { id: string | number; params: unknown } | undefined {
  try {
    const parsed = PreauthRequest.safeParse(JSON.parse(message))
    if (!parsed.success || parsed.data.method !== 'authenticate' || parsed.data.id === undefined) return undefined
    return { id: parsed.data.id, params: parsed.data.params }
  } catch {
    return undefined
  }
}

// A credential-less upgrade, with or without the `ahp` subprotocol, may authenticate in-band.
function offersPreauth(req: IncomingMessage): boolean {
  return (
    req.headers.authorization === undefined &&
    !protocolsOf(req).some((value) => value.startsWith(AHP_WEBCHAT_TOKEN_PREFIX))
  )
}

// The resource is only echoed by this connection's own client, so the dialed host names it.
function resourceOf(req: IncomingMessage, pathname: string): string | undefined {
  const host = req.headers.host
  return host && HOST.test(host) ? `https://${host.toLowerCase()}${pathname}` : undefined
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

function closeCode(reason: RdAhpClose['reason']): number {
  if (reason === 'unauthorized') return 4401
  if (reason === 'invalid_message') return 1008
  return reason === 'client_closed' ? 1000 : 1013
}

// The relay binds credentials and placement; JSON-RPC content remains opaque on the data plane once attached.
export function createAhpServer(app: FastifyInstance, deps: AhpServerDeps) {
  const now = deps.now ?? Date.now
  const limits = deps.preauth ?? PREAUTH
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: AHP_MAX_MESSAGE_BYTES,
    perMessageDeflate: false,
    handleProtocols: (protocols) => (protocols.has(AHP_WEBSOCKET_PROTOCOL) ? AHP_WEBSOCKET_PROTOCOL : false)
  })
  const trackAlive = attachKeepalive(wss, 30_000)
  const active = new Set<() => void>()
  let pending = 0
  let preauthorizing = 0
  let stopped = false

  const open = async (
    credential: Credential,
    agentId: string,
    attachmentId: string,
    alive: () => boolean,
    handshake?: AhpHandshake
  ): Promise<Opened | 401 | 503> => {
    let conn: RelayDaemonConnection | undefined
    let attempted = false
    let overflow = false
    let release = () => {}
    const held: DaemonEvent[] = []
    const detach = (reason: RdAhpClose['reason']) => {
      release()
      if (!attempted) return
      try {
        conn?.sendAhp({ attachmentId, reason })
      } catch {
        // A lost carrier already removes its host attachments.
      }
    }
    const fail = (status: 401 | 503) => {
      detach('unavailable')
      return status
    }
    try {
      const started = now()
      const verdict = authorizationOf(
        await deps.verify(credential.credential, agentId, credential.kind, credential.resource),
        agentId,
        credential.kind,
        started,
        now()
      )
      if (!alive()) return fail(503)
      if (!verdict) return fail(401)
      conn = deps.daemon(verdict.daemonId)
      const current = () =>
        !stopped &&
        deps.mode() === 'on' &&
        deps.daemon(verdict.daemonId) === conn &&
        conn?.state === 'READY' &&
        conn.supports(API_AHP_V1_FEATURE) &&
        (!handshake || conn.supports(API_AHP_HANDSHAKE_V1_FEATURE))
      if (!current()) return fail(503)
      attempted = true
      // The daemon may answer the handshake before `opened`, so its frames wait for the client binding.
      release = conn!.listenAhp(attachmentId, (event) => {
        if (held.length < MAX_HELD_EVENTS) held.push(event)
        else overflow = true
      })
      const payload = { attachmentId, authorization: verdict.authorization, ...(handshake ? { handshake } : {}) }
      if (!(await conn!.authorizeAhp(payload, true))) return fail(503)
      if (!alive() || !current() || overflow) return fail(503)
      if (verdict.authorization.grant.expiresAtMs <= now()) return fail(401)
      return {
        conn: conn!,
        daemonId: verdict.daemonId,
        authorization: verdict.authorization,
        held,
        current,
        detach
      }
    } catch {
      return fail(503)
    }
  }

  const bind = (ws: WebSocket, initial: Credential, agentId: string, attachmentId: string, opened: Opened) => {
    const { conn, current } = opened
    let credential = initial
    let closed = false
    let authorization = opened.authorization
    let expiry: ReturnType<typeof setTimeout> | undefined
    let renewal: ReturnType<typeof setTimeout> | undefined
    const close = (reason: RdAhpClose['reason'], notify = true) => {
      if (closed) return
      closed = true
      clearTimeout(expiry)
      clearTimeout(renewal)
      remove()
      removeLost()
      active.delete(shutdown)
      if (notify) opened.detach(reason)
      ws.close(closeCode(reason), reason)
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
    // Adoptions run one at a time, so a slow renewal cannot replace a token the client refreshed meanwhile.
    let adoptions: Promise<unknown> = Promise.resolve()
    const serially = (run: () => Promise<boolean>): Promise<boolean> => {
      const next = adoptions.then(run, run)
      adoptions = next.catch(() => undefined)
      return next
    }
    // Re-verifies a credential for the same caller and agent, then adopts the grant it yields.
    const adopt = async (candidate: Credential): Promise<boolean> => {
      const checkedAt = now()
      const next = authorizationOf(
        await deps.verify(candidate.credential, agentId, candidate.kind, candidate.resource),
        agentId,
        candidate.kind,
        checkedAt,
        now()
      )
      if (!valid()) return false
      if (
        !next ||
        next.daemonId !== opened.daemonId ||
        ['orgId', 'agentId', 'userId', 'conversationId', 'targetSessionId'].some(
          (key) =>
            next.authorization[key as keyof AhpAttachmentAuthorization] !==
            authorization[key as keyof AhpAttachmentAuthorization]
        )
      )
        return false
      if (!(await conn.authorizeAhp({ attachmentId, authorization: next.authorization }))) return false
      if (!valid()) return false
      authorization = next.authorization
      credential = candidate
      arm()
      return true
    }
    const renew = async () => {
      if (!valid()) return
      try {
        if (!(await serially(() => adopt(credential))) && !closed) close('unauthorized')
      } catch {
        close('unauthorized')
      }
    }
    // A client that refreshes its token pushes `authenticate` again; it never reaches the daemon.
    const reauthenticate = async (id: string | number, params: unknown) => {
      const reply = (message: object) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(message))
      const parsed = AuthenticateParams.safeParse(params)
      if (!parsed.success || parsed.data.resource !== credential.resource) {
        reply({ jsonrpc: '2.0', id, error: { code: INVALID_PARAMS, message: 'Unknown protected resource' } })
        return close('invalid_message')
      }
      try {
        if (await serially(() => adopt({ ...credential, credential: parsed.data.token })))
          return reply({ jsonrpc: '2.0', id, result: {} })
      } catch {
        // Treated as a refused credential below.
      }
      if (closed) return
      reply({ jsonrpc: '2.0', id, error: { code: AUTH_REQUIRED, message: 'Invalid credential' } })
      close('unauthorized')
    }
    const overloaded = (message: string) =>
      deps.log?.warn(
        `ahp: attachment ${attachmentId} (agent ${agentId}, daemon ${opened.daemonId}) overloaded: ${message}`
      )
    const deliver = (event: DaemonEvent) => {
      if ('reason' in event) {
        if (event.reason === 'overloaded') overloaded('closed by the daemon')
        return close(event.reason, false)
      }
      if (!valid()) return
      if (!AhpMessageText.safeParse(event.message).success) return close('invalid_message')
      if (ws.bufferedAmount + Buffer.byteLength(event.message) > MAX_BUFFER_BYTES) {
        overloaded(`browser socket backed up (${ws.bufferedAmount} bytes)`)
        return close('overloaded')
      }
      ws.send(event.message, (error) => {
        if (error) close('unavailable')
      })
    }
    const forward = (message: string) => {
      if (!valid()) return
      try {
        conn.sendAhp({ attachmentId, message })
      } catch (error) {
        // Only daemon-link backpressure is overload; a link that is going away is unavailable.
        if (!(error instanceof WireError && error.code === 'OVERLOADED')) return close('unavailable')
        overloaded('daemon link backed up')
        close('overloaded')
      }
    }
    active.add(shutdown)
    const remove = conn.listenAhp(attachmentId, deliver)
    const removeLost = conn.onceClosed(() => close('unavailable', false))
    arm()
    for (const event of opened.held.splice(0)) deliver(event)
    return {
      forward,
      message: (data: RawData, binary: boolean) => {
        if (!valid()) return
        const message = data.toString()
        if (binary || !AhpMessageText.safeParse(message).success) return close('invalid_message')
        const request =
          credential.resource && message.includes('"authenticate"') ? reauthenticationOf(message) : undefined
        if (request) return void reauthenticate(request.id, request.params)
        forward(message)
      },
      closed: () => close('client_closed'),
      errored: () => close('unavailable')
    }
  }

  // Before `authenticate`, only the handshake and the credential are accepted; nothing reaches a daemon.
  const preauth = (ws: WebSocket, agentId: string, resource: string) => {
    const metadata = {
      resource,
      resource_name: 'AgentConnect agent',
      ...(deps.authorizationServer
        ? { authorization_servers: [deps.authorizationServer], scopes_supported: OAUTH_SCOPES }
        : {}),
      required: true
    }
    const required = { resources: [metadata] }
    const attachmentId = randomUUID()
    const queued: string[] = []
    let phase: 'open' | 'verifying' | 'bound' | 'closed' = 'open'
    let bound: ReturnType<typeof bind> | undefined
    let client: AhpHandshake | undefined
    let count = 0
    let bytes = 0
    preauthorizing++
    const leave = () => {
      clearTimeout(deadline)
      active.delete(shutdown)
      preauthorizing--
    }
    const end = (reason: RdAhpClose['reason']) => {
      if (phase === 'closed' || phase === 'bound') return
      phase = 'closed'
      leave()
      ws.close(closeCode(reason), reason)
    }
    const shutdown = () => end('unavailable')
    const deadline = setTimeout(() => end('unauthorized'), limits.deadlineMs)
    active.add(shutdown)
    const send = (message: object) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message))
    }
    const fail = (id: string | number, code: number, message: string, data?: object) =>
      send({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } })
    const authenticate = async (id: string | number, token: string) => {
      phase = 'verifying'
      const opened = await open(
        { credential: token, kind: 'ahp-client-key', resource },
        agentId,
        attachmentId,
        () => phase === 'verifying',
        client
      )
      if (phase !== 'verifying') {
        if (typeof opened === 'object') opened.detach('client_closed')
        return
      }
      if (opened === 401) {
        fail(id, AUTH_REQUIRED, 'Invalid credential', required)
        return end('unauthorized')
      }
      if (opened === 503) {
        fail(id, INTERNAL_ERROR, 'Host unavailable')
        return end('unavailable')
      }
      leave()
      phase = 'bound'
      send({ jsonrpc: '2.0', id, result: {} })
      bound = bind(ws, { credential: token, kind: 'ahp-client-key', resource }, agentId, attachmentId, opened)
      for (const message of queued.splice(0)) bound.forward(message)
    }
    ws.on('message', (data, binary) => {
      if (phase === 'bound') return bound!.message(data, binary)
      if (phase === 'closed') return
      if (++count > limits.maxMessages) return end('invalid_message')
      const text = data.toString()
      if (binary || !AhpMessageText.safeParse(text).success) return end('invalid_message')
      if ((bytes += Buffer.byteLength(text)) > (limits.maxBytes ?? PREAUTH.maxBytes)) return end('invalid_message')
      // A pipelining client's next requests wait for the verdict and reach the daemon only once bound.
      if (phase === 'verifying') return void queued.push(text)
      let request: z.infer<typeof PreauthRequest>
      try {
        const parsed = PreauthRequest.safeParse(JSON.parse(text))
        if (!parsed.success) return end('invalid_message')
        request = parsed.data
      } catch {
        return end('invalid_message')
      }
      const { id, method, params } = request
      if (id !== undefined && method === 'initialize' && !client) {
        const parsed = InitializeParams.safeParse(params)
        if (!parsed.success) {
          fail(id, INVALID_PARAMS, 'Invalid method parameters')
          return end('invalid_message')
        }
        if (!parsed.data.protocolVersions.includes('1.0.0')) {
          fail(id, UNSUPPORTED_VERSION, 'AHP 1.0.0 is required', { supportedVersions: ['1.0.0'] })
          return end('invalid_message')
        }
        // Other initial subscriptions are dropped as unauthorized; the daemon replaces this placeholder agent.
        client = { clientId: parsed.data.clientId, root: parsed.data.initialSubscriptions?.includes(ROOT) ?? false }
        const agent = {
          provider: agentId,
          displayName: 'AgentConnect agent',
          description: 'Sign in with AgentConnect or a personal API key to use this agent.',
          models: [],
          protectedResources: [metadata]
        }
        const snapshots = client.root ? [{ resource: ROOT, state: { agents: [agent] }, fromSeq: 0 }] : []
        return send({ jsonrpc: '2.0', id, result: { protocolVersion: '1.0.0', serverSeq: 0, snapshots } })
      }
      // Clients that pipeline requests or notifications (VS Code) keep the socket; only the bounds end it.
      if (id === undefined) return
      if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} })
      // An unknown client makes a resuming client fall back to `initialize` on this socket.
      if (method === 'reconnect' && !client) return fail(id, NOT_FOUND, 'Unknown client')
      if (method === 'authenticate' && client) {
        const parsed = AuthenticateParams.safeParse(params)
        if (!parsed.success || parsed.data.resource !== resource) {
          fail(id, INVALID_PARAMS, 'Unknown protected resource')
          return end('invalid_message')
        }
        return void authenticate(id, parsed.data.token)
      }
      fail(id, AUTH_REQUIRED, 'Authentication required', required)
    })
    ws.on('close', () => (phase === 'bound' ? bound!.closed() : end('client_closed')))
    ws.on('error', () => (phase === 'bound' ? bound!.errored() : end('unavailable')))
  }

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
    const agentId = match[1]!.toLowerCase()
    const resource = resourceOf(req, `/ahp/agents/${agentId}`)
    const presented = credentialOf(req)
    const credential = presented?.kind === 'ahp-client-key' && resource ? { ...presented, resource } : presented
    if (!credential) {
      if (!offersPreauth(req)) return refuse(socket, 401)
      if (!resource) return refuse(socket, 400)
      if (preauthorizing >= MAX_PREAUTH) return refuse(socket, 503)
      return wss.handleUpgrade(req, socket, head, (ws) => {
        trackAlive(ws)
        preauth(ws, agentId, resource)
        wss.emit('connection', ws, req)
      })
    }
    const attachmentId = randomUUID()
    pending++
    void (async () => {
      let opened: Opened | undefined
      try {
        const result = await open(credential, agentId, attachmentId, () => !socket.destroyed)
        if (socket.destroyed) {
          if (typeof result === 'object') result.detach('unavailable')
          return
        }
        if (typeof result === 'number') return refuse(socket, result)
        opened = result
        wss.handleUpgrade(req, socket, head, (ws) => {
          opened = undefined
          trackAlive(ws)
          const bound = bind(ws, credential, agentId, attachmentId, result)
          ws.on('message', bound.message)
          ws.on('close', bound.closed)
          ws.on('error', bound.errored)
          wss.emit('connection', ws, req)
        })
      } catch {
        refuse(socket, 503)
      } finally {
        pending--
        opened?.detach('unavailable')
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
