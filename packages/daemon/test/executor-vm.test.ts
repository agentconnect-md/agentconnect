import { lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { microsandboxLauncher } from '../src/execution/executor-vm.js'
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
    expect(launcher.seedsHome).toBe(true)
    const environment = await launcher.start({ daemonRoot: root, sessionLeaf: LEAF, log: quiet })

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
    await launcher.discard!(LEAF)
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
    await launcher.start({ daemonRoot: root, sessionLeaf: LEAF, log: quiet })

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
      await launcher.start({ daemonRoot: root, sessionLeaf: LEAF, log: quiet })

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
    await launcher.start({
      daemonRoot: root,
      sessionLeaf: LEAF,
      log: { ...quiet, warn: (line: string) => void warnings.push(line) }
    })

    expect(warnings).toEqual([expect.stringMatching(/no dsh-acp sign-in .*custom TLS trust/)])
    expect(prepared[0]!.secrets).toBeUndefined()
    expect(prepared[0]!.hosted!.env.DEEPSEEK_API_KEY).toBeUndefined()
    expect(JSON.stringify(prepared)).not.toContain(KEY)
    expect(readFileSync(join(root, 'sessions', LEAF, 'home', '.codex', 'config.toml'), 'utf8')).toBe(
      'model = "example"\n'
    )
  })

  it('refuses on a machine that runs no microsandbox backend, and discards nothing there', async () => {
    root = await mkdtemp(join(tmpdir(), 'ac-xv-'))
    const launcher = microsandboxLauncher({ manager: () => undefined })
    await expect(launcher.start({ daemonRoot: root, sessionLeaf: LEAF, log: quiet })).rejects.toThrow(
      /no microsandbox backend/
    )
    await expect(launcher.discard!(LEAF)).resolves.toBeUndefined()
  })
})
