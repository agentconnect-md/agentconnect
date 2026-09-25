import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { createHash } from 'node:crypto'
import { decode, encode } from 'cborg'
import type { ExecEvent, ModifyOptions } from 'microsandbox'
import type { SecretBuilder } from 'microsandbox/native'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MicrosandboxManager,
  recordedImageModels,
  type MicrosandboxEnvironment,
  type MicrosandboxManagerOptions
} from '../src/microsandbox/driver.js'
import { MICROSANDBOX_NODE } from '../src/microsandbox/exec.js'
import type { GuestShim, startGuestShim } from '../src/microsandbox/shim.js'
import { SANDBOX_MCP_BRIDGE_ENTRY } from '../src/shim/sandbox-paths.js'
import { OVERLAY_BASE_ROOT } from '../src/microsandbox/overlay.js'
import { prepareMicrosandboxLaunch } from '../src/microsandbox/launch.js'
import { microsandboxSupportMounts } from '../src/microsandbox/support.js'

class FakeExec {
  private readonly queue: Array<ExecEvent | Error | undefined> = []
  private wake?: () => void
  readonly id = 1
  readonly writes: Uint8Array[] = []
  readonly stdin = vi.fn((_data: Uint8Array) => {})
  readonly signal = vi.fn(async (_signal: number) => this.push({ kind: 'exited', code: 0 }))
  readonly kill = vi.fn(async () => this.push({ kind: 'exited', code: 137 }))
  readonly close = vi.fn(async () => {})
  request?: { cmd: string; args: string[]; cwd: string; env: string[]; user: string; tty: boolean }

  push(event: ExecEvent | Error | undefined): void {
    this.queue.push(event)
    this.wake?.()
  }

  async *[Symbol.asyncIterator]() {
    for (;;) {
      while (!this.queue.length)
        await new Promise<void>((resolve) => {
          this.wake = resolve
        })
      const event = this.queue.shift()
      if (event instanceof Error) throw event
      const { kind, ...payload } = event ?? { kind: 'failed', message: 'guest execution failed' }
      yield {
        id: this.id,
        flags: kind === 'exited' || kind === 'failed' ? 1 : 0,
        body: Buffer.from(encode({ v: 9, t: `core.exec.${kind}`, p: encode(payload) }))
      }
      if (kind === 'exited' || kind === 'failed') return
    }
  }
}

function fakeSdk() {
  class SandboxNotFoundError extends Error {}
  class SandboxAlreadyExistsError extends Error {}
  class VolumeNotFoundError extends Error {}
  class InvalidConfigError extends Error {}
  class ImageInUseError extends Error {}
  const volumes = new Map<string, { attached: boolean }>()
  const removeVolume = vi.fn(async (name: string) => {
    const volume = volumes.get(name)
    if (!volume) throw new VolumeNotFoundError()
    if (volume.attached) throw new Error('disk is still attached')
    volumes.delete(name)
  })
  const sandboxes = new Map<string, FakeSandbox>()
  // Names a failed create claimed on disk before its database row: `get` misses them and a plain create collides.
  const claimed = new Set<string>()
  let nextCreateFailure: Error | undefined
  const created: FakeSandbox[] = []
  const processes: FakeExec[] = []
  let onRun: ((process: FakeExec) => void | Promise<void>) | undefined
  const images = new Map<string, number | null>([['test-image', 4_194_304]])
  const imageDigests = new Map<string, string>()
  const digestOf = (reference: string) =>
    imageDigests.get(reference) ?? `sha256:${createHash('sha256').update(reference).digest('hex')}`
  const imageCache = {
    get: vi.fn(async (reference: string) => ({
      manifestDigest: digestOf(reference),
      os: 'linux',
      architecture: 'amd64'
    })),
    list: vi.fn(async () =>
      [...images].map(([reference, sizeBytes]) => ({ reference, sizeBytes, manifestDigest: digestOf(reference) }))
    ),
    remove: vi.fn(async (reference: string) => {
      if (!images.has(reference)) throw new Error(`image not found: ${reference}`)
      // The cache refuses an image any sandbox still boots from, stopped ones included.
      for (const sandbox of sandboxes.values()) {
        if (sandbox.spec.image === reference) throw new ImageInUseError('image in use by sandbox(es): 1')
      }
      images.delete(reference)
    })
  }

  class FakeSandbox {
    readonly id = `vm-${created.length}`
    status = 'running'
    readonly processes: FakeExec[] = []
    readonly spec = {
      image: 'test-image',
      labels: {} as Record<string, string>,
      env: [{ key: 'PATH', value: '/image/bin' }],
      secrets: {} as Record<string, { value: string; placeholder: string; host: string[] }>,
      runtime: { workdir: '/image', user: 'agent' }
    }
    readonly stopWithTimeout = vi.fn(async () => {
      this.status = 'stopped'
      for (const process of this.processes) process.push({ kind: 'exited', code: 0 })
    })
    readonly destroy = vi.fn(async () => {
      await this.stopWithTimeout()
      sandboxes.delete(this.name)
    })
    readonly detach = vi.fn(async () => {
      for (const name of this.volumeNames) {
        if (volumes.has(name)) volumes.get(name)!.attached = false
      }
    })

    constructor(
      readonly name: string,
      readonly volumeNames: string[] = [],
      readonly mounts: Array<{ source: string; target: string; readonly: boolean }> = []
    ) {}
    get dockerVolume() {
      return this.volumeNames.find((name) => name.endsWith('-docker'))
    }
    config() {
      return this.spec
    }
    readonly modify = vi.fn(async (options: ModifyOptions) => {
      for (const [name, spec] of Object.entries(options.secrets ?? {})) this.spec.secrets[name]!.value = spec.value!
      return { applied: true }
    })
    async startDetached() {
      for (const name of this.volumeNames) {
        const volume = volumes.get(name)!
        if (volume.attached) throw new Error('disk is still attached')
        volume.attached = true
      }
      this.status = 'running'
      return this
    }
    async connectOrStart() {
      return this.startDetached()
    }
    async ping() {}
    readonly execWith = vi.fn(async (_command: string, configure: (exec: any) => unknown) => {
      const exec = { user: vi.fn(() => exec), args: vi.fn(() => exec), timeout: vi.fn(() => exec) }
      configure(exec)
      expect(exec.user).toHaveBeenCalledWith('root')
      return { success: true, code: 0, stderr: (): string => '' }
    })
    readonly exec = vi.fn(async (command: string, args: string[]) => {
      expect(command).toBe(MICROSANDBOX_NODE)
      expect(args[0]).toBe('-e')
      if (args[1]!.includes('/proc/self/mountinfo')) {
        const requested = JSON.parse(args[2]!) as MicrosandboxEnvironment['mounts']
        const success = requested.every(
          (mount) =>
            mount.mode === 'overlay' ||
            this.mounts.some(
              (actual) => actual.target === mount.target && actual.readonly === (mount.mode === 'readonly')
            )
        )
        return { success, code: success ? 0 : 1, stdout: (): string => '', stderr: (): string => 'mount mismatch' }
      }
      let stdout = ''
      const python = vi.fn((_command: string, _args: string[]) => {})
      runInNewContext(args[1]!, {
        require: (name: string) => {
          if (name === 'node:child_process') return { execFileSync: python }
          expect(name).toBe('node:fs')
          return {
            existsSync: (path: string) => path === SANDBOX_MCP_BRIDGE_ENTRY,
            readFileSync: (path: string) => {
              expect(path).toBe('/opt/agentconnect/runtime/k8s-runtimes.json')
              return JSON.stringify({ runtimes: [{ id: 'test' }] })
            }
          }
        },
        process: {
          argv: [MICROSANDBOX_NODE, ...args.slice(2)],
          execPath: '/image/node',
          stdout: { write: (value: string) => (stdout += value) }
        }
      })
      expect(python).toHaveBeenCalledWith(
        '/usr/bin/python3',
        ['-I', '-c', expect.stringContaining('shutil.rmtree.avoids_symlink_attacks')],
        { timeout: 10_000 }
      )
      return { success: true, code: 0, stdout: () => stdout }
    })
  }

  const sdk = {
    SandboxNotFoundError,
    SandboxAlreadyExistsError,
    VolumeNotFoundError,
    InvalidConfigError,
    ImageInUseError,
    Volume: { remove: removeVolume },
    Image: imageCache,
    AgentClient: {
      async connectSandbox(name: string) {
        const sandbox = sandboxes.get(name)!
        const process = new FakeExec()
        return {
          close: process.close,
          async stream(flags: number, body: Uint8Array) {
            const message = decode(body) as { v: number; t: string; p: Uint8Array }
            expect(flags).toBe(2)
            expect(message).toMatchObject({ v: 7, t: 'core.exec.request' })
            process.request = decode(message.p) as NonNullable<FakeExec['request']>
            sandbox.processes.push(process)
            process.push({ kind: 'started', pid: 1 })
            processes.push(process)
            await onRun?.(process)
            return process
          },
          async send(id: number, flags: number, body: Uint8Array) {
            expect(id).toBe(process.id)
            expect(flags).toBe(0)
            const message = decode(body) as { t: string; p: Uint8Array }
            if (message.t === 'core.exec.stdin') {
              const { data } = decode(message.p) as { data: Uint8Array }
              process.stdin(data)
              if (data.length) {
                process.writes.push(data)
                process.push({ kind: 'stdout', data })
              }
            } else {
              expect(message.t).toBe('core.exec.signal')
              const { signal } = decode(message.p) as { signal: number }
              if (signal === 9) await process.kill()
              else await process.signal(signal)
            }
          }
        }
      }
    },
    Sandbox: {
      async get(name: string) {
        const sandbox = sandboxes.get(name)
        if (!sandbox) throw new SandboxNotFoundError()
        return sandbox
      },
      builder(name: string) {
        const volumeNames: string[] = []
        const mounts: FakeSandbox['mounts'] = []
        const secrets: FakeSandbox['spec']['secrets'] = {}
        const labels: Record<string, string> = {}
        let image = 'test-image'
        let replace = false
        const builder = {
          image(value: string) {
            image = value
            return builder
          },
          replace() {
            replace = true
            return builder
          },
          label(key: string, value: string) {
            labels[key] = value
            return builder
          },
          rootDisk() {
            return builder
          },
          cpus() {
            return builder
          },
          memory() {
            return builder
          },
          deploymentProfile() {
            return builder
          },
          detached() {
            return builder
          },
          ephemeral() {
            return builder
          },
          quietLogs() {
            return builder
          },
          secret(configure: (entry: any) => unknown) {
            let name = ''
            const data = { value: '', placeholder: '', host: [] as string[] }
            const entry = {
              env(value: string) {
                name = value
                return entry
              },
              value(value: string) {
                data.value = value
                return entry
              },
              placeholder(value: string) {
                data.placeholder = value
                return entry
              },
              allow(value: string) {
                data.host.push(value)
                return entry
              },
              // Headers only: a key in a query string or body is never substituted.
              substituteInHeaders(value: boolean) {
                expect(value).toBe(true)
                return entry
              },
              substituteInQuery(value: boolean) {
                expect(value).toBe(false)
                return entry
              },
              substituteInBody(value: boolean) {
                expect(value).toBe(false)
                return entry
              }
              // The SDK's own names, so a rename fails the typecheck rather than a real VM.
            } satisfies Partial<Record<keyof SecretBuilder, unknown>>
            configure(entry)
            secrets[name] = data
            return builder
          },
          volume(target: string, configure: (volume: any) => unknown) {
            let source: string | undefined
            let readonly = false
            const volume = {
              namedWith(name: string) {
                volumeNames.push(name)
                return volume
              },
              tmpfs: () => volume,
              bind(path: string) {
                source = path
                return volume
              },
              readonly() {
                readonly = true
                return volume
              }
            }
            configure(volume)
            if (source) mounts.push({ source, target, readonly })
            return builder
          },
          async create() {
            if (replace && sandboxes.has(name)) throw new Error(`replace would destroy the tracked sandbox ${name}`)
            if (claimed.has(name) && !replace) throw new SandboxAlreadyExistsError(`sandbox '${name}' already exists`)
            claimed.delete(name)
            if (nextCreateFailure) {
              const failure = nextCreateFailure
              nextCreateFailure = undefined
              claimed.add(name)
              throw failure
            }
            for (const name of volumeNames) {
              if (volumes.has(name)) throw new Error('volume already exists')
              volumes.set(name, { attached: true })
            }
            const sandbox = new FakeSandbox(name, volumeNames, mounts)
            sandbox.spec.image = image
            sandbox.spec.secrets = secrets
            sandbox.spec.labels = labels
            created.push(sandbox)
            sandboxes.set(name, sandbox)
            return sandbox
          }
        }
        return builder
      }
    }
  } as unknown as MicrosandboxManagerOptions['sdk']
  return {
    sdk,
    created,
    processes,
    volumes,
    images,
    imageDigests,
    digestOf,
    imageCache,
    removeVolume,
    claimed,
    /** Fail the next create after it claimed its name, as msb does when the disk fills mid-create. */
    failNextCreate: (failure: Error) => {
      nextCreateFailure = failure
    },
    /** A VM this daemon does not know about: one an operator created, or one an interrupted start left behind. */
    leak: (name: string, image: string) => {
      const sandbox = new FakeSandbox(name)
      sandbox.spec.image = image
      sandboxes.set(name, sandbox)
      return sandbox
    },
    runWith: (callback: (process: FakeExec) => void | Promise<void>) => {
      onRun = callback
    }
  }
}

