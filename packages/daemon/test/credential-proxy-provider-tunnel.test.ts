import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import type { AddressInfo, LookupFunction, Socket } from 'node:net'
import { join } from 'node:path'
import { connect as tlsConnect, createSecureContext } from 'node:tls'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { generateCa } from '@anthropic-ai/sandbox-runtime'
import { createMitmCA } from '@anthropic-ai/sandbox-runtime/dist/sandbox/mitm-ca.js'
import { mintLeafCert } from '@anthropic-ai/sandbox-runtime/dist/sandbox/mitm-leaf.js'
import { loadProxyCa } from '../src/credential-proxy/ca.js'
import { loadPlaceholderKey } from '../src/credential-proxy/placeholder.js'
import type { ProviderSlot } from '../src/credential-proxy/provider-route.js'
import { CredentialProxy } from '../src/credential-proxy/proxy.js'
import type { ManagedCredentialHost } from '../src/gitcred/managed-hosts.js'
import { daemonTunnelSocketPath } from '../src/remote/tunnel-sockets.js'
import type { ShimEvent } from '../src/shim/protocol.js'
import { TunnelHost } from '../src/shim/tunnel-host.js'
import { TunnelProxy } from '../src/shim/tunnel-proxy.js'
import type { TunnelName } from '../src/shim/tunnel.js'

// An executor's or VM's organization Provider key end to end: the shim's one loopback listener, the provider tunnel, and the holder's credential proxy.

const AGENT = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const REAL_KEY = 'sk-example-real'
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
  const dir = mkdtempSync('/tmp/acpt-')
  dirs.push(dir)
  return dir
}

let upstream: HttpsServer
let port = 0
let upstreamCaPem = ''
const seen: { host?: string; url?: string; headers: IncomingHttpHeaders }[] = []
let releaseStream: () => void = () => {}

