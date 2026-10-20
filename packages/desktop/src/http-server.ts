import { once } from 'node:events'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node'
import type { McpServer } from '@modelcontextprotocol/server'
import type { Computer } from './computer.js'
import type { McpPrincipal } from './mcp-access.js'
import { controlHost, isLoopbackHost, isWildcardHost } from './config.js'
import { runSelf } from './self.js'
import type { Viewer } from './viewer.js'

export const CONTROL_HEADER = 'x-agentconnect-desktop'

// IPv6 literals need brackets inside a URL.
export const urlHost = (host: string): string => (host.includes(':') ? `[${host}]` : host)

export interface HttpServerOptions {
  host: string
  port: number
  computer: Computer
  authenticate: (authorization: string | undefined) => McpPrincipal | undefined
  createMcpServer: (principal: McpPrincipal) => McpServer
  log: (line: string) => void
  // Browser remote desktop under /view; its page is public, its API uses the same bearer tokens.
  viewer?: Viewer
}

export interface RunningHttpServer {
  url: string
  // The address the public listener actually bound.
  address: AddressInfo
  close(): Promise<void>
}

const isLoopback = (req: IncomingMessage): boolean =>
  /^(::1|(::ffff:)?127(\.\d{1,3}){3})$/.test(req.socket.remoteAddress ?? '')

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = typeof body === 'string' ? body : JSON.stringify(body, null, 2)
  res.writeHead(status, { 'content-type': typeof body === 'string' ? 'text/plain' : 'application/json', ...headers })
  res.end(typeof body === 'string' ? `${text}\n` : text)
}

// Stateless Streamable HTTP: one MCP server per request, identified by its bearer token's principal.
export async function startHttpServer(options: HttpServerOptions): Promise<RunningHttpServer> {
  const active = new Set<McpServer>()
  const http = createServer(async (req, res) => {
    try {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname
      if (path === '/healthz') return send(res, 200, 'ok')
      if (path.startsWith('/control/')) return await control(req, res, path, options)
      if (options.viewer && (path === '/view' || path.startsWith('/view/')))
        return await options.viewer.handle(req, res, path)
      if (path !== '/mcp') return send(res, 404, 'not found')
      const principal = options.authenticate(req.headers.authorization)
      if (!principal) return send(res, 401, 'unauthorized', { 'www-authenticate': 'Bearer' })
      const mcp = options.createMcpServer(principal)
      const transport = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true
      })
      active.add(mcp)
      res.once('close', () => {
        active.delete(mcp)
        void mcp.close().catch(() => undefined)
      })
      await mcp.connect(transport)
      await transport.handleRequest(req, res)
    } catch (error) {
      options.log(`request failed: ${(error as Error).message}`)
      if (res.headersSent) return res.destroy()
      send(res, 500, 'failed')
    }
  })
  http.listen(options.port, options.host)
  await once(http, 'listening')
  const address = http.address()
  if (!address || typeof address === 'string') throw new Error('desktop daemon failed to bind')
  const localControl = await listenLocalControl(options, address.port)
  const shownHost = isWildcardHost(options.host) ? '127.0.0.1' : options.host
  return {
    url: `http://${urlHost(shownHost)}:${address.port}/mcp`,
    address,
    async close() {
      const closing = Promise.all([http, ...(localControl ? [localControl] : [])].map(closeServer))
      options.viewer?.close()
      http.closeAllConnections()
      localControl?.closeAllConnections()
      await closing
      await Promise.allSettled([...active].map((server) => server.close()))
    }
  }
}

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))

// A specific non-loopback host (a LAN or Tailscale IP) gets a second loopback listener so the owner CLI reaches /control.
async function listenLocalControl(options: HttpServerOptions, port: number): Promise<Server | undefined> {
  if (isLoopbackHost(options.host) || isWildcardHost(options.host)) return undefined
  const local = createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    if (path === '/healthz') return send(res, 200, 'ok')
    if (!path.startsWith('/control/')) return send(res, 404, 'not found')
    try {
      await control(req, res, path, options)
    } catch (error) {
      options.log(`control request failed: ${(error as Error).message}`)
      if (res.headersSent) return res.destroy()
      send(res, 500, 'failed')
    }
  })
  local.listen(port, controlHost(options.host))
  try {
    await once(local, 'listening')
    return local
  } catch (error) {
    options.log(`owner controls unavailable: cannot listen on loopback port ${port}: ${(error as Error).message}`)
    return undefined
  }
}

// Owner controls for the local CLI; loopback-only, and a custom header plus no Origin keeps browsers out.
async function control(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  options: HttpServerOptions
): Promise<void> {
  if (!isLoopback(req)) return send(res, 403, 'control endpoints are loopback-only')
  if (req.headers.origin || req.headers[CONTROL_HEADER] !== '1') return send(res, 403, 'forbidden')
  const { computer } = options
  if (path === '/control/status' && req.method === 'GET') return send(res, 200, computer.info())
  // Checks run as children of the daemon, so on macOS they see the daemon's (the .app's) permissions.
  const query = new URL(req.url ?? '/', 'http://localhost').searchParams
  if (path === '/control/permissions' && req.method === 'GET') {
    const prompt = query.get('prompt') === '1'
    const output = await runSelf(['permissions', '--json', ...(prompt ? ['--prompt'] : [])], prompt ? 200_000 : 30_000)
    return send(res, 200, JSON.parse(output))
  }
  if (path === '/control/doctor' && req.method === 'GET') {
    const captureMs = Math.min(Number(query.get('captureTimeoutMs')) || 15_000, 180_000)
    const output = await runSelf(
      ['doctor', '--json', '--here', '--capture-timeout', String(captureMs)],
      captureMs + 90_000
    )
    return send(res, 200, JSON.parse(output))
  }
  if (path === '/control/pause' && req.method === 'POST') {
    computer.pause('stopped by the local owner')
    options.log('PAUSED by local owner: all agent input is blocked until resume')
    return send(res, 200, computer.info())
  }
  if (path === '/control/resume' && req.method === 'POST') {
    computer.resume()
    options.log('resumed by local owner')
    return send(res, 200, computer.info())
  }
  send(res, 404, 'not found')
}
