import { createServer as createHttpServer, request, type Server } from 'node:http'
import {
  connect,
  createServer as createTcpServer,
  type AddressInfo,
  type Server as TcpServer,
  type Socket
} from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { EgressForwarder, egressPort } from './egress.js'

const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close()
})

const portOf = (server: Server | TcpServer): number => (server.address() as AddressInfo).port

async function listen<T extends Server | TcpServer>(server: T): Promise<T> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const sockets = new Set<Socket>()
  server.on('connection', (s: Socket) => sockets.add(s))
  closers.push(async () => {
    for (const s of sockets) s.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  return server
}

/** A TCP echo target, the far end of a tunnel. */
const echo = () => listen(createTcpServer((socket) => socket.pipe(socket)))

/** A plain web server, the far end of an absolute-form request. */
const web = () =>
  listen(createHttpServer((req, res) => res.end(`hello ${req.method} ${req.url} via ${req.headers['x-hop'] ?? '-'}`)))

/** The organization's proxy: checks Basic credentials, then tunnels or forwards, noting every request it saw. */
async function orgProxy(user = 'acme', pass = 's3cret') {
  const seen: string[] = []
  const expected = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`
  const server = createHttpServer((req, res) => {
    seen.push(`${req.method} ${req.url}`)
    if (req.headers['proxy-authorization'] !== expected) return void res.writeHead(407).end()
    const target = new URL(req.url!)
    const upstream = request(
      {
        host: target.hostname,
        port: target.port,
        path: target.pathname,
        method: req.method,
        headers: { 'x-hop': 'proxy' }
      },
      (answer) => {
        res.writeHead(answer.statusCode!, answer.headers)
        answer.pipe(res)
      }
    )
    req.pipe(upstream)
  })
  server.on('connect', (req, socket: Socket, head) => {
    seen.push(`CONNECT ${req.url}`)
    if (req.headers['proxy-authorization'] !== expected)
      return void socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n')
    const [host, port] = req.url!.split(':')
    const upstream = connect(Number(port), host!, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
  })
  return { server: await listen(server), seen }
}

async function forwarder() {
  const lines: string[] = []
  const fwd = new EgressForwarder({ port: 0, log: (line) => lines.push(line) })
  const port = await fwd.start()
  closers.push(() => fwd.stop())
  return { fwd, port, lines }
}

/** CONNECT through the forwarder, then a round trip through the tunnel; the status line, and what came back. */
function tunnel(port: number, target: string): Promise<{ status: string; echoed?: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () =>
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`)
    )
    let buffered = ''
    let status: string | undefined
    socket.on('data', (chunk) => {
      buffered += chunk.toString()
      if (status === undefined) {
        const end = buffered.indexOf('\r\n\r\n')
        if (end < 0) return
        status = buffered.slice(0, buffered.indexOf('\r\n'))
        buffered = buffered.slice(end + 4)
        if (!status.includes(' 200 ')) {
          socket.destroy()
          return resolve({ status })
        }
        socket.write('ping')
      }
      if (buffered === 'ping') {
        socket.destroy()
        resolve({ status, echoed: buffered })
      }
    })
    socket.on('error', reject)
    socket.on('end', () => status && !status.includes(' 200 ') && resolve({ status }))
  })
}

function fetchVia(port: number, url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path: url, method: 'GET', headers: { host: new URL(url).host } },
      (res) => {
        let body = ''
        res.on('data', (c) => (body += c))
        res.on('end', () => resolve({ status: res.statusCode!, body }))
      }
    )
    req.on('error', reject)
    req.end()
  })
}

describe('egress forwarder (computer-use.md §15.4)', () => {
  it('lets nothing out until the Control Plane names the egress', async () => {
    const target = await echo()
    const { port } = await forwarder()
    expect((await tunnel(port, `127.0.0.1:${portOf(target)}`)).status).toMatch(/ 503 /)
    expect((await fetchVia(port, 'http://127.0.0.1:1/')).status).toBe(503)
  })

  it('goes straight out in direct mode, for tunnels and plain requests alike', async () => {
    const target = await echo()
    const site = await web()
    const { fwd, port } = await forwarder()
    fwd.apply({ mode: 'direct' })
    expect(await tunnel(port, `127.0.0.1:${portOf(target)}`)).toEqual({
      status: 'HTTP/1.1 200 Connection Established',
      echoed: 'ping'
    })
    expect(await fetchVia(port, `http://127.0.0.1:${portOf(site)}/page?q=1`)).toEqual({
      status: 200,
      body: 'hello GET /page?q=1 via -'
    })
  })

  it('goes through the organization’s proxy with its credentials, and never logs them', async () => {
    const target = await echo()
    const site = await web()
    const proxy = await orgProxy()
    const { fwd, port, lines } = await forwarder()
    fwd.apply({ mode: 'proxy', url: `http://127.0.0.1:${portOf(proxy.server)}`, username: 'acme', password: 's3cret' })
    expect(await tunnel(port, `127.0.0.1:${portOf(target)}`)).toMatchObject({ echoed: 'ping' })
    expect(await fetchVia(port, `http://127.0.0.1:${portOf(site)}/a`)).toEqual({
      status: 200,
      body: 'hello GET /a via proxy'
    })
    expect(proxy.seen).toEqual([`CONNECT 127.0.0.1:${portOf(target)}`, `GET http://127.0.0.1:${portOf(site)}/a`])
    expect(lines.join('\n')).not.toMatch(/s3cret|acme/)
    expect(lines.at(-1)).toBe(`egress: proxy http://127.0.0.1:${portOf(proxy.server)}`)

    // Wrong credentials are refused at the proxy, and the tunnel says so.
    fwd.apply({ mode: 'proxy', url: `http://127.0.0.1:${portOf(proxy.server)}`, username: 'acme', password: 'nope' })
    expect((await tunnel(port, `127.0.0.1:${portOf(target)}`)).status).toMatch(/^HTTP\/1\.1 502 /)
    expect((await fetchVia(port, `http://127.0.0.1:${portOf(site)}/b`)).status).toBe(407)
  })

  it('answers 502 when the proxy cannot be reached, and refuses a tunnel without a port', async () => {
    const closed = await listen(createTcpServer())
    const dead = portOf(closed)
    await new Promise<void>((resolve) => closed.close(() => resolve()))
    const { fwd, port } = await forwarder()
    fwd.apply({ mode: 'proxy', url: `http://127.0.0.1:${dead}` })
    expect((await tunnel(port, 'example.com:443')).status).toMatch(/ 502 /)
    expect((await tunnel(port, 'example.com')).status).toMatch(/ 400 /)
  })

  it('reads its port from the environment', () => {
    expect(egressPort({})).toBeUndefined()
    expect(egressPort({ AGENTCONNECT_EGRESS_PORT: '7691' })).toBe(7691)
    expect(() => egressPort({ AGENTCONNECT_EGRESS_PORT: 'x' })).toThrow(/not a valid port/)
  })
})
