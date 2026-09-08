import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, posix } from 'node:path'
import { promisify } from 'node:util'
import type { ExecHandle, ExecSink, Sandbox, SandboxHandle } from 'microsandbox'
import type { SpawnDriver, SpawnedRuntime, SpawnRequest } from '../acp/spawn-driver.js'
import type { SandboxMount } from '../config/config-schema.js'
import type { Logger } from '../log.js'
import { K8sRuntimeTableSchema, type K8sRuntimeTable } from '../runtimes/k8s-runtimes.js'
import { SinkRelPathSchema } from '../shim/file-sink.js'
import { SANDBOX_MCP_BRIDGE_ENTRY } from '../shim/sandbox-paths.js'
import { MICROSANDBOX_GUEST_ENTRY, MICROSANDBOX_NODE } from './guest.js'

const runFile = promisify(execFile)
const STOP_TIMEOUT_MS = 10_000
const RUNTIME_TABLE_PATH = '/opt/agentconnect/runtime/k8s-runtimes.json'
const IMAGE_PROBE_SCRIPT = `
const { existsSync, readFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
execFileSync('/usr/bin/python3', ['-c', 'import socket; socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM).close()'], { timeout: 10000 });
const table = JSON.parse(readFileSync(process.argv[1], 'utf8'));
const bridge = process.argv[2];
if (existsSync(bridge)) table.mcpBridge = { command: process.execPath, args: [bridge] };
process.stdout.write(JSON.stringify(table));
`

export interface MicrosandboxEnvironment {
  id: string
  mounts: SandboxMount[]
  workspaceRoot: string
}

export interface MicrosandboxExecOptions {
  env?: Record<string, string>
  cwd?: string
  abort?: AbortSignal
  timeoutMs?: number
  maxBytes?: number
}

export interface MicrosandboxExecResult {
  stdout: string
  stderr: string
  exitCode: number
}

export interface MicrosandboxManagerOptions {
  root: string
  config: { image: string; cpus: number; memoryMiB: number; diskGiB: number }
  sdk: Pick<typeof import('microsandbox'), 'Sandbox' | 'SandboxNotFoundError'>
  msbCommand: { command: string; args: string[] }
  log?: Logger
  sockets: { mcp: string; gitcred: string }
}

interface EnvironmentState {
  environment: MicrosandboxEnvironment
  spec: string
  sandbox: Promise<Sandbox>
  active: number
  closing?: Promise<void>
  bridgeFailed?: boolean
  processes: Set<MicrosandboxProcess>
  pending: Set<Promise<void>>
  lastUsed: number
}

interface Binding {
  version: 1
  spec: string
  sandboxId: string
  configHash: string
  environmentId: string
}

/** Owns VM lifecycle while exposing the existing ACP process-stream contract. */
export class MicrosandboxManager {
  private readonly environments = new Map<string, EnvironmentState>()
  private readonly bridges = new Map<string, MicrosandboxProcess>()
  private preparation?: Promise<K8sRuntimeTable>
  private closed = false

  constructor(private readonly options: MicrosandboxManagerOptions) {}

  prepare(): Promise<K8sRuntimeTable> {
    return (this.preparation ??= this.probe())
  }

  driverFor(environment: MicrosandboxEnvironment): SpawnDriver {
    return { launch: (request) => this.launch(environment, request) }
  }