type ShimInput = Parameters<typeof startGuestShim>[0]

/** One VM's exposed shim, as the manager sees it: started, stopped or dying; whoever drives the VM dials it elsewhere. */
class FakeShim implements GuestShim {
  readonly token = 'fake-token'
  readonly exited: Promise<void>
  readonly stop = vi.fn(async () => this.end())
  private end!: () => void

  constructor(readonly input: ShimInput) {
    this.exited = new Promise((resolve) => (this.end = resolve))
  }

  connect(): Promise<never> {
    return Promise.reject(new Error('the manager never dials its shim'))
  }

  /** The shim process died: what the real pump reports when its exec stream ends. */
  die(): void {
    this.end()
    this.input.failed?.(new Error('sandbox shim exited'))
  }
}

/** What a local launch asks of the manager (session-executors.md §11 step 4): the VM held and up, released when its runtime ends. */
async function occupy(manager: MicrosandboxManager, environment: MicrosandboxEnvironment) {
  const release = manager.hold(environment)
  try {
    await manager.prepareEnvironment(environment)
  } catch (error) {
    release()
    throw error
  }
  return { stop: (_deadlineMs?: number) => Promise.resolve(release()) }
}

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'microsandbox-driver-'))
  roots.push(root)
  const fake = fakeSdk()
  const shims: FakeShim[] = []
  const options: MicrosandboxManagerOptions = {
    root,
    config: { image: 'test-image', cpus: 2, memoryMiB: 2048, diskGiB: 10 },
    sdk: fake.sdk,
    msbCommand: { command: process.execPath, args: ['-e', ''] },
    kvmPreflight: () => {},
    sockets: { mcp: '/host/mcp.sock', gitcred: '/host/gitcred.sock' },
    startShim: async (input) => {
      const shim = new FakeShim(input)
      shims.push(shim)
      return shim
    }
  }
  const manager = new MicrosandboxManager(options)
  const environment = { id: 'agent/session-example', mounts: [], workspaceRoot: '/workspace' }
  return { ...fake, shims, manager, options, environment }
}

/** Wrap the fake builder's terminal create() so a test can stall or fail a VM start. */
function interceptCreate(
  options: MicrosandboxManagerOptions,
  around: (create: () => Promise<unknown>) => Promise<unknown>
) {
  const api = options.sdk.Sandbox as unknown as { builder: (name: string) => { create: () => Promise<unknown> } }
  const build = api.builder.bind(api)
  const intercepted = vi.fn((create: () => Promise<unknown>) => around(create))
  vi.spyOn(api, 'builder').mockImplementation((name: string) => {
    const builder = build(name)
    const create = builder.create.bind(builder)
    builder.create = () => intercepted(create)
    return builder
  })
  return intercepted
}

