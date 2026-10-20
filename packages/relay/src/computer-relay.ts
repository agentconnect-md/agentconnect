// The Computer data plane on the relay (computer-use.md §3.7): desktops dial in, agent daemons' MCP HTTP is forwarded to them.
import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { WsServerTransport, attachKeepalive, type Transport } from '@agentconnect.md/connection'
import {
  RELAY_COMPUTER_MAX_BODY_BYTES,
  RELAY_COMPUTER_MAX_FRAME_BYTES,
  RELAY_COMPUTER_MCP_ROUTE,
  RELAY_COMPUTER_REQUEST_TIMEOUT_MS,
  RELAY_COMPUTER_SUBPROTOCOL,
  RELAY_COMPUTER_WS_PATH,
  buildRelayComputerFrame,
  decodeRelayComputerFrame,
  type CrHttpResponse,
  type RcVerifyResult,
  type RelayComputerFrame,
  type RelayComputerFrameType,
  type RELAY_COMPUTER_SCHEMAS
} from '@agentconnect.md/protocol'
import type { z } from 'zod'
import type { Logger } from './log.js'

const HELLO_TIMEOUT_MS = 10_000
const CLOSE_BAD_HELLO = 4400
const CLOSE_AUTH_FAILED = 4401
const CLOSE_SUPERSEDED = 1012
/** Requests one desktop may have in flight through this relay; more get 429. */
const DEFAULT_MAX_IN_FLIGHT = 16
/** Bytes queued on a desktop's socket beyond which new requests get 503 instead of piling up. */
const SEND_HIGH_WATER_BYTES = 32 * 1024 * 1024

// Only what Streamable HTTP MCP needs crosses the relay; cookies, hop-by-hop and proxy headers never do.
const FORWARD_REQUEST_HEADERS = ['authorization', 'content-type', 'accept', 'mcp-protocol-version', 'mcp-session-id']
const FORWARD_RESPONSE_HEADERS = ['allow', 'content-type', 'mcp-protocol-version', 'mcp-session-id', 'www-authenticate']

export interface ComputerRelayDeps {
  /** `rc/verify` of the desktop's relay-audience token; the CP checks it against the Computer's live channel key. */
  verify: (token: string, computerId: string) => Promise<RcVerifyResult>
  relayId: () => string | undefined
  log: Logger
  keepaliveMs?: number
  requestTimeoutMs?: number
  maxInFlight?: number
}

export interface ComputerRelay {
  readonly wss: WebSocketServer
  /** Whether a desktop for this Computer is attached here. */
  attached(computerId: string): boolean
  /** Requests forwarded to this Computer's desktop and not yet answered. */
  inFlight(computerId: string): number
  size(): number
}

interface Pending {
  resolve: (res: CrHttpResponse) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

// One desktop's authenticated socket: requests go out as `cr/http`, replies settle by `corr`.
class DesktopLink {
  computerId = ''
  private readonly pending = new Map<string, Pending>()

  constructor(
    private readonly transport: Transport,
    private readonly bufferedAmount: () => number
  ) {}

  get inFlight(): number {
    return this.pending.size
  }

  get congested(): boolean {
    return this.bufferedAmount() > SEND_HIGH_WATER_BYTES
  }

  forward(request: z.input<(typeof RELAY_COMPUTER_SCHEMAS)['cr/http']>, timeoutMs: number): Promise<CrHttpResponse> {
    const frame = buildRelayComputerFrame('cr/http', request)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(frame.id)
        reject(new Error('timeout'))
      }, timeoutMs)
      this.pending.set(frame.id, { resolve, reject, timer })
      try {
        this.transport.send(JSON.stringify(frame))
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(frame.id)
        reject(err as Error)
      }
    })
  }

  settle(frame: RelayComputerFrame): void {
    const waiting = frame.corr ? this.pending.get(frame.corr) : undefined
    if (!waiting) return
    this.pending.delete(frame.corr!)
    clearTimeout(waiting.timer)
    if (frame.type === 'cr/http/result') waiting.resolve(frame.payload)
    else if (frame.type === 'error') waiting.reject(new Error(frame.payload.code))
  }

  failAll(reason: string): void {
    for (const [id, waiting] of this.pending) {
      clearTimeout(waiting.timer)
      waiting.reject(new Error(reason))
      this.pending.delete(id)
    }
  }

  send<T extends RelayComputerFrameType>(
    type: T,
    payload: z.input<(typeof RELAY_COMPUTER_SCHEMAS)[T]>,
    corr?: string
  ): void {
    this.transport.send(JSON.stringify(buildRelayComputerFrame(type, payload, corr ? { corr } : {})))
  }

  close(code: number, reason: string): void {
    this.failAll('closed')
    this.transport.close(code, reason)
  }
}

const bearerOk = (header: string | undefined): boolean => /^Bearer\s+\S+$/i.test(header ?? '')