  async exec(
    environment: MicrosandboxEnvironment,
    command: string,
    args: string[],
    options: MicrosandboxExecOptions = {}
  ): Promise<MicrosandboxExecResult> {
    options.abort?.throwIfAborted()
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let bytes = 0
    const append = (chunks: Buffer[], chunk: Uint8Array) => {
      bytes += chunk.byteLength
      if (bytes > (options.maxBytes ?? 16 * 1024 * 1024)) throw new Error('microsandbox exec output limit exceeded')
      chunks.push(Buffer.from(chunk))
    }
    const runtime = await this.startProcess(environment, command, args, options, (chunk) => append(stderr, chunk))
    let failure: unknown
    const abort = () => {
      failure ??= options.abort?.reason ?? new Error('microsandbox exec aborted')
      void runtime.stop(STOP_TIMEOUT_MS).catch((error: unknown) => runtime.fail(error))
    }
    options.abort?.addEventListener('abort', abort, { once: true })
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            failure ??= new Error('microsandbox exec timed out')
            void runtime.stop(STOP_TIMEOUT_MS).catch((error: unknown) => runtime.fail(error))
          }, options.timeoutMs)
    if (options.abort?.aborted) abort()
    try {
      await runtime.closeStdin()
      for await (const chunk of runtime.fromAgent) append(stdout, chunk)
      const exitCode = await runtime.exited
      if (failure !== undefined) throw failure
      return {
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        exitCode
      }
    } catch (error) {
      await runtime.stop(STOP_TIMEOUT_MS)
      throw error
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      options.abort?.removeEventListener('abort', abort)
    }
  }

  async suspend(id: string): Promise<void> {
    await this.closeEnvironment(id, false)
  }

  async discard(id: string): Promise<void> {
    await this.closeEnvironment(id, true)
  }

  environment(id: string): MicrosandboxEnvironment | undefined {
    return this.environments.get(id)?.environment
  }

  async environmentIds(): Promise<string[]> {
    return [...new Set([...this.environments.keys(), ...(await this.persistedIds())])]
  }

  async suspendIdle(idleBefore: number): Promise<void> {
    for (const [id, state] of this.environments) {
      if (!state.closing && state.active === 0 && state.lastUsed <= idleBefore) await this.suspend(id)
    }
  }

  async stopAll(): Promise<void> {
    this.closed = true
    const results = await Promise.allSettled(
      [...this.environments.entries()].map(async ([id, state]) => {
        await Promise.all([...state.pending])
        await Promise.all([...state.processes].map((process) => process.stop(STOP_TIMEOUT_MS)))
        await this.suspend(id)
      })
    )
    const errors = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))
    if (errors.length) throw new AggregateError(errors, 'microsandbox shutdown failed')
  }

  private name(id: string): string {
    return `agentconnect-${hash(this.options.root).slice(0, 12)}-${hash(id).slice(0, 24)}`
  }

  private bindingPath(id: string): string {
    return join(this.options.root, 'microsandbox', 'bindings', `${this.name(id)}.json`)
  }

  private spec(environment: MicrosandboxEnvironment): string {
    return stableJson({
      version: 2,
      config: this.options.config,
      environment: { ...environment, mounts: [...environment.mounts].sort((a, b) => a.target.localeCompare(b.target)) },
      sockets: this.options.sockets
    })
  }

  private builder(name: string, mounts: SandboxMount[]) {
    const builder = this.options.sdk.Sandbox.builder(name)
      .image(this.options.config.image)
      .rootDisk((disk) =>
        disk
          .flat()
          .size(this.options.config.diskGiB * 1024)
          .cloneStrategy('auto')
      )
      .cpus(this.options.config.cpus)
      .memory(this.options.config.memoryMiB)
      .deploymentProfile('single-tenant')
      .detached(true)
      .ephemeral(false)
      .volume('/run', (volume) => volume.tmpfs())
      .quietLogs()
    for (const mount of mounts) {
      builder.volume(mount.target, (volume) => {
        volume.bind(mount.source)
        return mount.readOnly ? volume.readonly() : volume
      })
    }
    return builder
  }

  private async probe(): Promise<K8sRuntimeTable> {
    const bindings = join(this.options.root, 'microsandbox', 'bindings')
    await mkdir(bindings, { recursive: true, mode: 0o700 })
    for (const id of await this.persistedIds()) {
      const binding = await this.readBinding(id)
      const handle = await this.find(this.name(id))
      if (handle) {
        if (handle.id !== binding?.sandboxId) throw new Error('microsandbox persisted environment identity changed')
        if (handle.status === 'running' || handle.status === 'starting' || handle.status === 'draining') {
          await handle.stopWithTimeout(STOP_TIMEOUT_MS)
        }
      }
    }
    const { command, args } = this.options.msbCommand
    await runFile(command, [...args, 'pull', this.options.config.image, '--materialize', 'all', '--quiet'], {
      env: { ...process.env, MSB_HOME: join(this.options.root, 'microsandbox'), MSB_BACKEND: 'local' },
      timeout: 5 * 60_000,
      maxBuffer: 1024 * 1024
    })
    const sandbox = await this.builder(`${this.name('probe')}-${randomUUID().slice(0, 8)}`, []).create()
    try {
      const output = await sandbox.exec(MICROSANDBOX_NODE, [
        '-e',
        IMAGE_PROBE_SCRIPT,
        RUNTIME_TABLE_PATH,
        SANDBOX_MCP_BRIDGE_ENTRY
      ])
      if (!output.success)
        throw new Error(`microsandbox image preflight failed (exit ${output.code}): ${output.stderr().trim()}`)
      const table = K8sRuntimeTableSchema.parse(JSON.parse(output.stdout()))
      await sandbox.stopWithTimeout(STOP_TIMEOUT_MS)
      const resumed = await (await this.options.sdk.Sandbox.get(sandbox.name)).startDetached()
      await resumed.ping()
      this.options.log?.info('microsandbox: image, Node, Python/vsock, runtime table and disk resume verified')
      return table
    } finally {
      await sandbox.destroy({ timeoutMs: STOP_TIMEOUT_MS })
    }
  }

  private async persistedIds(): Promise<string[]> {
    const directory = join(this.options.root, 'microsandbox', 'bindings')
    let files: string[]
    try {
      files = await readdir(directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const ids: string[] = []
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      const value = JSON.parse(await readFile(join(directory, file), 'utf8')) as Partial<Binding>
      if (typeof value.environmentId !== 'string' || file !== `${this.name(value.environmentId)}.json`) {
        throw new Error('microsandbox has an invalid persisted environment binding')
      }
      await this.readBinding(value.environmentId)
      ids.push(value.environmentId)
    }
    return ids
  }

  private async find(name: string): Promise<SandboxHandle | undefined> {
    try {
      return await this.options.sdk.Sandbox.get(name)
    } catch (error) {
      if (error instanceof this.options.sdk.SandboxNotFoundError) return undefined
      throw error
    }
  }

  private async readBinding(id: string): Promise<Binding | undefined> {
    try {
      const value: unknown = JSON.parse(await readFile(this.bindingPath(id), 'utf8'))
      if (!value || typeof value !== 'object') throw new Error('invalid binding')
      const binding = value as Partial<Binding>
      if (
        binding.version !== 1 ||
        binding.environmentId !== id ||
        typeof binding.spec !== 'string' ||
        typeof binding.sandboxId !== 'string' ||
        typeof binding.configHash !== 'string'
      ) {
        throw new Error('invalid binding')
      }
      return binding as Binding
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  private async open(environment: MicrosandboxEnvironment): Promise<Sandbox> {
    const name = this.name(environment.id)
    const spec = this.spec(environment)
    const binding = await this.readBinding(environment.id)
    const existing = await this.find(name)
    if (binding || existing) {
      if (
        !binding ||
        !existing ||
        binding.spec !== spec ||
        binding.sandboxId !== existing.id ||
        binding.configHash !== hash(stableJson(existing.config()))
      ) {
        throw new Error(
          `microsandbox environment ${environment.id} has missing or changed persisted configuration; discard it before recreating`
        )
      }
      if (existing.status === 'running' || existing.status === 'starting' || existing.status === 'draining') {
        await existing.stopWithTimeout(STOP_TIMEOUT_MS)
      }
      const sandbox = await existing.connectOrStart({ detached: true })
      try {
        await this.startBridge(environment.id, sandbox)
        return sandbox
      } catch (error) {
        await sandbox.stopWithTimeout(STOP_TIMEOUT_MS)
        throw error
      }
    }
    const sandbox = await this.builder(name, environment.mounts)
      .vsock(this.options.sockets.mcp, 5000)
      .vsock(this.options.sockets.gitcred, 5001)
      .create()
    try {
      const persisted = await this.options.sdk.Sandbox.get(name)
      const binding: Binding = {
        version: 1,
        environmentId: environment.id,
        spec,
        sandboxId: persisted.id,
        configHash: hash(stableJson(persisted.config()))
      }
      const path = this.bindingPath(environment.id)
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      const temporary = `${path}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, JSON.stringify(binding), { mode: 0o600, flag: 'wx' })
        await rename(temporary, path)
      } finally {
        await rm(temporary, { force: true })
      }
      await this.startBridge(environment.id, sandbox)
      return sandbox
    } catch (error) {
      await sandbox.destroy({ timeoutMs: STOP_TIMEOUT_MS })
      await rm(this.bindingPath(environment.id), { force: true })
      throw error
    }
  }

  private async startBridge(id: string, sandbox: Sandbox): Promise<void> {
    const handle = await sandbox.execStreamWith(MICROSANDBOX_NODE, (exec) =>
      exec.args([MICROSANDBOX_GUEST_ENTRY, 'sockets']).stdinPipe().tty(false)
    )
    const stdin = await handle.takeStdin()
    if (!stdin) {
      await handle.kill()
      throw new Error('microsandbox socket bridge did not provide a stream')
    }
    const bridge = new MicrosandboxProcess(
      handle,
      stdin,
      (data) => process.stderr.write(data),
      () => {}
    )
    try {
      const reader = bridge.fromAgent.getReader()
      let ready = ''
      const timer = setTimeout(() => {
        void bridge.stop(STOP_TIMEOUT_MS).catch((error: unknown) => bridge.fail(error))
      }, STOP_TIMEOUT_MS)
      try {
        while (ready !== 'ready\n') {
          const chunk = await reader.read()
          if (chunk.done) throw new Error('microsandbox socket bridge exited before becoming ready')
          ready += Buffer.from(chunk.value).toString('utf8')
          if (!'ready\n'.startsWith(ready))
            throw new Error('microsandbox socket bridge returned invalid readiness output')
        }
      } finally {
        clearTimeout(timer)
        reader.releaseLock()
      }
      this.bridges.set(id, bridge)
      bridge.onExit(() => {
        if (this.bridges.get(id) === bridge) {
          this.bridges.delete(id)
          this.options.log?.error(`microsandbox: socket bridge exited for ${id}`)
          const state = this.environments.get(id)
          if (state) {
            state.bridgeFailed = true
            this.stopFailedEnvironment(id)
          }
        }
      })
    } catch (error) {
      await bridge.stop(STOP_TIMEOUT_MS)
      throw error
    }
  }

  private stopFailedEnvironment(id: string): void {
    void this.closeEnvironment(id, false, true).catch((error: unknown) => {
      this.options.log?.error(`microsandbox: failed to stop environment ${id}: ${String(error)}`)
    })
  }

  private acquire(environment: MicrosandboxEnvironment): { state: EnvironmentState; release: () => void } {
    if (this.closed) throw new Error('microsandbox manager is shutting down')
    let state = this.environments.get(environment.id)
    if (state?.closing) throw new Error(`microsandbox environment ${environment.id} is stopping`)
    if (state?.bridgeFailed) {
      this.stopFailedEnvironment(environment.id)
      throw new Error(`microsandbox environment ${environment.id} socket bridge failed; stopping before retry`)
    }
    const spec = this.spec(environment)
    if (state && state.spec !== spec)
      throw new Error(`microsandbox environment ${environment.id} configuration changed while active`)
    if (!state) {
      state = {
        environment,
        spec,
        sandbox: this.open(environment),
        active: 0,
        processes: new Set(),
        pending: new Set(),
        lastUsed: Date.now()
      }
      this.environments.set(environment.id, state)
      const opening = state
      void state.sandbox.catch(() => {
        if (this.environments.get(environment.id) === opening) this.environments.delete(environment.id)
      })
    }
    state.active++
    state.lastUsed = Date.now()
    let released = false
    return {
      state,
      release: () => {
        if (!released) {
          released = true
          state.active--
          state.lastUsed = Date.now()
        }
      }
    }
  }

  private async startProcess(
    environment: MicrosandboxEnvironment,
    command: string,
    args: string[],
    options: Pick<MicrosandboxExecOptions, 'env' | 'cwd' | 'abort'>,
    stderr: (data: Uint8Array) => void,
    files: SpawnRequest['files'] = [],
    hints: SpawnRequest['hints'] = []
  ): Promise<MicrosandboxProcess> {
    const { state, release } = this.acquire(environment)
    let ready!: () => void
    const pending = new Promise<void>((resolve) => {
      ready = resolve
    })
    state.pending.add(pending)
    try {
      const sandbox = await state.sandbox
      if (this.closed) throw new Error('microsandbox manager is shutting down')
      options.abort?.throwIfAborted()
      if (!this.bridges.has(environment.id))
        throw new Error(`microsandbox environment ${environment.id} socket bridge is not running`)
      const env = { ...options.env }
      for (const hint of hints ?? []) {
        if (env[hint.envVar]) continue
        const output = await sandbox.execWith('/bin/sh', (exec) =>
          exec.args(['-c', 'command -v -- "$1"', 'sh', hint.command]).envs(env)
        )
        const path = output.stdout().trim()
        if (output.success && posix.isAbsolute(path)) env[hint.envVar] = path
      }
      for (const file of files ?? []) {
        SinkRelPathSchema.parse(file.relPath)
        if (!posix.isAbsolute(file.root)) throw new Error('microsandbox materialization root must be absolute')
        const path = posix.join(file.root, ...file.relPath)
        await sandbox.fs().mkdir(posix.dirname(path))
        await sandbox.fs().write(path, file.content)
        const output = await sandbox.exec('chmod', ['0600', path])
        if (!output.success) throw new Error('microsandbox could not protect materialized file permissions')
      }
      options.abort?.throwIfAborted()
      const handle = await sandbox.execStreamWith(command, (exec) =>
        exec
          .args(args)
          .cwd(options.cwd ?? environment.workspaceRoot)
          .envs(env)
          .stdinPipe()
          .tty(false)
      )
      const stdin = await handle.takeStdin()
      if (!stdin) {
        await handle.kill()
        throw new Error('microsandbox did not provide process stdin')
      }
      const runtime = new MicrosandboxProcess(handle, stdin, stderr, () => {
        state.processes.delete(runtime)
        release()
      })
      state.processes.add(runtime)
      return runtime
    } catch (error) {
      release()
      throw error
    } finally {
      state.pending.delete(pending)
      ready()
    }
  }

  private launch(environment: MicrosandboxEnvironment, request: SpawnRequest): Promise<SpawnedRuntime> {
    return this.startProcess(
      environment,
      request.command,
      request.args,
      { env: request.env },
      (data) => {
        if (!request.suppressChildStderr) process.stderr.write(data)
      },
      request.files,
      request.hints
    )
  }

  private async closeEnvironment(id: string, remove: boolean, drain = false): Promise<void> {
    const state = this.environments.get(id)
    if (state?.closing) {
      await state.closing
      if (remove) await this.closeEnvironment(id, true)
      return
    }
    if (state?.active && !drain) throw new Error(`microsandbox environment ${id} has ${state.active} active executions`)
    const closing = (async () => {
      try {
        if (state && drain) {
          await Promise.all([...state.pending])
          await Promise.all([...state.processes].map((process) => process.stop(STOP_TIMEOUT_MS)))
        }
        const binding = await this.readBinding(id)
        const handle = await this.find(this.name(id))
        if (handle) {
          if (!binding || handle.id !== binding.sandboxId)
            throw new Error(`microsandbox environment ${id} identity changed`)
          const bridge = this.bridges.get(id)
          if (bridge) {
            this.bridges.delete(id)
            await bridge.stop(STOP_TIMEOUT_MS)
          }
          if (remove) await handle.destroy({ timeoutMs: STOP_TIMEOUT_MS })
          else await handle.stopWithTimeout(STOP_TIMEOUT_MS)
        }
        if (remove) await rm(this.bindingPath(id), { force: true })
        this.environments.delete(id)
      } finally {
        if (state) state.closing = undefined
      }
    })()
    if (state) state.closing = closing
    await closing
  }
}

class MicrosandboxProcess implements SpawnedRuntime {
  readonly toAgent: WritableStream<Uint8Array>
  readonly fromAgent: ReadableStream<Uint8Array>
  readonly exited: Promise<number>
  private readonly listeners = new Set<() => void>()
  private output!: ReadableStreamDefaultController<Uint8Array>
  private wakeOutput?: () => void
  private finishExit!: (code: number) => void
  private rejectExit!: (error: unknown) => void
  private finished = false
  private stopping?: Promise<void>
  private discardOutput = false
  private outputCancelled = false
  private failing?: Promise<void>
  private failure?: unknown

  constructor(
    private readonly handle: ExecHandle,
    private readonly stdin: ExecSink,
    private readonly stderr: (data: Uint8Array) => void,
    private readonly release: () => void
  ) {
    this.exited = new Promise((resolve, reject) => {
      this.finishExit = resolve
      this.rejectExit = reject
    })
    void this.exited.catch(() => {})
    this.toAgent = new WritableStream({
      write: (data) => this.stdin.write(data),
      close: () => this.closeStdin(),
      abort: () => this.stop(STOP_TIMEOUT_MS)
    })
    this.fromAgent = new ReadableStream(
      {
        start: (controller) => {
          this.output = controller
        },
        pull: () => {
          this.wakeOutput?.()
          this.wakeOutput = undefined
        },
        cancel: () => {
          this.outputCancelled = true
          return this.stop(STOP_TIMEOUT_MS)
        }
      },
      { highWaterMark: 64 * 1024, size: (chunk) => chunk.byteLength }
    )
    void this.pump().catch((error: unknown) => this.fail(error))
  }

  onExit(listener: () => void): void {
    if (this.finished) queueMicrotask(listener)
    else this.listeners.add(listener)
  }

  closeStdin(): Promise<void> {
    return this.stdin.close()
  }

  stop(deadlineMs: number, eofGraceMs = 0): Promise<void> {
    if (!this.stopping) {
      const stopping = this.stopProcess(deadlineMs, eofGraceMs)
      this.stopping = stopping
      void stopping.catch(() => {
        if (this.stopping === stopping) this.stopping = undefined
      })
    }
    return this.stopping
  }

  fail(error: unknown): Promise<void> {
    return (this.failing ??= this.failProcess(error))
  }

  private async failProcess(error: unknown): Promise<void> {
    if (this.finished) return
    this.failure = error
    this.discardOutput = true
    this.wakeOutput?.()
    try {
      await this.handle.kill()
    } catch (killError) {
      error = new AggregateError([error, killError], 'microsandbox process failure and cleanup failure')
      this.failure = error
    }
    if (this.finished) return
    this.output.error(error)
    this.rejectExit(error)
    this.finish()
  }

  private finish(): void {
    this.finished = true
    this.wakeOutput?.()
    this.release()
    for (const listener of this.listeners) listener()
    this.listeners.clear()
  }

  private async pump(): Promise<void> {
    for await (const event of this.handle) {
      if (!event) throw new Error('microsandbox emitted an unsupported process failure event')
      if (event.kind === 'stdout' && !this.discardOutput) {
        while ((this.output.desiredSize ?? 0) <= 0 && !this.discardOutput && !this.finished) {
          await new Promise<void>((resolve) => {
            this.wakeOutput = resolve
          })
        }
        if (!this.discardOutput && !this.finished) this.output.enqueue(event.data)
      } else if (event.kind === 'stderr') {
        this.stderr(event.data)
      } else if (event.kind === 'exited') {
        if (this.finished) return
        if (this.failure !== undefined) {
          this.output.error(this.failure)
          this.rejectExit(this.failure)
        } else {
          if (!this.outputCancelled) this.output.close()
          this.finishExit(event.code)
        }
        this.finish()
        return
      }
    }
    throw new Error('microsandbox process stream ended without an exit event')
  }

  private async waitExit(ms: number): Promise<boolean> {
    if (this.finished) return true
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        this.exited.then(
          () => true,
          () => true
        ),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), Math.max(0, ms))
        })
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  private async stopProcess(deadlineMs: number, eofGraceMs: number): Promise<void> {
    if (this.finished) return
    this.discardOutput = true
    this.wakeOutput?.()
    const deadline = Date.now() + Math.max(0, deadlineMs)
    try {
      await this.closeStdin()
    } catch (error) {
      if (this.finished) return
      await this.handle.kill()
      if (!(await this.waitExit(STOP_TIMEOUT_MS))) throw error
      return
    }
    if (eofGraceMs > 0 && (await this.waitExit(Math.min(eofGraceMs, deadlineMs)))) return
    if (this.finished) return
    try {
      await this.handle.signal(15)
    } catch (error) {
      if (this.finished) return
      await this.handle.kill()
      if (!(await this.waitExit(STOP_TIMEOUT_MS))) throw error
      return
    }
    if (await this.waitExit(deadline - Date.now())) return
    await this.handle.kill()
    if (!(await this.waitExit(STOP_TIMEOUT_MS))) throw new Error('microsandbox process did not exit after SIGKILL')
  }
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry
    return Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)))
  })
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
