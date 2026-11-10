import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { generateCa } from '@anthropic-ai/sandbox-runtime'
import type { CodehostSpawn, SpawnedRuntime } from '../src/acp/spawn-driver.js'
import type { RuntimeDef } from '../src/config/config-schema.js'
import { microsandboxLauncher } from '../src/execution/executor-vm.js'
import { LocalExecutor } from '../src/execution/local-executor.js'
import type { EnvironmentDescriptor } from '../src/execution/strategies.js'
import { applySessionTrust, SESSION_TRUST_ENV } from '../src/credential-proxy/trust-bundle.js'
import { microsandboxCredentialStep } from '../src/microsandbox/secrets.js'
import { applyProxySpawn } from '../src/remote/codehost-spawn.js'
import { TunnelHost } from '../src/shim/tunnel-host.js'
import { TunnelProxy } from '../src/shim/tunnel-proxy.js'
import { daemonSocket, fakeVm, fakeVmManager } from './fixtures/microsandbox-vm.js'

// A VM or pool pod session's code-host route: its own shim's codehost listener, applied at spawn only when that shim reports one.

// A shim frame's cap, which a launch file or a listen must fit inside.
const MAX_FRAME_BYTES = 256 * 1024
const quiet = { trace() {}, debug() {}, info() {}, warn() {}, error() {} }
const REPORTER = `process.stdout.write(JSON.stringify({ env: process.env }) + '\\n'); process.stdin.resume()`
const ROUTES = ['github.com:443', 'api.github.com:443']
const OVERLAY: CodehostSpawn = {
  env: {
    AC_CODEHOST_CREDENTIAL: 'placeholder-example',
    GH_TOKEN: 'placeholder-example'
  }
}

let proxyCa = ''
let msbCa = ''
let sessionCa = ''
beforeAll(() => {
  proxyCa = generateCa({ cn: 'example proxy CA' }).certPem
  msbCa = generateCa({ cn: 'example substitution CA' }).certPem
  sessionCa = generateCa({ cn: 'example private service CA' }).certPem
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
  const dir = realpathSync(mkdtempSync(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'acg-')))
  dirs.push(dir)
  return dir
}

/** A VM env with a protected provider key, as protectEnv leaves it. */
function protectedEnv(home: string): Record<string, string> {
  const runtime = { command: 'dsh-acp', args: [], env: [] } as unknown as RuntimeDef
  const env: Record<string, string> = {}
  microsandboxCredentialStep('dsh-acp', runtime, { HOME: home, DEEPSEEK_API_KEY: 'example-key' }).protectEnv(env)
  return env
}

function certificates(pem: string): string[] {
  return pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? []
}

const LISTENER = { port: 41_234, token: 'listener-token-example', trustBundle: '/run/agentconnect/codehost-trust.pem' }

