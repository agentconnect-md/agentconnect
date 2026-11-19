import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import type { LookupAddress } from 'node:dns'
import { createServer as createHttpServer, request, type Server } from 'node:http'
import {
  connect,
  createServer as createTcpServer,
  type AddressInfo,
  type Server as TcpServer,
  type Socket
} from 'node:net'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EgressForwarder, egressPort } from './egress.js'
import type { ProcFs } from './form-fill/attribution.js'
import { LoopbackGuard, type LoopbackGuardOptions } from './loopback-guard.js'
import { fakeProc, type FakeProcess } from './testing.js'

const closers: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close()
})

const portOf = (server: Server | TcpServer): number => (server.address() as AddressInfo).port

async function listen<T extends Server | TcpServer>(server: T, host = '127.0.0.1'): Promise<T> {
  await new Promise<void>((resolve) => server.listen(0, host, () => resolve()))
  const sockets = new Set<Socket>()
  server.on('connection', (s: Socket) => sockets.add(s))
  closers.push(async () => {
    for (const s of sockets) s.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  return server
}

/** A TCP echo target, the far end of a tunnel. */
const echo = (host?: string) =>
  listen(
    createTcpServer((socket) => socket.pipe(socket)),
    host
  )

/** A plain web server, the far end of an absolute-form request. */
const web = (host?: string) =>
  listen(
    createHttpServer((req, res) => res.end(`hello ${req.method} ${req.url} via ${req.headers['x-hop'] ?? '-'}`)),
    host
  )

/** This machine's first non-internal IPv4 address, which the tests' guard does not count as local. */
const EXTERNAL = Object.values(networkInterfaces())
  .flatMap((entries) => entries ?? [])
  .find((entry) => entry.family === 'IPv4' && !entry.internal)?.address

/** A port nothing listens on. */
async function closedPort(): Promise<number> {
  const server = createTcpServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = portOf(server)
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

/** The organization's proxy: checks Basic credentials, then tunnels or forwards to this machine, noting every request. */
async function orgProxy(user = 'acme', pass = 's3cret') {
  const seen: string[] = []
  const expected = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`
  const server = createHttpServer((req, res) => {
    seen.push(`${req.method} ${req.url}`)
    if (req.headers['proxy-authorization'] !== expected) return void res.writeHead(407).end()
    const target = new URL(req.url!)
    const upstream = request(
      {
        host: '127.0.0.1',
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
    const port = req.url!.split(':').at(-1)
    const upstream = connect(Number(port), '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
  })
  return { server: await listen(server), seen }
}

const DAEMON = 4242
const CHROME = '/opt/google/chrome/chrome'

/** A desktop profile whose browser (pid 100) and its child (140) hold `browser` sockets, and the daemon `daemon` ones. */
function desktop(sockets: { browser?: string[]; daemon?: string[] } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'egress-')))
  closers.push(() => rmSync(dir, { recursive: true, force: true }))
  const profile = join(dir, 'browser', 'main')
  mkdirSync(profile, { recursive: true })
  const fds = (inodes: string[] = []) =>
    Object.fromEntries(inodes.map((inode, i) => [`${20 + i}`, `socket:[${inode}]`]))
  const processes: Record<number, FakeProcess> = {
    1: { exe: '/usr/bin/tini', title: '/usr/bin/tini', ppid: 0, fds: {} },
    100: {
      exe: CHROME,
      title: `${CHROME} --user-data-dir=${profile}`,
      ppid: 1,
      fds: { '40': `${profile}/Default/Cookies` }
    },
    140: { exe: CHROME, title: `${CHROME} --type=utility`, ppid: 100, fds: fds(sockets.browser) },
    [DAEMON]: {
      exe: '/usr/local/bin/node',
      title: 'node agentconnect-computer.mjs run',
      ppid: 1,
      fds: fds(sockets.daemon)
    }
  }
  return { profile, processes }
}

interface ForwarderSetup {
  listeners?: Record<string, number>
  processes?: Record<number, FakeProcess>
  profiles?: string[]
  daemonPorts?: number[]
  interfaces?: string[]
  names?: Record<string, LookupAddress[]>
  proc?: ProcFs
  guard?: Partial<LoopbackGuardOptions>
  lookup?: (name: string) => Promise<LookupAddress[]>
  timeoutMs?: number
  now?: () => number
}

async function forwarder(setup: ForwarderSetup = {}) {
  const lines: string[] = []
  const lookups: string[] = []
  let clock = 0
  const loopback = new LoopbackGuard({
    daemonPorts: () => setup.daemonPorts ?? [],
    profiles: () => setup.profiles ?? [],
    proc: setup.proc ?? fakeProc(setup.listeners ?? {}, setup.processes ?? {}),
    interfaces: () => setup.interfaces ?? ['127.0.0.1', '::1'],
    pid: DAEMON,
    ...setup.guard
  })
  const fwd = new EgressForwarder({
    port: 0,
    log: (line) => lines.push(line),
    loopback,
    lookup:
      setup.lookup ??
      (async (name) => {
        lookups.push(name)
        const found = setup.names?.[name]
        if (!found) throw Object.assign(new Error(`ENOTFOUND ${name}`), { code: 'ENOTFOUND' })
        return found
      }),
    ...(setup.timeoutMs !== undefined ? { timeoutMs: setup.timeoutMs } : {}),
    // A minute passes between refusals, so every one is logged unless a test says otherwise.
    now: setup.now ?? (() => (clock += 60_000))
  })
  const port = await fwd.start()
  closers.push(() => fwd.stop())
  return { fwd, port, lines, lookups }
}

/** The forwarder's raw answer to one request, as a page's connection sees it. */
function raw(port: number, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => socket.write(text))
    let buffered = ''
    socket.on('data', (chunk) => {
      buffered += chunk.toString()
      if (/\r\n\r\n/.test(buffered) && /Content-Length: 0\r\n/i.test(buffered)) socket.end()
    })
    socket.on('error', reject)
    socket.on('close', () => resolve(buffered))
  })
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

const CLOSED = 'HTTP/1.1 502 Bad Gateway'

describe('egress forwarder (computer-use.md §15.4)', () => {
  it('lets nothing out until the Control Plane names the egress', async () => {
    const target = await echo()
    const { port } = await forwarder()
    expect((await tunnel(port, `127.0.0.1:${portOf(target)}`)).status).toMatch(/ 503 /)
    expect((await fetchVia(port, 'http://127.0.0.1:1/')).status).toBe(503)
  })

  it('goes through the organization’s proxy with its credentials, and never logs them', async () => {
    const target = await echo()
    const site = await web()
    const proxy = await orgProxy()
    const { fwd, port, lines, lookups } = await forwarder()
    fwd.apply({ mode: 'proxy', url: `http://127.0.0.1:${portOf(proxy.server)}`, username: 'acme', password: 's3cret' })
    expect(await tunnel(port, `echo.example.test:${portOf(target)}`)).toMatchObject({ echoed: 'ping' })
    expect(await fetchVia(port, `http://site.example.test:${portOf(site)}/a`)).toEqual({
      status: 200,
      body: 'hello GET /a via proxy'
    })
    expect(proxy.seen).toEqual([
      `CONNECT echo.example.test:${portOf(target)}`,
      `GET http://site.example.test:${portOf(site)}/a`
    ])
    // A name goes to the organization's proxy unresolved: it resolves there.
    expect(lookups).toEqual([])
    expect(lines.join('\n')).not.toMatch(/s3cret|acme/)
    expect(lines.at(-1)).toBe(`egress: proxy http://127.0.0.1:${portOf(proxy.server)}`)

    // Wrong credentials are refused at the proxy, and the tunnel says so.
    fwd.apply({ mode: 'proxy', url: `http://127.0.0.1:${portOf(proxy.server)}`, username: 'acme', password: 'nope' })
    expect((await tunnel(port, `echo.example.test:${portOf(target)}`)).status).toMatch(/^HTTP\/1\.1 502 /)
    expect((await fetchVia(port, `http://site.example.test:${portOf(site)}/b`)).status).toBe(407)
  })

  it('answers 502 when the proxy cannot be reached, and refuses a tunnel without a port', async () => {
    const { fwd, port } = await forwarder()
    fwd.apply({ mode: 'proxy', url: `http://127.0.0.1:${await closedPort()}` })
    expect((await tunnel(port, 'example.com:443')).status).toMatch(/ 502 /)
    expect((await tunnel(port, 'example.com')).status).toMatch(/ 400 /)
  })

  it('reads its port from the environment', () => {
    expect(egressPort({})).toBeUndefined()
    expect(egressPort({ AGENTCONNECT_EGRESS_PORT: '7691' })).toBe(7691)
    expect(() => egressPort({ AGENTCONNECT_EGRESS_PORT: 'x' })).toThrow(/not a valid port/)
  })
})

