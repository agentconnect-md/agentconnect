// The managed desktop's egress forwarder (computer-use.md §15.4): the browser's only proxy, sending traffic out directly or through the organization's proxy.
import { request as httpRequest, createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { connect as netConnect, isIP, type Socket } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import type { ComputerEgress } from '@agentconnect.md/protocol/computer'

/** The forwarder port's environment variable; the image sets it in managed pods and points the browser at it. */
export const EGRESS_PORT_ENV = 'AGENTCONNECT_EGRESS_PORT'

/** Until the Control Plane says, nothing leaves: a managed desktop never goes direct when its organization wants a proxy. */
export type EgressPolicy = ComputerEgress | { mode: 'pending' }

const CONNECT_TIMEOUT_MS = 15_000
const MAX_PROXY_HEADER_BYTES = 16 * 1024
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
])

export function egressPort(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env[EGRESS_PORT_ENV]?.trim()
  if (!raw) return undefined
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Error(`${EGRESS_PORT_ENV} is not a valid port: ${raw}`)
  return port
}

/** `host:port` of a CONNECT target; undefined when it names no port. */
function connectTarget(authority: string | undefined): { host: string; port: number } | undefined {
  const match = /^\[?([^\]]+?)\]?:(\d{1,5})$/.exec(authority ?? '')
  if (!match) return undefined
  const port = Number(match[2])
  return port > 0 && port <= 65_535 ? { host: match[1]!, port } : undefined
}

const basic = (egress: Extract<ComputerEgress, { mode: 'proxy' }>): string | undefined =>
  egress.username !== undefined || egress.password !== undefined
    ? `Basic ${Buffer.from(`${egress.username ?? ''}:${egress.password ?? ''}`).toString('base64')}`
    : undefined

function forwardHeaders(headers: IncomingMessage['headers']): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !HOP_BY_HOP.has(name.toLowerCase())) out[name] = value
  }
  return out
}

export interface EgressForwarderOptions {
  port: number
  host?: string
  log: (line: string) => void
}

export class EgressForwarder {
  private policy: EgressPolicy = { mode: 'pending' }
  private server: Server | undefined
  private readonly sockets = new Set<Socket>()

  constructor(private readonly opts: EgressForwarderOptions) {}

  get mode(): EgressPolicy['mode'] {
    return this.policy.mode
  }

  /** Apply the organization's egress; open connections keep the route they started on. */
  apply(policy: EgressPolicy): void {
    const before = this.describe()
    this.policy = policy
    const after = this.describe()
    if (after !== before) this.opts.log(`egress: ${after}`)
  }

  // Never the credentials: the proxy's origin is enough to tell which one is in use.
  private describe(): string {
    if (this.policy.mode !== 'proxy') return this.policy.mode
    return `proxy ${new URL(this.policy.url).origin}`
  }

