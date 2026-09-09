import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { decode, encode } from 'cborg'
import type { ExecEvent } from 'microsandbox'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MicrosandboxManager, type MicrosandboxManagerOptions } from '../src/microsandbox/driver.js'
import { MICROSANDBOX_NODE } from '../src/microsandbox/exec.js'
import { SANDBOX_MCP_BRIDGE_ENTRY } from '../src/shim/sandbox-paths.js'

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

  class FakeSandbox {
    readonly id = `vm-${created.length}`
    status = 'running'
    readonly processes: FakeExec[] = []
    readonly spec = {
      image: 'test-image',
      env: [{ key: 'PATH', value: '/image/bin' }],
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
      if (this.dockerVolume && volumes.has(this.dockerVolume)) volumes.get(this.dockerVolume)!.attached = false
    })

    constructor(
      readonly name: string,
      readonly dockerVolume?: string
    ) {}
    config() {
      return this.spec
    }
    async startDetached() {
      if (this.dockerVolume) {
        const volume = volumes.get(this.dockerVolume)!
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
    readonly exec = vi.fn(async (command: string, args: string[]) => {
      expect(command).toBe(MICROSANDBOX_NODE)
      expect(args[0]).toBe('-e')
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
        ['-I', '-c', expect.stringContaining('socket.socket(socket.AF_VSOCK')],
        { timeout: 10_000 }
      )
      return { success: true, code: 0, stdout: () => stdout }
    })
  }

  const sdk = {
    SandboxNotFoundError,
    VolumeNotFoundError,
    InvalidConfigError,
    Volume: { remove: removeVolume },
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
            if (process.request.cmd === '/usr/bin/python3')
              process.push({ kind: 'stdout', data: Buffer.from('ready\n') })
            else {
              processes.push(process)
              await onRun?.(process)
            }
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
        let dockerVolume: string | undefined
        let image = 'test-image'
        const builder = {
          image(value: string) {
            image = value
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
          volume(target: string, configure: (volume: { namedWith: (name: string) => unknown }) => unknown) {
            if (target === '/var/lib/docker')
              configure({
                namedWith(name) {
                  dockerVolume = name
                  return this
                }
              })
            return builder
          },
          vsock() {
            return builder
          },
          async create() {
            if (dockerVolume) {
              if (volumes.has(dockerVolume)) throw new Error('volume already exists')
              volumes.set(dockerVolume, { attached: true })
            }
            const sandbox = new FakeSandbox(name, dockerVolume)
            sandbox.spec.image = image
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
    removeVolume,
    runWith: (callback: (process: FakeExec) => void | Promise<void>) => {
      onRun = callback
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
  const options: MicrosandboxManagerOptions = {
    root,
    config: { image: 'test-image', cpus: 2, memoryMiB: 2048, diskGiB: 10 },
    sdk: fake.sdk,
    msbCommand: { command: process.execPath, args: ['-e', ''] },
    sockets: { mcp: '/host/mcp.sock', gitcred: '/host/gitcred.sock' }
  }
  const manager = new MicrosandboxManager(options)
  const environment = { id: 'agent/session-example', mounts: [], workspaceRoot: '/workspace' }
  const request = { command: '/usr/local/bin/node', args: ['agent.js'], env: {} }
  return { ...fake, manager, options, environment, request }
}

describe('microsandbox process and VM ownership', () => {
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

  it('shares a VM, preserves binary ACP data, and refuses suspend while another execution is active', async () => {
    const { manager, environment, request, created, processes } = await fixture()
    const [first, second] = await Promise.all([
      manager.driverFor(environment).launch({ ...request, env: { PATH: '/session/bin' } }),
      manager.driverFor(environment).launch(request)
    ])
    expect(created).toHaveLength(1)
    expect(created[0]!.processes[0]!.request).toMatchObject({
      cwd: '/image',
      env: ['PATH=/image/bin'],
      user: 'agent'
    })
    expect(processes[0]!.request).toMatchObject({
      cmd: request.command,
      args: request.args,
      cwd: '/workspace',
      env: ['PATH=/session/bin'],
      user: 'agent',
      tty: false
    })
    expect(processes[1]!.request?.env).toEqual(['PATH=/image/bin'])
    const writer = first.toAgent.getWriter()
    const reader = first.fromAgent.getReader()
    const bytes = Uint8Array.of(0, 255, 10, 13, 128)
    await writer.write(bytes)
    expect((await reader.read()).value).toEqual(bytes)
    await expect(manager.suspend(environment.id)).rejects.toThrow('2 active executions')
    let releaseClose!: () => void
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve
    })
    processes[0]!.close.mockImplementationOnce(() => closeGate)
    const terminal = vi.fn()
    const exited = new Promise<void>((resolve) => first.onExit(resolve))
    first.onExit(terminal)
    processes[0]!.push({ kind: 'exited', code: 0 })
    await vi.waitFor(() => expect(processes[0]!.close).toHaveBeenCalledOnce())
    expect(terminal).not.toHaveBeenCalled()
    const stopped = vi.fn()
    const stdinClosed = vi.fn()
    const stopping = first.stop(1).then(stopped)
    const closingStdin = writer.close().then(stdinClosed)
    await expect(manager.suspend(environment.id)).rejects.toThrow('2 active executions')
    await second.toAgent.getWriter().write(bytes)
    expect((await second.fromAgent.getReader().read()).value).toEqual(bytes)
    expect(processes[1]!.close).not.toHaveBeenCalled()
    expect(processes[0]!.signal).not.toHaveBeenCalled()
    expect(processes[0]!.kill).not.toHaveBeenCalled()
    expect(processes[0]!.stdin).toHaveBeenCalledExactlyOnceWith(bytes)
    expect(stopped).not.toHaveBeenCalled()
    expect(stdinClosed).not.toHaveBeenCalled()
    releaseClose()
    await Promise.all([exited, stopping, closingStdin])
    expect(stopped).toHaveBeenCalledOnce()
    expect(stdinClosed).toHaveBeenCalledOnce()
    await expect(manager.suspend(environment.id)).rejects.toThrow('1 active executions')
    processes[1]!.signal.mockImplementation(async () => {})
    await second.stop(1)
    expect(processes[1]!.kill).toHaveBeenCalledOnce()
    expect(processes[1]!.close).toHaveBeenCalledOnce()
    await manager.suspendIdle(Date.now())
    expect(created[0]!.status).toBe('stopped')
    expect(created[0]!.processes[0]!.close).toHaveBeenCalledOnce()
    expect(await manager.environmentIds()).toEqual([environment.id])
    await manager.discard(environment.id)
    expect(await manager.environmentIds()).toEqual([])
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

  it('closes a terminal failure before releasing the execution without hanging readers', async () => {
    const { manager, environment, request, processes, runWith } = await fixture()
    let releaseClose!: () => void
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve
    })
    runWith((process) => {
      process.close.mockImplementationOnce(() => closeGate)
      process.push(undefined)
    })
    const runtime = await manager.driverFor(environment).launch(request)
    const exited = new Promise<void>((resolve) => runtime.onExit(resolve))
    const terminal = vi.fn()
    runtime.onExit(terminal)
    const read = expect(runtime.fromAgent.getReader().read()).rejects.toThrow('guest execution failed')
    await vi.waitFor(() => expect(processes[0]!.close).toHaveBeenCalledOnce())
    expect(terminal).not.toHaveBeenCalled()
    await expect(manager.suspend(environment.id)).rejects.toThrow('1 active executions')
    releaseClose()
    await read
    await exited
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

  it('pins retained VM images while new environments use the configured image', async () => {
    const { manager, options, environment, request, created } = await fixture()
    await (await manager.driverFor(environment).launch(request)).stop(0)
    await manager.stopAll()
    const upgraded = { ...options, config: { ...options.config, image: 'next-image' } }
    await expect(
      new MicrosandboxManager({ ...upgraded, config: { ...upgraded.config, cpus: 4 } })
        .driverFor(environment)
        .launch(request)
    ).rejects.toThrow('changed persisted configuration')
    const resumed = new MicrosandboxManager(upgraded)
    await expect(
      resumed
        .driverFor({ ...environment, mounts: [{ source: '/extra', target: '/extra', readOnly: true }] })
        .launch(request)
    ).rejects.toThrow('changed persisted configuration')
    await (await resumed.driverFor(environment).launch(request)).stop(0)
    expect(created).toHaveLength(1)
    expect(created[0]!.spec.image).toBe('test-image')
    expect(created[0]!.destroy).not.toHaveBeenCalled()
    const next = { ...environment, id: 'agent/new-session' }
    await (await resumed.driverFor(next).launch(request)).stop(0)
    expect(created[1]!.spec.image).toBe('next-image')
    await resumed.stopAll()
    const restarted = new MicrosandboxManager({ ...upgraded, config: { ...upgraded.config, image: 'later-image' } })
    for (const env of [environment, next]) {
      await (await restarted.driverFor(env).launch(request)).stop(0)
      await restarted.discard(env.id)
    }
    expect(created).toHaveLength(2)
  })

  it('resumes the retained VM after retiring only the known guest helper mount', async () => {
    const { manager, options, environment, request, created } = await fixture()
    const helpers = join(options.root, 'microsandbox', 'helpers')
    await mkdir(helpers, { recursive: true })
    const helper = join(helpers, 'guest.js')
    await writeFile(helper, 'export {}')
    const legacy = {
      ...environment,
      mounts: [{ source: await realpath(helper), target: '/opt/agentconnect-local/guest.js', readOnly: true }]
    }
    const runtime = await manager.driverFor(legacy).launch(request)
    await runtime.stop(0)
    await manager.stopAll()
    const resumed = new MicrosandboxManager({
      ...options,
      config: { ...options.config, image: 'next-image' }
    })
    await expect(
      resumed
        .driverFor({
          ...environment,
          mounts: [{ source: '/workspace-other', target: '/workspace-other', readOnly: false }]
        })
        .launch(request)
    ).rejects.toThrow('changed persisted configuration')
    const changed = new MicrosandboxManager({ ...options, config: { ...options.config, cpus: 4 } })
    await expect(changed.driverFor(environment).launch(request)).rejects.toThrow('changed persisted configuration')
    const restored = await resumed.driverFor(environment).launch(request)
    expect(created).toHaveLength(1)
    expect(created[0]!.destroy).not.toHaveBeenCalled()
    await restored.stop(0)
    await resumed.discard(environment.id)
  })

  it('retries a failed VM lookup without retaining a rejected launch', async () => {
    const { manager, options, environment, request } = await fixture()
    vi.spyOn(options.sdk.Sandbox, 'get').mockRejectedValueOnce(new Error('temporary lookup failure'))
    await expect(manager.driverFor(environment).launch(request)).rejects.toThrow('temporary lookup failure')
    const runtime = await manager.driverFor(environment).launch(request)
    await runtime.stop(0)
    await manager.discard(environment.id)
  })

  it('drains a failed bridge before retrying VM stop and resuming from the retained disk', async () => {
    const { manager, environment, request, created, processes } = await fixture()
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
    processes[0]!.signal.mockImplementationOnce(async () => {
      stopping()
      await blocked
      processes[0]!.push({ kind: 'exited', code: 0 })
    })
    const vm = created[0]!
    vm.stopWithTimeout.mockRejectedValueOnce(new Error('temporary VM stop failure'))
    vm.processes[0]!.push({ kind: 'exited', code: 1 })
    await stopped
    await expect(driver.launch(request)).rejects.toThrow('is stopping')
    expect(vm.stopWithTimeout).not.toHaveBeenCalled()
    const firstStop = manager.suspend(environment.id)
    release()
    await expect(firstStop).rejects.toThrow('temporary VM stop failure')
    expect(terminal).toHaveBeenCalledOnce()
    expect(await manager.environmentIds()).toEqual([environment.id])

    await expect(driver.launch(request)).rejects.toThrow('transport failed')
    await manager.suspend(environment.id)
    expect(vm.status).toBe('stopped')
    const recovered = await driver.launch(request)
    expect(created).toHaveLength(1)
    expect(vm.status).toBe('running')
    const bytes = new TextEncoder().encode('recovered\n')
    await recovered.toAgent.getWriter().write(bytes)
    expect((await recovered.fromAgent.getReader().read()).value).toEqual(bytes)
    await recovered.stop(0)
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
    const runtime = await driver.launch(request)
    const vm = created[0]!
    let releaseOpening!: () => void
    const openingGate = new Promise<void>((resolve) => {
      releaseOpening = resolve
    })
    runWith(() => openingGate)
    const opening = expect(driver.launch(request)).rejects.toThrow('is stopping')
    await vi.waitFor(() => expect(processes).toHaveLength(2))
    let releaseStop!: () => void
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve
    })
    vm.stopWithTimeout.mockImplementationOnce(async () => {
      await stopGate
      vm.status = 'stopped'
    })
    const read = expect(runtime.fromAgent.getReader().read()).rejects.toThrow('transport disconnected')
    processes[0]!.push(new Error('transport disconnected'))
    await read
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
    expect(processes[1]!.signal).toHaveBeenCalledWith(15)
    expect(processes[1]!.close).toHaveBeenCalledOnce()
    expect(processes[0]!.close).not.toHaveBeenCalled()
    const bytes = new TextEncoder().encode('still running\n')
    await runtime.toAgent.getWriter().write(bytes)
    expect((await runtime.fromAgent.getReader().read()).value).toEqual(bytes)
    await runtime.stop(0)
    await manager.suspend(environment.id)
  })
})