describe('applying a launch codehost env at spawn', () => {
  const listener = LISTENER
  const base = { command: 'x', args: [], env: { AC_AGENT_ID: 'agent-a', NO_PROXY: 'internal.example.test' } }

  it('points the session at its shim listener with the placeholder and the shim bundle', () => {
    const launch = applyProxySpawn({ ...base, codehost: OVERLAY }, { codehost: listener })
    expect(launch.codehost).toBeUndefined()
    expect(launch.env).toMatchObject({
      ...OVERLAY.env,
      HTTPS_PROXY: 'http://codehost:listener-token-example@127.0.0.1:41234',
      https_proxy: 'http://codehost:listener-token-example@127.0.0.1:41234',
      NO_PROXY: 'localhost,127.0.0.1,::1,internal.example.test',
      NODE_USE_ENV_PROXY: '1',
      SSL_CERT_FILE: listener.trustBundle,
      NODE_EXTRA_CA_CERTS: listener.trustBundle,
      GIT_SSL_CAINFO: listener.trustBundle
    })
    expect(launch.files).toBeUndefined()
    expect(launch.env[SESSION_TRUST_ENV]).toBeUndefined()
  })

  it('leaves the session without a credential when the shim reported no listener, or the launch names a proxy of its own', () => {
    expect(applyProxySpawn({ ...base, codehost: OVERLAY }, {})).toEqual(base)
    const own = { ...base, env: { ...base.env, HTTPS_PROXY: 'http://egress.example.test:3128' } }
    expect(applyProxySpawn({ ...own, codehost: OVERLAY }, { codehost: listener })).toEqual(own)
  })

  it('uses the filtered codehost bypass list over the inherited wildcard and retains loopback', () => {
    const launch = applyProxySpawn(
      {
        ...base,
        env: { ...base.env, NO_PROXY: '*', no_proxy: '*' },
        codehost: { ...OVERLAY, env: { ...OVERLAY.env, NO_PROXY: '' } }
      },
      { codehost: listener }
    )
    expect(launch.env.NO_PROXY).toBe('localhost,127.0.0.1,::1')
    expect(launch.env.no_proxy).toBe(launch.env.NO_PROXY)
  })

  it("appends the codehost's command-scope helper after the pairs the launch already carries", () => {
    const env = { ...base.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: '*' }
    const codehost = {
      env: {
        ...OVERLAY.env,
        GIT_CONFIG_COUNT: '2',
        GIT_CONFIG_KEY_0: 'credential.https://github.com.helper',
        GIT_CONFIG_VALUE_0: '',
        GIT_CONFIG_KEY_1: 'credential.https://github.com.helper',
        GIT_CONFIG_VALUE_1: '!placeholder'
      }
    }
    const launch = applyProxySpawn({ ...base, env, codehost }, { codehost: listener })
    expect(launch.env).toMatchObject({
      GIT_CONFIG_COUNT: '4',
      GIT_CONFIG_KEY_0: 'safe.directory',
      GIT_CONFIG_VALUE_0: '*',
      GIT_CONFIG_KEY_1: 'credential.https://github.com.helper',
      GIT_CONFIG_VALUE_1: '',
      GIT_CONFIG_KEY_2: 'credential.https://github.com.helper',
      GIT_CONFIG_VALUE_2: '!placeholder',
      // No machine helper is handed the listener's own credential.
      GIT_CONFIG_KEY_3: 'credential.http://127.0.0.1:41234.helper',
      GIT_CONFIG_VALUE_3: ''
    })
  })
})

describe('the shim trust bundle beside microsandbox and a session own authorities', () => {
  it('hands the shim the files protectEnv named, so the session keeps the substitution CA beside the proxy CA', () => {
    const env = protectedEnv(shortDir())
    const launch = applyProxySpawn({ command: 'x', args: [], env, codehost: OVERLAY }, { codehost: LISTENER })
    expect(launch.env.SSL_CERT_FILE).toBe(LISTENER.trustBundle)
    expect(launch.env.NODE_EXTRA_CA_CERTS).toBe(LISTENER.trustBundle)
    expect(JSON.parse(launch.env[SESSION_TRUST_ENV]!)).toEqual({
      bundle: LISTENER.trustBundle,
      files: [env.SSL_CERT_FILE, env.NODE_EXTRA_CA_CERTS]
    })
  })

  it.skipIf(process.platform === 'win32')(
    'merges them in the guest into the listener bundle, keeping its roots and the proxy CA',
    async () => {
      const dir = shortDir()
      const msbFile = join(dir, 'msb-ca.pem')
      const sessionFile = join(dir, 'service-ca.pem')
      writeFileSync(msbFile, msbCa)
      writeFileSync(sessionFile, sessionCa)
      const host = new TunnelHost({ emit: () => undefined, socketPathFor: (tunnel) => join(dir, `${tunnel}.sock`) })
      closers.push(() => host.close())
      const { proxy } = (await host.handle({ op: 'listen', tunnel: 'codehost', routes: ROUTES, ca: proxyCa })) as {
        proxy: { trustBundle: string; port: number; token: string }
      }
      const env = { NODE_EXTRA_CA_CERTS: msbFile, SSL_CERT_FILE: sessionFile, AC_AGENT_ID: 'agent-a' }
      const launch = applyProxySpawn({ command: 'x', args: [], env, codehost: OVERLAY }, { codehost: proxy })
      // What the guest shim does before exec.
      applySessionTrust(launch.env, () => undefined)
      expect(launch.env[SESSION_TRUST_ENV]).toBeUndefined()
      expect(launch.env.SSL_CERT_FILE).not.toBe(proxy.trustBundle)
      expect(launch.env.NODE_EXTRA_CA_CERTS).toBe(launch.env.SSL_CERT_FILE)
      const bundle = readFileSync(launch.env.SSL_CERT_FILE!, 'utf8')
      for (const pem of [msbCa, sessionCa, proxyCa]) expect(bundle).toContain(certificates(pem)[0])
    }
  )
})