  async start(): Promise<number> {
    const server = createServer((req, res) => this.onRequest(req, res))
    server.on('connect', (req: IncomingMessage, socket: Socket, head: Buffer) => this.onConnect(req, socket, head))
    server.on('connection', (socket: Socket) => {
      this.sockets.add(socket)
      socket.once('close', () => this.sockets.delete(socket))
    })
    server.on('clientError', (_err, socket) => socket.destroy())
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.opts.port, this.opts.host ?? '127.0.0.1', () => resolve())
    })
    this.server = server
    const address = server.address()
    return typeof address === 'object' && address ? address.port : this.opts.port
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy()
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()))
    this.server = undefined
  }

  // A tunnel (HTTPS and WebSocket traffic): straight to the target, or a CONNECT through the organization's proxy.
  private onConnect(req: IncomingMessage, client: Socket, head: Buffer): void {
    const policy = this.policy
    const target = connectTarget(req.url)
    const refuse = (status: string): void => {
      client.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    }
    if (!target) return refuse('400 Bad Request')
    if (policy.mode === 'pending') return refuse('503 Service Unavailable')
    client.on('error', () => {})
    const upstream =
      policy.mode === 'direct' ? netConnect(target.port, target.host) : this.dialProxy(new URL(policy.url))
    let opened = false
    upstream.setTimeout(CONNECT_TIMEOUT_MS, () => upstream.destroy(new Error('timeout')))
    upstream.on('error', () => {
      if (opened) client.destroy()
      else if (!client.destroyed) refuse('502 Bad Gateway')
    })
    client.once('close', () => upstream.destroy())
    const open = (rest: Buffer): void => {
      opened = true
      upstream.setTimeout(0)
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (rest.length > 0) client.write(rest)
      if (head.length > 0) upstream.write(head)
      upstream.pipe(client)
      client.pipe(upstream)
    }
    if (policy.mode === 'direct') {
      upstream.once('connect', () => open(Buffer.alloc(0)))
      return
    }
    const auth = basic(policy)
    const authority = target.host.includes(':') ? `[${target.host}]:${target.port}` : `${target.host}:${target.port}`
    upstream.once(policy.url.startsWith('https:') ? 'secureConnect' : 'connect', () => {
      upstream.write(
        `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${auth ? `Proxy-Authorization: ${auth}\r\n` : ''}\r\n`
      )
    })
    let buffered = Buffer.alloc(0)
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk])
      const end = buffered.indexOf('\r\n\r\n')
      if (end < 0) {
        if (buffered.length > MAX_PROXY_HEADER_BYTES) upstream.destroy(new Error('oversized proxy reply'))
        return
      }
      upstream.off('data', onData)
      const status = /^HTTP\/1\.[01] (\d{3})/.exec(buffered.subarray(0, end).toString('latin1'))?.[1]
      if (status !== '200') {
        upstream.destroy()
        return refuse(status === '407' ? '502 Bad Gateway (egress proxy refused the credentials)' : '502 Bad Gateway')
      }
      open(buffered.subarray(end + 4))
    }
    upstream.on('data', onData)
  }

  // A plain HTTP request in absolute form: fetched directly, or handed to the organization's proxy as is.
  private onRequest(req: IncomingMessage, res: ServerResponse): void {
    const policy = this.policy
    let target: URL
    try {
      target = new URL(req.url ?? '')
    } catch {
      res.writeHead(400).end()
      return
    }
    if (target.protocol !== 'http:') return void res.writeHead(400).end()
    if (policy.mode === 'pending') return void res.writeHead(503).end('egress is not configured yet')
    const headers = forwardHeaders(req.headers)
    let upstream
    if (policy.mode === 'direct') {
      upstream = httpRequest({
        host: target.hostname,
        port: target.port || 80,
        method: req.method,
        path: `${target.pathname}${target.search}`,
        headers
      })
    } else {
      const proxy = new URL(policy.url)
      const auth = basic(policy)
      upstream = (proxy.protocol === 'https:' ? httpsRequest : httpRequest)({
        host: proxy.hostname,
        port: proxy.port || (proxy.protocol === 'https:' ? 443 : 80),
        method: req.method,
        path: target.href,
        headers: { ...headers, ...(auth ? { 'proxy-authorization': auth } : {}) }
      })
    }
    upstream.setTimeout(CONNECT_TIMEOUT_MS, () => upstream.destroy(new Error('timeout')))
    upstream.on('response', (answer) => {
      upstream.setTimeout(0)
      res.writeHead(answer.statusCode ?? 502, forwardHeaders(answer.headers))
      answer.pipe(res)
    })
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502).end()
      else res.destroy()
    })
    req.pipe(upstream)
  }

  private dialProxy(proxy: URL): Socket {
    const port = Number(proxy.port || (proxy.protocol === 'https:' ? 443 : 80))
    return proxy.protocol === 'https:'
      ? tlsConnect({ host: proxy.hostname, port, ...(isIP(proxy.hostname) ? {} : { servername: proxy.hostname }) })
      : netConnect(port, proxy.hostname)
  }
}
