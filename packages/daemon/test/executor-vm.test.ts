import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hostedEnvironment, microsandboxLauncher } from '../src/execution/executor-vm.js'
import type { StrategyLauncher } from '../src/execution/strategies.js'
import type { Logger } from '../src/log.js'
import type { MicrosandboxEnvironment, MicrosandboxManager } from '../src/microsandbox/driver.js'
import { DEFAULT_SHIM_RUNTIME_ROOT } from '../src/shim/sandbox-paths.js'

const LEAF = 'session-0123456789abcdef01234567'
const KEY = 'fixture-executor-deepseek-key'
const DSH = { 'dsh-acp': { command: 'dsh-acp', args: [], env: [] } }
const quiet = { trace() {}, debug() {}, info() {}, warn() {}, error() {} }

/** The manager with its VMs stubbed out: what it was asked to prepare, stop and discard. */
function stubManager() {
  const prepared: MicrosandboxEnvironment[] = []
  const suspended: string[] = []
  const discarded: string[] = []
  const guest = {
    connect: vi.fn(async () => new PassThrough()),
    token: 't',
    exited: new Promise<void>(() => {}),
    stop: vi.fn()
  }
  const manager = {
    prepareEnvironment: async (environment: MicrosandboxEnvironment) => void prepared.push(environment),
    guestShim: (id: string) => (prepared.some((environment) => environment.id === id) ? guest : undefined),
    suspend: async (id: string) => void suspended.push(id),
    discard: async (id: string) => void discarded.push(id)
  } as unknown as MicrosandboxManager
  return { manager, guest, prepared, suspended, discarded }
}

/** What the facet does for a hosted prepare: the launcher's own seed into the session HOME, then the environment built from the leaf. */
async function startHosted(launcher: StrategyLauncher, root: string, log: Logger = quiet) {
  const seed = await launcher.seedHome!(join(root, 'sessions', LEAF, 'home'), log)
  return launcher.start({ environment: hostedEnvironment(root, LEAF, seed), log })
}

/** Every regular file under a directory, as text: what a guest mounting it could read. */
function filesUnder(directory: string): string[] {
  return readdirSync(directory, { recursive: true, encoding: 'utf8' })
    .map((path) => join(directory, path))
    .filter((path) => lstatSync(path).isFile())
    .map((path) => readFileSync(path, 'utf8'))
}

