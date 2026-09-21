import { statSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { microsandboxLauncher } from '../src/execution/executor-vm.js'
import type { MicrosandboxEnvironment, MicrosandboxManager } from '../src/microsandbox/driver.js'
import { DEFAULT_SHIM_RUNTIME_ROOT } from '../src/shim/sandbox-paths.js'

const LEAF = 'session-0123456789abcdef01234567'
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

describe('the microsandbox strategy launcher', () => {
  let root: string | undefined
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true })
    root = undefined
  })

  it("starts a VM over the session directory and the seed's sign-in, and names the image's roots", async () => {
    root = await mkdtemp(join(tmpdir(), 'ac-xv-'))
    const { manager, guest, prepared, suspended, discarded } = stubManager()
    const launcher = microsandboxLauncher({ manager: () => manager })
    const seed = {
      env: { CLAUDE_SECURESTORAGE_CONFIG_DIR: '/home/op/.claude' },
      paths: ['/home/op/.claude', '/home/op/.codex/auth.json']
    }
    const environment = await launcher.start({ daemonRoot: root, sessionLeaf: LEAF, log: quiet, seed })

    const directory = join(root, 'sessions', LEAF)
    // The state is this machine's directory, and the sign-in the seeded HOME points at is this machine's too: both at the same path in the guest.
    expect(prepared).toEqual([
      {
        id: `executor/${LEAF}`,
        workspaceRoot: directory,
        mounts: [directory, ...seed.paths].map((path) => ({ source: path, target: path, mode: 'writable' })),
        hosted: { env: seed.env }
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

  it('refuses on a machine that runs no microsandbox backend, and discards nothing there', async () => {
    root = await mkdtemp(join(tmpdir(), 'ac-xv-'))
    const launcher = microsandboxLauncher({ manager: () => undefined })
    await expect(launcher.start({ daemonRoot: root, sessionLeaf: LEAF, log: quiet })).rejects.toThrow(
      /no microsandbox backend/
    )
    await expect(launcher.discard!(LEAF)).resolves.toBeUndefined()
  })
})