describe('microsandbox process and VM ownership', () => {
  it.skipIf(process.platform === 'win32')('launches and resumes with the actual daemon support mounts', async () => {
    const { manager, options, environment, created } = await fixture()
    const scopeDir = join(options.root, 'agent')
    const cwd = join(scopeDir, 'workspace')
    const hostHome = join(options.root, 'host')
    await mkdir(cwd, { recursive: true })
    await mkdir(hostHome)
    const launch = prepareMicrosandboxLaunch({
      runtimeId: 'test',
      scopeDir,
      cwd,
      daemonRoot: options.root,
      stateSourceEnv: { HOME: hostHome },
      mounts: [],
      trustedMounts: microsandboxSupportMounts(options.root)
    })
    const env = { id: environment.id, ...launch.microsandbox }
    await (await occupy(manager, env)).stop(0)
    await manager.stopAll()
    const resumed = new MicrosandboxManager(options)
    await (await occupy(resumed, env)).stop(0)
    expect(created).toHaveLength(1)
    await resumed.discard(env.id)
  })

  it('refuses host SDK state mounts even for a runtime without its own secrets', async () => {
    const { manager, options, environment, created } = await fixture()
    for (const path of ['', 'microsandbox', 'microsandbox/sandboxes']) {
      const env = {
        ...environment,
        mounts: [{ source: join(options.root, path), target: '/config', mode: 'readonly' as const }]
      }
      await expect(occupy(manager, env)).rejects.toThrow('cannot expose host sandbox state')
    }
    expect(created).toHaveLength(0)
    await manager.stopAll()
  })

  it.each(['api.deepseek.com', ['api.example.test', 'alternate.example.test']])(
    'keeps secrets scoped to %j and rotates them when the retained VM resumes',
    async (host) => {
      const { manager, options, environment, created, shims } = await fixture()
      let key = 'fixture-first-key'
      const secret = {
        env: 'DEEPSEEK_API_KEY',
        placeholder: 'fixture-placeholder',
        host,
        readValue: () => key
      }
      const env = { ...environment, secrets: [secret] }
      await (await occupy(manager, env)).stop(0)
      expect(created[0]!.spec.secrets.DEEPSEEK_API_KEY!.value).toBe(key)
      expect(created[0]!.spec.secrets.DEEPSEEK_API_KEY!.host).toEqual([host].flat())
      // A local VM's shim is handed no seed: the guest reads the placeholder its launch names, never the value.
      expect(shims[0]!.input.seedEnv).toBeUndefined()
      const directory = join(options.root, 'microsandbox', 'bindings')
      const path = join(directory, (await readdir(directory))[0]!)
      expect(await readFile(path, 'utf8')).not.toContain(key)
      await manager.stopAll()
      key = 'fixture-rotated-key'
      const resumed = new MicrosandboxManager(options)
      await (await occupy(resumed, env)).stop(0)
      expect(created).toHaveLength(1)
      expect(created[0]!.spec.secrets.DEEPSEEK_API_KEY!.value).toBe(key)
      expect(await readFile(path, 'utf8')).not.toContain(key)
      await resumed.stopAll()
      created[0]!.modify.mockResolvedValueOnce({ applied: false, changes: [], conflicts: [] } as never)
      const restarted = new MicrosandboxManager(options)
      await (await occupy(restarted, env)).stop(0)
      expect(created).toHaveLength(1)
      expect(created[0]!.status).toBe('running')
      await restarted.discard(env.id)
    }
  )

  it.each([false, true])('replaces the VM when its credential scope changes (protected=%s)', async (protectedVm) => {
    const { manager, options, environment, created, volumes } = await fixture()
    const env = {
      ...environment,
      secrets: [
        {
          env: 'DEEPSEEK_API_KEY',
          placeholder: 'fixture-placeholder',
          host: 'api.deepseek.com',
          readValue: () => 'fixture-key'
        }
      ]
    }
    await (await occupy(manager, protectedVm ? env : environment)).stop(0)
    await manager.stopAll()
    const resumed = new MicrosandboxManager(options)
    await (await occupy(resumed, protectedVm ? environment : env)).stop(0)
    expect(created).toHaveLength(2)
    expect(created[0]!.destroy).toHaveBeenCalledOnce()
    expect(created[1]!.spec.secrets).toEqual(
      protectedVm ? {} : expect.objectContaining({ DEEPSEEK_API_KEY: expect.anything() })
    )
    expect(volumes.size).toBe(1)
    await resumed.discard(environment.id)
  })

  it('shares read-only bases while retaining and cleaning up each session overlay disk', async () => {
    const { manager, options, environment, created, volumes, removeVolume } = await fixture()
    const first: MicrosandboxEnvironment = {
      ...environment,
      mounts: [{ source: '/shared/store', target: '/session/home/store', mode: 'overlay' }]
    }
    const second = { ...first, id: 'agent/second-session' }
    for (const env of [first, second]) await (await occupy(manager, env)).stop(0)
    expect(volumes.size).toBe(4)
    for (const vm of created) {
      expect(vm.mounts).toEqual([
        { source: '/shared/store', target: expect.stringMatching(OVERLAY_BASE_ROOT), readonly: true }
      ])
      expect(vm.execWith).toHaveBeenCalledOnce()
    }
    await manager.stopAll()
    const resumed = new MicrosandboxManager(options)
    await (await occupy(resumed, first)).stop(0)
    expect(created).toHaveLength(2)
    expect(created[0]!.execWith).toHaveBeenCalledTimes(2)
    const overlay = created[0]!.volumeNames.find((name) => name.endsWith('-overlays'))!
    const originalRemove = removeVolume.getMockImplementation()!
    removeVolume.mockImplementationOnce(originalRemove).mockRejectedValueOnce(new Error('volume busy'))
    await expect(resumed.discard(first.id)).rejects.toThrow('volume busy')
    expect(volumes.has(overlay)).toBe(true)
    await resumed.discard(first.id)
    await resumed.discard(second.id)
    expect(volumes.size).toBe(0)
    expect(await resumed.environmentIds()).toEqual([])
  })

  it('preserves a retained overlay disk when remounting fails and retries on the next resume', async () => {
    const { manager, options, environment, created, volumes } = await fixture()
    const env: MicrosandboxEnvironment = {
      ...environment,
      mounts: [{ source: '/shared/store', target: '/cache/store', mode: 'overlay' }]
    }
    await (await occupy(manager, env)).stop(0)
    await manager.stopAll()
    const vm = created[0]!
    vm.execWith.mockResolvedValueOnce({ success: false, code: 1, stderr: () => 'mount failed' })
    const resumed = new MicrosandboxManager(options)
    await expect(occupy(resumed, env)).rejects.toThrow('overlay setup failed')
    expect(vm.status).toBe('stopped')
    expect(volumes.size).toBe(2)
    await (await occupy(resumed, env)).stop(0)
    await resumed.discard(env.id)
    expect(volumes.size).toBe(0)
  })

  it('prepares only layered image artifacts without stopping an existing VM', async () => {
    const { manager, options, environment, created } = await fixture()
    const runtime = await occupy(manager, environment)
    const argsFile = join(options.root, 'pull.json')
    options.msbCommand = {
      command: process.execPath,
      args: [
        '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(1)))`
      ]
    }
    await manager.prepareImage()
    expect(JSON.parse(await readFile(argsFile, 'utf8'))).toEqual([
      'pull',
      'test-image',
      '--materialize',
      'layered',
      '--quiet'
    ])
    expect(created).toHaveLength(1)
    expect(created[0]!.status).toBe('running')
    expect(created[0]!.stopWithTimeout).not.toHaveBeenCalled()
    await runtime.stop(0)
    await manager.discard(environment.id)
  })

  it('retains Docker data across manager restarts and retries failed volume cleanup without losing ownership', async () => {
    const { manager, options, environment, created, volumes, removeVolume } = await fixture()
    const runtime = await occupy(manager, environment)
    const volume = created[0]!.dockerVolume!
    await runtime.stop(0)
    await manager.stopAll()
    expect(volumes.has(volume)).toBe(true)
    expect(removeVolume).not.toHaveBeenCalled()

    const resumed = new MicrosandboxManager(options)
    vi.spyOn(created[0]!, 'connectOrStart').mockRejectedValueOnce(
      new options.sdk.InvalidConfigError(`volume "${volume}" is already attached with an incompatible disk mode`)
    )
    const restored = await occupy(resumed, environment)
    expect(created).toHaveLength(1)
    await restored.stop(0)
    removeVolume.mockRejectedValueOnce(new Error('temporary volume removal failure'))
    await expect(resumed.discard(environment.id)).rejects.toThrow('temporary volume removal failure')
    expect(await resumed.environmentIds()).toEqual([environment.id])
    expect(volumes.has(volume)).toBe(true)
    removeVolume.mockRejectedValueOnce(
      new options.sdk.InvalidConfigError(`volume "${volume}" is currently attached by a running sandbox`)
    )
    await resumed.discard(environment.id)
    expect(volumes.size).toBe(0)
    expect(await resumed.environmentIds()).toEqual([])
  })

  it('resumes bindings from before Docker volumes without claiming or removing a separate disk', async () => {
    const { manager, options, environment, created, removeVolume } = await fixture()
    const runtime = await occupy(manager, environment)
    await runtime.stop(0)
    await manager.stopAll()
    const directory = join(options.root, 'microsandbox', 'bindings')
    const path = join(directory, (await readdir(directory))[0]!)
    const binding = JSON.parse(await readFile(path, 'utf8')) as { dockerVolume?: string }
    delete binding.dockerVolume
    await writeFile(path, JSON.stringify(binding))

    const resumed = new MicrosandboxManager(options)
    const restored = await occupy(resumed, environment)
    expect(created).toHaveLength(1)
    await restored.stop(0)
    await resumed.discard(environment.id)
    expect(removeVolume).not.toHaveBeenCalled()
  })

  it('starts one exposed shim with the VM and holds the VM while any launch uses it', async () => {
    const { manager, environment, created, shims, processes } = await fixture()
    const [first, second] = await Promise.all([occupy(manager, environment), occupy(manager, environment)])
    expect(created).toHaveLength(1)
    expect(shims).toHaveLength(1)
    // This daemon drives a local VM and sends each runtime its whole environment; no seed is handed to its shim (§11 step 4).
    expect(shims[0]!.input).toMatchObject({ workspaceRoot: '/workspace', completeEnv: true })
    expect(shims[0]!.input.seedEnv).toBeUndefined()
    expect(manager.guestShim(environment.id)).toBe(shims[0])
    // What a runtime starts from beneath its launch's env: the image's own.
    await expect(manager.runtimeEnv(environment.id)).resolves.toEqual({ PATH: '/image/bin' })
    // No process of the runtime's is started over the guest agent's exec channel.
    expect(processes).toHaveLength(0)
    await expect(manager.suspend(environment.id)).rejects.toThrow('2 active executions')
    await first.stop()
    await expect(manager.suspend(environment.id)).rejects.toThrow('1 active executions')
    await second.stop()
    await manager.suspendIdle(Date.now())
    expect(created[0]!.status).toBe('stopped')
    expect(shims[0]!.stop).toHaveBeenCalledOnce()
    expect(manager.guestShim(environment.id)).toBeUndefined()
    expect(await manager.environmentIds()).toEqual([environment.id])
    // A resumed VM is a new incarnation, with a shim of its own.
    await (await occupy(manager, environment)).stop()
    expect(created).toHaveLength(1)
    expect(shims).toHaveLength(2)
    await manager.discard(environment.id)
    expect(await manager.environmentIds()).toEqual([])
  })

  it('starts a hosted VM its shim with the seed and without the complete-env claim', async () => {
    const { manager, created, shims } = await fixture()
    const hosted: MicrosandboxEnvironment = {
      id: 'executor/session-example',
      mounts: [],
      workspaceRoot: '/sessions/session-example',
      hosted: { env: { CLAUDE_SECURESTORAGE_CONFIG_DIR: '/home/op/.claude' } }
    }
    await manager.prepareEnvironment(hosted)
    expect(created).toHaveLength(1)
    expect(shims[0]!.input).toMatchObject({
      workspaceRoot: '/sessions/session-example',
      completeEnv: false,
      seedEnv: { CLAUDE_SECURESTORAGE_CONFIG_DIR: '/home/op/.claude' }
    })
    // Its idle judge is the facet's linger, not this machine's session ttl (§7).
    await manager.suspendIdle(Date.now())
    expect(created[0]!.status).toBe('running')
    await manager.discard(hosted.id)
  })

  it('tells a same spec from a changed one, whatever object carries it', async () => {
    const { manager, environment } = await fixture()
    expect(manager.sameEnvironment(environment, { ...environment })).toBe(true)
    // Mount order and the readOnly/mode spelling are the binding's normalization, not a change.
    const a = { source: '/a', target: '/a', mode: 'writable' as const }
    const b = { source: '/b', target: '/b', mode: 'readonly' as const }
    expect(manager.sameEnvironment({ ...environment, mounts: [a, b] }, { ...environment, mounts: [b, a] })).toBe(true)
    expect(manager.sameEnvironment(environment, { ...environment, mounts: [a] })).toBe(false)
    expect(manager.sameEnvironment(environment, { ...environment, id: 'agent/other' })).toBe(false)
  })

  it('drops the runtime stderr while a quiet launch holds the VM, and passes every other one through', async () => {
    const { manager, environment, shims } = await fixture()
    const written = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const loud = await occupy(manager, environment)
      shims[0]!.input.runtimeStderr('runtime warning\n')
      expect(written).toHaveBeenCalledExactlyOnceWith('runtime warning\n')
      const quiet = manager.quiet(environment.id)
      shims[0]!.input.runtimeStderr('probe output\n')
      expect(written).toHaveBeenCalledOnce()
      quiet()
      quiet()
      shims[0]!.input.runtimeStderr('runtime warning\n')
      expect(written).toHaveBeenCalledTimes(2)
      await loud.stop()
    } finally {
      written.mockRestore()
    }
    await manager.discard(environment.id)
  })

  it('streams large UTF-8 stdin while draining output and replaces the image environment when requested', async () => {
    const { manager, environment, runWith, processes } = await fixture()
    const input = '中文 input\n'.repeat(20_000)
    runWith((process) => {
      process.stdin.mockImplementation((data) => {
        if (data.length === 0) process.push({ kind: 'exited', code: 0 })
      })
    })
    const result = await manager.exec(environment, '/bin/cat', [], {
      stdin: input,
      env: { HOME: '/workspace' },
      inheritEnv: false
    })
    expect(result).toEqual({ exitCode: 0, stdout: input, stderr: '' })
    expect(processes[0]!.request).toMatchObject({
      cmd: '/usr/bin/env',
      args: ['-i', '--', 'HOME=/workspace', '/bin/cat'],
      env: []
    })
    expect(processes[0]!.writes.length).toBeGreaterThan(1)
    expect(processes[0]!.writes.every((chunk) => chunk.length <= 64 * 1024)).toBe(true)
    await manager.stopAll()
  })

  it('closes a terminal failure before releasing the execution', async () => {
    const { manager, environment, processes, runWith } = await fixture()
    let releaseClose!: () => void
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve
    })
    runWith((process) => {
      process.close.mockImplementationOnce(() => closeGate)
      process.push(undefined)
    })
    const settled = vi.fn()
    const execution = manager.exec(environment, 'test', [])
    void execution.catch(settled)
    await vi.waitFor(() => expect(processes[0]!.close).toHaveBeenCalledOnce())
    expect(settled).not.toHaveBeenCalled()
    await expect(manager.suspend(environment.id)).rejects.toThrow('1 active executions')
    releaseClose()
    await expect(execution).rejects.toThrow('guest execution failed')
    expect(processes[0]!.kill).not.toHaveBeenCalled()
    await manager.suspend(environment.id)
  })

  it('leaves a VM with an execution still running up instead of refusing, and stops it once idle', async () => {
    const { manager, environment, processes, runWith, created } = await fixture()
    let releaseClose!: () => void
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve
    })
    runWith((process) => {
      process.close.mockImplementationOnce(() => closeGate)
      process.push(undefined)
    })
    const execution = manager.exec(environment, 'test', [])
    void execution.catch(() => {})
    await vi.waitFor(() => expect(processes[0]!.close).toHaveBeenCalledOnce())
    await expect(manager.suspendUnlessBusy(environment.id)).resolves.toBe(false)
    expect(created[0]!.status).not.toBe('stopped')
    releaseClose()
    await expect(execution).rejects.toThrow('guest execution failed')
    await expect(manager.suspendUnlessBusy(environment.id)).resolves.toBe(true)
    expect(created[0]!.status).toBe('stopped')
  })

  it('fences saved VMs at startup and refuses changed persistent configuration', async () => {
    const { manager, options, environment, created } = await fixture()
    const runtime = await occupy(manager, environment)
    await runtime.stop(0)
    const resumed = new MicrosandboxManager(options)
    expect(await resumed.environmentIds()).toEqual([environment.id])
    await expect(resumed.prepare()).resolves.toEqual({
      runtimes: [{ id: 'test' }],
      mcpBridge: { command: '/image/node', args: [SANDBOX_MCP_BRIDGE_ENTRY] }
    })
    expect(created[0]!.status).toBe('stopped')
    created[0]!.spec.image = 'changed-outside-daemon'
    await expect(occupy(resumed, environment)).rejects.toThrow('changed persisted configuration')
    await manager.discard(environment.id)
  })

  it('fences an earlier daemon’s running VM at startup without pulling or booting anything (session-executors.md §5)', async () => {
    const { manager, options, environment, created, imageCache } = await fixture()
    const runtime = await occupy(manager, environment)
    // The daemon died with its VM still running; the next one recovers its state and prepares no image.
    const pulls = join(options.root, 'pulls')
    const restarted = new MicrosandboxManager({
      ...options,
      msbCommand: {
        command: process.execPath,
        args: ['-e', `require('node:fs').appendFileSync(${JSON.stringify(pulls)}, 'x')`]
      }
    })
    await restarted.recover()
    await restarted.collectImages()
    expect(created).toHaveLength(1)
    expect(created[0]!.status).toBe('stopped')
    await expect(readFile(pulls, 'utf8')).rejects.toThrow()
    expect(imageCache.remove).not.toHaveBeenCalled()
    await runtime.stop(0)
    await manager.discard(environment.id)
  })

  it('records the runtime table its first preparation read, for as long as the cache holds that image', async () => {
    const { options, imageDigests } = await fixture()
    const table = {
      runtimes: [{ id: 'test' }],
      mcpBridge: { command: '/image/node', args: [SANDBOX_MCP_BRIDGE_ENTRY] }
    }
    // Nothing read yet: no record, so the first session prepares.
    expect(await new MicrosandboxManager(options).cachedTable()).toBeUndefined()
    await expect(new MicrosandboxManager(options).prepare()).resolves.toEqual(table)
    const restarted = new MicrosandboxManager(options)
    expect(await restarted.cachedTable()).toEqual(table)
    // The recorded table is the preparation: no probe VM boots for it.
    await expect(restarted.prepare()).resolves.toEqual(table)
    // A tag that moved, or another configured image, is prepared again.
    imageDigests.set('test-image', 'sha256:moved')
    expect(await new MicrosandboxManager(options).cachedTable()).toBeUndefined()
    const other = { ...options, config: { ...options.config, image: 'next-image' } }
    expect(await new MicrosandboxManager(other).cachedTable()).toBeUndefined()
  })

  it('records what each runtime advertised in a VM, and carries it across an image change until replaced', async () => {
    const { options, imageDigests, created } = await fixture()
    await new MicrosandboxManager(options).prepare()
    const booted = created.length
    const manager = new MicrosandboxManager(options)
    expect(await manager.cachedModels()).toEqual({})
    await manager.recordModels('test', ['model-a', 'model-b'])
    await manager.recordModels('other', ['model-c'])
    await manager.recordModels('test', ['model-b'])
    expect(await new MicrosandboxManager(options).cachedModels()).toEqual({ test: ['model-b'], other: ['model-c'] })
    expect(await recordedImageModels(options.root)).toEqual({ test: ['model-b'], other: ['model-c'] })
    expect(created).toHaveLength(booted)
    // Another build behind the same tag, or another image, starts from the previous lists, and replaces one at a time.
    imageDigests.set('test-image', 'sha256:moved')
    expect(await new MicrosandboxManager(options).cachedModels()).toEqual({ test: ['model-b'], other: ['model-c'] })
    const next = new MicrosandboxManager({ ...options, config: { ...options.config, image: 'next-image' } })
    expect(await next.cachedModels()).toEqual({ test: ['model-b'], other: ['model-c'] })
    await next.recordModels('test', ['model-d'])
    expect(await next.cachedModels()).toEqual({ test: ['model-d'], other: ['model-c'] })
  })

  it('starts no preparation VM after a shutdown that came during the image pull', async () => {
    const { manager, options, created } = await fixture()
    const release = join(options.root, 'release-pull')
    const pulling = join(options.root, 'pulling')
    // A pull that holds until the test releases it, as a real one holds for minutes.
    options.msbCommand = {
      command: process.execPath,
      args: [
        '-e',
        `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(pulling)}, ''); const wait = setInterval(() => fs.existsSync(${JSON.stringify(release)}) && clearInterval(wait), 20)`
      ]
    }
    const booted = created.length
    const preparing = manager.prepare()
    preparing.catch(() => {})
    await vi.waitFor(() => expect(readFile(pulling, 'utf8')).resolves.toBe(''))
    await manager.stopAll()
    await writeFile(release, '')
    await expect(preparing).rejects.toThrow('microsandbox manager is shutting down')
    expect(created).toHaveLength(booted)
  })

  it('tries a failed preparation again at the next use', async () => {
    const { options } = await fixture()
    let fail = true
    const manager = new MicrosandboxManager({
      ...options,
      kvmPreflight: () => {
        if (fail) throw new Error('microsandbox requires KVM')
      }
    })
    await expect(manager.prepare()).rejects.toThrow('microsandbox requires KVM')
    fail = false
    await expect(manager.prepare()).resolves.toBeDefined()
  })

  it('reuses an alias with the same platform digest and refreshes a changed image', async () => {
    const { manager, options, environment, created, imageDigests, imageCache } = await fixture()
    await manager.prepareEnvironment(environment)
    await manager.stopAll()
    const identity = await imageCache.get('test-image')
    imageDigests.set('next-image', identity.manifestDigest)
    const upgraded = { ...options, config: { ...options.config, image: 'next-image' } }
    const resumed = new MicrosandboxManager(upgraded)
    await resumed.refreshEnvironment(environment)
    expect(created).toHaveLength(1)
    expect(created[0]!.status).toBe('stopped')
    await resumed.prepareEnvironment(environment)
    expect(created).toHaveLength(1)
    await resumed.stopAll()

    imageDigests.set('next-image', 'sha256:changed')
    const changed = new MicrosandboxManager(upgraded)
    await changed.refreshEnvironment(environment)
    expect(created).toHaveLength(2)
    expect(created[0]!.destroy).toHaveBeenCalledOnce()
    expect(created[1]!.spec.image).toBe('next-image')
    await changed.stopAll()
    const restarted = new MicrosandboxManager(upgraded)
    await restarted.prepareEnvironment(environment)
    expect(created).toHaveLength(2)
    await restarted.discard(environment.id)
  })

  it('refreshes a reused tag when its recorded digest changes', async () => {
    const { manager, options, environment, created, imageDigests } = await fixture()
    await manager.prepareEnvironment(environment)
    await manager.stopAll()
    imageDigests.set('test-image', 'sha256:new-content')
    const restarted = new MicrosandboxManager(options)
    await restarted.refreshEnvironment(environment)
    expect(created).toHaveLength(2)
    expect(created[0]!.destroy).toHaveBeenCalledOnce()
    await restarted.discard(environment.id)
  })

  it('waits for VM preparation during shutdown', async () => {
    const { manager, environment, created } = await fixture()
    let enter!: () => void
    const entered = new Promise<void>((resolve) => {
      enter = resolve
    })
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const start = (manager as any).startShim.bind(manager)
    vi.spyOn(manager as any, 'startShim').mockImplementation(async (...args) => {
      enter()
      await blocked
      await start(...args)
    })
    const preparation = manager.prepareEnvironment(environment)
    await entered
    const stopped = vi.fn()
    const stopping = manager.stopAll().then(stopped)
    await Promise.resolve()
    expect(stopped).not.toHaveBeenCalled()
    release()
    await Promise.all([preparation, stopping])
    expect(created[0]!.status).toBe('stopped')
    await manager.discard(environment.id)
  })

  it('collects a retired release image and keeps the configured one before any VM boots', async () => {
    const { options, images, imageCache } = await fixture()
    images.set('previous-image', 3_145_728)
    await expect(new MicrosandboxManager(options).prepare()).resolves.toBeDefined()
    expect(imageCache.remove).toHaveBeenCalledExactlyOnceWith('previous-image')
    expect([...images.keys()]).toEqual(['test-image'])
  })

  it('keeps the image of a retained VM until its environment is discarded', async () => {
    const { manager, options, environment, images } = await fixture()
    await (await occupy(manager, environment)).stop(0)
    await manager.stopAll()
    images.set('next-image', null)
    const upgraded = { ...options, config: { ...options.config, image: 'next-image' } }
    await new MicrosandboxManager(upgraded).prepare()
    expect([...images.keys()]).toEqual(['test-image', 'next-image'])
    await new MicrosandboxManager(upgraded).discard(environment.id)
    await new MicrosandboxManager(upgraded).prepare()
    expect([...images.keys()]).toEqual(['next-image'])
  })

  it('keeps an image a sandbox outside this daemon still boots from', async () => {
    const { options, images, imageCache, leak } = await fixture()
    images.set('shared-image', null)
    leak('sandbox-outside-this-daemon', 'shared-image')
    await expect(new MicrosandboxManager(options).prepare()).resolves.toBeDefined()
    expect(imageCache.remove).toHaveBeenCalledExactlyOnceWith('shared-image')
    expect([...images.keys()]).toEqual(['test-image', 'shared-image'])
  })

  it('reclaims the preparation VM an interrupted start left behind and frees its image', async () => {
    const { options, images, created, leak } = await fixture()
    await new MicrosandboxManager(options).prepare()
    const probe = created[created.length - 1]!
    expect(probe.destroy).toHaveBeenCalledOnce()
    images.set('previous-image', null)
    const abandoned = leak(probe.name, 'previous-image')
    await expect(new MicrosandboxManager(options).prepare()).resolves.toBeDefined()
    expect(abandoned.destroy).toHaveBeenCalledOnce()
    expect([...images.keys()]).toEqual(['test-image'])
  })

  it('reclaims the preparation disk a start left behind after its VM was destroyed', async () => {
    const { options, created, volumes } = await fixture()
    await new MicrosandboxManager(options).prepare()
    const probe = created[created.length - 1]!.name
    // A start that exits between destroying the VM and removing its disk leaves the disk under a fixed name.
    volumes.set(`${probe}-docker`, { attached: false })
    await expect(new MicrosandboxManager(options).prepare()).resolves.toBeDefined()
    expect(volumes.has(`${probe}-docker`)).toBe(false)
  })

  // A create that died between claiming the name and writing its row (a full disk) must not wedge that name for good.
  it('takes back a VM name a failed create left claimed and starts the VM on the next attempt', async () => {
    const { manager, environment, created, claimed, failNextCreate } = await fixture()
    failNextCreate(new Error('No space left on device (os error 28)'))
    await expect(manager.prepareEnvironment(environment)).rejects.toThrow('No space left on device')
    expect(claimed.size).toBe(1)
    await manager.prepareEnvironment(environment)
    expect(created).toHaveLength(1)
    expect(claimed.size).toBe(0)
    await manager.discard(environment.id)
  })

  it('takes back the preparation VM name a failed create left claimed', async () => {
    const { options, claimed, failNextCreate } = await fixture()
    failNextCreate(new Error('No space left on device (os error 28)'))
    await expect(new MicrosandboxManager(options).prepare()).rejects.toThrow('No space left on device')
    expect(claimed.size).toBe(1)
    await expect(new MicrosandboxManager(options).prepare()).resolves.toBeDefined()
    expect(claimed.size).toBe(0)
  })

  it('starts when the image cache cannot be read', async () => {
    const { options, imageCache } = await fixture()
    imageCache.list.mockRejectedValueOnce(new Error('image cache is locked'))
    await expect(new MicrosandboxManager(options).prepare()).resolves.toBeDefined()
    expect(imageCache.remove).not.toHaveBeenCalled()
  })

  it('collects at runtime what a discarded VM unpinned, keeping the tag an upgrade pre-pulled', async () => {
    const { manager, options, environment, images } = await fixture()
    await (await occupy(manager, environment)).stop(0)
    await manager.stopAll()
    images.set('next-image', null)
    const upgraded = new MicrosandboxManager({ ...options, config: { ...options.config, image: 'next-image' } })
    await upgraded.prepare()
    expect([...images.keys()]).toEqual(['test-image', 'next-image'])
    // The next release's pre-pull, which runs in its own process beside this daemon.
    images.set('pre-pulled-image', null)
    await new MicrosandboxManager({
      ...options,
      config: { ...options.config, image: 'pre-pulled-image' }
    }).prepareImage()
    await upgraded.discard(environment.id)
    await upgraded.collectImages()
    expect([...images.keys()]).toEqual(['next-image', 'pre-pulled-image'])
  })

  it('keeps a pre-pulled tag that was already cached before this daemon prepared', async () => {
    const { manager, options, environment, images } = await fixture()
    await (await occupy(manager, environment)).stop(0)
    await manager.stopAll()
    images.set('next-image', null)
    const upgraded = new MicrosandboxManager({ ...options, config: { ...options.config, image: 'next-image' } })
    await upgraded.prepare()
    // A rollback pre-pulls the tag the retained VM still pins; msb keeps that tag's original creation time.
    await new MicrosandboxManager(options).prepareImage()
    await upgraded.discard(environment.id)
    await upgraded.collectImages()
    expect([...images.keys()]).toEqual(['test-image', 'next-image'])
  })

  it('sweeps the flat rootfs refs and blobs no cached image names', async () => {
    const { options, digestOf } = await fixture()
    const flat = join(options.root, 'microsandbox', 'cache', 'flat')
    await mkdir(join(flat, 'refs'), { recursive: true })
    await mkdir(join(flat, 'blobs'), { recursive: true })
    const file = (digest: string, extension: string) => `${digest.replace(':', '_')}.${extension}`
    const live = { manifest_digest: digestOf('test-image'), artifact_digest: `sha256:${'a'.repeat(64)}` }
    const orphan = { manifest_digest: `sha256:${'b'.repeat(64)}`, artifact_digest: `sha256:${'c'.repeat(64)}` }
    for (const ref of [live, orphan]) {
      await writeFile(join(flat, 'refs', file(ref.manifest_digest, 'json')), JSON.stringify({ schema: 1, ...ref }))
      await writeFile(join(flat, 'blobs', file(ref.artifact_digest, 'raw')), 'ext4')
    }
    await writeFile(join(flat, 'blobs', file(`sha256:${'d'.repeat(64)}`, 'raw')), 'ext4')
    await new MicrosandboxManager(options).prepare()
    expect(await readdir(join(flat, 'refs'))).toEqual([file(live.manifest_digest, 'json')])
    expect(await readdir(join(flat, 'blobs'))).toEqual([file(live.artifact_digest, 'raw')])
  })

  it('skips a runtime collection while another live process holds the image cache', async () => {
    const { manager, options, images } = await fixture()
    await manager.prepare()
    images.set('previous-image', null)
    const lock = join(options.root, 'microsandbox', 'image-cache.lock')
    await writeFile(lock, `${process.ppid}\n`)
    await manager.collectImages()
    expect(images.has('previous-image')).toBe(true)
    await rm(lock)
    await manager.collectImages()
    expect(images.has('previous-image')).toBe(false)
  })

  it('pulls only after a live holder releases the image cache', async () => {
    const { manager, options } = await fixture()
    const lock = join(options.root, 'microsandbox', 'image-cache.lock')
    await mkdir(dirname(lock), { recursive: true })
    await writeFile(lock, `${process.ppid}\n`)
    const seen = join(options.root, 'seen')
    options.msbCommand = {
      command: process.execPath,
      args: [
        '-e',
        `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(seen)}, fs.readFileSync(${JSON.stringify(lock)}))`
      ]
    }
    const pulling = manager.prepareImage()
    await new Promise((resolve) => setTimeout(resolve, 300))
    await expect(readFile(seen, 'utf8')).rejects.toThrow()
    await rm(lock)
    await pulling
    expect(await readFile(seen, 'utf8')).toBe(`${process.pid}\n`)
    await expect(readdir(dirname(lock))).resolves.not.toContain('image-cache.lock')
  })

  it('fails a pull that outwaits a live holder instead of taking its lock', async () => {
    const { manager, options } = await fixture()
    const lock = join(options.root, 'microsandbox', 'image-cache.lock')
    await mkdir(dirname(lock), { recursive: true })
    await writeFile(lock, `${process.ppid}\n`)
    vi.useFakeTimers({ toFake: ['Date'] })
    // Jump the clock past the wait cap on every real tick, whenever the waiter took its deadline.
    const advancing = setInterval(() => vi.setSystemTime(Date.now() + 11 * 60_000), 50)
    try {
      await expect(manager.prepareImage()).rejects.toThrow(`still held by pid ${process.ppid}`)
    } finally {
      clearInterval(advancing)
      vi.useRealTimers()
    }
    expect(await readFile(lock, 'utf8')).toBe(`${process.ppid}\n`)
    await expect(readFile(join(options.root, 'microsandbox', 'pulled-image'), 'utf8')).rejects.toThrow()
  })

  it('reclaims an image cache lock whose holder is gone', async () => {
    const { options, images } = await fixture()
    const lock = join(options.root, 'microsandbox', 'image-cache.lock')
    await mkdir(dirname(lock), { recursive: true })
    await writeFile(lock, `${spawnSync(process.execPath, ['-e', '']).pid}\n`)
    const manager = new MicrosandboxManager(options)
    await expect(manager.prepare()).resolves.toBeDefined()
    images.set('previous-image', null)
    // An earlier incarnation of this process, as a restarted container hands out the same pid.
    await writeFile(lock, `${process.pid}\n`)
    await manager.collectImages()
    expect(images.has('previous-image')).toBe(false)
    await expect(readdir(dirname(lock))).resolves.not.toContain('image-cache.lock')
  })

  it('keeps active executions and replaces idle VMs when mounts change', async () => {
    const { manager, options, environment, created, shims } = await fixture()
    const workspace = join(options.root, 'workspace')
    await mkdir(workspace)
    await writeFile(join(workspace, 'uncommitted.txt'), 'keep')
    const original: MicrosandboxEnvironment = {
      ...environment,
      mounts: [{ source: workspace, target: '/workspace', mode: 'writable' }]
    }
    const runtime = await occupy(manager, original)
    const desired: MicrosandboxEnvironment = {
      ...original,
      mounts: [...original.mounts, { source: '/store', target: '/store', mode: 'writable' }]
    }
    await expect(manager.prepareEnvironment(desired)).rejects.toThrow('configuration changed while active')
    expect(created[0]!.destroy).not.toHaveBeenCalled()
    await runtime.stop(0)
    await Promise.all([manager.prepareEnvironment(desired), manager.prepareEnvironment(desired)])
    expect(created).toHaveLength(2)
    expect(created[0]!.destroy).toHaveBeenCalledOnce()
    expect(created[1]!.mounts).toContainEqual({ source: workspace, target: '/workspace', readonly: false })
    expect(await readFile(join(workspace, 'uncommitted.txt'), 'utf8')).toBe('keep')
    // Each VM starts a shim of its own.
    expect(shims).toHaveLength(2)
    await manager.discard(environment.id)
    expect(await readFile(join(workspace, 'uncommitted.txt'), 'utf8')).toBe('keep')
  })

  it('preserves the old binding when replacement validation fails and permits a later retry', async () => {
    const { manager, options, environment, created, volumes } = await fixture()
    await manager.prepareEnvironment(environment)
    await manager.stopAll()
    const next = { ...options, config: { ...options.config, cpus: 4 } }
    const build = options.sdk.Sandbox.builder.bind(options.sdk.Sandbox)
    const intercept = vi.spyOn(options.sdk.Sandbox, 'builder').mockImplementation((name) => {
      const builder = build(name)
      const create = builder.create.bind(builder)
      builder.create = async () => {
        const sandbox = await create()
        vi.mocked(sandbox.exec).mockRejectedValueOnce(new Error('mount check failed'))
        return sandbox
      }
      return builder
    })
    const failed = new MicrosandboxManager(next)
    await expect(failed.prepareEnvironment(environment)).rejects.toThrow('mount check failed')
    expect(created[0]!.destroy).not.toHaveBeenCalled()
    expect(created[1]!.destroy).toHaveBeenCalledOnce()
    expect(volumes.size).toBe(1)
    intercept.mockRestore()
    const restored = new MicrosandboxManager(options)
    await restored.prepareEnvironment(environment)
    expect(created).toHaveLength(2)
    await restored.stopAll()
    const retry = new MicrosandboxManager(next)
    await retry.prepareEnvironment(environment)
    expect(created).toHaveLength(3)
    expect(created[0]!.destroy).toHaveBeenCalledOnce()
    await retry.discard(environment.id)
  })

  it('recovers an abandoned candidate before retrying and retains ownership across cleanup failures', async () => {
    const { manager, options, environment, created, volumes } = await fixture()
    await manager.prepareEnvironment(environment)
    await manager.stopAll()
    const token = 'a'.repeat(32)
    const directory = join(options.root, 'microsandbox', 'bindings')
    const path = join(directory, (await readdir(directory))[0]!)
    const binding = JSON.parse(await readFile(path, 'utf8'))
    const candidate = await options.sdk.Sandbox.builder(created[0]!.name + '-' + token)
      .label('io.agentconnect.vm-replacement', token)
      .create()
    await candidate.stopWithTimeout(0)
    await candidate.detach()
    await writeFile(path, JSON.stringify({ ...binding, replacement: token }))
    created[0]!.destroy.mockRejectedValueOnce(new Error('old VM busy'))
    const upgraded = { ...options, config: { ...options.config, cpus: 4 } }
    const resumed = new MicrosandboxManager(upgraded)
    await resumed.prepareEnvironment(environment)
    expect(created[1]!.destroy).toHaveBeenCalledOnce()
    expect(JSON.parse(await readFile(path, 'utf8')).retired).toHaveLength(1)
    await resumed.stopAll()
    const restarted = new MicrosandboxManager(upgraded)
    await restarted.prepareEnvironment(environment)
    expect(created).toHaveLength(3)
    expect(created[0]!.destroy).toHaveBeenCalledTimes(2)
    expect(JSON.parse(await readFile(path, 'utf8')).retired).toBeUndefined()
    expect(volumes.size).toBe(1)
    await restarted.discard(environment.id)
  })

  it('retries a failed VM lookup without retaining a rejected launch', async () => {
    const { manager, options, environment } = await fixture()
    vi.spyOn(options.sdk.Sandbox, 'get').mockRejectedValueOnce(new Error('temporary lookup failure'))
    await expect(occupy(manager, environment)).rejects.toThrow('temporary lookup failure')
    const runtime = await occupy(manager, environment)
    await runtime.stop(0)
    await manager.discard(environment.id)
  })

  it('stops the VM when its shim is lost, refuses it until it has, then resumes it from the retained disk', async () => {
    const { manager, environment, created, shims } = await fixture()
    await (await occupy(manager, environment)).stop()
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    let stopping!: () => void
    const stopped = new Promise<void>((resolve) => {
      stopping = resolve
    })
    shims[0]!.stop.mockImplementationOnce(async () => {
      stopping()
      await blocked
    })
    const vm = created[0]!
    vm.stopWithTimeout.mockRejectedValueOnce(new Error('temporary VM stop failure'))
    // Whoever drives the VM learns from the shim's exit; the manager stops the VM before anything uses it again.
    shims[0]!.die()
    await stopped
    await expect(occupy(manager, environment)).rejects.toThrow('is stopping')
    expect(vm.stopWithTimeout).not.toHaveBeenCalled()
    const firstStop = manager.suspend(environment.id)
    release()
    await expect(firstStop).rejects.toThrow('temporary VM stop failure')
    expect(await manager.environmentIds()).toEqual([environment.id])

    await expect(occupy(manager, environment)).rejects.toThrow('transport failed')
    await manager.suspend(environment.id)
    expect(vm.status).toBe('stopped')
    await (await occupy(manager, environment)).stop()
    expect(created).toHaveLength(1)
    expect(vm.status).toBe('running')
    expect(shims).toHaveLength(2)
    await manager.discard(environment.id)
  })

  it('suspends a VM something still holds only when asked to drain it, ending its shim first (#2246)', async () => {
    const { manager, environment, created, shims } = await fixture()
    await occupy(manager, environment)
    await expect(manager.suspend(environment.id)).rejects.toThrow('has 1 active executions')
    expect(created[0]!.status).not.toBe('stopped')
    await manager.suspend(environment.id, { drain: true })
    // A runtime runs through the shim, so stopping the shim ends it.
    expect(shims[0]!.stop).toHaveBeenCalledOnce()
    expect(created[0]!.status).toBe('stopped')
    await manager.discard(environment.id)
  })

  it('fences a VM whose runtime can no longer be reached, whatever still holds it, and resumes it on the next use', async () => {
    const { manager, environment, created, shims } = await fixture()
    await occupy(manager, environment)
    manager.stopFailedEnvironment(environment.id)
    await vi.waitFor(() => expect(created[0]!.status).toBe('stopped'))
    expect(shims[0]!.stop).toHaveBeenCalledOnce()
    await (await occupy(manager, environment)).stop()
    expect(created).toHaveLength(1)
    expect(shims).toHaveLength(2)
    await manager.discard(environment.id)
  })

  it('refuses the VM when its shim cannot start, and starts it again on the next launch', async () => {
    const { manager, options, environment, created, shims } = await fixture()
    const start = options.startShim!
    options.startShim = vi.fn(start).mockRejectedValueOnce(new Error('tunnel gitcred could not listen'))
    await expect(occupy(manager, environment)).rejects.toThrow('tunnel gitcred could not listen')
    expect(shims).toHaveLength(0)
    expect(created[0]!.destroy).toHaveBeenCalledOnce()
    await (await occupy(manager, environment)).stop(0)
    expect(created).toHaveLength(2)
    expect(shims).toHaveLength(1)
    await manager.discard(environment.id)
  })

  it('drains the killed command before releasing its connection after exceeding output bounds', async () => {
    const { manager, environment, processes, runWith } = await fixture()
    runWith((process) => {
      process.kill.mockImplementationOnce(async () => {})
      process.push({ kind: 'stderr', data: Buffer.from('oversized') })
    })
    const execution = expect(manager.exec(environment, 'test', [], { maxBytes: 4 })).rejects.toThrow(
      'output limit exceeded'
    )
    await vi.waitFor(() => expect(processes[0]!.kill).toHaveBeenCalledOnce())
    expect(processes[0]!.close).not.toHaveBeenCalled()
    await expect(manager.suspend(environment.id)).rejects.toThrow('1 active executions')
    processes[0]!.push({ kind: 'stdout', data: Buffer.from('late output') })
    processes[0]!.push({ kind: 'exited', code: 137 })
    await execution
    expect(processes[0]!.close).toHaveBeenCalledOnce()
    await manager.suspend(environment.id)
  })

  it('stops a VM after transport failure before allowing another execution', async () => {
    const { manager, environment, created, processes, runWith } = await fixture()
    const running = manager.exec(environment, 'test', [])
    await vi.waitFor(() => expect(processes).toHaveLength(1))
    const vm = created[0]!
    let releaseOpening!: () => void
    const openingGate = new Promise<void>((resolve) => {
      releaseOpening = resolve
    })
    runWith(() => openingGate)
    const opening = expect(manager.exec(environment, 'test', [])).rejects.toThrow('is stopping')
    await vi.waitFor(() => expect(processes).toHaveLength(2))
    let releaseStop!: () => void
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve
    })
    vm.stopWithTimeout.mockImplementationOnce(async () => {
      await stopGate
      vm.status = 'stopped'
    })
    const failed = expect(running).rejects.toThrow('transport disconnected')
    processes[0]!.push(new Error('transport disconnected'))
    await failed
    expect(processes[0]!.close).toHaveBeenCalledOnce()
    await expect(occupy(manager, environment)).rejects.toThrow('is stopping')
    expect(vm.stopWithTimeout).not.toHaveBeenCalled()
    releaseOpening()
    await opening
    expect(processes[1]!.close).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(vm.stopWithTimeout).toHaveBeenCalledOnce())
    expect(processes).toHaveLength(2)
    releaseStop()
    await manager.suspend(environment.id)
    expect(vm.status).toBe('stopped')
    const recovered = await occupy(manager, environment)
    expect(vm.status).toBe('running')
    expect(created).toHaveLength(1)
    await recovered.stop()
    await manager.discard(environment.id)
  })

  it('closes a timed-out command without stopping the shim another launch holds the VM for', async () => {
    const { manager, environment, processes, shims } = await fixture()
    const runtime = await occupy(manager, environment)
    await expect(manager.exec(environment, 'test', [], { timeoutMs: 1 })).rejects.toThrow('timed out')
    expect(processes[0]!.signal).toHaveBeenCalledWith(15)
    expect(processes[0]!.close).toHaveBeenCalledOnce()
    expect(shims[0]!.stop).not.toHaveBeenCalled()
    await runtime.stop()
    await manager.suspend(environment.id)
  })

  it('starts one VM at a time so a start cannot inherit the disk locks of another', async () => {
    const { manager, options, created } = await fixture()
    let active = 0
    let peak = 0
    const slowCreate = interceptCreate(options, async (create) => {
      peak = Math.max(peak, ++active)
      try {
        await new Promise((resolve) => setTimeout(resolve, 5))
        return await create()
      } finally {
        active--
      }
    })
    const environments = ['agent/session-one', 'agent/session-two', 'agent/session-three'].map((id) => ({
      id,
      mounts: [],
      workspaceRoot: '/workspace'
    }))
    const runtimes = await Promise.all(environments.map((env) => occupy(manager, env)))
    expect(slowCreate).toHaveBeenCalledTimes(3)
    expect(created).toHaveLength(3)
    expect(peak).toBe(1)
    await Promise.all(runtimes.map((runtime) => runtime.stop(0)))
    await manager.stopAll()
  })

  it('suspends the idle sibling holding an inherited disk lock, then starts on the retry', async () => {
    const { manager, options, created } = await fixture()
    const sibling = { id: 'agent/session-sibling', mounts: [], workspaceRoot: '/workspace' }
    const blocked = { id: 'agent/session-blocked', mounts: [], workspaceRoot: '/workspace' }
    const idle = await occupy(manager, sibling)
    await idle.stop(0)
    const vm = created[0]!
    const volume = 'agentconnect-example-blocked-overlays'
    options.lockHolder = async () => ({ pid: 4242, sandbox: vm.name })
    interceptCreate(options, async (create) => {
      if (!vm.stopWithTimeout.mock.calls.length)
        throw new options.sdk.InvalidConfigError(
          `invalid config: volume "${volume}" is already attached with an incompatible disk mode`
        )
      return create()
    })
    const runtime = await occupy(manager, blocked)
    expect(vm.stopWithTimeout).toHaveBeenCalledOnce()
    expect(await manager.environmentIds()).toContain(sibling.id)
    expect(created).toHaveLength(2)
    await runtime.stop(0)
    await manager.stopAll()
  })

  it('keeps a busy lock holder running and reports who holds the disk instead', async () => {
    const { manager, options, created } = await fixture()
    const sibling = { id: 'agent/session-sibling', mounts: [], workspaceRoot: '/workspace' }
    const blocked = { id: 'agent/session-blocked', mounts: [], workspaceRoot: '/workspace' }
    const busy = await occupy(manager, sibling)
    const vm = created[0]!
    const volume = 'agentconnect-example-blocked-overlays'
    options.lockHolder = async () => ({ pid: 4242, sandbox: vm.name })
    interceptCreate(options, async () => {
      throw new options.sdk.InvalidConfigError(
        `invalid config: volume "${volume}" is already attached with an incompatible disk mode`
      )
    })
    await expect(occupy(manager, blocked)).rejects.toThrow(
      `volume "${volume}" is still locked by pid 4242 (sandbox ${vm.name})`
    )
    expect(vm.stopWithTimeout).not.toHaveBeenCalled()
    expect(created).toHaveLength(1)
    await busy.stop(0)
    await manager.stopAll()
  })

  it('leaves a lock holder this daemon has no binding for running', async () => {
    const { manager, options, created } = await fixture()
    const sibling = { id: 'agent/session-sibling', mounts: [], workspaceRoot: '/workspace' }
    const blocked = { id: 'agent/session-blocked', mounts: [], workspaceRoot: '/workspace' }
    const idle = await occupy(manager, sibling)
    await idle.stop(0)
    await manager.suspend(sibling.id)
    const vm = created[0]!
    const stops = vm.stopWithTimeout.mock.calls.length
    const bindings = join(options.root, 'microsandbox', 'bindings')
    for (const file of await readdir(bindings)) await rm(join(bindings, file))
    const volume = 'agentconnect-example-blocked-overlays'
    options.lockHolder = async () => ({ pid: 4242, sandbox: vm.name })
    interceptCreate(options, async () => {
      throw new options.sdk.InvalidConfigError(
        `invalid config: volume "${volume}" is already attached with an incompatible disk mode`
      )
    })
    await expect(occupy(manager, blocked)).rejects.toThrow(
      `volume "${volume}" is still locked by pid 4242 (sandbox ${vm.name})`
    )
    expect(vm.stopWithTimeout.mock.calls).toHaveLength(stops)
    expect(created).toHaveLength(1)
    await manager.stopAll()
  })
})