describe('egress forwarder’s loopback refusal (computer-use.md §5.8)', () => {
  it('refuses the daemon’s listeners: named ones, its own port, and any socket the daemon holds', async () => {
    const named = await web()
    const found = await web()
    const { processes } = desktop({ daemon: ['700'] })
    const { fwd, port, lines } = await forwarder({
      listeners: { '700': portOf(found) },
      processes,
      daemonPorts: [portOf(named)]
    })
    fwd.apply({ mode: 'direct' })
    for (const refused of [portOf(named), portOf(found), port]) {
      expect((await tunnel(port, `127.0.0.1:${refused}`)).status).toBe(CLOSED)
      expect(await fetchVia(port, `http://127.0.0.1:${refused}/healthz`)).toEqual({ status: 502, body: '' })
    }
    expect(lines.filter((line) => line.includes('refused'))).toEqual(
      [portOf(named), portOf(found), port].flatMap((refused) =>
        Array(2).fill(`egress: refused loopback port ${refused} (daemon listener)`)
      )
    )
  })

  it('refuses every port a desktop’s browser listens on, found from its processes’ sockets', async () => {
    const devtools = await web()
    const { profile, processes } = desktop({ browser: ['900'] })
    const { fwd, port, lines } = await forwarder({
      listeners: { '900': portOf(devtools) },
      processes,
      profiles: [profile]
    })
    fwd.apply({ mode: 'direct' })
    expect((await tunnel(port, `127.0.0.1:${portOf(devtools)}`)).status).toBe(CLOSED)
    expect(await fetchVia(port, `http://127.0.0.1:${portOf(devtools)}/json/version`)).toEqual({
      status: 502,
      body: ''
    })
    expect(lines.at(-1)).toBe(`egress: refused loopback port ${portOf(devtools)} (browser port)`)
    // Never the page's URL or path.
    expect(lines.join('\n')).not.toMatch(/json|version/)
  })

  it('refuses a browser port in every form of loopback, and through a name that resolves to it', async () => {
    const devtools = await web()
    const { profile, processes } = desktop({ browser: ['900'] })
    const p = portOf(devtools)
    const { fwd, port, lines, lookups } = await forwarder({
      listeners: { '900': p },
      processes,
      profiles: [profile],
      interfaces: ['127.0.0.1', '::1', '192.0.2.10', '2001:db8::10'],
      names: {
        localhost: [
          { address: '::1', family: 6 },
          { address: '127.0.0.1', family: 4 }
        ],
        'rebound.example.test': [{ address: '127.0.0.1', family: 4 }]
      }
    })
    fwd.apply({ mode: 'direct' })
    const hosts = [
      '127.0.0.1',
      '127.9.8.7',
      '[::1]',
      '[::ffff:127.0.0.1]',
      '[::ffff:7f00:1]',
      '0.0.0.0',
      '0.1.2.3',
      '[::]',
      '192.0.2.10',
      '[2001:db8::10]',
      'localhost',
      'LocalHost.',
      'app.localhost',
      'rebound.example.test'
    ]
    for (const host of hosts) {
      expect((await tunnel(port, `${host}:${p}`)).status, host).toBe(CLOSED)
      expect((await fetchVia(port, `http://${host}:${p}/json`)).status, host).toBe(502)
    }
    expect(lines.filter((line) => line.includes('refused'))).toHaveLength(hosts.length * 2)
    // Each name was resolved once per request; `*.localhost` is `localhost`.
    expect(lookups).toEqual([...Array(6).fill('localhost'), 'rebound.example.test', 'rebound.example.test'])
  })

  it('refuses every loopback destination while a desktop’s browser is starting', async () => {
    const devServer = await web()
    const { profile } = desktop()
    const { fwd, port, lines } = await forwarder({
      profiles: [profile],
      names: { localhost: [{ address: '127.0.0.1', family: 4 }] }
    })
    fwd.apply({ mode: 'direct' })
    writeFileSync(`${profile}.launch-lock`, '')
    expect((await tunnel(port, `127.0.0.1:${portOf(devServer)}`)).status).toBe(CLOSED)
    expect((await fetchVia(port, `http://localhost:${portOf(devServer)}/`)).status).toBe(502)
    expect(lines.at(-1)).toBe(`egress: refused loopback port ${portOf(devServer)} (browser starting)`)
    rmSync(`${profile}.launch-lock`)
    expect((await fetchVia(port, `http://127.0.0.1:${portOf(devServer)}/`)).status).toBe(200)
  })

  it('lets other loopback ports through, resolving a name once and connecting to the address it checked', async () => {
    const target = await echo()
    const site = await web()
    const devtools = await web()
    const { profile, processes } = desktop({ browser: ['900'] })
    const { fwd, port, lookups } = await forwarder({
      // The dev server listens too, held by a process that is not a desktop browser.
      listeners: { '900': portOf(devtools), '901': portOf(site) },
      processes,
      profiles: [profile],
      names: { 'dev.example.test': [{ address: '127.0.0.1', family: 4 }] }
    })
    fwd.apply({ mode: 'direct' })
    expect(await tunnel(port, `127.0.0.1:${portOf(target)}`)).toEqual({
      status: 'HTTP/1.1 200 Connection Established',
      echoed: 'ping'
    })
    expect(await tunnel(port, `dev.example.test:${portOf(target)}`)).toMatchObject({ echoed: 'ping' })
    expect(await fetchVia(port, `http://dev.example.test:${portOf(site)}/page?q=1`)).toEqual({
      status: 200,
      body: 'hello GET /page?q=1 via -'
    })
    // Only the forwarder's own lookup ran: the system's resolver does not know the name.
    expect(lookups).toEqual(['dev.example.test', 'dev.example.test'])
  })

  it('answers a reply it cannot pass on like a closed port, and keeps serving', async () => {
    // A status Node's parser accepts but writeHead refuses would otherwise throw out of the daemon.
    const odd = await listen(
      createTcpServer((socket) =>
        socket.once('data', () => socket.end('HTTP/1.1 099 Odd\r\nContent-Length: 0\r\n\r\n'))
      )
    )
    const site = await web()
    const { fwd, port } = await forwarder()
    fwd.apply({ mode: 'direct' })
    expect(await fetchVia(port, `http://127.0.0.1:${portOf(odd)}/`)).toEqual({ status: 502, body: '' })
    expect(await fetchVia(port, `http://127.0.0.1:${portOf(site)}/`)).toEqual({
      status: 200,
      body: 'hello GET / via -'
    })
  })

  it('connects an allowed loopback destination locally even with the organization’s proxy configured', async () => {
    const target = await echo()
    const site = await web()
    const devtools = await web()
    const proxy = await orgProxy()
    const { profile, processes } = desktop({ browser: ['900'] })
    const { fwd, port } = await forwarder({
      listeners: { '900': portOf(devtools) },
      processes,
      profiles: [profile],
      names: { localhost: [{ address: '127.0.0.1', family: 4 }] }
    })
    fwd.apply({ mode: 'proxy', url: `http://127.0.0.1:${portOf(proxy.server)}`, username: 'acme', password: 's3cret' })
    expect(await tunnel(port, `127.0.0.1:${portOf(target)}`)).toMatchObject({ echoed: 'ping' })
    expect(await fetchVia(port, `http://localhost:${portOf(site)}/a`)).toEqual({
      status: 200,
      body: 'hello GET /a via -'
    })
    // A refused one is not handed to the proxy either.
    expect((await tunnel(port, `localhost:${portOf(devtools)}`)).status).toBe(CLOSED)
    expect(proxy.seen).toEqual([])
  })

  it('checks a local port again once connected, refusing a listener that opened after the first check', async () => {
    for (const via of ['tunnel', 'fetch'] as const) {
      const requests: string[] = []
      const devtools = await listen(createHttpServer((req, res) => res.end(String(requests.push(req.url!)))))
      const { profile, processes } = desktop({ browser: ['900'] })
      const listeners: Record<string, number> = {}
      const base = fakeProc(listeners, processes)
      let reads = 0
      // The browser's listener shows up right after the first check's read, before the forwarder connects.
      const proc: ProcFs = {
        ...base,
        read: (path) => {
          const table = base.read(path)
          if (path === '/proc/net/tcp6' && ++reads === 1) listeners['900'] = portOf(devtools)
          return table
        }
      }
      const { fwd, port, lines } = await forwarder({ proc, profiles: [profile] })
      fwd.apply({ mode: 'direct' })
      if (via === 'tunnel') expect((await tunnel(port, `127.0.0.1:${portOf(devtools)}`)).status).toBe(CLOSED)
      else
        expect(await fetchVia(port, `http://127.0.0.1:${portOf(devtools)}/json/version`)).toEqual({
          status: 502,
          body: ''
        })
      expect(reads, via).toBe(2)
      expect(requests, via).toEqual([])
      expect(lines.at(-1), via).toBe(`egress: refused loopback port ${portOf(devtools)} (browser port)`)
    }
  })

  it.skipIf(!EXTERNAL)('never reuses a socket checked for one address once the name resolves to another', async () => {
    const site = await listen(
      createHttpServer((req, res) => res.end(`${req.socket.localAddress} ${req.headers.connection ?? '-'}`)),
      '0.0.0.0'
    )
    const names: Record<string, LookupAddress[]> = { 'moving.example.test': [{ address: '127.0.0.1', family: 4 }] }
    const { fwd, port } = await forwarder({ names })
    fwd.apply({ mode: 'direct' })
    const url = `http://moving.example.test:${portOf(site)}/`
    expect(await fetchVia(port, url)).toEqual({ status: 200, body: '127.0.0.1 close' })
    names['moving.example.test'] = [{ address: EXTERNAL!, family: 4 }]
    expect(await fetchVia(port, url)).toEqual({ status: 200, body: `${EXTERNAL} close` })
  })

  it.skipIf(!EXTERNAL)('forwards a destination that is not local without reading a socket table', async () => {
    const target = await echo('0.0.0.0')
    const site = await web('0.0.0.0')
    const base = fakeProc({}, {})
    const reads: string[] = []
    const { fwd, port } = await forwarder({
      proc: { ...base, read: (path) => (reads.push(path), base.read(path)) },
      names: { 'public.example.test': [{ address: EXTERNAL!, family: 4 }] }
    })
    fwd.apply({ mode: 'direct' })
    expect(await tunnel(port, `${EXTERNAL}:${portOf(target)}`)).toMatchObject({ echoed: 'ping' })
    expect(await fetchVia(port, `http://public.example.test:${portOf(site)}/p`)).toEqual({
      status: 200,
      body: 'hello GET /p via -'
    })
    expect(reads).toEqual([])
  })

  it('refuses a name that resolves to a public address and to a browser port on loopback', async () => {
    const devtools = await web()
    const { profile, processes } = desktop({ browser: ['900'] })
    const { fwd, port, lines } = await forwarder({
      listeners: { '900': portOf(devtools) },
      processes,
      profiles: [profile],
      names: {
        'mixed.example.test': [
          { address: '198.51.100.7', family: 4 },
          { address: '127.0.0.1', family: 4 }
        ]
      }
    })
    fwd.apply({ mode: 'direct' })
    expect((await tunnel(port, `mixed.example.test:${portOf(devtools)}`)).status).toBe(CLOSED)
    expect(await fetchVia(port, `http://mixed.example.test:${portOf(devtools)}/json`)).toEqual({
      status: 502,
      body: ''
    })
    expect(lines.at(-1)).toBe(`egress: refused loopback port ${portOf(devtools)} (browser port)`)
  })

  it('answers a check that throws like a closed port, and logs it once', async () => {
    const { fwd, port, lines } = await forwarder({
      guard: {
        interfaces: () => {
          throw new Error('no interfaces')
        },
        daemonPorts: () => {
          throw new Error('no state')
        }
      },
      now: () => 0
    })
    fwd.apply({ mode: 'direct' })
    for (const host of ['198.51.100.7', '127.0.0.1']) {
      expect((await tunnel(port, `${host}:9000`)).status, host).toBe(CLOSED)
      expect(await fetchVia(port, `http://${host}:9000/`), host).toEqual({ status: 502, body: '' })
    }
    expect(lines.filter((line) => line.includes('failed'))).toEqual(['egress: destination check failed (Error)'])
  })

  it('answers a name that does not resolve in time like a closed port', async () => {
    const { fwd, port } = await forwarder({ lookup: () => new Promise(() => {}), timeoutMs: 50 })
    fwd.apply({ mode: 'direct' })
    expect((await tunnel(port, 'slow.example.test:443')).status).toBe(CLOSED)
    expect(await fetchVia(port, 'http://slow.example.test/')).toEqual({ status: 502, body: '' })
  })

  it('answers a refused destination exactly as a closed port', async () => {
    const devtools = await web()
    const closed = await closedPort()
    const { profile, processes } = desktop({ browser: ['900'] })
    const { fwd, port } = await forwarder({ listeners: { '900': portOf(devtools) }, processes, profiles: [profile] })
    fwd.apply({ mode: 'direct' })
    const connectTo = (p: number) => raw(port, `CONNECT 127.0.0.1:${p} HTTP/1.1\r\nHost: 127.0.0.1:${p}\r\n\r\n`)
    const getFrom = async (p: number) =>
      (
        await raw(port, `GET http://127.0.0.1:${p}/json HTTP/1.1\r\nHost: 127.0.0.1:${p}\r\nConnection: close\r\n\r\n`)
      ).replace(/^Date: .*\r\n/m, '')
    const timed = async (run: () => Promise<string>) => {
      const started = performance.now()
      return { answer: await run(), ms: performance.now() - started }
    }
    const [refusedTunnel, closedTunnel] = [
      await timed(() => connectTo(portOf(devtools))),
      await timed(() => connectTo(closed))
    ]
    expect(refusedTunnel.answer).toBe(closedTunnel.answer)
    expect(refusedTunnel.answer).toBe(`${CLOSED}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    expect(await getFrom(portOf(devtools))).toBe(await getFrom(closed))
    expect(await getFrom(closed)).toMatch(/^HTTP\/1\.1 502 Bad Gateway\r\n/)
    // Both answer at once: neither waits on anything a probe could time.
    expect(refusedTunnel.ms).toBeLessThan(500)
    expect(closedTunnel.ms).toBeLessThan(500)
  })

  it('logs each refused port once a minute, and a port scan a few lines at a time', async () => {
    const lines: string[] = []
    let now = 0
    const fwd = new EgressForwarder({
      port: 0,
      log: (line) => lines.push(line),
      loopback: new LoopbackGuard({
        daemonPorts: () => [],
        profiles: () => [],
        proc: fakeProc({}, {}, { unreadable: true })
      }),
      now: () => now
    })
    const port = await fwd.start()
    closers.push(() => fwd.stop())
    fwd.apply({ mode: 'direct' })
    for (let i = 0; i < 3; i++) await tunnel(port, '127.0.0.1:9000')
    expect(lines.filter((line) => line.includes('refused'))).toEqual([
      'egress: refused loopback port 9000 (ports unreadable)'
    ])
    for (let p = 9001; p < 9020; p++) await tunnel(port, `127.0.0.1:${p}`)
    expect(lines.filter((line) => line.includes('refused'))).toHaveLength(5)
    now += 60_000
    await tunnel(port, '127.0.0.1:9100')
    expect(lines.slice(-2)).toEqual([
      'egress: 15 more loopback refusal(s) not logged',
      'egress: refused loopback port 9100 (ports unreadable)'
    ])
  })
})
