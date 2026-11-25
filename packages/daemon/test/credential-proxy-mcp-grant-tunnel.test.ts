import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import type { AddressInfo, LookupFunction, Server, Socket } from 'node:net'
import { join } from 'node:path'
import { connect as tlsConnect, createSecureContext } from 'node:tls'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { generateCa } from '@anthropic-ai/sandbox-runtime'
import { createMitmCA } from '@anthropic-ai/sandbox-runtime/dist/sandbox/mitm-ca.js'
import { mintLeafCert } from '@anthropic-ai/sandbox-runtime/dist/sandbox/mitm-leaf.js'
import type { McpToolDecisions } from '@agentconnect.md/protocol'
import type { McpGrantSpawn, SpawnedRuntime, SpawnRequest } from '../src/acp/spawn-driver.js'
import { loadProxyCa } from '../src/credential-proxy/ca.js'
import { mcpGrantRouteRefusal, mcpGrantShimOf, mcpGrantShimRefusal } from '../src/credential-proxy/mcp-grant-route.js'
import { loadPlaceholderKey } from '../src/credential-proxy/placeholder.js'
import { CredentialProxy } from '../src/credential-proxy/proxy.js'
import { CODEX_CA_ENV, SESSION_TRUST_ENV } from '../src/credential-proxy/trust-bundle.js'
import { microsandboxLauncher } from '../src/execution/executor-vm.js'
import { LocalExecutor } from '../src/execution/local-executor.js'
import type { EnvironmentDescriptor } from '../src/execution/strategies.js'
import { ApprovalRecords, argumentsDigest } from '../src/mcp/approval-records.js'
import { applyProxySpawn, codehostProxyUrl, mcpGrantRouteOf } from '../src/remote/codehost-spawn.js'
import { TunnelBinder } from '../src/remote/tunnel-binder.js'
import { daemonTunnelSocketPath } from '../src/remote/tunnel-sockets.js'
import type { ShimEvent } from '../src/shim/protocol.js'
import { TunnelHost } from '../src/shim/tunnel-host.js'
import { ShimPredatesTunnelError, TunnelProxy } from '../src/shim/tunnel-proxy.js'
import { MCP_GRANT_TUNNEL_FEATURE, type TunnelName } from '../src/shim/tunnel.js'
import { daemonSocket, fakeVm, fakeVmManager } from './fixtures/microsandbox-vm.js'

// A restricted MCP grant reached from a pod, VM or executor (mcp-tool-permissions.md §7.2, §8): the shim's mcp-grant tunnel, the proxy's mcp-grant socket, and the skew refusal.

const AGENT = '11111111-1111-4111-8111-111111111111'
const KEY = 'mcpg_real_grant_key'
const PATH = '/mcp/00000000-0000-4000-8000-000000000001'
const DECISIONS: McpToolDecisions = { allow: ['read_note'], approval: ['write_note'], ask: [], block: [] }
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
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

/** Short, so each socket fits AF_UNIX on a host whose temp directory is long. */
function shortDir(): string {
  const dir = realpathSync(mkdtempSync('/tmp/acmt-'))
  dirs.push(dir)
  return dir
}

let relay: HttpsServer
let port = 0
let relayCaPem = ''
const seen: { url?: string; headers: IncomingHttpHeaders; body: string }[] = []

beforeAll(async () => {
  const generated = generateCa({ cn: 'example relay CA' })
  relayCaPem = generated.certPem
  const mitm = createMitmCA({ caCertPem: generated.certPem, caKeyPem: generated.keyPem })
  const leaf = mintLeafCert(mitm, 'relay.example.test')
  const context = createSecureContext({ key: leaf.keyPem, cert: leaf.certPem })
  relay = createHttpsServer({ SNICallback: (_name, callback) => callback(null, context) }, (req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => (body += chunk))
    req.on('end', () => {
      seen.push({ ...(req.url ? { url: req.url } : {}), headers: req.headers, body })
      res.setHeader('content-type', 'application/json')
      res.end('{"jsonrpc":"2.0","id":7,"result":{"content":[]}}')
    })
  })
  await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve))
  port = (relay.address() as AddressInfo).port
})
afterAll(async () => {
  await new Promise<void>((resolve) => relay.close(() => resolve()))
})

const authority = (): string => `relay.example.test:${port}`

