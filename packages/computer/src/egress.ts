// The managed desktop's egress forwarder (computer-use.md §15.4): the browser's only proxy, sending traffic out directly or through the organization's proxy.
import {
  request as httpRequest,
  createServer,
  type ClientRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from 'node:http'
import { request as httpsRequest } from 'node:https'
import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
import { connect as netConnect, isIP, type LookupFunction, type Socket } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import type { ComputerEgress } from '@agentconnect.md/protocol/computer'
import type { LoopbackGuard } from './loopback-guard.js'

/** The forwarder port's environment variable; the image sets it in managed pods and points the browser at it. */
export const EGRESS_PORT_ENV = 'AGENTCONNECT_EGRESS_PORT'

/** Until the Control Plane says, nothing leaves: a managed desktop never goes direct when its organization wants a proxy. */
export type EgressPolicy = ComputerEgress | { mode: 'pending' }

const CONNECT_TIMEOUT_MS = 15_000
// What a closed port gets, and so every refused destination too (computer-use.md §5.8).
const UNREACHABLE = '502 Bad Gateway'
// Each port and reason is logged once per window, and a port scan only a few lines.
const REFUSAL_LOG_WINDOW_MS = 60_000
const REFUSAL_LOG_LINES = 5
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

const basic = (egress: OrgProxy): string | undefined =>
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

/** Where one destination goes: out directly to the addresses resolved once, to the organization's proxy, or nowhere. */
type OrgProxy = Extract<ComputerEgress, { mode: 'proxy' }>
type Route =
  { via: 'direct'; addresses: LookupAddress[]; local: boolean } | { via: 'proxy'; proxy: OrgProxy } | { via: 'closed' }

const resolveName = (name: string): Promise<LookupAddress[]> =>
  new Promise((resolve, reject) =>
    dnsLookup(name, { all: true }, (error, addresses) => (error ? reject(error) : resolve(addresses)))
  )

// Hands the connection the addresses already checked, so it never resolves the name a second time.
const pinned =
  (addresses: LookupAddress[]): LookupFunction =>
  (_hostname, options, callback) => {
    if (options.all) return callback(null, addresses)
    callback(null, addresses[0]!.address, addresses[0]!.family)
  }

export interface EgressForwarderOptions {
  port: number
  host?: string
  log: (line: string) => void
  // The loopback destinations it refuses (computer-use.md §5.8).
  loopback: LoopbackGuard
  // Resolves a name once; tests pass their own.
  lookup?: (name: string) => Promise<LookupAddress[]>
  // How long resolving a name or connecting may take; tests shorten it.
  timeoutMs?: number
  now?: () => number
}

const failure = (error: unknown): string =>
  (error as NodeJS.ErrnoException | undefined)?.code ?? (error as Error | undefined)?.name ?? 'Error'

export class EgressForwarder {
  private policy: EgressPolicy = { mode: 'pending' }
  private server: Server | undefined
  private listening: number | undefined
  private readonly sockets = new Set<Socket>()
  private refusals = { since: Number.NEGATIVE_INFINITY, logged: new Set<string>(), unlogged: 0 }
  private readonly timeoutMs: number

  constructor(private readonly opts: EgressForwarderOptions) {
    this.timeoutMs = opts.timeoutMs ?? CONNECT_TIMEOUT_MS
  }

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
    this.listening = typeof address === 'object' && address ? address.port : this.opts.port
    return this.listening
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
      if (!client.destroyed) client.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    }
    if (!target) return refuse('400 Bad Request')
    if (policy.mode === 'pending') return refuse('503 Service Unavailable')
    client.on('error', () => {})
    void this.route(policy, target.host, target.port)
      .then(async (route) => {
        if (client.destroyed || route.via === 'closed') return refuse(UNREACHABLE)
        if (route.via === 'proxy')
          return this.tunnel(this.dialProxy(new URL(route.proxy.url)), route.proxy, target, client, head, refuse)
        const upstream = await this.dial(route, target.host, target.port)
        if (!upstream) return refuse(UNREACHABLE)
        if (client.destroyed) return void upstream.destroy()
        this.tunnel(upstream, undefined, target, client, head, refuse)
      })
      .catch((error: unknown) => this.failed(error, () => refuse(UNREACHABLE)))
  }

  // `upstream` is a direct socket already connected and checked, or a fresh dial to the organization's proxy.
  private tunnel(
    upstream: Socket,
    proxy: OrgProxy | undefined,
    target: { host: string; port: number },
    client: Socket,
    head: Buffer,
    refuse: (status: string) => void
  ): void {
    let opened = false
    upstream.setTimeout(this.timeoutMs, () => upstream.destroy(new Error('timeout')))
    upstream.on('error', () => {
      if (opened) client.destroy()
      else refuse(UNREACHABLE)
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
    if (!proxy) return open(Buffer.alloc(0))
    const auth = basic(proxy)
    const authority = target.host.includes(':') ? `[${target.host}]:${target.port}` : `${target.host}:${target.port}`
    upstream.once(proxy.url.startsWith('https:') ? 'secureConnect' : 'connect', () => {
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
        return refuse(status === '407' ? '502 Bad Gateway (egress proxy refused the credentials)' : UNREACHABLE)
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
    const unreachable = (): void => {
      if (res.headersSent) res.destroy()
      else if (!res.destroyed) res.writeHead(502).end()
    }
    const port = Number(target.port || 80)
    void this.route(policy, target.hostname, port)
      .then(async (route) => {
        if (res.destroyed || route.via === 'closed') return unreachable()
        const headers = forwardHeaders(req.headers)
        let upstream: ClientRequest
        if (route.via === 'direct') {
          const socket = await this.dial(route, target.hostname, port)
          if (!socket) return unreachable()
          if (res.destroyed) return void socket.destroy()
          // The checked socket, never a pooled one: no agent keeps it for a later request to the same name.
          upstream = httpRequest({
            host: bare(target.hostname),
            port,
            createConnection: () => socket,
            method: req.method,
            path: `${target.pathname}${target.search}`,
            headers
          })
        } else {
          const proxy = new URL(route.proxy.url)
          const auth = basic(route.proxy)
          upstream = (proxy.protocol === 'https:' ? httpsRequest : httpRequest)({
            host: proxy.hostname,
            port: proxy.port || (proxy.protocol === 'https:' ? 443 : 80),
            method: req.method,
            path: target.href,
            headers: { ...headers, ...(auth ? { 'proxy-authorization': auth } : {}) }
          })
        }
        upstream.setTimeout(this.timeoutMs, () => upstream.destroy(new Error('timeout')))
        upstream.on('response', (answer) => {
          upstream.setTimeout(0)
          // A reply Node cannot pass on (a status like 099) gets the closed answer instead of throwing out of the daemon.
          try {
            res.writeHead(answer.statusCode ?? 502, forwardHeaders(answer.headers))
          } catch {
            upstream.destroy()
            return unreachable()
          }
          answer.pipe(res)
        })
        upstream.on('error', unreachable)
        req.pipe(upstream)
      })
      .catch((error: unknown) => this.failed(error, unreachable))
  }

  // In proxy mode a name resolves at the organization's proxy; only literals and localhost names are this machine's.
  private async route(policy: ComputerEgress, host: string, port: number): Promise<Route> {
    const name = bare(host).toLowerCase()
    // Chrome takes `localhost` and every `*.localhost` for loopback, so the forwarder does too.
    const resolved = /^(.+\.)?localhost\.?$/.test(name) ? 'localhost' : name
    const literal = isIP(resolved.replace(/%.*$/, '')) !== 0
    if (policy.mode === 'proxy' && !literal && resolved !== 'localhost') return { via: 'proxy', proxy: policy }
    let addresses: LookupAddress[]
    try {
      addresses = literal
        ? [{ address: resolved, family: isIP(resolved.replace(/%.*$/, '')) }]
        : await this.within((this.opts.lookup ?? resolveName)(resolved))
    } catch {
      return { via: 'closed' }
    }
    if (addresses.length === 0) return { via: 'closed' }
    if (!addresses.some((entry) => this.opts.loopback.isLocal(entry.address)))
      return policy.mode === 'proxy' ? { via: 'proxy', proxy: policy } : { via: 'direct', addresses, local: false }
    // A local destination it allows always connects here, never through the organization's proxy.
    return (await this.refused(port)) ? { via: 'closed' } : { via: 'direct', addresses, local: true }
  }

  // Every local destination waits for the same socket-table read, so a refused port answers no sooner than a closed one.
  private async refused(port: number): Promise<boolean> {
    const checked = await this.opts.loopback.refusal(port)
    const refusal = port === this.listening ? 'daemon listener' : checked
    if (refusal === undefined) return false
    this.note(`egress: refused loopback port ${port} (${refusal})`)
    return true
  }

  // Connects to the checked addresses, then checks a local port again: a listener that opened since is refused unwritten.
  private async dial(
    route: Extract<Route, { via: 'direct' }>,
    host: string,
    port: number
  ): Promise<Socket | undefined> {
    const upstream = netConnect({ host: bare(host), port, lookup: pinned(route.addresses) })
    upstream.on('error', () => {})
    upstream.setTimeout(this.timeoutMs, () => upstream.destroy(new Error('timeout')))
    const connected = await new Promise<boolean>((resolve) => {
      upstream.once('connect', () => resolve(true))
      upstream.once('close', () => resolve(false))
    })
    if (!connected) return undefined
    try {
      if (!route.local || !(await this.refused(port))) return upstream
    } catch (error) {
      upstream.destroy()
      throw error
    }
    upstream.destroy()
    return undefined
  }

  private within<T>(work: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined
    const expiry = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), this.timeoutMs)
    })
    return Promise.race([work, expiry]).finally(() => clearTimeout(timer))
  }

  // A check that throws answers like a closed port, and is logged with its error code alone.
  private failed(error: unknown, answer: () => void): void {
    this.note(`egress: destination check failed (${failure(error)})`)
    answer()
  }

  // Never the page's URL or host: the port and the reason are enough to tell what was probed.
  private note(line: string): void {
    const now = (this.opts.now ?? Date.now)()
    if (now - this.refusals.since >= REFUSAL_LOG_WINDOW_MS) {
      if (this.refusals.unlogged > 0)
        this.opts.log(`egress: ${this.refusals.unlogged} more loopback refusal(s) not logged`)
      this.refusals = { since: now, logged: new Set(), unlogged: 0 }
    }
    if (this.refusals.logged.has(line)) return
    if (this.refusals.logged.size >= REFUSAL_LOG_LINES) return void this.refusals.unlogged++
    this.refusals.logged.add(line)
    this.opts.log(line)
  }

  private dialProxy(proxy: URL): Socket {
    const port = Number(proxy.port || (proxy.protocol === 'https:' ? 443 : 80))
    return proxy.protocol === 'https:'
      ? tlsConnect({ host: proxy.hostname, port, ...(isIP(proxy.hostname) ? {} : { servername: proxy.hostname }) })
      : netConnect(port, proxy.hostname)
  }
}

// A URL's IPv6 hostname keeps its brackets; a socket wants the bare address.
const bare = (host: string): string => host.replace(/^\[(.*)\]$/, '$1')