beforeAll(async () => {
  const generated = generateCa({ cn: 'example upstream CA' })
  upstreamCaPem = generated.certPem
  const mitm = createMitmCA({ caCertPem: generated.certPem, caKeyPem: generated.keyPem })
  const contexts = new Map<string, ReturnType<typeof createSecureContext>>()
  const contextFor = (name: string) => {
    if (!contexts.has(name)) {
      const leaf = mintLeafCert(mitm, name)
      contexts.set(name, createSecureContext({ key: leaf.keyPem, cert: leaf.certPem }))
    }
    return contexts.get(name)!
  }
  upstream = createHttpsServer({ SNICallback: (name, callback) => callback(null, contextFor(name)) }, (req, res) => {
    seen.push({
      ...(req.headers.host ? { host: req.headers.host } : {}),
      ...(req.url ? { url: req.url } : {}),
      headers: req.headers
    })
    if (req.url === '/v1/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.write('event: one\ndata: {"n":1}\n\n')
      const released = new Promise<void>((resolve) => {
        releaseStream = resolve
        setTimeout(resolve, 5000)
      })
      void released.then(() => res.end('event: two\ndata: {"n":2}\n\n'))
      return
    }
    res.setHeader('content-type', 'application/json')
    res.end('{"ok":true}')
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  port = (upstream.address() as AddressInfo).port
})
afterAll(async () => {
  await new Promise<void>((resolve) => upstream.close(() => resolve()))
})

const provider = (): string => `llm.example.test:${port}`
const gitlab = (): string => `gitlab.example.test:${port}`

/** The holder's proxy, and a shim's tunnel host bound to it over an in-process channel, serving both proxy tunnels. */
async function placedSession(
  options: { maxProviderStreams?: number; maxCodehostStreams?: number; connectQueueWaitMs?: number } = {}
) {
  const dir = shortDir()
  const ca = loadProxyCa(join(dir, 'ca'))
  const slot = (id: string): ProviderSlot => ({
    id,
    provider: 'anthropic',
    host: 'llm.example.test',
    port,
    saas: false
  })
  // A pool pod's install key slot rides the same tunnel as an organization key's.
  const slots: Record<string, ProviderSlot[]> = {
    [AGENT]: [slot('org:anthropic'), slot('install:model:anthropic')],
    [OTHER]: [slot('org:anthropic')]
  }
  const instances: Record<string, ManagedCredentialHost[]> = {
    [AGENT]: [{ provider: 'gitlab', baseUrl: `https://gitlab.example.test:${port}` }]
  }
  const resolveProviderSlot = vi.fn(async () => ({ key: REAL_KEY }))
  const proxy = new CredentialProxy({
    key: loadPlaceholderKey(join(dir, 'proxy.key')),
    ca,
    mint: async () => ({ username: 'service-account', token: 'glpat_minted', access: 'write' as const }),
    workspaceRepo: () => undefined,
    instancesOf: (agentId) => instances[agentId] ?? [],
    runningAgents: () => [AGENT, OTHER],
    knownAgent: () => true,
    providerSlotsOf: (agentId) => slots[agentId] ?? [],
    resolveProviderSlot,
    log: quiet,
    upstream: { lookupFor: () => toLoopback, trustedCa: [upstreamCaPem] }
  })
  await proxy.start(join(dir, 'run'))
  cleanups.push(() => proxy.stop())

  const listeners: Array<(event: ShimEvent) => void> = []
  const host = new TunnelHost({
    emit: (streamId, event) => {
      for (const listener of listeners) listener({ type: 'shim/event', streamId, event })
    },
    socketPathFor: (tunnel) => join(dir, 'rt', `${tunnel}.sock`),
    ...(options.maxProviderStreams === undefined ? {} : { maxProviderStreams: options.maxProviderStreams }),
    ...(options.maxCodehostStreams === undefined ? {} : { maxCodehostStreams: options.maxCodehostStreams }),
    ...(options.connectQueueWaitMs === undefined ? {} : { connectQueueWaitMs: options.connectQueueWaitMs })
  })
  cleanups.push(() => host.close())
  const tunnel = new TunnelProxy({
    session: {
      agentId: AGENT,
      request: async (_capability, payload) => await host.handle(JSON.parse(JSON.stringify(payload))),
      onEvent: (listener) => listeners.push(listener),
      offEvent: () => undefined,
      onAttach: () => undefined,
      offAttach: () => undefined,
      onLost: () => undefined
    },
    socketPathFor: (name) =>
      daemonTunnelSocketPath(name, AGENT, {
        agent: join(dir, 'none.sock'),
        mcp: join(dir, 'none.sock'),
        codehost: (agentId) => proxy.tunnelSocketFor(agentId),
        provider: (agentId) => proxy.providerTunnelSocketFor(agentId)
      }),
    listenOptions: (name: TunnelName) =>
      name === 'codehost'
        ? { routes: proxy.tunnelRoutes(AGENT), ca: ca.certPem }
        : name === 'provider'
          ? { routes: proxy.providerTunnelRoutes(AGENT), ca: ca.certPem }
          : undefined,
    log: quiet
  })
  cleanups.push(() => tunnel.stop('test over'))
  await tunnel.ensure('codehost')
  await tunnel.ensure('provider')
  const listening = tunnel.listeningAt('provider')!.proxy!
  return { proxy, ca, tunnel, listening, resolveProviderSlot, bundle: readFileSync(listening.trustBundle, 'utf8') }
}

type Dial = { host: string; port: number; proxyAuth?: string } | { socketPath: string }

function shimDial(listening: { port: number; token: string }): Dial {
  return {
    host: '127.0.0.1',
    port: listening.port,
    proxyAuth: `Basic ${Buffer.from(`codehost:${listening.token}`).toString('base64')}`
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

/** One HTTPS request through a CONNECT to `authority`, the response body read as it arrives. */
function through(
  dial: Dial,
  authority: string,
  caPem: string,
  request: { method?: string; path: string; headers?: Record<string, string> },
  onData?: (body: string) => void
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    void connectThrough(dial, authority, (socket) => {
      const [hostname = '', authorityPort = '443'] = authority.split(':')
      const tls = tlsConnect({ socket, servername: hostname, ca: caPem })
      const req = httpRequest(
        {
          createConnection: () => tls as unknown as Socket,
          host: hostname,
          port: Number(authorityPort),
          method: request.method ?? 'GET',
          path: request.path,
          headers: { ...request.headers, connection: 'close' }
        },
        (response) => {
          let body = ''
          response.setEncoding('utf8')
          response.on('data', (chunk: string) => {
            body += chunk
            onData?.(body)
          })
          response.on('end', () => resolve({ status: response.statusCode ?? 0, body }))
          response.on('error', reject)
        }
      )
      req.on('error', reject)
      req.end()
    }).then((status) => {
      if (status !== 200) resolve({ status, body: '' })
    }, reject)
  })
}

// Unix sockets carry the daemon side, which Windows never runs.
describe.skipIf(process.platform === 'win32')('an executor or VM session’s provider traffic', () => {
  it('shares the codehost listener, so the session needs one HTTPS_PROXY', async () => {
    const { tunnel, listening, ca, bundle } = await placedSession()
    expect(tunnel.listeningAt('codehost')?.proxy).toEqual(listening)
    expect(bundle).toContain(ca.certPem.trim())
  })

  it('exchanges the placeholder through the provider tunnel, and the real key arrives upstream', async () => {
    const { proxy, tunnel, listening, bundle, resolveProviderSlot } = await placedSession()
    seen.length = 0
    let during = { provider: -1, codehost: -1 }
    const reply = await through(
      shimDial(listening),
      provider(),
      bundle,
      {
        method: 'POST',
        path: '/v1/stream',
        headers: { 'x-api-key': proxy.providerPlaceholderFor(AGENT, 'org:anthropic')! }
      },
      () => {
        if (during.provider !== -1) return
        during = { provider: tunnel.streamCount('provider'), codehost: tunnel.streamCount('codehost') }
        releaseStream()
      }
    )
    expect(reply.status).toBe(200)
    expect(seen.map((entry) => entry.headers['x-api-key'])).toEqual([REAL_KEY])
    expect(resolveProviderSlot).toHaveBeenCalledWith(AGENT, 'org:anthropic')
    // Observe the tunnel while its upstream response is still open.
    expect(during).toEqual({ provider: 1, codehost: 0 })
  })

  it('streams server-sent events: the first event arrives before the upstream finishes', async () => {
    const { proxy, listening, bundle } = await placedSession()
    let firstSeen = false
    const reply = await through(
      shimDial(listening),
      provider(),
      bundle,
      { path: '/v1/stream', headers: { 'x-api-key': proxy.providerPlaceholderFor(AGENT, 'org:anthropic')! } },
      (body) => {
        if (!firstSeen && body.includes('event: one')) {
          firstSeen = true
          expect(body).not.toContain('event: two')
          releaseStream()
        }
      }
    )
    expect(firstSeen).toBe(true)
    expect(reply.body).toContain('event: two')
  })

  it("streams a pool pod's install key slot the same way, resolving that slot", async () => {
    const { proxy, listening, bundle, resolveProviderSlot } = await placedSession()
    seen.length = 0
    let firstSeen = false
    const placeholder = proxy.providerPlaceholderFor(AGENT, 'install:model:anthropic')!
    const reply = await through(
      shimDial(listening),
      provider(),
      bundle,
      { path: '/v1/stream', headers: { 'x-api-key': placeholder } },
      (body) => {
        if (!firstSeen && body.includes('event: one')) {
          firstSeen = true
          expect(body).not.toContain('event: two')
          releaseStream()
        }
      }
    )
    expect(firstSeen).toBe(true)
    expect(reply.body).toContain('event: two')
    expect(seen.at(-1)?.headers['x-api-key']).toBe(REAL_KEY)
    expect(resolveProviderSlot).toHaveBeenCalledWith(AGENT, 'install:model:anthropic')
  })

  it('refuses another agent’s placeholder, and a code-host placeholder, on the provider tunnel', async () => {
    const { proxy, listening, bundle, resolveProviderSlot } = await placedSession()
    seen.length = 0
    const other = await through(shimDial(listening), provider(), bundle, {
      path: '/v1/models',
      headers: { 'x-api-key': proxy.providerPlaceholderFor(OTHER, 'org:anthropic')! }
    })
    const codehost = await through(shimDial(listening), provider(), bundle, {
      path: '/v1/models',
      headers: { authorization: `Bearer ${proxy.placeholderFor(AGENT)}` }
    })
    expect([other.status, codehost.status]).toEqual([403, 403])
    expect(seen).toEqual([])
    expect(resolveProviderSlot).not.toHaveBeenCalled()
  })

  it('refuses at the holder a CONNECT to anything but the agent’s provider routes, whatever the shim sends', async () => {
    const { proxy } = await placedSession()
    const socketPath = proxy.providerTunnelSocketFor(AGENT)
    expect(proxy.providerTunnelSocketFor(AGENT)).toBe(socketPath)
    expect(socketPath).not.toBe(proxy.tunnelSocketFor(AGENT))
    expect(socketPath).not.toBe(proxy.socketFor(AGENT))
    expect(await connectThrough({ socketPath }, provider())).toBe(200)
    for (const elsewhere of [gitlab(), 'registry.example.test:443', 'llm.example.test:443', '127.0.0.1:22'])
      expect(await connectThrough({ socketPath }, elsewhere)).not.toBe(200)
    // The codehost socket is the mirror image: no provider host there.
    expect(await connectThrough({ socketPath: proxy.tunnelSocketFor(AGENT) }, provider())).not.toBe(200)
  })

  it('caps provider streams on their own budget, apart from codehost’s', async () => {
    const { listening, tunnel } = await placedSession({
      maxProviderStreams: 1,
      maxCodehostStreams: 1,
      connectQueueWaitMs: 100
    })
    const held = await connectThrough(shimDial(listening), provider(), (socket) =>
      cleanups.push(() => void socket.destroy())
    )
    expect(held).toBe(200)
    expect(await connectThrough(shimDial(listening), provider())).toBe(503)
    const code = await connectThrough(shimDial(listening), gitlab(), (socket) =>
      cleanups.push(() => void socket.destroy())
    )
    expect(code).toBe(200)
    await vi.waitFor(() => expect(tunnel.streamCount('codehost')).toBe(1))
    expect(tunnel.streamCount('provider')).toBe(1)
  })
})
