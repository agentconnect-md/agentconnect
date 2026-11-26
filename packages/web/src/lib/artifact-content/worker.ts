// The content-domain service worker (artifacts.md §5.5), keeping no bytes; each function is shipped via `toString()`, so it uses only its parameters and browser globals.
import type { ContentReply, ContentRequest } from './protocol'

export interface WorkerConfig {
  /** `frame-ancestors 'self' <console origin>`, added to every navigation response the worker builds. */
  ancestors: string
  /** How long a port has to acknowledge or answer a request before it counts as dead. */
  replyMs: number
  /** How long an acknowledged request may take, since the console may be fetching a whole file. */
  answerMs: number
  /** How long the worker waits for a shim to bring a fresh port. */
  portMs: number
}

export const WORKER_CONFIG = { replyMs: 3_000, answerMs: 120_000, portMs: 5_000 } as const

export interface ClientLike {
  id: string
  url: string
  type: string
  frameType?: string
  postMessage(message: unknown): void
}

export interface PortLike {
  onmessage: ((event: { data: unknown }) => void) | null
  postMessage(message: unknown): void
}

interface FetchEventLike {
  request: {
    url: string
    method: string
    mode: string
    destination: string
    headers: { get(name: string): string | null }
  }
  clientId: string
  respondWith(response: Promise<unknown>): void
}

interface MessageEventLike {
  source: ClientLike | null
  data: unknown
  ports: readonly PortLike[]
}

export interface WorkerScope {
  location: { origin: string }
  clients: {
    get(id: string): Promise<ClientLike | undefined>
    matchAll(options: { includeUncontrolled: boolean; type: 'window' }): Promise<readonly ClientLike[]>
  }
  skipWaiting(): Promise<void>
  addEventListener(type: 'install', listener: () => void): void
  addEventListener(type: 'message', listener: (event: MessageEventLike) => void): void
  addEventListener(type: 'fetch', listener: (event: FetchEventLike) => void): void
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  Response: new (
    body: ArrayBuffer | string | null,
    init: { status: number; headers: Record<string, string> }
  ) => unknown
}

export type FetchRoute = 'network' | 'navigate' | 'subresource'

/** Which requests the worker answers: same-origin reads outside `/__ac/`, never a top-level navigation. */
export function fetchRoute(
  request: { url: string; method: string; mode: string; destination: string },
  origin: string
): FetchRoute {
  const url = new URL(request.url)
  if (url.origin !== origin || url.pathname.startsWith('/__ac/')) return 'network'
  if (request.method !== 'GET' && request.method !== 'HEAD') return 'network'
  if (request.mode !== 'navigate') return 'subresource'
  return request.destination === 'iframe' || request.destination === 'frame' ? 'navigate' : 'network'
}

/** A subresource is answered only for a nested frame or a worker; a top-level or popup window gets a 404. */
export function servesClient(client: Pick<ClientLike, 'type' | 'frameType'> | undefined): boolean {
  if (!client) return false
  if (client.type === 'window') return client.frameType === 'nested'
  return client.type === 'worker' || client.type === 'sharedworker'
}

/** The shim of this origin, framed by the console: the only client the worker takes a port from or asks for one. */
export function isShimClient(client: ClientLike | null | undefined, origin: string): boolean {
  if (!client || client.type !== 'window' || client.frameType !== 'nested') return false
  const url = new URL(client.url)
  return url.origin === origin && url.pathname === '/__ac/shim'
}

/** A console message on the port: an acknowledgement, a well-formed reply, or null for anything else. */
export function readReply(data: unknown): { id: number; ack: true } | ContentReply | null {
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  if (typeof d.id !== 'number' || !Number.isInteger(d.id)) return null
  if (d.ack === true) return { id: d.id, ack: true }
  const { status, type, body } = d
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 200 || status > 599) return null
  if (typeof type !== 'string' || type.length > 255 || /[\r\n]/.test(type)) return null
  if (body !== null && !(body instanceof ArrayBuffer)) return null
  if (status !== 206) return { id: d.id, status, type, body }
  const [start, end, size] = [d.start, d.end, d.size]
  if (!Number.isInteger(start) || !Number.isInteger(end) || !Number.isInteger(size)) return null
  if (!(body instanceof ArrayBuffer)) return null
  const [s, e, n] = [start, end, size] as [number, number, number]
  if (s < 0 || e < s || e >= n || body.byteLength !== e - s + 1) return null
  return { id: d.id, status, type, body, start: s, end: e, size: n }
}

/** Status, headers and body of the response the worker builds from a reply; null-body statuses drop the body. */
export function responseParts(
  reply: ContentReply,
  navigate: boolean,
  ancestors: string
): { status: number; headers: Record<string, string>; body: ArrayBuffer | null } {
  const headers: Record<string, string> = {
    'Content-Type': reply.type,
    'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff'
  }
  if (navigate) headers['Content-Security-Policy'] = ancestors
  if (reply.status === 206 && 'start' in reply)
    headers['Content-Range'] = `bytes ${reply.start}-${reply.end}/${reply.size}`
  const empty = reply.status === 204 || reply.status === 205 || reply.status === 304
  return { status: reply.status, headers, body: empty ? null : reply.body }
}