/** The holder's proxy, and a shim's tunnel host bound to it over an in-process channel, serving the mcp-grant tunnel. */
async function placedSession(options: { features?: boolean } = {}) {
  const dir = shortDir()
  const ca = loadProxyCa(join(dir, 'ca'))
  const records = new ApprovalRecords()
  const proxy = new CredentialProxy({
    key: loadPlaceholderKey(join(dir, 'proxy.key')),
    ca,
    mint: async () => ({ username: 'x-access-token', token: 'ghs_minted', access: 'write' as const }),
    workspaceRepo: () => undefined,
    instancesOf: () => [],
    runningAgents: () => [AGENT],
    knownAgent: () => true,
    mcpGrantsOf: (agentId) =>
      agentId === AGENT
        ? [{ provider: 'notes', url: `https://${authority()}${PATH}`, key: KEY, decisions: DECISIONS }]
        : [],
    approvals: records,
    log: quiet,
    upstream: { lookupFor: () => toLoopback, trustedCa: [relayCaPem] }
  })
  await proxy.start(join(dir, 'run'))
  cleanups.push(() => proxy.stop())

  const listeners: Array<(event: ShimEvent) => void> = []
  const host = new TunnelHost({
    emit: (streamId, event) => {
      for (const listener of listeners) listener({ type: 'shim/event', streamId, event })
    },
    socketPathFor: (tunnel) => join(dir, 'rt', `${tunnel}.sock`)
  })
  cleanups.push(() => host.close())
  const request = vi.fn(
    async (_capability: string, payload: unknown) => await host.handle(JSON.parse(JSON.stringify(payload)))
  )
  const tunnel = new TunnelProxy({
    session: {
      agentId: AGENT,
      request,
      onEvent: (listener) => listeners.push(listener),
      offEvent: () => undefined,
      onAttach: () => undefined,
      offAttach: () => undefined,
      onLost: () => undefined,
      hasFeature: (feature) => options.features !== false && feature === MCP_GRANT_TUNNEL_FEATURE
    },
    socketPathFor: (name) =>
      daemonTunnelSocketPath(name, AGENT, {
        agent: join(dir, 'none.sock'),
        mcp: join(dir, 'none.sock'),
        codehost: () => undefined,
        provider: () => undefined,
        mcpGrant: (agentId) => proxy.mcpGrantTunnelSocketFor(agentId)
      }),
    listenOptions: (name: TunnelName) =>
      name === 'mcp-grant' ? { routes: proxy.mcpGrantTunnelRoutes(AGENT), ca: ca.certPem } : undefined,
    log: quiet
  })
  cleanups.push(() => tunnel.stop('test over'))
  return { proxy, ca, tunnel, records, request }
}

type Dial = { host: string; port: number } | { socketPath: string }

/** A CONNECT's status, the tunnel left open for `then` when it is 200. */
function connectThrough(dial: Dial, target: string, then?: (socket: Socket) => void): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ ...dial, method: 'CONNECT', path: target })
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

/** One HTTPS request through a CONNECT to the relay, answered whole. */
function through(
  dial: Dial,
  caPem: string,
  request: { method?: string; headers?: Record<string, string>; body?: string }
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    void connectThrough(dial, authority(), (socket) => {
      const tls = tlsConnect({ socket, servername: 'relay.example.test', ca: caPem })
      const req = httpRequest(
        {
          createConnection: () => tls as unknown as Socket,
          host: 'relay.example.test',
          port,
          method: request.method ?? 'GET',
          path: PATH,
          headers: { ...request.headers, connection: 'close' }
        },
        (response) => {
          let body = ''
          response.setEncoding('utf8')
          response.on('data', (chunk: string) => (body += chunk))
          response.on('end', () => resolve({ status: response.statusCode ?? 0, body }))
          response.on('error', reject)
        }
      )
      req.on('error', reject)
      req.end(request.body)
    }).then((status) => {
      if (status !== 200) resolve({ status, body: '' })
    }, reject)
  })
}

const call = (name: string, args: unknown, id = 'toolu_1') =>
  JSON.stringify({
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: { name, arguments: args, _meta: { 'claudecode/toolUseId': id } }
  })

