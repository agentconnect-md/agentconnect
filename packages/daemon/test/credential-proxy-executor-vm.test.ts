import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getCACertificates } from 'node:tls'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { generateCa } from '@anthropic-ai/sandbox-runtime'
import type { AgentSpec } from '@agentconnect.md/protocol'
import { sessionHostKey } from '../src/acp/host-key.js'
import type { CodehostSpawn, SpawnedRuntime } from '../src/acp/spawn-driver.js'
import type { RuntimeDef } from '../src/config/config-schema.js'
import { applySessionTrust, PROXY_TRUST_VARS, SESSION_TRUST_ENV } from '../src/credential-proxy/trust-bundle.js'
import { Daemon } from '../src/daemon.js'
import { microsandboxLauncher } from '../src/execution/executor-vm.js'
import { LocalExecutor } from '../src/execution/local-executor.js'
import type { EnvironmentDescriptor } from '../src/execution/strategies.js'
import { microsandboxCredentialStep } from '../src/microsandbox/secrets.js'
import { applyProxySpawn } from '../src/remote/codehost-spawn.js'
import { SHIM_SEED_ENV } from '../src/shim/protocol.js'
import { TunnelHost, writeCodehostTrustBundle } from '../src/shim/tunnel-host.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import { daemonSocket, fakeVm, fakeVmManager } from './fixtures/microsandbox-vm.js'

// github-app-git-credentials.md, Listeners: a VM session placed on an executor reaches its holder's proxy through its guest shim's codehost listener, its seeded trust kept.

const quiet = { trace() {}, debug() {}, info() {}, warn() {}, error() {} }
const REPORTER = `process.stdout.write(JSON.stringify({ env: process.env }) + '\\n'); process.stdin.resume()`
const ROUTES = ['github.com:443', 'api.github.com:443']
const LISTENER = { port: 41_234, token: 'listener-token-example', trustBundle: '/run/agentconnect/codehost-trust.pem' }
const OVERLAY: CodehostSpawn = {
  env: {
    AC_CODEHOST_CREDENTIAL: 'placeholder-example',
    GH_TOKEN: 'placeholder-example'
  },
  guestTrust: true
}

let proxyCa = ''
let msbCa = ''
let guestRootCa = ''
beforeAll(() => {
  proxyCa = generateCa({ cn: 'example proxy CA' }).certPem
  msbCa = generateCa({ cn: 'example substitution CA' }).certPem
  guestRootCa = generateCa({ cn: 'example guest root CA' }).certPem
})

const dirs: string[] = []
const closers: Array<() => unknown> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of closers.splice(0).reverse()) await close()
})
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

/** Short, so each socket fits AF_UNIX on a host whose temp directory is long; Windows has no /tmp and no sockets here. */
function shortDir(): string {
  const dir = realpathSync(mkdtempSync(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'acv-')))
  dirs.push(dir)
  return dir
}

function certificates(pem: string): string[] {
  return pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? []
}

/** A hosted VM's seed as its executor's protectEnv leaves it, with microsandbox's CA and the guest bundle at files of this test's own. */
function msbSeed(dir: string): Record<string, string> {
  const msbFile = join(dir, 'msb-ca.pem')
  const guestBundle = join(dir, 'ca-certificates.crt')
  writeFileSync(msbFile, msbCa)
  // microsandbox adds its CA to the guest bundle beside the image's roots.
  writeFileSync(guestBundle, `${guestRootCa.trim()}\n${msbCa.trim()}\n`)
  const runtime = { command: 'dsh-acp', args: [], env: [] } as unknown as RuntimeDef
  const env: Record<string, string> = {}
  microsandboxCredentialStep('dsh-acp', runtime, { HOME: dir, DEEPSEEK_API_KEY: 'example-key' }).protectEnv(env)
  const local: Record<string, string> = {
    '/.msb/tls/ca.pem': msbFile,
    '/etc/ssl/certs/ca-certificates.crt': guestBundle
  }
  for (const name of PROXY_TRUST_VARS) if (env[name]) env[name] = local[env[name]] ?? env[name]
  expect(env.NODE_EXTRA_CA_CERTS).toBe(msbFile)
  expect(env.SSL_CERT_FILE).toBe(guestBundle)
  return env
}

