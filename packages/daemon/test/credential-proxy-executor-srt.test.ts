import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import { connect, type AddressInfo, type LookupFunction, type Socket } from 'node:net'
import { join } from 'node:path'
import { connect as tlsConnect } from 'node:tls'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { generateCa } from '@anthropic-ai/sandbox-runtime'
import { createMitmCA } from '@anthropic-ai/sandbox-runtime/dist/sandbox/mitm-ca.js'
import { mintLeafCert } from '@anthropic-ai/sandbox-runtime/dist/sandbox/mitm-leaf.js'
import { openConnectTunnel } from '@anthropic-ai/sandbox-runtime/dist/sandbox/parent-proxy.js'
import type { AgentSpec } from '@agentconnect.md/protocol'
import { sessionHostKey } from '../src/acp/host-key.js'
import { loadProxyCa } from '../src/credential-proxy/ca.js'
import { loadPlaceholderKey } from '../src/credential-proxy/placeholder.js'
import { CredentialProxy } from '../src/credential-proxy/proxy.js'
import { PROXY_TRUST_VARS } from '../src/credential-proxy/trust-bundle.js'
import { Daemon } from '../src/daemon.js'
import { srtLauncher } from '../src/execution/srt-local.js'
import { srtShimBoundary } from '../src/execution/srt-shim.js'
import type { HostShim, HostShimInput } from '../src/execution/host-shim.js'
import { hostedEnvironment } from '../src/execution/executor-vm.js'
import type { ManagedCredentialHost } from '../src/gitcred/managed-hosts.js'
import { daemonTunnelSocketPath } from '../src/remote/tunnel-sockets.js'
import { shimEntryOptions } from '../src/shim/entry-options.js'
import { SHIM_CODEHOST_DOMAINS_ENV, type ShimEvent } from '../src/shim/protocol.js'
import { TunnelHost } from '../src/shim/tunnel-host.js'
import { TunnelProxy } from '../src/shim/tunnel-proxy.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'

// github-app-git-credentials.md, Listeners: an srt session placed on an executor reaches its holder's proxy through SRT's route to that shim's codehost socket.

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
  vi.unstubAllEnvs()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

/** Short, so each socket fits AF_UNIX on a host whose temp directory is long. */
function shortDir(): string {
  const dir = realpathSync(mkdtempSync('/tmp/acxs-'))
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

/** The holder's proxy, and an executor shim inside srt bound to it over an in-process channel. */
async function placedSrtSession(domains: string[] | null = ['gitlab.example.test']) {
  const dir = shortDir()
  const ca = loadProxyCa(join(dir, 'ca'))
  const instances: Record<string, ManagedCredentialHost[]> = {
    [AGENT]: [{ provider: 'gitlab', baseUrl: `https://gitlab.example.test:${upstreamPort}` }],
    [OTHER]: [{ provider: 'gitlab', baseUrl: `https://gitlab.example.test:${upstreamPort}` }]
  }
  const mint = vi.fn(async () => ({ username: 'service-account', token: 'glpat_minted', access: 'write' as const }))
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
  const socketPathFor = (tunnel: string): string => join(dir, 'rt', `${tunnel}.sock`)
  const host = new TunnelHost({
    emit: (streamId, event) => {
      for (const listener of listeners) listener({ type: 'shim/event', streamId, event })
    },
    socketPathFor,
    ...(domains ? { srtCodehostDomains: domains } : {})
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
        provider: () => undefined
      }),
    listenOptions: (name) => (name === 'codehost' ? { routes: proxy.tunnelRoutes(AGENT), ca: ca.certPem } : undefined),
    log: quiet
  })
  cleanups.push(() => tunnel.stop('test over'))
  await tunnel.ensure('codehost')
  return { proxy, ca, mint, tunnel, listening: tunnel.listeningAt('codehost')!, srtSocket: socketPathFor('codehost') }
}

/** One HTTPS request as SRT's proxy carries it to a routed name: a bare CONNECT over the unix socket, then the client's TLS. */
async function throughSrt(socketPath: string, authority: string, caPem: string, lines: string[]): Promise<number> {
  const [host, port] = [authority.replace(/:\d+$/, ''), Number(authority.split(':').pop())]
  let tunnel: Socket
  try {
    tunnel = await openConnectTunnel({
      dial: () => connect({ path: socketPath }),
      readyEvent: 'connect',
      destHost: host,
      destPort: port
    })
  } catch (error) {
    const status = /\b(\d{3})\b/.exec((error as Error).message)?.[1]
    if (status) return Number(status)
    throw error
  }
  return await new Promise((resolve, reject) => {
    const tls = tlsConnect({ socket: tunnel, servername: host, ca: caPem }, () => {
      const [first, ...headers] = lines
      tls.write(`${[first, `Host: ${authority}`, ...headers, 'Connection: close'].join('\r\n')}\r\n\r\n`)
    })
    let raw = ''
    tls.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')))
    tls.on('end', () => resolve(Number(raw.split(' ')[1])))
    tls.on('error', reject)
  })
}