// Unix sockets carry the daemon side, which Windows never runs.
describe.skipIf(process.platform === 'win32')('a sandboxed session’s restricted MCP grant through its shim', () => {
  it('exchanges the placeholder for the key through the mcp-grant tunnel and judges each call there', async () => {
    const { proxy, tunnel, records } = await placedSession()
    await tunnel.ensure('mcp-grant')
    const listening = tunnel.listeningAt('mcp-grant')!.proxy!
    const bundle = readFileSync(listening.trustBundle, 'utf8')
    const dial = { host: '127.0.0.1', port: listening.port }
    const placeholder = proxy.mcpGrantPlaceholderFor(AGENT, 'notes', 'session-a')!
    const headers = { authorization: `Bearer ${placeholder}`, 'content-type': 'application/json' }
    seen.length = 0

    const get = await through(dial, bundle, { headers: { ...headers, 'x-ac-tool-approval': 'person' } })
    expect(get.status).toBe(200)
    expect(seen.at(-1)?.headers.authorization).toBe(`Bearer ${KEY}`)
    expect(seen.at(-1)?.headers['x-ac-tool-approval']).toBeUndefined()

    // A gated call without its record is answered here, and the relay never sees it.
    const unapproved = await through(dial, bundle, { method: 'POST', headers, body: call('write_note', { t: 1 }) })
    expect(JSON.parse(unapproved.body).result).toMatchObject({ isError: true })
    expect(seen).toHaveLength(1)

    records.put({
      agentId: AGENT,
      toolCallId: 'toolu_2',
      provider: 'notes',
      tool: 'write_note',
      argsDigest: argumentsDigest({ t: 2 }),
      source: 'person'
    })
    const approved = await through(dial, bundle, {
      method: 'POST',
      headers,
      body: call('write_note', { t: 2 }, 'toolu_2')
    })
    expect(approved.status).toBe(200)
    expect(seen.at(-1)?.headers).toMatchObject({ authorization: `Bearer ${KEY}`, 'x-ac-tool-approval': 'person' })
    expect(JSON.stringify(seen)).not.toContain(placeholder)
    expect(tunnel.streamCount('mcp-grant')).toBeLessThanOrEqual(1)
  })

  it('refuses at the holder a CONNECT to anything but the agent’s relays, and serves the relay on no other tunnel socket', async () => {
    const { proxy } = await placedSession()
    const socketPath = proxy.mcpGrantTunnelSocketFor(AGENT)
    expect(proxy.mcpGrantTunnelSocketFor(AGENT)).toBe(socketPath)
    expect(socketPath).not.toBe(proxy.providerTunnelSocketFor(AGENT))
    expect(socketPath).not.toBe(proxy.tunnelSocketFor(AGENT))
    expect(await connectThrough({ socketPath }, authority())).toBe(200)
    for (const elsewhere of ['api.github.com:443', 'relay.example.test:443', '127.0.0.1:22'])
      expect(await connectThrough({ socketPath }, elsewhere)).not.toBe(200)
    expect(await connectThrough({ socketPath: proxy.providerTunnelSocketFor(AGENT) }, authority())).not.toBe(200)
    expect(proxy.mcpGrantTunnelRoutes(AGENT)).toEqual([authority()])
  })

  it('never asks a shim that does not advertise the tunnel, and its binder says so once', async () => {
    const { tunnel, request } = await placedSession({ features: false })
    await expect(tunnel.ensure('mcp-grant')).rejects.toBeInstanceOf(ShimPredatesTunnelError)
    expect(request).not.toHaveBeenCalled()
    expect(tunnel.listeningAt('mcp-grant')).toBeUndefined()

    const log = { info: vi.fn(), warn: vi.fn() }
    const session = {
      agentId: AGENT,
      generation: 1,
      request: vi.fn(async () => ({ socketPath: '/run/agentconnect/mcp.sock' })),
      onEvent: () => undefined,
      offEvent: () => undefined,
      onAttach: () => undefined,
      offAttach: () => undefined,
      onLost: () => undefined,
      hasFeature: () => false
    }
    const binder = new TunnelBinder({
      tunnelsFor: () => ['mcp', 'mcp-grant'],
      tunnelSocketPath: () => '/daemon/socket.sock',
      tunnelListenOptions: (_agentId, name) =>
        name === 'mcp-grant' ? { routes: [authority()], ca: 'example certificate' } : undefined,
      log
    })
    await binder.ensure(AGENT, session)
    await binder.ensure(AGENT, session)
    expect(session.request).toHaveBeenCalledTimes(1)
    expect(binder.serves(AGENT, 'mcp')).toBe(true)
    expect(binder.listeningAt(AGENT, 'mcp-grant')).toBeUndefined()
    expect(log.warn).not.toHaveBeenCalled()
    expect(log.info.mock.calls.filter(([line]) => String(line).includes('no mcp-grant tunnel'))).toHaveLength(1)
  })
})

