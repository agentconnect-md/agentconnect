import { chmodSync, mkdirSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { dirname } from 'node:path'
import { isWindowsNamedPipe } from '../paths.js'

/** What a route returns: an HTTP status and an optional JSON body. */
export interface LocalApiReply {
  status: number
  body?: unknown
}

/** One route; `path` segments starting with `:` are captured into `params`. */
export interface LocalApiRoute {
  method: 'GET' | 'POST' | 'PATCH'
  path: string
  handle(input: { params: Record<string, string>; body: unknown }): Promise<LocalApiReply>
}

const MAX_BODY_BYTES = 64 * 1024

function match(route: LocalApiRoute, method: string, path: string): Record<string, string> | undefined {
  if (route.method !== method) return undefined
  const want = route.path.split('/')
  const got = path.split('/')
  if (want.length !== got.length) return undefined
  const params: Record<string, string> = {}
  for (let i = 0; i < want.length; i++) {
    const segment = want[i]!
    if (segment.startsWith(':')) params[segment.slice(1)] = decodeURIComponent(got[i]!)
    else if (segment !== got[i]) return undefined
  }
  return params
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) throw new Error('body too large')
    chunks.push(chunk as Buffer)
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined
}

function send(res: ServerResponse, reply: LocalApiReply): void {
  if (reply.body === undefined) return void res.writeHead(reply.status).end()
  res.writeHead(reply.status, { 'content-type': 'application/json' }).end(JSON.stringify(reply.body))
}

/** HTTP on the daemon's `local` IPC socket for processes of the daemon's OS user; the socket's file mode is the only authority. */
export class LocalApiServer {
  private server?: Server

  constructor(
    private readonly opts: {
      socketPath: string
      routes: LocalApiRoute[]
      log?: { info(msg: string): void; warn(msg: string): void; error(msg: string): void }
    }
  ) {}

  /** Listen, or refuse with `false` where the endpoint would be a Windows named pipe, which has no owner-only mode to lean on. */
  async start(): Promise<boolean> {
    if (this.server) return true
    const path = this.opts.socketPath
    if (isWindowsNamedPipe(path)) {
      this.opts.log?.warn('local api: not started — a Windows named pipe has no owner-only permission to guard it')
      return false
    }
    // 0700 dir + 0600 socket confines the API to the daemon's uid.
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    chmodSync(dirname(path), 0o700)
    rmSync(path, { force: true })
    const server = createServer((req, res) => void this.serve(req, res))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(path, () => {
        server.off('error', reject)
        server.on('error', (err) => this.opts.log?.error(`local api: server error: ${err.message}`))
        resolve()
      })
    })
    this.server = server
    try {
      chmodSync(path, 0o600)
    } catch (err) {
      // Fail closed: a socket we could not narrow to the owner must not serve.
      await this.stop()
      throw err
    }
    this.opts.log?.info(`local api: listening at ${path}`)
    return true
  }

  async stop(): Promise<void> {
    const server = this.server
    if (!server) return
    this.server = undefined
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(this.opts.socketPath, { force: true })
  }

  private async serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const path = new URL(req.url ?? '/', 'http://local').pathname
      for (const route of this.opts.routes) {
        const params = match(route, req.method ?? '', path)
        if (!params) continue
        let body: unknown
        try {
          body = await readJson(req)
        } catch (err) {
          return send(res, { status: 400, body: { error: (err as Error).message } })
        }
        return send(res, await route.handle({ params, body }))
      }
      send(res, { status: 404, body: { error: 'not found' } })
    } catch (err) {
      this.opts.log?.warn(`local api: ${req.method} ${req.url} failed: ${(err as Error).message}`)
      send(res, { status: 500, body: { error: 'internal error' } })
    }
  }
}