// Unix sockets carry both sides, which Windows never runs.
describe.skipIf(process.platform === 'win32')('an executor-placed srt session’s code-host traffic', () => {
  const gitlab = (): string => `gitlab.example.test:${upstreamPort}`
  const gitRequest = (placeholder: string): string[] => [
    'GET /group/project.git/info/refs?service=git-upload-pack HTTP/1.1',
    `Authorization: Basic ${Buffer.from(`x-access-token:${placeholder}`).toString('base64')}`
  ]

  it('reports the names srt routes, and a placeholder SRT sends to the shim’s socket is exchanged by the holder', async () => {
    const { proxy, ca, mint, listening, srtSocket } = await placedSrtSession()
    seen.length = 0
    expect(listening.srt).toEqual({ domains: ['gitlab.example.test'] })
    expect(statSync(srtSocket).mode & 0o777).toBe(0o600)
    const bundle = readFileSync(listening.proxy!.trustBundle, 'utf8')
    expect(bundle).toContain(ca.certPem.trim())
    const status = await throughSrt(srtSocket, gitlab(), bundle, gitRequest(proxy.placeholderFor(AGENT)))
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
    const { proxy, mint, listening, srtSocket } = await placedSrtSession()
    seen.length = 0
    const bundle = readFileSync(listening.proxy!.trustBundle, 'utf8')
    expect(await throughSrt(srtSocket, gitlab(), bundle, gitRequest(proxy.placeholderFor(OTHER)))).toBe(403)
    expect(seen).toEqual([])
    expect(mint).not.toHaveBeenCalled()
  })

  it('refuses at the shim a CONNECT to anything but a codehost route, and sends nothing into the tunnel', async () => {
    const { listening, srtSocket, tunnel } = await placedSrtSession()
    const bundle = readFileSync(listening.proxy!.trustBundle, 'utf8')
    for (const elsewhere of ['gitlab.example.test:443', 'registry.example.test:443'])
      expect(await throughSrt(srtSocket, elsewhere, bundle, ['GET / HTTP/1.1'])).toBe(403)
    expect(tunnel.streamCount()).toBe(0)
  })

  it('serves no socket and reports no route where srt routes nothing to the shim', async () => {
    const { listening, srtSocket } = await placedSrtSession(null)
    expect(listening.srt).toBeUndefined()
    expect(listening.proxy).toBeDefined()
    expect(existsSync(srtSocket)).toBe(false)
  })
})

describe('the shim of an executor’s srt environment', () => {
  it('reads the routed names from its environment only beside a host socket', () => {
    const base = { AC_SHIM_SOCKET: '/home/agent/hs/abc/shim.sock' }
    expect(
      shimEntryOptions({ ...base, [SHIM_CODEHOST_DOMAINS_ENV]: 'github.com, api.github.com,' }).codehostDomains
    ).toEqual(['github.com', 'api.github.com'])
    expect(shimEntryOptions(base).codehostDomains).toBeUndefined()
    expect(shimEntryOptions({ [SHIM_CODEHOST_DOMAINS_ENV]: 'github.com' }).codehostDomains).toBeUndefined()
  })
})

