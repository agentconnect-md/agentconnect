// A managed desktop pod's registration (computer-use.md §15.1): the pool member that claimed it pushes a one-time token here.
import { once } from 'node:events'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Registration } from './registration.js'

/** Set by the pool's pod template: the port the member dials, and what turns pool mode on. */
export const POOL_BOOTSTRAP_PORT_ENV = 'AGENTCONNECT_POOL_BOOTSTRAP_PORT'

/** The pool's port, or undefined outside the pool; a bad value fails the start rather than going unregistered. */
export function poolBootstrapPort(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env[POOL_BOOTSTRAP_PORT_ENV]?.trim()
  if (!raw) return undefined
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Error(`${POOL_BOOTSTRAP_PORT_ENV} is not a valid port: ${raw}`)
  return port
}

const MAX_BODY = 4096

export interface PoolBootstrapOptions {
  port: number
  host?: string
  /** The stored registration, read on every status so a revoke or a new key shows at once. */
  load: () => Registration | undefined
  /** Spend a pushed token with this pod's profile and store the key; throws when the CP refuses it. */
  register: (token: string, name: string) => Promise<Registration>
  log: (line: string) => void
}

export interface PoolBootstrap {
  /** Resolves once the pod holds a live key, at once when it already did. */
  registered: Promise<Registration>
  address: AddressInfo
  close(): Promise<void>
}

const live = (registration: Registration | undefined): Registration | undefined =>
  registration && !registration.revokedAt ? registration : undefined

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage): Promise<string> {
  let body = ''
  for await (const chunk of req) {
    body += String(chunk)
    if (body.length > MAX_BODY) throw new Error('body too large')
  }
  return body
}

/**
 * Serves `GET /pool/status` for the life of the pod, and `POST /pool/register` only until the pod holds a key.
 * The NetworkPolicy admits only pool members to this port; the token is spent once and never logged.
 */
export async function startPoolBootstrap(options: PoolBootstrapOptions): Promise<PoolBootstrap> {
  let resolveRegistered!: (registration: Registration) => void
  const registered = new Promise<Registration>((resolve) => (resolveRegistered = resolve))
  const existing = live(options.load())
  if (existing) resolveRegistered(existing)
  let registering: Promise<Registration> | undefined
  const status = () => {
    const current = live(options.load())
    return current ? { registered: true, computerId: current.computerId } : { registered: false }
  }
  const server: Server = createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname
      if (path === '/pool/status' && req.method === 'GET') return send(res, 200, status())
      if (path !== '/pool/register' || req.method !== 'POST') return send(res, 404, { error: 'not found' })
      if (status().registered) return send(res, 409, status())
      let token: unknown
      let name: unknown
      try {
        ;({ token, name } = JSON.parse(await readBody(req)) as { token?: unknown; name?: unknown })
      } catch {
        return send(res, 400, { error: 'invalid body' })
      }
      if (typeof token !== 'string' || !token || typeof name !== 'string' || !name.trim())
        return send(res, 400, { error: 'token and name are required' })
      // A second push while the first is spending waits for it rather than spending another token.
      registering ??= options.register(token, name.trim().slice(0, 120)).finally(() => (registering = undefined))
      try {
        const registration = await registering
        options.log(`registered as managed computer ${registration.computerId}`)
        resolveRegistered(registration)
        return send(res, 200, { registered: true, computerId: registration.computerId })
      } catch (error) {
        options.log(`managed registration failed: ${(error as Error).message}`)
        return send(res, 502, { error: 'registration failed' })
      }
    })().catch(() => {
      if (!res.headersSent) send(res, 500, { error: 'failed' })
    })
  })
  server.listen(options.port, options.host ?? '0.0.0.0')
  await once(server, 'listening')
  const address = server.address() as AddressInfo
  if (!existing) options.log(`waiting for the pool to register this desktop (port ${address.port})`)
  return {
    registered,
    address,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}