export function createComputerRelay(app: FastifyInstance, deps: ComputerRelayDeps): ComputerRelay {
  const byComputer = new Map<string, DesktopLink>()
  const timeoutMs = deps.requestTimeoutMs ?? RELAY_COMPUTER_REQUEST_TIMEOUT_MS
  const maxInFlight = deps.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: RELAY_COMPUTER_MAX_FRAME_BYTES,
    handleProtocols: (protocols: Set<string>) =>
      protocols.has(RELAY_COMPUTER_SUBPROTOCOL) ? RELAY_COMPUTER_SUBPROTOCOL : false
  })
  const trackAlive = attachKeepalive(wss, deps.keepaliveMs ?? 30_000)

  function accept(raw: WebSocket, remoteAddr: string): void {
    const transport = new WsServerTransport(raw, remoteAddr)
    const link = new DesktopLink(transport, () => raw.bufferedAmount)
    let state: 'HELLO' | 'VERIFYING' | 'READY' | 'CLOSED' = 'HELLO'
    const helloTimer = setTimeout(() => {
      if (state === 'HELLO' || state === 'VERIFYING') link.close(1008, 'hello timeout')
    }, HELLO_TIMEOUT_MS)
    transport.onClose(() => {
      state = 'CLOSED'
      clearTimeout(helloTimer)
      link.failAll('desktop disconnected')
      if (link.computerId && byComputer.get(link.computerId) === link) byComputer.delete(link.computerId)
    })
    transport.onMessage((text) => {
      const decoded = decodeRelayComputerFrame(text)
      if (!decoded.ok) {
        if (state !== 'READY') return link.close(CLOSE_BAD_HELLO, 'bad hello')
        if (decoded.corr) link.settle(errorFrame(decoded.corr, decoded.msg))
        return
      }
      const frame = decoded.frame
      if (state === 'READY') return link.settle(frame)
      if (state !== 'HELLO' || frame.type !== 'cr/hello') return link.close(CLOSE_BAD_HELLO, 'bad hello')
      state = 'VERIFYING'
      const hello = frame.payload
      void deps
        .verify(hello.token, hello.computerId)
        .catch((): RcVerifyResult => ({ ok: false, reason: 'verify unavailable' }))
        .then((verdict) => {
          if (state !== 'VERIFYING') return
          clearTimeout(helloTimer)
          const relayId = deps.relayId()
          if (!verdict.ok || verdict.computerId !== hello.computerId || !relayId) {
            link.send(
              'error',
              { code: 'AUTH_FAILED', message: 'computer credential refused', retryable: true },
              frame.id
            )
            state = 'CLOSED'
            return link.close(CLOSE_AUTH_FAILED, 'auth failed')
          }
          state = 'READY'
          link.computerId = hello.computerId
          const prev = byComputer.get(hello.computerId)
          byComputer.set(hello.computerId, link)
          if (prev && prev !== link) prev.close(CLOSE_SUPERSEDED, 'superseded by a newer connection for this computer')
          link.send('cr/hello/ok', { relayId }, frame.id)
          deps.log.info(`relay: computer ${hello.computerId} attached (desktop ${hello.desktopDaemonVersion})`)
        })
    })
  }

  app.server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    let pathname: string
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    } catch {
      socket.destroy()
      return
    }
    if (pathname !== RELAY_COMPUTER_WS_PATH) return
    const offered = (req.headers['sec-websocket-protocol'] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (!offered.includes(RELAY_COMPUTER_SUBPROTOCOL)) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (raw: WebSocket) => {
      trackAlive(raw)
      accept(raw, req.socket.remoteAddress ?? 'unknown')
    })
  })

  async function forward(req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
    // The desktop verifies the token; a request without one is refused here so it never reaches a desktop.
    if (!bearerOk(req.headers.authorization)) return reply.code(401).send({ error: 'missing bearer token' })
    // Bodies are buffered, so a GET's standalone SSE stream could only hold a slot until it timed out.
    if (req.method === 'GET')
      return reply.code(405).header('allow', 'POST, DELETE').send({ error: 'method not allowed' })
    const computerId = (req.params as { computerId?: string }).computerId ?? ''
    const link = byComputer.get(computerId)
    if (!link) return reply.code(503).send({ error: 'computer_not_attached' })
    if (link.inFlight >= maxInFlight) return reply.code(429).send({ error: 'too many requests for this computer' })
    if (link.congested) return reply.code(503).send({ error: 'computer link congested' })
    const headers: Record<string, string> = {}
    for (const name of FORWARD_REQUEST_HEADERS) {
      const value = req.headers[name]
      if (typeof value === 'string') headers[name] = value
    }
    const body = req.body as Buffer | undefined
    let res: CrHttpResponse
    try {
      res = await link.forward(
        {
          method: req.method as 'GET' | 'POST' | 'DELETE',
          path: '/mcp',
          headers,
          ...(body && body.length > 0 ? { body: body.toString('base64') } : {})
        },
        timeoutMs
      )
    } catch (err) {
      const timedOut = (err as Error).message === 'timeout'
      return reply.code(timedOut ? 504 : 502).send({ error: timedOut ? 'computer timed out' : 'computer unreachable' })
    }
    const out = res.body ? Buffer.from(res.body, 'base64') : Buffer.alloc(0)
    if (out.length > RELAY_COMPUTER_MAX_BODY_BYTES)
      return reply.code(502).send({ error: 'computer response too large' })
    for (const name of FORWARD_RESPONSE_HEADERS) {
      const value = res.headers[name]
      if (value !== undefined) void reply.header(name, value)
    }
    return reply.code(res.status).send(out)
  }

  void app.register(async (scope) => {
    // Bodies pass through as bytes; the relay never parses MCP.
    scope.removeAllContentTypeParsers()
    scope.addContentTypeParser(
      '*',
      { parseAs: 'buffer', bodyLimit: RELAY_COMPUTER_MAX_BODY_BYTES },
      (_req, body, done) => done(null, body)
    )
    scope.route({ method: ['GET', 'POST', 'DELETE'], url: RELAY_COMPUTER_MCP_ROUTE, handler: forward })
  })

  return {
    wss,
    attached: (computerId) => byComputer.has(computerId),
    inFlight: (computerId) => byComputer.get(computerId)?.inFlight ?? 0,
    size: () => byComputer.size
  }
}

function errorFrame(corr: string, msg: string): RelayComputerFrame {
  return buildRelayComputerFrame(
    'error',
    { code: msg === 'FRAME_TOO_LARGE' ? 'FRAME_TOO_LARGE' : 'BAD_PAYLOAD', message: msg, retryable: false },
    { corr, id: randomUUID() }
  )
}
