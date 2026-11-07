import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import { createServer, type AddressInfo, type LookupFunction, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import { connect as tlsConnect } from 'node:tls'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { generateCa } from '@anthropic-ai/sandbox-runtime'
import { createMitmCA } from '@anthropic-ai/sandbox-runtime/dist/sandbox/mitm-ca.js'
import { mintLeafCert } from '@anthropic-ai/sandbox-runtime/dist/sandbox/mitm-leaf.js'
import { loadProxyCa } from '../src/credential-proxy/ca.js'
import { loadPlaceholderKey } from '../src/credential-proxy/placeholder.js'
import { CredentialProxy } from '../src/credential-proxy/proxy.js'
import { GITHUB_MANAGED_HOST, type ManagedCredentialHost } from '../src/gitcred/managed-hosts.js'
import { daemonTunnelSocketPath } from '../src/remote/tunnel-sockets.js'
import type { ShimEvent } from '../src/shim/protocol.js'
import { connectAuthority, TunnelHost } from '../src/shim/tunnel-host.js'
import { TunnelProxy } from '../src/shim/tunnel-proxy.js'

// An executor-placed session's code-host route end to end: the shim's loopback listener, the codehost tunnel, and the holder's credential proxy.

const AGENT = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const quiet = { info: () => {}, warn: () => {} }

const toLoopback: LookupFunction = (_host, options, callback) => {
  if (options.all)
    (callback as (e: null, a: { address: string; family: number }[]) => void)(null, [
      { address: '127.0.0.1', family: 4 }
    ])
  else callback(null, '127.0.0.1', 4)
}

const dirs: string[] = []
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

/** Short, so each socket fits AF_UNIX on a host whose temp directory is long. */
function shortDir(): string {
  const dir = mkdtempSync('/tmp/acct-')
  dirs.push(dir)
  return dir
}

let upstream: HttpsServer
let upstreamPort = 0
let upstreamCaPem = ''
const seen: { url?: string; authorization?: string }[] = []

beforeAll(async () => {
  const generated = generateCa({ cn: 'example private CA' })
  upstreamCaPem = generated.certPem
  const leaf = mintLeafCert(
    createMitmCA({ caCertPem: generated.certPem, caKeyPem: generated.keyPem }),
    'gitlab.example.test'
  )
  upstream = createHttpsServer({ key: leaf.keyPem, cert: leaf.certPem }, (req, res) => {
    seen.push({
      ...(req.url ? { url: req.url } : {}),
      ...(req.headers.authorization ? { authorization: req.headers.authorization } : {})
    })
    res.end('ok')
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  upstreamPort = (upstream.address() as AddressInfo).port
})
afterAll(async () => {
  await new Promise<void>((resolve) => upstream.close(() => resolve()))
})

/** The holder's proxy, and an executor shim's tunnel host bound to it over an in-process channel, as one placed session sees them. */
async function placedSession(options: { maxCodehostStreams?: number } = {}) {
  const dir = shortDir()
  const ca = loadProxyCa(join(dir, 'ca'))
  const instances: Record<string, ManagedCredentialHost[]> = {
    [AGENT]: [GITHUB_MANAGED_HOST, { provider: 'gitlab', baseUrl: `https://gitlab.example.test:${upstreamPort}` }],
    [OTHER]: [{ provider: 'gitlab', baseUrl: `https://gitlab.example.test:${upstreamPort}` }]
  }
  const mint = vi.fn(async () => ({ username: 'service-account', token: 'glpat_minted' }))
  const proxy = new CredentialProxy({
    key: loadPlaceholderKey(join(dir, 'proxy.key')),
    ca,
    mint,
    workspaceRepo: () => undefined,
    instancesOf: (agentId) => instances[agentId] ?? [],
    runningAgents: () => Object.keys(instances),
    knownAgent: (agentId) => agentId in instances,
    log: quiet,
    upstream: { lookupFor: () => toLoopback, trustedCa: [upstreamCaPem] }
  })
  await proxy.start(join(dir, 'run'))
  cleanups.push(() => proxy.stop())

  const listeners: Array<(event: ShimEvent) => void> = []
  const host = new TunnelHost({
    // Delivered in order, as the shim client's event stream is.
    emit: (streamId, event) => {
      for (const listener of listeners) listener({ type: 'shim/event', streamId, event })
    },
    socketPathFor: (tunnel) => join(dir, 'rt', `${tunnel}.sock`),
    ...(options.maxCodehostStreams === undefined ? {} : { maxCodehostStreams: options.maxCodehostStreams })
  })
  cleanups.push(() => host.close())
  const tunnel = new TunnelProxy({
    session: {
      agentId: AGENT,
      // Through JSON, as a frame is.
      request: async (_capability, payload) => await host.handle(JSON.parse(JSON.stringify(payload))),
      onEvent: (listener) => listeners.push(listener),
      offEvent: () => undefined,
      onAttach: () => undefined,
      offAttach: () => undefined,
      onLost: () => undefined
    },
    socketPathFor: (name) =>
      daemonTunnelSocketPath(name, AGENT, {
        gitcred: join(dir, 'none.sock'),
        mcp: join(dir, 'none.sock'),
        codehost: (agentId) => proxy.tunnelSocketFor(agentId)
      }),
    listenOptions: (name) => (name === 'codehost' ? { routes: proxy.tunnelRoutes(AGENT), ca: ca.certPem } : undefined),
    log: quiet
  })
  cleanups.push(() => tunnel.stop('test over'))
  await tunnel.ensure('codehost')
  const listening = tunnel.listeningAt('codehost')!.proxy!
  return { proxy, ca, mint, tunnel, listening, dir }
}

type Dial = { host: string; port: number; proxyAuth?: string } | { socketPath: string }

function shimDial(listening: { port: number; token: string }, token = listening.token): Dial {
  return {
    host: '127.0.0.1',
    port: listening.port,
    proxyAuth: `Basic ${Buffer.from(`codehost:${token}`).toString('base64')}`
  }
}

/** A CONNECT's status, the tunnel left open for `then` when it is 200. */
function connectThrough(dial: Dial, authority: string, then?: (socket: Socket) => void): Promise<number> {
  return new Promise((resolve, reject) => {
    const target = 'socketPath' in dial ? { socketPath: dial.socketPath } : { host: dial.host, port: dial.port }
    const headers = 'proxyAuth' in dial && dial.proxyAuth ? { 'proxy-authorization': dial.proxyAuth } : {}
    const req = httpRequest({ ...target, method: 'CONNECT', path: authority, headers })
    req.on('connect', (res, socket) => {
      if (res.statusCode === 200 && then) then(socket)
      else socket.destroy()
      resolve(res.statusCode ?? 0)
    })
    req.on('response', (res) => resolve(res.statusCode ?? 0))
    req.on('error', reject)
    req.end()
  })
}

/** One HTTPS request through a CONNECT to `authority`: its status line's code. */
function exchange(dial: Dial, authority: string, caPem: string, lines: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    void connectThrough(dial, authority, (socket) => {
      const tls = tlsConnect({ socket, servername: authority.replace(/:\d+$/, ''), ca: caPem }, () => {
        const [first, ...headers] = lines
        tls.write(`${[first, `Host: ${authority}`, ...headers, 'Connection: close'].join('\r\n')}\r\n\r\n`)
      })
      let raw = ''
      tls.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')))
      tls.on('end', () => resolve(Number(raw.split(' ')[1])))
      tls.on('error', reject)
    }).then((status) => {
      if (status !== 200) resolve(status)
    }, reject)
  })
}

describe('a CONNECT target', () => {
  it('is a plain host and port, lower-cased, an IPv6 host bracketed', () => {
    expect(connectAuthority('GitHub.com:443')).toEqual({ host: 'github.com', port: 443, key: 'github.com:443' })
    expect(connectAuthority('[2001:DB8::1]:8443')).toMatchObject({ host: '2001:db8::1', key: '[2001:db8::1]:8443' })
    for (const bad of ['github.com', 'github.com:0', 'github.com:70000', 'a/b:443', 'http://github.com:443', ''])
      expect(connectAuthority(bad)).toBeUndefined()
  })
})

describe('the routes a codehost tunnel carries', () => {
  it('are the agent’s SaaS names on 443 and its self-managed instance on its own port', async () => {
    const { proxy } = await placedSession()
    expect(proxy.tunnelRoutes(AGENT)).toEqual([
      'github.com:443',
      'api.github.com:443',
      'uploads.github.com:443',
      'codeload.github.com:443',
      `gitlab.example.test:${upstreamPort}`
    ])
    expect(proxy.tunnelRoutes(OTHER)).toEqual([`gitlab.example.test:${upstreamPort}`])
  })
})

// Unix sockets carry the daemon side, which Windows never runs.
describe.skipIf(process.platform === 'win32')('an executor-placed session’s code-host traffic', () => {
  const gitlab = (): string => `gitlab.example.test:${upstreamPort}`
  const gitRequest = (placeholder: string): string[] => [
    'GET /group/project.git/info/refs?service=git-upload-pack HTTP/1.1',
    `Authorization: Basic ${Buffer.from(`x-access-token:${placeholder}`).toString('base64')}`
  ]

  it('reaches the holder’s proxy through the tunnel, and the minted token arrives upstream', async () => {
    const { proxy, ca, mint, listening } = await placedSession()
    seen.length = 0
    // The session verifies with the bundle its shim wrote there: that machine's roots and the holder's CA.
    const bundle = readFileSync(listening.trustBundle, 'utf8')
    expect(bundle).toContain(ca.certPem.trim())
    expect(statSync(listening.trustBundle).mode & 0o777).toBe(0o600)

    const status = await exchange(shimDial(listening), gitlab(), bundle, gitRequest(proxy.placeholderFor(AGENT)))
    expect(status).toBe(200)
    expect(seen).toEqual([
      {
        url: '/group/project.git/info/refs?service=git-upload-pack',
        authorization: `Basic ${Buffer.from('service-account:glpat_minted').toString('base64')}`
      }
    ])
    expect(mint).toHaveBeenCalledTimes(1)
  })

  it('refuses another agent’s placeholder over this agent’s tunnel', async () => {
    const { proxy, mint, listening } = await placedSession()
    seen.length = 0
    const bundle = readFileSync(listening.trustBundle, 'utf8')
    const status = await exchange(shimDial(listening), gitlab(), bundle, gitRequest(proxy.placeholderFor(OTHER)))
    expect(status).toBe(403)
    expect(seen).toEqual([])
    expect(mint).not.toHaveBeenCalled()
  })

  it('refuses at the holder a CONNECT to anything but the agent’s code-host routes, whatever the shim sends', async () => {
    // The executor's shim is not trusted to filter: the holder's socket answers only the agent's routes.
    const { proxy } = await placedSession()
    const socketPath = proxy.tunnelSocketFor(AGENT)
    expect(proxy.tunnelSocketFor(AGENT)).toBe(socketPath)
    expect(socketPath).not.toBe(proxy.socketFor(AGENT))
    expect(await connectThrough({ socketPath }, gitlab())).toBe(200)
    for (const elsewhere of [
      'registry.example.test:443',
      'gitlab.example.test:443',
      'api.github.com:8443',
      '127.0.0.1:22'
    ])
      expect(await connectThrough({ socketPath }, elsewhere)).not.toBe(200)
  })

  it('requires the listener’s credential, so it is no open proxy to the machine’s other users', async () => {
    const { listening, tunnel } = await placedSession()
    expect(await connectThrough({ host: '127.0.0.1', port: listening.port }, gitlab())).toBe(407)
    expect(await connectThrough(shimDial(listening, 'w'.repeat(32)), gitlab())).toBe(407)
    expect(tunnel.streamCount()).toBe(0)
  })

  it('sends a CONNECT to any other host straight out, never into the tunnel', async () => {
    const { listening, tunnel } = await placedSession()
    const echo: Server = createServer((socket) => socket.pipe(socket))
    await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => new Promise<void>((resolve) => echo.close(() => resolve())))
    const port = (echo.address() as AddressInfo).port
    let reply = ''
    const status = await connectThrough(shimDial(listening), `127.0.0.1:${port}`, (socket) => {
      socket.on('data', (chunk: Buffer) => (reply += chunk.toString('utf8')))
      socket.write('ping')
      cleanups.push(() => void socket.destroy())
    })
    expect(status).toBe(200)
    await vi.waitFor(() => expect(reply).toBe('ping'))
    expect(tunnel.streamCount()).toBe(0)
  })

  it('caps the shim’s concurrent codehost connections', async () => {
    const { listening, tunnel } = await placedSession({ maxCodehostStreams: 1 })
    const held = await connectThrough(shimDial(listening), gitlab(), (socket) =>
      cleanups.push(() => void socket.destroy())
    )
    expect(held).toBe(200)
    expect(tunnel.streamCount(true)).toBe(1)
    expect(await connectThrough(shimDial(listening), gitlab())).toBe(503)
    expect(tunnel.streamCount(true)).toBe(1)
  })
})
