import { createServer, type Server } from 'node:http'
import type { InClusterConfig } from '../config.js'

/** One handler decides every response; return `lines` (+`hold`) to emulate `?watch=true` streams. */
export interface FakeRoute {
  (req: { method: string; url: URL; body: string; headers: Record<string, string | string[] | undefined> }): {
    status?: number
    json?: unknown
    lines?: unknown[]
    hold?: boolean
  }
}

export interface FakeApiServer {
  config: InClusterConfig
  requests: URL[]
  tokens: string[]
}

const servers: Server[] = []

/** In-process fake API server; pair with closeFakeApiServers() in afterEach. */
export async function fakeApiServer(route: FakeRoute): Promise<FakeApiServer> {
  const requests: URL[] = []
  const tokens: string[] = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      requests.push(url)
      const auth = req.headers.authorization
      if (typeof auth === 'string') tokens.push(auth.replace(/^Bearer /, ''))
      const result = route({ method: req.method ?? 'GET', url, body, headers: req.headers })
      res.statusCode = result.status ?? 200
      res.setHeader('content-type', 'application/json')
      if (result.lines) {
        for (const line of result.lines) res.write(`${JSON.stringify(line)}\n`)
        if (!result.hold) res.end()
        return
      }
      res.end(JSON.stringify(result.json ?? {}))
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  let tokenReads = 0
  return {
    config: {
      server: `http://127.0.0.1:${port}`,
      namespace: 'org-test',
      // Distinct value per read makes a client that fails to re-read the rotating projected token detectable.
      token: () => `token-${++tokenReads}`
    },
    requests,
    tokens
  }
}

/** Close every fake server started since the last call; call from afterEach. */
export async function closeFakeApiServers(): Promise<void> {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
}
