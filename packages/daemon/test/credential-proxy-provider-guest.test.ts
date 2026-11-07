import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:net'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { generateCa } from '@anthropic-ai/sandbox-runtime'
import type { CodehostSpawn, ProviderSpawn, SpawnedRuntime, SpawnRequest } from '../src/acp/spawn-driver.js'
import { CODEX_CA_ENV, SESSION_TRUST_ENV } from '../src/credential-proxy/trust-bundle.js'
import { microsandboxLauncher } from '../src/execution/executor-vm.js'
import { LocalExecutor } from '../src/execution/local-executor.js'
import type { EnvironmentDescriptor } from '../src/execution/strategies.js'
import { applyProxySpawn, codehostProxyUrl } from '../src/remote/codehost-spawn.js'
import type { TunnelName } from '../src/shim/tunnel.js'
import { daemonSocket, fakeVm, fakeVmManager } from './fixtures/microsandbox-vm.js'

// A VM or executor session's organization Provider key: the placeholder swapped in at spawn, only when its own shim reports a provider listener.

const quiet = { trace() {}, debug() {}, info() {}, warn() {}, error() {} }
const REPORTER = `process.stdout.write(JSON.stringify({ env: process.env }) + '\\n'); process.stdin.resume()`
const REAL_KEY = 'sk-example-real'
const PLACEHOLDER = 'acph1_example-placeholder'
const PROVIDER: ProviderSpawn = { env: { ANTHROPIC_API_KEY: PLACEHOLDER, ANTHROPIC_CUSTOM_HEADERS: '' } }
const CODEHOST: CodehostSpawn = { env: { AC_CODEHOST_CREDENTIAL: 'placeholder-example' } }
const LISTENER = { port: 41_234, token: 'listener-token-example', trustBundle: '/run/agentconnect/codehost-trust.pem' }
const URL = codehostProxyUrl(LISTENER)