describe('applying a launch’s relay route at spawn', () => {
  const LISTENER = {
    port: 41_236,
    token: 'listener-token-example',
    trustBundle: '/run/agentconnect/codehost-trust.pem'
  }
  const URL = codehostProxyUrl(LISTENER)
  const routed = vi.fn()
  const GRANT: McpGrantSpawn = { noProxy: 'localhost,127.0.0.1,::1,internal.example.test', routed }
  const base: SpawnRequest = {
    command: 'x',
    args: [],
    env: { AC_AGENT_ID: 'agent-a', NO_PROXY: 'relay.example.test', [CODEX_CA_ENV]: '/home/agent/codex-ca.pem' }
  }

  it('points the session at its shim listener with Codex’s bundle and a NO_PROXY that keeps the relay', () => {
    const launch = applyProxySpawn({ ...base, mcpGrant: GRANT }, { mcpGrant: LISTENER })
    expect(launch.mcpGrant).toBeUndefined()
    expect(launch.env).toMatchObject({
      HTTPS_PROXY: URL,
      https_proxy: URL,
      NODE_USE_ENV_PROXY: '1',
      SSL_CERT_FILE: LISTENER.trustBundle,
      [CODEX_CA_ENV]: LISTENER.trustBundle,
      NO_PROXY: 'localhost,127.0.0.1,::1,localhost,127.0.0.1,::1,internal.example.test'
    })
    expect(JSON.parse(launch.env[SESSION_TRUST_ENV]!)).toEqual({
      bundle: LISTENER.trustBundle,
      files: ['/home/agent/codex-ca.pem']
    })
    expect(mcpGrantRouteOf(launch, LISTENER)).toBe('routed')
  })

  it('reports a launch without the listener unserved, and one under its own proxy a conflict', () => {
    expect(mcpGrantRouteOf(applyProxySpawn({ ...base, mcpGrant: GRANT }, {}), undefined)).toBe('unserved')
    const own = { ...base, env: { ...base.env, HTTPS_PROXY: 'http://egress.example.test:3128' } }
    const launch = applyProxySpawn({ ...own, mcpGrant: GRANT }, { mcpGrant: LISTENER })
    expect(launch.env.HTTPS_PROXY).toBe('http://egress.example.test:3128')
    expect(mcpGrantRouteOf(launch, LISTENER)).toBe('conflict')
  })

  it('shares the codehost listener, and asks a hosted VM’s shim for its seeded trust', () => {
    const codehost = { env: { AC_CODEHOST_CREDENTIAL: 'placeholder-example', NO_PROXY: 'localhost' } }
    const both = applyProxySpawn({ ...base, codehost, mcpGrant: GRANT }, { codehost: LISTENER, mcpGrant: LISTENER })
    expect(both.env).toMatchObject({ HTTPS_PROXY: URL, [CODEX_CA_ENV]: LISTENER.trustBundle })
    expect(mcpGrantRouteOf(both, LISTENER)).toBe('routed')
    const guest = applyProxySpawn({ ...base, mcpGrant: { ...GRANT, guestTrust: true } }, { mcpGrant: LISTENER })
    expect(JSON.parse(guest.env[SESSION_TRUST_ENV]!)).toMatchObject({ guest: true })
  })

  it('names the shim a session needs upgraded, and refuses an executor’s srt session up front', () => {
    expect(mcpGrantShimOf({ strategy: 'host' })).toBeUndefined()
    expect(mcpGrantShimOf({ strategy: 'host', k8s: true })).toBe("its sandbox pod's shim")
    expect(mcpGrantShimOf({ strategy: 'microsandbox' })).toBe("its VM's shim")
    const placed = { strategy: 'host', executorDaemonId: 'executor-example' }
    expect(mcpGrantShimOf({ strategy: 'host', placed })).toBe('the host shim of daemon executor-example')
    expect(mcpGrantRouteRefusal("its sandbox pod's shim", 'routed')).toBeUndefined()
    expect(mcpGrantRouteRefusal("its sandbox pod's shim", 'unserved')).toBe(
      "its sandbox pod's shim does not carry the mcp-grant route; upgrade that shim to use this provider"
    )
    expect(mcpGrantRouteRefusal("its VM's shim", 'conflict')).toContain('its own HTTPS proxy')
    expect(mcpGrantShimRefusal({ strategy: 'microsandbox' })).toBeUndefined()
    expect(mcpGrantShimRefusal({ strategy: 'host', placed })).toBeUndefined()
    expect(mcpGrantShimRefusal({ strategy: 'host', placed: { ...placed, strategy: 'microsandbox' } })).toBeUndefined()
    expect(mcpGrantShimRefusal({ strategy: 'host', placed: { ...placed, strategy: 'srt' } })).toContain(
      'the srt shim of daemon executor-example'
    )
  })
})