export interface WorkerLib {
  fetchRoute: typeof fetchRoute
  servesClient: typeof servesClient
  isShimClient: typeof isShimClient
  readReply: typeof readReply
  responseParts: typeof responseParts
}

/** Wire the worker's events to `scope`; returns its port table for tests. */
export function workerMain(scope: WorkerScope, config: WorkerConfig, lib: WorkerLib) {
  const origin = scope.location.origin
  const ports = new Map<string, PortLike>()
  const pending = new Map<number, (message: { ack: true } | ContentReply) => void>()
  let waiters: ((port: PortLike | null) => void)[] = []
  let asking: Promise<PortLike | null> | null = null
  let seq = 0

  scope.addEventListener('install', () => void scope.skipWaiting())

  scope.addEventListener('message', (event) => {
    const client = event.source
    const data = event.data as { t?: unknown } | null
    const port = event.ports[0]
    if (!client || !lib.isShimClient(client, origin) || data?.t !== 'port' || !port) return
    port.onmessage = (message) => {
      const reply = lib.readReply(message.data)
      if (reply) pending.get(reply.id)?.(reply)
    }
    ports.set(client.id, port)
    client.postMessage({ t: 'port-ok' })
    const ready = waiters
    waiters = []
    for (const resolve of ready) resolve(port)
  })

  // A live port, dropping those whose shim is gone; with none, every shim of the origin is asked for one.
  async function livePort(): Promise<PortLike | null> {
    for (const [id, port] of ports) {
      if (await scope.clients.get(id)) return port
      ports.delete(id)
    }
    if (!asking) {
      asking = (async () => {
        const windows = await scope.clients.matchAll({ includeUncontrolled: true, type: 'window' })
        const shims = windows.filter((client) => lib.isShimClient(client, origin))
        if (!shims.length) return null
        const got = new Promise<PortLike | null>((resolve) => {
          waiters.push(resolve)
          scope.setTimeout(() => {
            waiters = waiters.filter((waiter) => waiter !== resolve)
            resolve(null)
          }, config.portMs)
        })
        for (const shim of shims) shim.postMessage({ t: 'need-port' })
        return got
      })().finally(() => (asking = null))
    }
    return asking
  }

  // The reply, or 'dead' when the port neither acknowledged nor answered in time, or 'late' after an acknowledgement.
  function ask(port: PortLike, request: Omit<ContentRequest, 'id'>): Promise<ContentReply | 'dead' | 'late'> {
    const id = ++seq
    return new Promise((resolve) => {
      const finish = (result: ContentReply | 'dead' | 'late') => {
        scope.clearTimeout(timer)
        pending.delete(id)
        resolve(result)
      }
      let timer = scope.setTimeout(() => finish('dead'), config.replyMs)
      pending.set(id, (message) => {
        if (!('ack' in message)) return finish(message)
        scope.clearTimeout(timer)
        timer = scope.setTimeout(() => finish('late'), config.answerMs)
      })
      port.postMessage({ id, ...request } satisfies ContentRequest)
    })
  }

  // A dead port never errors, so a silent one is dropped and the request retried once on a fresh port.
  async function request(message: Omit<ContentRequest, 'id'>): Promise<ContentReply | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const port = await livePort()
      if (!port) return null
      const reply = await ask(port, message)
      if (reply === 'late') return null
      if (reply !== 'dead') return reply
      for (const [id, held] of ports) if (held === port) ports.delete(id)
    }
    return null
  }

  async function answer(event: FetchEventLike, navigate: boolean): Promise<unknown> {
    const plain = (status: number) => {
      const headers: Record<string, string> = { 'Content-Type': 'text/plain; charset=utf-8' }
      if (navigate) headers['Content-Security-Policy'] = config.ancestors
      return new scope.Response(status === 404 ? 'Not found' : 'The console did not answer', { status, headers })
    }
    if (!navigate) {
      const client = event.clientId ? await scope.clients.get(event.clientId) : undefined
      if (!lib.servesClient(client)) return plain(404)
    }
    const url = new URL(event.request.url)
    const reply = await request({ path: url.pathname, navigate, range: event.request.headers.get('range') })
    if (!reply) return plain(504)
    const parts = lib.responseParts(reply, navigate, config.ancestors)
    try {
      return new scope.Response(parts.body, { status: parts.status, headers: parts.headers })
    } catch {
      return plain(502)
    }
  }

  scope.addEventListener('fetch', (event) => {
    const route = lib.fetchRoute(event.request, origin)
    if (route === 'network') return
    event.respondWith(answer(event, route === 'navigate'))
  })

  return { ports }
}

const LIB: WorkerLib = { fetchRoute, servesClient, isShimClient, readReply, responseParts }

/** The worker script with the console origin embedded. */
export function workerScript(consoleOrigin: string): string {
  const config: WorkerConfig = { ancestors: `frame-ancestors 'self' ${consoleOrigin}`, ...WORKER_CONFIG }
  const lib = Object.entries(LIB)
    .map(([name, fn]) => `${JSON.stringify(name)}: ${fn.toString()}`)
    .join(',\n')
  return `'use strict';\n(${workerMain.toString()})(self, ${JSON.stringify(config)}, {\n${lib}\n});\n`
}