let proxyCa = ''
beforeAll(() => {
  proxyCa = generateCa({ cn: 'example proxy CA' }).certPem
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

/** Short, so each socket fits AF_UNIX on a host whose temp directory is long. */
function shortDir(): string {
  const dir = realpathSync(mkdtempSync('/tmp/acpg-'))
  dirs.push(dir)
  return dir
}

describe('applying a launch provider env at spawn', () => {
  const base: SpawnRequest = {
    command: 'x',
    args: [],
    env: { AC_AGENT_ID: 'agent-a', ANTHROPIC_API_KEY: REAL_KEY, ANTHROPIC_CUSTOM_HEADERS: 'x-workspace: example' }
  }

  it('swaps the placeholder in and points the session at its shim listener, Codex’s bundle included', () => {
    const launch = applyProxySpawn({ ...base, provider: PROVIDER }, { provider: LISTENER })
    expect(launch.provider).toBeUndefined()
    expect(launch.env).toMatchObject({
      ANTHROPIC_API_KEY: PLACEHOLDER,
      ANTHROPIC_CUSTOM_HEADERS: '',
      HTTPS_PROXY: URL,
      https_proxy: URL,
      NODE_USE_ENV_PROXY: '1',
      SSL_CERT_FILE: LISTENER.trustBundle,
      [CODEX_CA_ENV]: LISTENER.trustBundle
    })
    expect(JSON.stringify(launch)).not.toContain(REAL_KEY)
  })

  it('keeps the real key when the shim reported no provider listener, or the launch names a proxy of its own', () => {
    expect(applyProxySpawn({ ...base, provider: PROVIDER }, {})).toEqual(base)
    // A codehost listener alone does not carry the key.
    expect(applyProxySpawn({ ...base, provider: PROVIDER }, { codehost: LISTENER }).env.ANTHROPIC_API_KEY).toBe(
      REAL_KEY
    )
    const own = { ...base, env: { ...base.env, HTTPS_PROXY: 'http://egress.example.test:3128' } }
    expect(applyProxySpawn({ ...own, provider: PROVIDER }, { provider: LISTENER })).toEqual(own)
  })

  it('applies codehost and provider together on one listener, so the session has a single HTTPS_PROXY', () => {
    const launch = applyProxySpawn(
      { ...base, codehost: CODEHOST, provider: PROVIDER },
      { codehost: LISTENER, provider: LISTENER }
    )
    expect(launch.env).toMatchObject({ ...CODEHOST.env, ...PROVIDER.env, HTTPS_PROXY: URL, https_proxy: URL })
    // A provider listener other than the one the session is pointed at is not used.
    const other = applyProxySpawn(
      { ...base, codehost: CODEHOST, provider: PROVIDER },
      { codehost: LISTENER, provider: { ...LISTENER, port: 41_235 } }
    )
    expect(other.env).toMatchObject({ ...CODEHOST.env, HTTPS_PROXY: URL, ANTHROPIC_API_KEY: REAL_KEY })
  })

  it('adds the key to an executor session already routed through that listener, keeping its trust request', () => {
    const routed = {
      ...base,
      env: {
        ...base.env,
        HTTPS_PROXY: URL,
        SSL_CERT_FILE: LISTENER.trustBundle,
        [CODEX_CA_ENV]: '/home/agent/codex-ca.pem',
        [SESSION_TRUST_ENV]: JSON.stringify({ bundle: LISTENER.trustBundle, files: ['/home/agent/service-ca.pem'] })
      }
    }
    const launch = applyProxySpawn({ ...routed, provider: PROVIDER }, { provider: LISTENER })
    expect(launch.env).toMatchObject({ ANTHROPIC_API_KEY: PLACEHOLDER, HTTPS_PROXY: URL })
    expect(launch.env.NODE_USE_ENV_PROXY).toBeUndefined()
    expect(launch.env[CODEX_CA_ENV]).toBe(LISTENER.trustBundle)
    expect(JSON.parse(launch.env[SESSION_TRUST_ENV]!)).toEqual({
      bundle: LISTENER.trustBundle,
      files: ['/home/agent/service-ca.pem', '/home/agent/codex-ca.pem']
    })
  })
})

describe('a local VM session through its shim provider listener', () => {
  async function fixture(options: { refuse?: string[] } = {}) {
    const root = shortDir()
    const sockets = { mcp: join(root, 'mcp.sock'), agent: join(root, 'gc.sock'), provider: join(root, 'pv.sock') }
    const servers: Server[] = [
      await daemonSocket(sockets.mcp, 'mcp'),
      await daemonSocket(sockets.agent, 'agent'),
      await daemonSocket(sockets.provider, 'provider')
    ]
    writeFileSync(join(root, 'proxy-ca.pem'), proxyCa)
    const vm = fakeVm(
      { mcp: join(root, 'g', 'mcp.sock'), agent: join(root, 'g', 'gc.sock') },
      options.refuse ? { refuseTunnels: options.refuse } : {}
    )
    const fake = fakeVmManager({ vm })
    // The slot is registered as the launch is built, after the environment's first bind.
    const extra: TunnelName[] = []
    const listens = vi.fn()
    const local = new LocalExecutor({
      launcher: microsandboxLauncher({ manager: () => fake.manager }),
      generations: { nextSandboxGeneration: async () => 1 },
      tunnelSocketPath: (tunnel) => (tunnel === 'codehost' ? undefined : sockets[tunnel]),
      extraTunnelsFor: () => extra,
      tunnelListenOptions: (_agentId, tunnel) => {
        listens(tunnel)
        return tunnel === 'provider' ? { routes: ['api.anthropic.com:443'], ca: proxyCa } : undefined
      },
      log: quiet
    })
    const environment: EnvironmentDescriptor = { id: 'agent-a/session-example', mounts: [], workspaceRoot: root }
    closers.push(
      ...servers.map((server) => () => server.close()),
      () => vm.close(),
      () => fake.stop(),
      () => local.stop()
    )
    const launch = () =>
      local.driverFor(environment).launch({
        command: process.execPath,
        args: ['-e', REPORTER],
        env: { AC_AGENT_ID: 'agent-a', PATH: process.env.PATH ?? '', ANTHROPIC_API_KEY: REAL_KEY },
        provider: PROVIDER
      })
    return { launch, listens, extra, local, environment }
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
    'asks a bound shim for the provider listener at spawn and starts the runtime with the placeholder',
    async () => {
      const { launch, listens, extra, local, environment } = await fixture()
      // Bound before the agent had a slot, as a VM serving an earlier session was.
      await local.withEnvironment(environment, async () => undefined)
      expect(listens).not.toHaveBeenCalledWith('provider')
      extra.push('provider')
      const env = await reported(await launch())
      expect(listens).toHaveBeenCalledWith('provider')
      expect(env.ANTHROPIC_API_KEY).toBe(PLACEHOLDER)
      expect(env.HTTPS_PROXY).toMatch(/^http:\/\/codehost:[^@]+@127\.0\.0\.1:\d+$/)
      expect(env[CODEX_CA_ENV]).toBe(env.SSL_CERT_FILE)
      expect(JSON.stringify(env)).not.toContain(REAL_KEY)
    }
  )

  it.skipIf(process.platform === 'win32')('keeps the real key for an agent with no provider slot', async () => {
    const { launch, listens } = await fixture()
    const env = await reported(await launch())
    expect(listens).not.toHaveBeenCalledWith('provider')
    expect(env.ANTHROPIC_API_KEY).toBe(REAL_KEY)
    expect(env.HTTPS_PROXY).toBeUndefined()
  })

  it.skipIf(process.platform === 'win32')(
    'keeps the real key on a shim that predates the provider tunnel and refuses its listen',
    async () => {
      const { launch, listens, extra } = await fixture({ refuse: ['provider'] })
      extra.push('provider')
      const env = await reported(await launch())
      expect(listens).toHaveBeenCalledWith('provider')
      expect(env.ANTHROPIC_API_KEY).toBe(REAL_KEY)
      expect(env.HTTPS_PROXY).toBeUndefined()
    }
  )
})