describe('a local VM session’s relay route through its shim', () => {
  const REPORTER = `process.stdout.write(JSON.stringify({ env: process.env }) + '\\n'); process.stdin.resume()`
  const logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {} }

  async function fixture(options: { advertises: boolean }) {
    const root = shortDir()
    const sockets = { mcp: join(root, 'mcp.sock'), agent: join(root, 'gc.sock'), 'mcp-grant': join(root, 'mg.sock') }
    const servers: Server[] = [
      await daemonSocket(sockets.mcp, 'mcp'),
      await daemonSocket(sockets.agent, 'agent'),
      await daemonSocket(sockets['mcp-grant'], 'mcp-grant')
    ]
    const proxyCa = generateCa({ cn: 'example proxy CA' }).certPem
    writeFileSync(join(root, 'proxy-ca.pem'), proxyCa)
    const vm = fakeVm(
      { mcp: join(root, 'g', 'mcp.sock'), agent: join(root, 'g', 'gc.sock') },
      options.advertises ? { features: [MCP_GRANT_TUNNEL_FEATURE] } : {}
    )
    const fake = fakeVmManager({ vm })
    const listens = vi.fn()
    const local = new LocalExecutor({
      launcher: microsandboxLauncher({ manager: () => fake.manager }),
      generations: { nextSandboxGeneration: async () => 1 },
      tunnelSocketPath: (tunnel) =>
        tunnel === 'codehost' || tunnel === 'provider' ? undefined : sockets[tunnel as keyof typeof sockets],
      extraTunnelsFor: () => ['mcp-grant'],
      tunnelListenOptions: (_agentId, tunnel) => {
        listens(tunnel)
        return tunnel === 'mcp-grant' ? { routes: ['relay.example.test:443'], ca: proxyCa } : undefined
      },
      log: logger
    })
    const environment: EnvironmentDescriptor = { id: 'agent-a/session-example', mounts: [], workspaceRoot: root }
    cleanups.push(
      ...servers.map((server) => () => void server.close()),
      () => vm.close(),
      () => fake.stop(),
      () => local.stop()
    )
    const routed = vi.fn()
    const launch = () =>
      local.driverFor(environment).launch({
        command: process.execPath,
        args: ['-e', REPORTER],
        env: { AC_AGENT_ID: 'agent-a', PATH: process.env.PATH ?? '' },
        mcpGrant: { noProxy: 'localhost,127.0.0.1,::1', routed }
      })
    return { launch, listens, routed }
  }

  async function reported(runtime: SpawnedRuntime): Promise<Record<string, string>> {
    const reader = runtime.fromAgent.getReader()
    let text = ''
    while (!text.includes('\n')) text += Buffer.from((await reader.read()).value!).toString()
    reader.releaseLock()
    await runtime.stop(2_000)
    return (JSON.parse(text.slice(0, text.indexOf('\n'))) as { env: Record<string, string> }).env
  }

  it.skipIf(process.platform === 'win32')(
    'starts the runtime behind its shim listener once that shim serves mcp-grant, and reports the route',
    async () => {
      const { launch, listens, routed } = await fixture({ advertises: true })
      const env = await reported(await launch())
      expect(listens).toHaveBeenCalledWith('mcp-grant')
      expect(env.HTTPS_PROXY).toMatch(/^http:\/\/codehost:[^@]+@127\.0\.0\.1:\d+$/)
      expect(env[CODEX_CA_ENV]).toBe(env.SSL_CERT_FILE)
      expect(routed).toHaveBeenLastCalledWith('routed')
    }
  )

  it.skipIf(process.platform === 'win32')(
    'never asks a shim that predates the tunnel, and reports the launch unserved',
    async () => {
      const { launch, listens, routed } = await fixture({ advertises: false })
      const env = await reported(await launch())
      expect(listens).not.toHaveBeenCalledWith('mcp-grant')
      expect(env.HTTPS_PROXY).toBeUndefined()
      expect(routed).toHaveBeenLastCalledWith('unserved')
    }
  )
})