// POSIX paths and the boundary's own files; the real boundary runs in srt-shim.test.ts on Linux.
describe.skipIf(process.platform === 'win32')('an executor’s srt boundary', () => {
  function layoutIn(root: string) {
    const layout = {
      entry: { path: join(root, 'shim.js'), execArgv: [] },
      runtimeRoot: join(root, 'hs', 'abc'),
      workspaceRoot: join(root, 'sessions', 's'),
      home: join(root, 'sessions', 's', 'home'),
      helperRoot: join(root, 'helper'),
      privateDir: join(root, 'hs', 'abc.p')
    }
    for (const dir of [layout.runtimeRoot, layout.home, layout.helperRoot, layout.privateDir])
      mkdirSync(dir, { recursive: true })
    return layout
  }

  it('routes the holder’s code-host names to the shim’s codehost socket and trusts the bundle the shim rewrites', () => {
    const root = shortDir()
    const layout = layoutIn(root)
    const wrapped = srtShimBoundary({
      daemonRoot: root,
      mounts: [{ source: layout.workspaceRoot, target: layout.workspaceRoot, mode: 'writable' }],
      readRoots: [],
      shimCodehost: ['github.com', 'api.github.com']
    }).wrap({ cmd: process.execPath, args: [] }, layout)
    const settings = JSON.parse(readFileSync(join(layout.privateDir, 'settings.json'), 'utf8')) as {
      network: Record<string, unknown>
    }
    expect(settings.network.mitmProxy).toEqual({
      socketPath: join(layout.runtimeRoot, 'codehost.sock'),
      domains: ['github.com', 'api.github.com']
    })
    const bundle = join(layout.runtimeRoot, 'codehost-trust.pem')
    for (const name of PROXY_TRUST_VARS) expect(wrapped.env[name]).toBe(bundle)
    // Roots alone until the holder's listen brings its CA, so the variables name a file from the start.
    expect(readFileSync(bundle, 'utf8')).toContain('-----BEGIN CERTIFICATE-----')
    expect(wrapped.env[SHIM_CODEHOST_DOMAINS_ENV]).toBe('github.com,api.github.com')
  })

  it('routes nothing and adds no trust for an environment whose holder names no code host', () => {
    const root = shortDir()
    const layout = layoutIn(root)
    const wrapped = srtShimBoundary({
      daemonRoot: root,
      mounts: [{ source: layout.workspaceRoot, target: layout.workspaceRoot, mode: 'writable' }],
      readRoots: []
    }).wrap({ cmd: process.execPath, args: [] }, layout)
    const settings = JSON.parse(readFileSync(join(layout.privateDir, 'settings.json'), 'utf8')) as {
      network: Record<string, unknown>
    }
    expect(settings.network.mitmProxy).toBeUndefined()
    expect(wrapped.env.SSL_CERT_FILE).toBeUndefined()
    expect(wrapped.env[SHIM_CODEHOST_DOMAINS_ENV]).toBeUndefined()
  })

  it('takes the names from a hosted environment its facet built', async () => {
    const root = shortDir()
    const layout = layoutIn(root)
    let boundary: HostShimInput['boundary']
    const launcher = srtLauncher(root, { readRoots: () => [] }, async (input) => {
      boundary = input.boundary
      return { runtimeRoot: layout.runtimeRoot, exited: new Promise(() => {}) } as unknown as HostShim
    })
    const environment = hostedEnvironment(root, 's', { env: {}, paths: [] }, ['github.com'])
    expect(environment.hosted?.codehostDomains).toEqual(['github.com'])
    await launcher.start({ environment, log: quiet as never })
    const wrapped = boundary!.wrap({ cmd: process.execPath, args: [] }, layout)
    expect(wrapped.env[SHIM_CODEHOST_DOMAINS_ENV]).toBe('github.com')
    expect(hostedEnvironment(root, 's').hosted).toEqual({ env: {} })
  })
})

// The holder's side, as the daemon itself composes a placed srt session's launch.
const GITHUB_AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SESSION_KEY = 'slack:T1:C1:1700000000.000100'
const BUNDLE = '/home/agent/executor-run/codehost-trust.pem'

const githubSpec = (): AgentSpec =>
  ({
    name: 'gh',
    runtime: 'claude',
    workspace: {
      mode: 'github',
      isolation: 'shared',
      gitRepo: 'https://github.com/example-org/example-repo',
      branch: 'main',
      gitCredential: 'github-app',
      additionalRepos: []
    }
  }) as unknown as AgentSpec

async function holder(): Promise<{ d: any; agent: any; stop: () => Promise<void> }> {
  const root = shortDir()
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      runtimes: { claude: { command: 'node', args: ['claude-agent-acp'] } }
    })
  )
  const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root, probeRuntimes: async () => [] })
  await daemon.start()
  const d = daemon as any
  expect(await d.cpConfigApply().applyAgentUpsert({ agentId: GITHUB_AGENT, spec: githubSpec() })).toEqual({ ok: true })
  const agent = d.agents.get(GITHUB_AGENT)
  await d.enqueueAgentWorkspacePreparation(agent, async () => undefined)
  const realPlane = d.executorPlane
  return {
    d,
    agent,
    stop: async () => {
      d.executorPlane = realPlane
      await daemon.stop()
    }
  }
}

/** The executor plane as a placed srt session's holder sees it once its shim answered the `codehost` listen. */
function placedOnSrt(d: any, agent: any, srt: { domains: string[]; trustBundle: string } | undefined) {
  const placed = {
    agentId: agent.id,
    sessionKey: SESSION_KEY,
    leaf: 'leaf-example',
    subject: `${agent.id}/session-example`,
    executorDaemonId: 'executor-example',
    strategy: 'srt'
  }
  d.executorPlane = {
    placementOf: (key: string) => (key === SESSION_KEY ? placed : undefined),
    homeFor: () => '/home/agent/executor-home',
    rootsFor: () => ({ runtimeRoot: '/home/agent/executor-run', missingHelpers: [] }),
    codexStateFor: () => undefined,
    runtimeDefFor: () => undefined,
    codehostProxyFor: () => undefined,
    srtCodehostFor: () => srt,
    spawnFor: () => ({})
  }
  return placed
}

