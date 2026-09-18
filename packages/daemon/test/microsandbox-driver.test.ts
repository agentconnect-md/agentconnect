import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { createHash } from 'node:crypto'
import { decode, encode } from 'cborg'
import type { ExecEvent, ModifyOptions } from 'microsandbox'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MicrosandboxManager,
  type MicrosandboxEnvironment,
  type MicrosandboxManagerOptions
} from '../src/microsandbox/driver.js'
import { MICROSANDBOX_NODE } from '../src/microsandbox/exec.js'
import type { MicrosandboxShim } from '../src/microsandbox/shim.js'
import type { ShimConnection } from '../src/shim/connection.js'
import type { ShimFrame } from '../src/shim/protocol.js'
import { ShimSession } from '../src/shim/session.js'
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
        body: Buffer.from(encode({ v: 7, t: `core.exec.${kind}`, p: encode(payload) }))
      }
      if (kind === 'exited' || kind === 'failed') return
    }
  }
}

function fakeSdk() {
  class SandboxNotFoundError extends Error {}
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
  const created: FakeSandbox[] = []
  const processes: FakeExec[] = []
  let onRun: ((process: FakeExec) => void | Promise<void>) | undefined
  const images = new Map<string, number | null>([['test-image', 4_194_304]])
  const imageDigests = new Map<string, string>()
  const imageCache = {
    get: vi.fn(async (reference: string) => ({
      manifestDigest: imageDigests.get(reference) ?? `sha256:${createHash('sha256').update(reference).digest('hex')}`,
      os: 'linux',
      architecture: 'amd64'
    })),
    list: vi.fn(async () => [...images].map(([reference, sizeBytes]) => ({ reference, sizeBytes }))),
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
        const builder = {
          image(value: string) {
            image = value
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
              allowHost(value: string) {
                data.host.push(value)
                return entry
              },
              injectBasicAuth(value: boolean) {
                expect(value).toBe(false)
                return entry
              },
              injectQuery(value: boolean) {
                expect(value).toBe(false)
                return entry
              },
              injectBody(value: boolean) {
                expect(value).toBe(false)
                return entry
              }
            }
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
    imageCache,
    removeVolume,
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

type ShimInput = Parameters<NonNullable<MicrosandboxManagerOptions['startShim']>>[0]

/** One VM's shim, scripted: it opens ACP streams, echoes what is written to them, and ends one when asked to close it. */
class FakeShim implements MicrosandboxShim {
  readonly incarnation = 'fake-vm'
  readonly opens: Array<{ command: string; args: string[]; env: Record<string, string>; cwd?: string }> = []
  readonly closes: Array<{ streamId: string; deadlineMs?: number }> = []
  readonly session: ShimSession
  readonly stop = vi.fn(async () => this.session.lose('microsandbox shim stopped'))
  /** Answer a close without the runtime ever exiting: a child that survived SIGKILL, or a close that never landed. */
  unconfirmedClose = false
  private deliver: (text: string) => void = () => {}

  constructor(readonly input: ShimInput) {
    this.session = new ShimSession(input.subject, input.generation, {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (timer) => clearTimeout(timer as NodeJS.Timeout)
    })
    const connection: ShimConnection = {
      binding: {
        agentId: input.agentId,
        subject: input.subject,
        sandboxUid: 'fake-vm',
        generation: input.generation,
        grants: ['acp', 'tunnel'],
        podName: input.subject,
        podUid: 'fake-vm',
        expiresAtMs: Number.MAX_SAFE_INTEGER
      },
      issuedCredential: 'fake-credential',
      send: (frame) => queueMicrotask(() => this.serve(frame)),
      onFrame: (listener) => (this.deliver = listener),
      close: () => {}
    }
    this.session.attach(connection)
  }

  /** The shim process died: what the real pump reports when its exec stream ends. */
  die(): void {
    this.session.lose('sandbox shim exited')
    this.input.failed()
  }

  /** The runtime behind a stream ended on its own. */
  exit(streamId: string, error?: string): void {
    this.event(streamId, { kind: 'exit', code: error ? null : 0, signal: null, ...(error ? { error } : {}) })
  }

  event(streamId: string, event: Extract<ShimFrame, { type: 'shim/event' }>['event']): void {
    this.deliver(JSON.stringify({ type: 'shim/event', streamId, event }))
  }

  private serve(frame: ShimFrame): void {
    if (frame.type !== 'shim/request') return
    const payload = frame.payload as { op: string; streamId: string; data: string; deadlineMs?: number }
    const reply = (value?: unknown) =>
      this.deliver(JSON.stringify({ type: 'shim/response', id: frame.id, ok: true, payload: value }))
    if (payload.op === 'open') {
      this.opens.push(frame.payload as FakeShim['opens'][number])
      reply({ streamId: frame.id, resumableWrites: true })
    } else if (payload.op === 'chunk') {
      this.event(payload.streamId, { kind: 'chunk', data: payload.data })
      reply()
    } else {
      this.closes.push({ streamId: payload.streamId, deadlineMs: payload.deadlineMs })
      if (!this.unconfirmedClose) this.exit(payload.streamId)
      reply()
    }
  }
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
  let generation = 0
  const options: MicrosandboxManagerOptions = {
    root,
    config: { image: 'test-image', cpus: 2, memoryMiB: 2048, diskGiB: 10 },
    sdk: fake.sdk,
    msbCommand: { command: process.execPath, args: ['-e', ''] },
    kvmPreflight: () => {},
    sockets: { mcp: '/host/mcp.sock', gitcred: '/host/gitcred.sock' },
    nextShimGeneration: async () => ++generation,
    startShim: async (input) => {
      const shim = new FakeShim(input)
      shims.push(shim)
      return shim
    }
  }
  const manager = new MicrosandboxManager(options)
  const environment = { id: 'agent/session-example', mounts: [], workspaceRoot: '/workspace' }
  const request = { command: '/usr/local/bin/node', args: ['agent.js'], env: {} }
  return { ...fake, shims, manager, options, environment, request }
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
    const { manager, options, environment, request, created } = await fixture()
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
    await (await manager.driverFor(env).launch({ ...request, env: launch.env })).stop(0)
    await manager.stopAll()
    const resumed = new MicrosandboxManager(options)
    await (await resumed.driverFor(env).launch({ ...request, env: launch.env })).stop(0)
    expect(created).toHaveLength(1)
    await resumed.discard(env.id)
  })

  it('refuses host SDK state mounts even for a runtime without its own secrets', async () => {
    const { manager, options, environment, request, created } = await fixture()
    for (const path of ['', 'microsandbox', 'microsandbox/sandboxes']) {
      const env = {
        ...environment,
        mounts: [{ source: join(options.root, path), target: '/config', mode: 'readonly' as const }]
      }
      await expect(manager.driverFor(env).launch(request)).rejects.toThrow('cannot expose host sandbox state')
    }
    expect(created).toHaveLength(0)
    await manager.stopAll()
  })

  it.each(['api.deepseek.com', ['api.example.test', 'alternate.example.test']])(
    'keeps secrets scoped to %j and rotates them when the retained VM resumes',
    async (host) => {
      const { manager, options, environment, request, created, shims } = await fixture()
      let key = 'fixture-first-key'
      const secret = {
        env: 'DEEPSEEK_API_KEY',
        placeholder: 'fixture-placeholder',
        host,
        readValue: () => key
      }
      const env = { ...environment, secrets: [secret] }
      const launch = {
        ...request,
        env: { DEEPSEEK_API_KEY: secret.placeholder, NODE_EXTRA_CA_CERTS: '/.msb/tls/ca.pem' }
      }
      await (await manager.driverFor(env).launch(launch)).stop(0)
      expect(created[0]!.spec.secrets.DEEPSEEK_API_KEY!.value).toBe(key)
      expect(created[0]!.spec.secrets.DEEPSEEK_API_KEY!.host).toEqual([host].flat())
      expect(JSON.stringify(shims[0]!.opens[0])).not.toContain(key)
      expect(shims[0]!.opens[0]!.env).toMatchObject({ NODE_EXTRA_CA_CERTS: '/.msb/tls/ca.pem' })
      const directory = join(options.root, 'microsandbox', 'bindings')
      const path = join(directory, (await readdir(directory))[0]!)
      expect(await readFile(path, 'utf8')).not.toContain(key)
      await manager.stopAll()
      key = 'fixture-rotated-key'
      const resumed = new MicrosandboxManager(options)
      await (await resumed.driverFor(env).launch(launch)).stop(0)
      expect(created).toHaveLength(1)
      expect(created[0]!.spec.secrets.DEEPSEEK_API_KEY!.value).toBe(key)
      expect(await readFile(path, 'utf8')).not.toContain(key)
      await resumed.stopAll()
      created[0]!.modify.mockResolvedValueOnce({ applied: false, changes: [], conflicts: [] } as never)
      const restarted = new MicrosandboxManager(options)
      await (await restarted.driverFor(env).launch(launch)).stop(0)
      expect(created).toHaveLength(1)
      expect(created[0]!.status).toBe('running')
      await restarted.discard(env.id)
    }
  )

  it.each([false, true])('replaces the VM when its credential scope changes (protected=%s)', async (protectedVm) => {
    const { manager, options, environment, request, created, volumes } = await fixture()
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
    await (await manager.driverFor(protectedVm ? env : environment).launch(request)).stop(0)
    await manager.stopAll()
    const resumed = new MicrosandboxManager(options)
    await (await resumed.driverFor(protectedVm ? environment : env).launch(request)).stop(0)
    expect(created).toHaveLength(2)
    expect(created[0]!.destroy).toHaveBeenCalledOnce()
    expect(created[1]!.spec.secrets).toEqual(
      protectedVm ? {} : expect.objectContaining({ DEEPSEEK_API_KEY: expect.anything() })
    )
    expect(volumes.size).toBe(1)
    await resumed.discard(environment.id)
  })

  it('shares read-only bases while retaining and cleaning up each session overlay disk', async () => {
    const { manager, options, environment, request, created, volumes, removeVolume } = await fixture()
    const first: MicrosandboxEnvironment = {
      ...environment,
      mounts: [{ source: '/shared/store', target: '/session/home/store', mode: 'overlay' }]
    }
    const second = { ...first, id: 'agent/second-session' }
    for (const env of [first, second]) await (await manager.driverFor(env).launch(request)).stop(0)
    expect(volumes.size).toBe(4)
    for (const vm of created) {
      expect(vm.mounts).toEqual([
        { source: '/shared/store', target: expect.stringMatching(OVERLAY_BASE_ROOT), readonly: true }
      ])
      expect(vm.execWith).toHaveBeenCalledOnce()
    }
    await manager.stopAll()
    const resumed = new MicrosandboxManager(options)
    await (await resumed.driverFor(first).launch(request)).stop(0)
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
    const { manager, options, environment, request, created, volumes } = await fixture()
    const env: MicrosandboxEnvironment = {
      ...environment,
      mounts: [{ source: '/shared/store', target: '/cache/store', mode: 'overlay' }]
    }
    await (await manager.driverFor(env).launch(request)).stop(0)
    await manager.stopAll()
    const vm = created[0]!
    vm.execWith.mockResolvedValueOnce({ success: false, code: 1, stderr: () => 'mount failed' })
    const resumed = new MicrosandboxManager(options)
    await expect(resumed.driverFor(env).launch(request)).rejects.toThrow('overlay setup failed')
    expect(vm.status).toBe('stopped')
    expect(volumes.size).toBe(2)
    await (await resumed.driverFor(env).launch(request)).stop(0)
    await resumed.discard(env.id)
    expect(volumes.size).toBe(0)
  })

  it('prepares only layered image artifacts without stopping an existing VM', async () => {
    const { manager, options, environment, request, created } = await fixture()
    const runtime = await manager.driverFor(environment).launch(request)
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
    const { manager, options, environment, request, created, volumes, removeVolume } = await fixture()
    const runtime = await manager.driverFor(environment).launch(request)
    const volume = created[0]!.dockerVolume!
    await runtime.stop(0)
    await manager.stopAll()
    expect(volumes.has(volume)).toBe(true)
    expect(removeVolume).not.toHaveBeenCalled()

    const resumed = new MicrosandboxManager(options)
    vi.spyOn(created[0]!, 'connectOrStart').mockRejectedValueOnce(
      new options.sdk.InvalidConfigError(`volume "${volume}" is already attached with an incompatible disk mode`)
    )
    const restored = await resumed.driverFor(environment).launch(request)
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
    const { manager, options, environment, request, created, removeVolume } = await fixture()
    const runtime = await manager.driverFor(environment).launch(request)
    await runtime.stop(0)
    await manager.stopAll()
    const directory = join(options.root, 'microsandbox', 'bindings')
    const path = join(directory, (await readdir(directory))[0]!)
    const binding = JSON.parse(await readFile(path, 'utf8')) as { dockerVolume?: string }
    delete binding.dockerVolume
    await writeFile(path, JSON.stringify(binding))

    const resumed = new MicrosandboxManager(options)
    const restored = await resumed.driverFor(environment).launch(request)
    expect(created).toHaveLength(1)
    await restored.stop(0)
    await resumed.discard(environment.id)
    expect(removeVolume).not.toHaveBeenCalled()
  })

  it('starts one shim with the VM and runs every runtime through it, under the image environment', async () => {
    const { manager, options, environment, request, created, shims, processes } = await fixture()
    const [first, second] = await Promise.all([
      manager.driverFor(environment).launch({
        ...request,
        env: { PATH: '/session/bin' },
        hints: [{ envVar: 'CLAUDE_CODE_EXECUTABLE', command: 'claude' }]
      }),
      manager.driverFor(environment).launch(request)
    ])
    expect(created).toHaveLength(1)
    expect(shims).toHaveLength(1)
    expect(shims[0]!.input).toMatchObject({
      subject: environment.id,
      agentId: 'agent',
      generation: 1,
      workspaceRoot: '/workspace',
      sockets: options.sockets
    })
    await vi.waitFor(() => expect(shims[0]!.opens).toHaveLength(2))
    // The launch environment wins over the image's, the runtime starts in the workspace, and hints resolve in the guest.
    expect(shims[0]!.opens[0]).toEqual({
      op: 'open',
      command: request.command,
      args: request.args,
      env: { PATH: '/session/bin' },
      cwd: '/workspace',
      hints: [{ envVar: 'CLAUDE_CODE_EXECUTABLE', command: 'claude' }]
    })
    expect(shims[0]!.opens[1]!.env).toEqual({ PATH: '/image/bin' })
    // No process of the runtime's is started over the guest agent's exec channel any more.
    expect(processes).toHaveLength(0)
    const writer = first.toAgent.getWriter()
    const reader = first.fromAgent.getReader()
    const bytes = Uint8Array.of(0, 255, 10, 13, 128)
    await writer.write(bytes)
    expect(new Uint8Array((await reader.read()).value!)).toEqual(bytes)
    await expect(manager.suspend(environment.id)).rejects.toThrow('2 active executions')
    const terminal = vi.fn()
    first.onExit(terminal)
    await first.stop(1_234)
    expect(shims[0]!.closes).toEqual([{ streamId: expect.any(String), deadlineMs: 1_234 }])
    expect(terminal).toHaveBeenCalledOnce()
    await expect(manager.suspend(environment.id)).rejects.toThrow('1 active executions')
    await second.toAgent.getWriter().write(bytes)
    expect(new Uint8Array((await second.fromAgent.getReader().read()).value!)).toEqual(bytes)
    await second.stop(1)
    await manager.suspendIdle(Date.now())
    expect(created[0]!.status).toBe('stopped')
    expect(shims[0]!.stop).toHaveBeenCalledOnce()
    expect(await manager.environmentIds()).toEqual([environment.id])
    // A resumed VM is a new incarnation: its shim is started again, at the next generation.
    await (await manager.driverFor(environment).launch(request)).stop(0)
    expect(created).toHaveLength(1)
    expect(shims).toHaveLength(2)
    expect(shims[1]!.input.generation).toBe(2)
    await manager.discard(environment.id)
    expect(await manager.environmentIds()).toEqual([])
  })

  it('keeps one runtime out of another stream on the same shim, and a tunnel out of both', async () => {
    const { manager, environment, request, shims } = await fixture()
    const first = await manager.driverFor(environment).launch(request)
    const second = await manager.driverFor(environment).launch(request)
    const exited = vi.fn()
    second.onExit(exited)
    const reader = second.fromAgent.getReader()
    // A helper connection closing in the VM is an `exit` on the same session, for a stream neither runtime owns.
    shims[0]!.exit('00000000-0000-4000-8000-000000000000')
    await first.toAgent.getWriter().write(Buffer.from('first only\n'))
    await second.toAgent.getWriter().write(Buffer.from('second\n'))
    expect(Buffer.from((await reader.read()).value!).toString()).toBe('second\n')
    expect(exited).not.toHaveBeenCalled()
    await Promise.all([first.stop(0), second.stop(0)])
    await manager.discard(environment.id)
  })

  it('drops the runtime stderr of a launch that asked for silence, and passes every other one through', async () => {
    const { manager, environment, request, shims } = await fixture()
    const written = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const loud = await manager.driverFor(environment).launch(request)
      shims[0]!.input.runtimeStderr('runtime warning\n')
      expect(written).toHaveBeenCalledExactlyOnceWith('runtime warning\n')
      const quiet = await manager.driverFor(environment).launch({ ...request, suppressChildStderr: true })
      shims[0]!.input.runtimeStderr('probe output\n')
      expect(written).toHaveBeenCalledOnce()
      await quiet.stop(0)
      shims[0]!.input.runtimeStderr('runtime warning\n')
      expect(written).toHaveBeenCalledTimes(2)
      await loud.stop(0)
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

  it('fences saved VMs at startup and refuses changed persistent configuration', async () => {
    const { manager, options, environment, request, created } = await fixture()
    const runtime = await manager.driverFor(environment).launch(request)
    await runtime.stop(0)
    const resumed = new MicrosandboxManager(options)
    expect(await resumed.environmentIds()).toEqual([environment.id])
    await expect(resumed.prepare()).resolves.toEqual({
      runtimes: [{ id: 'test' }],
      mcpBridge: { command: '/image/node', args: [SANDBOX_MCP_BRIDGE_ENTRY] }
    })
    expect(created[0]!.status).toBe('stopped')
    created[0]!.spec.image = 'changed-outside-daemon'
    await expect(resumed.driverFor(environment).launch(request)).rejects.toThrow('changed persisted configuration')
    await manager.discard(environment.id)
  })

  it('reuses an alias with the same platform digest and refreshes a changed image without ACP', async () => {
    const { manager, options, environment, created, imageDigests, imageCache, shims } = await fixture()
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
    expect(shims.flatMap((shim) => shim.opens)).toHaveLength(0)
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

  it('waits for VM preparation during shutdown without launching ACP', async () => {
    const { manager, environment, created, shims } = await fixture()
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
    expect(shims.flatMap((shim) => shim.opens)).toHaveLength(0)
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
    const { manager, options, environment, request, images } = await fixture()
    await (await manager.driverFor(environment).launch(request)).stop(0)
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

  it('starts when the image cache cannot be read', async () => {
    const { options, imageCache } = await fixture()
    imageCache.list.mockRejectedValueOnce(new Error('image cache is locked'))
    await expect(new MicrosandboxManager(options).prepare()).resolves.toBeDefined()
    expect(imageCache.remove).not.toHaveBeenCalled()
  })

  it('keeps active executions and replaces idle VMs when mounts change', async () => {
    const { manager, options, environment, request, created, shims } = await fixture()
    const workspace = join(options.root, 'workspace')
    await mkdir(workspace)
    await writeFile(join(workspace, 'uncommitted.txt'), 'keep')
    const original: MicrosandboxEnvironment = {
      ...environment,
      mounts: [{ source: workspace, target: '/workspace', mode: 'writable' }]
    }
    const runtime = await manager.driverFor(original).launch(request)
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
    expect(shims.map((shim) => shim.opens.length)).toEqual([1, 0])
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
    const { manager, options, environment, request } = await fixture()
    vi.spyOn(options.sdk.Sandbox, 'get').mockRejectedValueOnce(new Error('temporary lookup failure'))
    await expect(manager.driverFor(environment).launch(request)).rejects.toThrow('temporary lookup failure')
    const runtime = await manager.driverFor(environment).launch(request)
    await runtime.stop(0)
    await manager.discard(environment.id)
  })

  it('ends the runtime when its shim is lost, then stops the VM before resuming it from the retained disk', async () => {
    const { manager, environment, request, created, shims } = await fixture()
    const driver = manager.driverFor(environment)
    const runtime = await driver.launch(request)
    const terminal = vi.fn()
    runtime.onExit(terminal)
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
    shims[0]!.die()
    // The host learns at once, the way it did from a dead exec stream: its runtime is over and the next turn rebuilds it.
    expect(terminal).toHaveBeenCalledOnce()
    expect((await runtime.fromAgent.getReader().read()).done).toBe(true)
    await stopped
    await expect(driver.launch(request)).rejects.toThrow('is stopping')
    expect(vm.stopWithTimeout).not.toHaveBeenCalled()
    const firstStop = manager.suspend(environment.id)
    release()
    await expect(firstStop).rejects.toThrow('temporary VM stop failure')
    expect(await manager.environmentIds()).toEqual([environment.id])

    await expect(driver.launch(request)).rejects.toThrow('transport failed')
    await manager.suspend(environment.id)
    expect(vm.status).toBe('stopped')
    const recovered = await driver.launch(request)
    expect(created).toHaveLength(1)
    expect(vm.status).toBe('running')
    expect(shims).toHaveLength(2)
    const bytes = new TextEncoder().encode('recovered\n')
    await recovered.toAgent.getWriter().write(bytes)
    expect(new Uint8Array((await recovered.fromAgent.getReader().read()).value!)).toEqual(bytes)
    await recovered.stop(0)
    await manager.discard(environment.id)
  })

  it('fences the VM when a stop is not confirmed by the runtime exiting', async () => {
    const { manager, environment, request, created, shims } = await fixture()
    const driver = manager.driverFor(environment)
    const runtime = await driver.launch(request)
    const terminal = vi.fn()
    runtime.onExit(terminal)
    shims[0]!.unconfirmedClose = true
    await runtime.stop(1)
    // Stopping the VM ends what the shim could not, and releases the execution the runtime held.
    await vi.waitFor(() => expect(created[0]!.status).toBe('stopped'))
    expect(terminal).toHaveBeenCalledOnce()
    expect(shims[0]!.stop).toHaveBeenCalledOnce()
    const recovered = await driver.launch(request)
    expect(created).toHaveLength(1)
    expect(shims).toHaveLength(2)
    await recovered.stop(0)
    await manager.discard(environment.id)
  })

  it('refuses the VM when its shim cannot start, and starts it again on the next launch', async () => {
    const { manager, options, environment, request, created, shims } = await fixture()
    const start = options.startShim!
    options.startShim = vi.fn(start).mockRejectedValueOnce(new Error('tunnel gitcred could not listen'))
    await expect(manager.driverFor(environment).launch(request)).rejects.toThrow('tunnel gitcred could not listen')
    expect(shims).toHaveLength(0)
    expect(created[0]!.destroy).toHaveBeenCalledOnce()
    await (await manager.driverFor(environment).launch(request)).stop(0)
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
    const { manager, environment, request, created, processes, runWith } = await fixture()
    const driver = manager.driverFor(environment)
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
    await expect(driver.launch(request)).rejects.toThrow('is stopping')
    expect(vm.stopWithTimeout).not.toHaveBeenCalled()
    releaseOpening()
    await opening
    expect(processes[1]!.close).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(vm.stopWithTimeout).toHaveBeenCalledOnce())
    expect(processes).toHaveLength(2)
    releaseStop()
    await manager.suspend(environment.id)
    expect(vm.status).toBe('stopped')
    const recovered = await driver.launch(request)
    expect(vm.status).toBe('running')
    expect(created).toHaveLength(1)
    await recovered.stop(0)
    await manager.discard(environment.id)
  })

  it('closes a timed-out command without closing another active stream', async () => {
    const { manager, environment, request, processes } = await fixture()
    const runtime = await manager.driverFor(environment).launch(request)
    await expect(manager.exec(environment, 'test', [], { timeoutMs: 1 })).rejects.toThrow('timed out')
    expect(processes[0]!.signal).toHaveBeenCalledWith(15)
    expect(processes[0]!.close).toHaveBeenCalledOnce()
    const bytes = new TextEncoder().encode('still running\n')
    await runtime.toAgent.getWriter().write(bytes)
    expect(new Uint8Array((await runtime.fromAgent.getReader().read()).value!)).toEqual(bytes)
    await runtime.stop(0)
    await manager.suspend(environment.id)
  })

  it('starts one VM at a time so a start cannot inherit the disk locks of another', async () => {
    const { manager, options, request, created } = await fixture()
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
    const runtimes = await Promise.all(environments.map((env) => manager.driverFor(env).launch(request)))
    expect(slowCreate).toHaveBeenCalledTimes(3)
    expect(created).toHaveLength(3)
    expect(peak).toBe(1)
    await Promise.all(runtimes.map((runtime) => runtime.stop(0)))
    await manager.stopAll()
  })

  it('suspends the idle sibling holding an inherited disk lock, then starts on the retry', async () => {
    const { manager, options, request, created } = await fixture()
    const sibling = { id: 'agent/session-sibling', mounts: [], workspaceRoot: '/workspace' }
    const blocked = { id: 'agent/session-blocked', mounts: [], workspaceRoot: '/workspace' }
    const idle = await manager.driverFor(sibling).launch(request)
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
    const runtime = await manager.driverFor(blocked).launch(request)
    expect(vm.stopWithTimeout).toHaveBeenCalledOnce()
    expect(await manager.environmentIds()).toContain(sibling.id)
    expect(created).toHaveLength(2)
    await runtime.stop(0)
    await manager.stopAll()
  })

  it('keeps a busy lock holder running and reports who holds the disk instead', async () => {
    const { manager, options, request, created } = await fixture()
    const sibling = { id: 'agent/session-sibling', mounts: [], workspaceRoot: '/workspace' }
    const blocked = { id: 'agent/session-blocked', mounts: [], workspaceRoot: '/workspace' }
    const busy = await manager.driverFor(sibling).launch(request)
    const vm = created[0]!
    const volume = 'agentconnect-example-blocked-overlays'
    options.lockHolder = async () => ({ pid: 4242, sandbox: vm.name })
    interceptCreate(options, async () => {
      throw new options.sdk.InvalidConfigError(
        `invalid config: volume "${volume}" is already attached with an incompatible disk mode`
      )
    })
    await expect(manager.driverFor(blocked).launch(request)).rejects.toThrow(
      `volume "${volume}" is still locked by pid 4242 (sandbox ${vm.name})`
    )
    expect(vm.stopWithTimeout).not.toHaveBeenCalled()
    expect(created).toHaveLength(1)
    await busy.stop(0)
    await manager.stopAll()
  })

  it('leaves a lock holder this daemon has no binding for running', async () => {
    const { manager, options, request, created } = await fixture()
    const sibling = { id: 'agent/session-sibling', mounts: [], workspaceRoot: '/workspace' }
    const blocked = { id: 'agent/session-blocked', mounts: [], workspaceRoot: '/workspace' }
    const idle = await manager.driverFor(sibling).launch(request)
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
    await expect(manager.driverFor(blocked).launch(request)).rejects.toThrow(
      `volume "${volume}" is still locked by pid 4242 (sandbox ${vm.name})`
    )
    expect(vm.stopWithTimeout.mock.calls).toHaveLength(stops)
    expect(created).toHaveLength(1)
    await manager.stopAll()
  })
})