describe('the microsandbox strategy launcher', () => {
  let root: string | undefined
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true })
    root = undefined
  })

  it("starts a VM over the session directory, seeding its HOME itself, and names the image's roots", async () => {
    root = await mkdtemp(join(tmpdir(), 'ac-xv-'))
    const { manager, guest, prepared, suspended, discarded } = stubManager()
    const launcher = microsandboxLauncher({ manager: () => manager, runtimes: () => ({}), hostEnv: { HOME: root } })
    // The facet's plain seed would copy raw sign-in files; this launcher seeds with its credentials protected (§8).
    expect(launcher.seedHome).toBeTypeOf('function')
    const environment = await startHosted(launcher, root)

    const directory = join(root, 'sessions', LEAF)
    expect(prepared).toEqual([
      {
        id: `executor/${LEAF}`,
        workspaceRoot: directory,
        mounts: [{ source: directory, target: directory, mode: 'writable' }],
        hosted: { env: {} }
      }
    ])
    for (const leaf of ['workspace', 'repos', 'home']) expect(statSync(join(directory, leaf)).isDirectory()).toBe(true)
    // Inside a VM the shim owns its filesystem namespace: the image's roots, no helper root, nothing missing (§5).
    expect(environment.runtimeRoot).toBe(DEFAULT_SHIM_RUNTIME_ROOT)
    expect(environment.helperRoot).toBeUndefined()
    expect(environment.missingHelpers).toEqual([])

    // The pipe reaches the guest shim through the connector, never through a path.
    await environment.connect()
    expect(guest.connect).toHaveBeenCalledOnce()
    // Idle stops the VM and keeps its disks; a release takes the VM and its disks.
    await environment.stop()
    expect(suspended).toEqual([`executor/${LEAF}`])
    // Found by the environment's id, which is all a release or the backstop has once the VM is gone from memory.
    await launcher.discard!(`executor/${LEAF}`)
    expect(discarded).toEqual([`executor/${LEAF}`])
  })

  // session-executors.md §8, §11 step 2: the preparers a local VM runs, against this machine's own environment.
  it("fixes the executor's own provider key as a placeholder secret at start, never a value the guest can read", async () => {
    root = await mkdtemp(join(tmpdir(), 'ac-xv-'))
    const { manager, prepared } = stubManager()
    const launcher = microsandboxLauncher({
      manager: () => manager,
      runtimes: () => DSH,
      hostEnv: { HOME: join(root, 'machine'), DEEPSEEK_API_KEY: KEY }
    })
    await startHosted(launcher, root)

    const [environment] = prepared
    expect(environment!.secrets).toEqual([
      {
        env: 'DEEPSEEK_API_KEY',
        placeholder: 'msb-secret-DEEPSEEK_API_KEY',
        host: 'api.deepseek.com',
        readValue: expect.any(Function)
      }
    ])
    // The value stays host-side, for the driver to hand the VM when it creates or starts it.
    expect(environment!.secrets![0]!.readValue()).toBe(KEY)
    // What the guest is given: the placeholder and the proxy's CA, filled in beneath the holder's env.
    expect(environment!.hosted!.env).toEqual({
      DEEPSEEK_API_KEY: 'msb-secret-DEEPSEEK_API_KEY',
      NODE_EXTRA_CA_CERTS: '/.msb/tls/ca.pem',
      SSL_CERT_FILE: '/etc/ssl/certs/ca-certificates.crt',
      REQUESTS_CA_BUNDLE: '/etc/ssl/certs/ca-certificates.crt',
      CURL_CA_BUNDLE: '/etc/ssl/certs/ca-certificates.crt'
    })
    expect(JSON.stringify(prepared)).not.toContain(KEY)
    for (const text of filesUnder(join(root, 'sessions', LEAF))) expect(text).not.toContain(KEY)
  })

  it("protects a key configured in the executor's runtime definition as a local VM launch does", async () => {
    root = await mkdtemp(join(tmpdir(), 'ac-xv-'))
    const { manager, prepared } = stubManager()
    const launcher = microsandboxLauncher({
      manager: () => manager,
      runtimes: () => ({
        'dsh-acp': { command: 'dsh-acp', args: [], env: [{ name: 'DEEPSEEK_API_KEY', value: KEY }] }
      }),
      hostEnv: { HOME: join(root, 'machine') }
    })
    await startHosted(launcher, root)

    expect(prepared[0]!.secrets!.map((secret) => [secret.env, secret.readValue()])).toEqual([['DEEPSEEK_API_KEY', KEY]])
    expect(prepared[0]!.hosted!.env.DEEPSEEK_API_KEY).toBe('msb-secret-DEEPSEEK_API_KEY')
    expect(JSON.stringify(prepared)).not.toContain(KEY)
  })

  it("fills in the executor's own environment key a preparer does not protect, as a local VM on it inherits one", async () => {
    root = await mkdtemp(join(tmpdir(), 'ac-xv-'))
    const { manager, prepared } = stubManager()
    const launcher = microsandboxLauncher({
      manager: () => manager,
      runtimes: () => ({ 'claude-acp': { command: 'claude-agent-acp', args: [], env: [] } }),
      hostEnv: { HOME: join(root, 'machine'), ANTHROPIC_API_KEY: 'fixture-executor-env-key' }
    })
    await startHosted(launcher, root)

    // Claude's placeholder covers its saved login; an environment-only key reaches a local VM as its value, and so a hosted one.
    expect(prepared[0]!.secrets).toBeUndefined()
    // Linux also seeds the shared sign-in's pointer beside it, so only the key is asserted.
    expect(prepared[0]!.hosted!.env.ANTHROPIC_API_KEY).toBe('fixture-executor-env-key')
    expect(prepared[0]!.hosted!.env.NODE_EXTRA_CA_CERTS).toBeUndefined()
  })

  it.skipIf(process.platform !== 'linux')(
    'projects a sign-in file into the hosted HOME with the placeholder, and mounts none of the host copy',
    async () => {
      root = await mkdtemp(join(tmpdir(), 'ac-xv-'))
      const machine = join(root, 'machine')
      const content = `DEEPSEEK_API_KEY: ${KEY}\nOPENROUTER_API_KEY: fixture-other-provider\n`
      mkdirSync(join(machine, '.dsh'), { recursive: true })
      writeFileSync(join(machine, '.dsh', '.credentials.yaml'), content)
      const { manager, prepared } = stubManager()
      const launcher = microsandboxLauncher({ manager: () => manager, runtimes: () => DSH, hostEnv: { HOME: machine } })
      await startHosted(launcher, root)

      const directory = join(root, 'sessions', LEAF)
      const projected = readFileSync(join(directory, 'home', '.dsh', '.credentials.yaml'), 'utf8')
      expect(projected).toContain('msb-secret-DEEPSEEK_API_KEY')
      expect(projected).toContain('fixture-other-provider')
      expect(projected).not.toContain(KEY)
      for (const text of filesUnder(directory)) expect(text).not.toContain(KEY)
      expect(prepared[0]!.secrets![0]!.readValue()).toBe(KEY)
      expect(prepared[0]!.mounts.map(({ source }) => source)).toEqual([directory])
      // The executor's own file is read, never rewritten.
      expect(readFileSync(join(machine, '.dsh', '.credentials.yaml'), 'utf8')).toBe(content)
    }
  )

  it('refuses a runtime whose credentials it cannot protect rather than seeding it plainly, and seeds the others', async () => {
    root = await mkdtemp(join(tmpdir(), 'ac-xv-'))
    const machine = join(root, 'machine')
    mkdirSync(join(machine, '.codex'), { recursive: true })
    writeFileSync(join(machine, '.codex', 'config.toml'), 'model = "example"\n')
    writeFileSync(join(machine, '.codex', 'auth.json'), '{"last_refresh":"2026-01-01T00:00:00Z"}\n')
    const warnings: string[] = []
    const { manager, prepared } = stubManager()
    const launcher = microsandboxLauncher({
      manager: () => manager,
      runtimes: () => ({ ...DSH, 'codex-acp': { command: 'codex-acp', args: [], env: [] } }),
      // A custom trust bundle would displace the proxy's CA, so protection refuses it as a local VM launch does.
      hostEnv: { HOME: machine, DEEPSEEK_API_KEY: KEY, NODE_EXTRA_CA_CERTS: '/operator/ca.pem' }
    })
    await startHosted(launcher, root, { ...quiet, warn: (line: string) => void warnings.push(line) })

    expect(warnings).toEqual([expect.stringMatching(/no dsh-acp sign-in .*custom TLS trust/)])
    expect(prepared[0]!.secrets).toBeUndefined()
    expect(prepared[0]!.hosted!.env.DEEPSEEK_API_KEY).toBeUndefined()
    expect(JSON.stringify(prepared)).not.toContain(KEY)
    expect(readFileSync(join(root, 'sessions', LEAF, 'home', '.codex', 'config.toml'), 'utf8')).toBe(
      'model = "example"\n'
    )
  })

  // The first use adopts the image's runtime table, so a seed taken before it would miss an image-only runtime's sign-in.
  it('prepares the image before it seeds, so a runtime the image table adds is seeded with its credentials', async () => {
    root = await mkdtemp(join(tmpdir(), 'ac-xv-'))
    const { manager, prepared } = stubManager()
    const admitted: Record<string, (typeof DSH)['dsh-acp']> = {}
    const order: string[] = []
    const launcher = microsandboxLauncher({
      manager: () => manager,
      runtimes: () => {
        order.push('runtimes')
        return admitted
      },
      hostEnv: { HOME: join(root, 'machine'), DEEPSEEK_API_KEY: KEY },
      ready: async () => {
        order.push('ready')
        Object.assign(admitted, DSH)
      }
    })
    await startHosted(launcher, root)

    expect(order.slice(0, 2)).toEqual(['ready', 'runtimes'])
    expect(prepared[0]!.secrets!.map((secret) => secret.env)).toEqual(['DEEPSEEK_API_KEY'])
    expect(prepared[0]!.hosted!.env.DEEPSEEK_API_KEY).toBe('msb-secret-DEEPSEEK_API_KEY')
  })

  it('refuses on a machine that runs no microsandbox backend, writes no HOME, and discards nothing there', async () => {
    root = await mkdtemp(join(tmpdir(), 'ac-xv-'))
    const launcher = microsandboxLauncher({ manager: () => undefined, runtimes: () => DSH, hostEnv: { HOME: root } })
    const home = join(root, 'sessions', LEAF, 'home')
    await expect(launcher.seedHome!(home, quiet)).rejects.toThrow(/no microsandbox backend/)
    expect(existsSync(home)).toBe(false)
    await expect(launcher.start({ environment: hostedEnvironment(root, LEAF), log: quiet })).rejects.toThrow(
      /no microsandbox backend/
    )
    await expect(launcher.discard!(`executor/${LEAF}`)).resolves.toBeUndefined()
  })
})