describe("a hosted VM launch's switch to its shim's codehost listener", () => {
  const base = { command: 'x', args: [], env: { AC_AGENT_ID: 'agent-a' } }

  it('includes the shim and seed authorities in its listener bundle before any runtime starts', () => {
    const dir = shortDir()
    const ownCa = join(dir, 'own-ca.pem')
    const seededCa = join(dir, 'seeded-ca.pem')
    const bundlePath = join(dir, 'codehost-trust.pem')
    writeFileSync(ownCa, msbCa)
    writeFileSync(seededCa, guestRootCa)
    writeCodehostTrustBundle(bundlePath, [proxyCa], {
      GIT_SSL_CAINFO: ownCa,
      [SHIM_SEED_ENV]: JSON.stringify({ NODE_EXTRA_CA_CERTS: seededCa })
    })
    const bundle = readFileSync(bundlePath, 'utf8')
    for (const pem of [proxyCa, msbCa, guestRootCa, getCACertificates('default')[0]!])
      expect(bundle).toContain(pem.trim())
  })

  it('names no trust file of its own and asks the shim to keep those its seed names', () => {
    const launch = applyProxySpawn({ ...base, codehost: OVERLAY }, { codehost: LISTENER })
    expect(launch.env).toMatchObject({
      ...OVERLAY.env,
      HTTPS_PROXY: 'http://codehost:listener-token-example@127.0.0.1:41234',
      NODE_USE_ENV_PROXY: '1'
    })
    for (const name of PROXY_TRUST_VARS) expect(launch.env[name]).toBe(LISTENER.trustBundle)
    expect(JSON.parse(launch.env[SESSION_TRUST_ENV]!)).toEqual({
      bundle: LISTENER.trustBundle,
      files: [],
      guest: true
    })
    expect(launch.files).toBeUndefined()
  })

  it('leaves the session without a credential where the shim reported no listener', () => {
    expect(applyProxySpawn({ ...base, codehost: OVERLAY }, {})).toEqual(base)
  })

  it.skipIf(process.platform === 'win32')(
    'merges the seeded files into the listener bundle only when the launch asks',
    async () => {
      const dir = shortDir()
      const seed = msbSeed(dir)
      const host = new TunnelHost({ emit: () => undefined, socketPathFor: (tunnel) => join(dir, `${tunnel}.sock`) })
      closers.push(() => host.close())
      const listening = (await host.handle({ op: 'listen', tunnel: 'codehost', routes: ROUTES, ca: proxyCa })) as {
        proxy: { trustBundle: string; port: number; token: string }
        guestTrust?: boolean
      }
      expect(listening.guestTrust).toBe(true)
      const launch = applyProxySpawn({ ...base, codehost: OVERLAY }, { codehost: listening.proxy })
      // What the guest shim does before exec, its seed beneath the holder's env.
      const env = { ...seed, ...launch.env }
      applySessionTrust(env, () => undefined, seed)
      expect(env[SESSION_TRUST_ENV]).toBeUndefined()
      expect(env.SSL_CERT_FILE).not.toBe(listening.proxy.trustBundle)
      for (const name of PROXY_TRUST_VARS) expect(env[name]).toBe(env.SSL_CERT_FILE)
      const bundle = readFileSync(env.SSL_CERT_FILE!, 'utf8')
      for (const pem of [msbCa, guestRootCa, proxyCa]) expect(bundle).toContain(certificates(pem)[0])

      // A launch that does not ask keeps the listener bundle, whatever the seed names.
      const unasked = applyProxySpawn(
        { ...base, codehost: { ...OVERLAY, guestTrust: false } },
        { codehost: listening.proxy }
      )
      const plain = { ...seed, ...unasked.env }
      applySessionTrust(plain, () => undefined, seed)
      expect(plain.SSL_CERT_FILE).toBe(listening.proxy.trustBundle)
    }
  )
})