function launch(d: any, agent: any): { env: Record<string, string>; files: Array<{ content: string }> } {
  const { host } = d.buildAcpHost(agent, d.cfg, {
    hostKey: sessionHostKey(agent.id, SESSION_KEY),
    strategy: 'srt',
    cwd: agent.workspace.path
  })
  return { env: host.opts.env, files: host.opts.files }
}

// Unix sockets carry the proxy, which Windows never runs.
describe.skipIf(process.platform === 'win32')('the holder of an executor-placed srt session', () => {
  it('asks its shim for codehost, and names the agent’s code hosts in the prepare', async () => {
    const { d, agent, stop } = await holder()
    const realPlane = d.executorPlane
    try {
      const placed = { agentId: agent.id, sessionKey: SESSION_KEY, strategy: 'srt' }
      expect(d.tunnelsForPlaced(agent.id, placed)).toEqual(['mcp', 'agent', 'codehost'])
      expect(d.tunnelsForPlaced(agent.id, { ...placed, strategy: 'microsandbox' })).toEqual([
        'mcp',
        'agent',
        'codehost'
      ])
      const executorPrepare = vi.fn(async () => ({ status: 'refused', reason: 'facet_off' }))
      d.cpClient = { connected: () => true, executorPrepare }
      const prepare = (strategy: string) =>
        realPlane.deps.prepare({
          agentId: agent.id,
          sessionKey: SESSION_KEY,
          executorDaemonId: 'executor-example',
          launchId: '55555555-5555-4555-8555-000000000001',
          strategy
        })
      await prepare('srt')
      await prepare('host')
      const [srtReq, hostReq] = executorPrepare.mock.calls.map((call) => (call as unknown[])[0] as any)
      expect(srtReq.codehostDomains).toEqual(d.credentialProxy.proxy.domainsFor(agent.id))
      expect(srtReq.codehostDomains).toContain('github.com')
      expect(hostReq.codehostDomains).toBeUndefined()
    } finally {
      d.cpClient = undefined
      await stop()
    }
  })

  it('hands the session the placeholder and the shim’s bundle where srt routes every code host, and no proxy of its own', async () => {
    const { d, agent, stop } = await holder()
    try {
      placedOnSrt(d, agent, { domains: d.codehostDomainsFor(agent.id), trustBundle: BUNDLE })
      const { env, files } = launch(d, agent)
      const placeholder = env.AC_CODEHOST_CREDENTIAL!
      expect(placeholder).toMatch(/^acph1_/)
      expect(env.GH_TOKEN).toBe(placeholder)
      // srt sets the proxy variables itself and routes the code hosts.
      expect(env.HTTPS_PROXY).toBeUndefined()
      expect(env.https_proxy).toBeUndefined()
      for (const name of PROXY_TRUST_VARS) expect(env[name]).toBe(BUNDLE)
      // The session gitconfig, written on the executor, presents the placeholder rather than asking the helper.
      expect(files.map((file) => file.content).join('\n')).toContain('password=$AC_CODEHOST_CREDENTIAL')
      expect(JSON.stringify(env)).not.toMatch(/ghs_/)
    } finally {
      await stop()
    }
  })

  it('seals none of this holder’s own provider keys for it, since the keys there are its executor’s', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'fixture-holder-anthropic-key')
    const { d, agent, stop } = await holder()
    try {
      placedOnSrt(d, agent, { domains: d.codehostDomainsFor(agent.id), trustBundle: BUNDLE })
      const { env } = launch(d, agent)
      const slots = [...(d.providerSlots.get(agent.id)?.keys() ?? [])] as string[]
      expect(slots.filter((id) => id.startsWith('host:'))).toEqual([])
      expect(env.ANTHROPIC_API_KEY ?? '').not.toMatch(/^acph1_/)
    } finally {
      await stop()
    }
  })

  it('gives no code-host credential where the shim routes nothing or misses a code host, which still trusts the bundle', async () => {
    const { d, agent, stop } = await holder()
    try {
      placedOnSrt(d, agent, undefined)
      const { env: none, files } = launch(d, agent)
      // The session config presents only a placeholder the environment does not carry, never the helper.
      expect(files.map((file) => file.content).join('\n')).not.toContain('bin/git-credential')
      expect(none.AC_CODEHOST_CREDENTIAL).toBeUndefined()
      expect(none.GH_TOKEN).toBeUndefined()
      expect(none.SSL_CERT_FILE).toBeUndefined()

      placedOnSrt(d, agent, { domains: ['github.com'], trustBundle: BUNDLE })
      const partial = launch(d, agent).env
      expect(partial.AC_CODEHOST_CREDENTIAL).toBeUndefined()
      expect(partial.GH_TOKEN).toBeUndefined()
      for (const name of PROXY_TRUST_VARS) expect(partial[name]).toBe(BUNDLE)
    } finally {
      await stop()
    }
  })
})