describe('a local VM session through its shim codehost listener', () => {
  async function fixture(extraTunnels: Array<'codehost'>) {
    const root = shortDir()
    const sockets = { mcp: join(root, 'mcp.sock'), agent: join(root, 'gc.sock'), codehost: join(root, 'ch.sock') }
    const servers: Server[] = [
      await daemonSocket(sockets.mcp, 'mcp'),
      await daemonSocket(sockets.agent, 'agent'),
      await daemonSocket(sockets.codehost, 'codehost')
    ]
    const msbFile = join(root, 'msb-ca.pem')
    writeFileSync(msbFile, msbCa)
    const vm = fakeVm({ mcp: join(root, 'g', 'mcp.sock'), agent: join(root, 'g', 'gc.sock') })
    const fake = fakeVmManager({ vm })
    const listens = vi.fn()
    const local = new LocalExecutor({
      launcher: microsandboxLauncher({ manager: () => fake.manager }),
      generations: { nextSandboxGeneration: async () => 1 },
      tunnelSocketPath: (tunnel) => (tunnel === 'provider' ? undefined : sockets[tunnel]),
      extraTunnelsFor: () => extraTunnels,
      tunnelListenOptions: (_agentId, tunnel) => {
        listens(tunnel)
        return tunnel === 'codehost' ? { routes: ROUTES, ca: proxyCa } : undefined
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
        // The substitution authority stands at a file of its own, as protectEnv names microsandbox's.
        env: {
          AC_AGENT_ID: 'agent-a',
          PATH: process.env.PATH ?? '',
          GIT_CONFIG_GLOBAL: '/session.gitconfig',
          NODE_EXTRA_CA_CERTS: msbFile
        },
        codehost: OVERLAY
      })
    return { launch, listens }
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
    'starts the runtime on the proxy when the agent is intercepted, its bundle keeping the substitution CA',
    async () => {
      const { launch, listens } = await fixture(['codehost'])
      const env = await reported(await launch())
      expect(listens).toHaveBeenCalledWith('codehost')
      expect(env.HTTPS_PROXY).toMatch(/^http:\/\/codehost:[^@]+@127\.0\.0\.1:\d+$/)
      expect(env.AC_CODEHOST_CREDENTIAL).toBe('placeholder-example')
      expect(env.GIT_CONFIG_GLOBAL).toBe('/session.gitconfig')
      const bundle = readFileSync(env.SSL_CERT_FILE!, 'utf8')
      expect(bundle).toContain(certificates(msbCa)[0])
      expect(bundle).toContain(certificates(proxyCa)[0])
    }
  )

  it.skipIf(process.platform === 'win32')(
    'asks for no codehost tunnel and holds no placeholder for an agent the proxy does not intercept',
    async () => {
      const { launch, listens } = await fixture([])
      const env = await reported(await launch())
      expect(listens).not.toHaveBeenCalledWith('codehost')
      expect(env.HTTPS_PROXY).toBeUndefined()
      expect(env.AC_CODEHOST_CREDENTIAL).toBeUndefined()
      expect(env.GIT_CONFIG_GLOBAL).toBe('/session.gitconfig')
      expect(env.NODE_EXTRA_CA_CERTS).toMatch(/msb-ca\.pem$/)
    }
  )
})

describe('a pool pod codehost listen', () => {
  it('sends the proxy CA certificate alone in the listen, well under a frame, and an older shim refusing it serves none', async () => {
    const sent: unknown[] = []
    const refused = new TunnelProxy({
      session: {
        agentId: 'agent-a',
        request: async (_capability, payload) => {
          sent.push(payload)
          // An image shim from before `codehost` fails the name in its schema.
          throw new Error('Invalid enum value')
        },
        onEvent: () => undefined,
        offEvent: () => undefined,
        onAttach: () => undefined,
        offAttach: () => undefined,
        onLost: () => undefined
      },
      socketPathFor: () => '/tmp/none.sock',
      listenOptions: () => ({ routes: ROUTES, ca: proxyCa }),
      log: { info: () => {}, warn: () => {} }
    })
    closers.push(() => refused.stop('test over'))
    await expect(refused.ensure('codehost')).rejects.toThrow()
    expect(refused.listeningAt('codehost')).toBeUndefined()
    const payload = sent[0] as { ca: string }
    expect(certificates(payload.ca)).toHaveLength(1)
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThan(MAX_FRAME_BYTES / 8)
  })
})