describe('a hosted VM session through its guest shim', () => {
  async function fixture(extraTunnels: Array<'codehost'>) {
    const root = shortDir()
    const sockets = { mcp: join(root, 'mcp.sock'), agent: join(root, 'gc.sock'), codehost: join(root, 'ch.sock') }
    const servers: Server[] = [
      await daemonSocket(sockets.mcp, 'mcp'),
      await daemonSocket(sockets.agent, 'agent'),
      await daemonSocket(sockets.codehost, 'codehost')
    ]
    const seed = msbSeed(root)
    const vm = fakeVm({ mcp: join(root, 'g', 'mcp.sock'), agent: join(root, 'g', 'gc.sock') }, { seedEnv: seed })
    const fake = fakeVmManager({ vm })
    const local = new LocalExecutor({
      launcher: microsandboxLauncher({ manager: () => fake.manager }),
      generations: { nextSandboxGeneration: async () => 1 },
      tunnelSocketPath: (tunnel) => (tunnel === 'provider' ? undefined : sockets[tunnel]),
      extraTunnelsFor: () => extraTunnels,
      tunnelListenOptions: (_agentId, tunnel) => (tunnel === 'codehost' ? { routes: ROUTES, ca: proxyCa } : undefined),
      log: quiet
    })
    const environment: EnvironmentDescriptor = { id: 'agent-a/session-example', mounts: [], workspaceRoot: root }
    closers.push(
      ...servers.map((server) => () => server.close()),
      () => vm.close(),
      () => fake.stop(),
      () => local.stop()
    )
    // The holder's launch names none of the seeded trust files: they are its executor's.
    const launch = () =>
      local.driverFor(environment).launch({
        command: process.execPath,
        args: ['-e', REPORTER],
        env: { AC_AGENT_ID: 'agent-a', PATH: process.env.PATH ?? '', GIT_CONFIG_GLOBAL: '/session.gitconfig' },
        codehost: OVERLAY
      })
    return { launch, seed }
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
    'starts the runtime on the proxy with the placeholder, its bundle keeping the seeded CA and roots beside the proxy CA',
    async () => {
      const { launch } = await fixture(['codehost'])
      const env = await reported(await launch())
      expect(env.HTTPS_PROXY).toMatch(/^http:\/\/codehost:[^@]+@127\.0\.0\.1:\d+$/)
      expect(env.AC_CODEHOST_CREDENTIAL).toBe('placeholder-example')
      expect(env.GH_TOKEN).toBe('placeholder-example')
      expect(env.GIT_CONFIG_GLOBAL).toBe('/session.gitconfig')
      expect(env[SESSION_TRUST_ENV]).toBeUndefined()
      for (const name of PROXY_TRUST_VARS) expect(env[name]).toBe(env.SSL_CERT_FILE)
      const bundle = readFileSync(env.SSL_CERT_FILE!, 'utf8')
      for (const pem of [msbCa, guestRootCa, proxyCa]) expect(bundle).toContain(certificates(pem)[0])
    }
  )

  it.skipIf(process.platform === 'win32')(
    'holds no placeholder and keeps the seeded trust where its shim serves no codehost listener',
    async () => {
      const { launch, seed } = await fixture([])
      const env = await reported(await launch())
      expect(env.HTTPS_PROXY).toBeUndefined()
      expect(env.AC_CODEHOST_CREDENTIAL).toBeUndefined()
      expect(env.GIT_CONFIG_GLOBAL).toBe('/session.gitconfig')
      expect(env.NODE_EXTRA_CA_CERTS).toBe(seed.NODE_EXTRA_CA_CERTS)
      expect(env.SSL_CERT_FILE).toBe(seed.SSL_CERT_FILE)
    }
  )
})

// The holder's side, as the daemon itself composes a placed VM session's launch.
const GITHUB_AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SESSION_KEY = 'slack:T1:C1:1700000000.000100'
const RUNTIME_ROOT = '/run/agentconnect'

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
      runtimes: { claude: { command: 'node', args: ['claude-agent-acp'] } },
      features: { credentialProxy: true }
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

/** The executor plane as a placed session's holder sees it before its shim is bound. */
function placedOn(d: any, agent: any, strategy: string): void {
  const placed = {
    agentId: agent.id,
    sessionKey: SESSION_KEY,
    leaf: 'leaf-example',
    subject: `${agent.id}/session-example`,
    executorDaemonId: 'executor-example',
    strategy
  }
  d.executorPlane = {
    placementOf: (key: string) => (key === SESSION_KEY ? placed : undefined),
    homeFor: () => '/home/agent',
    rootsFor: () => ({ runtimeRoot: RUNTIME_ROOT, missingHelpers: [] }),
    codexStateFor: () => undefined,
    runtimeDefFor: () => undefined,
    codehostProxyFor: () => undefined,
    srtCodehostFor: () => undefined,
    spawnFor: () => ({})
  }
}

function launch(d: any, agent: any, strategy: string) {
  const { host } = d.buildAcpHost(agent, d.cfg, {
    hostKey: sessionHostKey(agent.id, SESSION_KEY),
    strategy,
    cwd: agent.workspace.path
  })
  return host.opts as { env: Record<string, string>; codehost?: CodehostSpawn }
}

// Unix sockets carry the proxy, which Windows never runs.
describe.skipIf(process.platform === 'win32')('the holder of an executor-placed VM session', () => {
  it('asks its shim for codehost, never for provider', async () => {
    const { d, agent, stop } = await holder()
    try {
      const placed = { agentId: agent.id, sessionKey: SESSION_KEY, strategy: 'microsandbox' }
      expect(d.tunnelsForPlaced(agent.id, placed)).toEqual(['mcp', 'agent', 'codehost'])
    } finally {
      await stop()
    }
  })

  it('hands the launch the placeholder as the switch its shim keeps the seeded trust under', async () => {
    const { d, agent, stop } = await holder()
    try {
      placedOn(d, agent, 'microsandbox')
      const { env, codehost } = launch(d, agent, 'microsandbox')
      // No code-host credential until the bound shim reports its listener.
      expect(env.AC_CODEHOST_CREDENTIAL).toBeUndefined()
      expect(env.GH_TOKEN).toBeUndefined()
      expect(env.HTTPS_PROXY).toBeUndefined()
      expect(codehost?.guestTrust).toBe(true)
      const placeholder = codehost!.env.AC_CODEHOST_CREDENTIAL!
      expect(placeholder).toMatch(/^acph1_/)
      expect(codehost!.env.GH_TOKEN).toBe(placeholder)
      // The one session gitconfig, in the VM at the roots its executor reported, already presents the placeholder.
      expect(env.GIT_CONFIG_GLOBAL).toBe(`${RUNTIME_ROOT}/git/${agent.id}.gitconfig`)
      expect(codehost!.env.GIT_CONFIG_GLOBAL).toBeUndefined()
      for (const name of PROXY_TRUST_VARS) expect(codehost!.env[name]).toBeUndefined()

      const switched = applyProxySpawn({ command: 'x', args: [], env, codehost }, { codehost: LISTENER })
      expect(switched.env.AC_CODEHOST_CREDENTIAL).toBe(placeholder)
      expect(JSON.parse(switched.env[SESSION_TRUST_ENV]!)).toMatchObject({ bundle: LISTENER.trustBundle, guest: true })
      expect(JSON.stringify(switched)).not.toMatch(/ghs_/)
    } finally {
      await stop()
    }
  })

  it('switches no host session placed on an executor at spawn, which its shim listener routes at launch', async () => {
    const { d, agent, stop } = await holder()
    try {
      placedOn(d, agent, 'host')
      expect(launch(d, agent, 'host').codehost).toBeUndefined()
    } finally {
      await stop()
    }
  })
})
