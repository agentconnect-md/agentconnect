import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, readlink, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, posix } from 'node:path'
import { promisify } from 'node:util'
import type { Sandbox, SandboxHandle } from 'microsandbox'
import { z } from 'zod'
import type { SpawnDriver, SpawnedRuntime, SpawnRequest } from '../acp/spawn-driver.js'
import type { SandboxMount } from '../config/config-schema.js'
import type { Logger } from '../log.js'
import { formatErr } from '../daemon/text.js'
import { gitcredShimPath } from '../cp/gitcred-server.js'
import { K8sRuntimeTableSchema, type K8sRuntimeTable } from '../runtimes/k8s-runtimes.js'
import { canonicalPath, contains } from '../runtimes/read-roots.js'
import { SinkRelPathSchema } from '../shim/file-sink.js'
import { SANDBOX_MCP_BRIDGE_ENTRY } from '../shim/sandbox-paths.js'
import { assertKvmAvailable } from './kvm.js'
import { MICROSANDBOX_SOCKET_BRIDGE_COMMAND, MICROSANDBOX_SOCKET_BRIDGE_ARGS } from './socket-bridge.js'
import { overlayMounts, OVERLAY_BASE_ROOT, OVERLAY_STATE_ROOT, prepareOverlayMounts } from './overlay.js'
import type { MicrosandboxSecret } from './secrets.js'
import { startMicrosandboxShim, type MicrosandboxShim } from './shim.js'
import {
  MICROSANDBOX_NODE,
  openExecStream,
  type MicrosandboxExecuteOptions,
  type MicrosandboxExecStdin,
  type MicrosandboxExecStream
} from './exec.js'

const runFile = promisify(execFile)
const STOP_TIMEOUT_MS = 10_000
const RUNTIME_TABLE_PATH = '/opt/agentconnect/runtime/k8s-runtimes.json'
const IMAGE_PROBE_SCRIPT = `
const { existsSync, readFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
execFileSync('/usr/bin/python3', ['-I', '-c', 'import shutil, socket, sys; assert sys.version_info >= (3, 11) and shutil.rmtree.avoids_symlink_attacks, "Python 3.11+ with safe directory removal is required"; socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM).close()'], { timeout: 10000 });
const table = JSON.parse(readFileSync(process.argv[1], 'utf8'));
const bridge = process.argv[2];
if (existsSync(bridge)) table.mcpBridge = { command: process.execPath, args: [bridge] };
process.stdout.write(JSON.stringify(table));
`

export interface MicrosandboxEnvironment {
  id: string
  mounts: SandboxMount[]
  workspaceRoot: string
  secrets?: MicrosandboxSecret[]
}

export type MicrosandboxExecOptions = MicrosandboxExecuteOptions

export interface MicrosandboxExecResult {
  stdout: string
  stderr: string
  exitCode: number
}

export interface MicrosandboxManagerOptions {
  root: string
  config: { image: string; cpus: number; memoryMiB: number; diskGiB: number }
  sdk: Pick<
    typeof import('microsandbox'),
    | 'Sandbox'
    | 'SandboxNotFoundError'
    | 'AgentClient'
    | 'Volume'
    | 'VolumeNotFoundError'
    | 'InvalidConfigError'
    | 'Image'
    | 'ImageInUseError'
  >
  msbCommand: { command: string; args: string[] }
  // Overridden by tests; the real check opens this host's /dev/kvm.
  kvmPreflight?: () => void
  // Overridden by tests; the real lookup reads this host's /proc.
  lockHolder?: (volume: string) => Promise<LockHolder | undefined>
  log?: Logger
  sockets: { mcp: string; gitcred: string }
  nextShimGeneration?: (subject: string) => Promise<number>
}

interface EnvironmentState {
  environment: MicrosandboxEnvironment
  spec: string
  sandbox: Promise<Sandbox>
  started?: boolean
  active: number
  closing?: Promise<void>
  failed?: boolean
  processes: Set<MicrosandboxProcess>
  pending: Set<Promise<void>>
  lastUsed: number
  shim?: Promise<MicrosandboxShim>
}

interface Binding {
  version: 1
  spec: string
  sandboxId: string
  configHash: string
  environmentId: string
  dockerVolume?: string
  overlayVolume?: string
}

export interface LockHolder {
  pid: number
  sandbox?: string
}

const SpecImageSchema = z.object({ config: z.object({ image: z.string().min(1) }) })

/** Owns VM lifecycle while exposing the existing ACP process-stream contract. */
export class MicrosandboxManager {
  private readonly environments = new Map<string, EnvironmentState>()
  private readonly bridges = new Map<string, MicrosandboxProcess>()
  private preparation?: Promise<K8sRuntimeTable>
  private closed = false
  private startGate: Promise<void> = Promise.resolve()

  constructor(private readonly options: MicrosandboxManagerOptions) {}

  prepare(): Promise<K8sRuntimeTable> {
    return (this.preparation ??= this.probe())
  }

  async prepareImage(): Promise<void> {
    const started = performance.now()
    const { command, args } = this.options.msbCommand
    this.options.log?.info(`microsandbox: preparing image ${this.options.config.image}`)
    await runFile(command, [...args, 'pull', this.options.config.image, '--materialize', 'layered', '--quiet'], {
      env: { ...process.env, MSB_HOME: join(this.options.root, 'microsandbox'), MSB_BACKEND: 'local' },
      timeout: 5 * 60_000,
      maxBuffer: 1024 * 1024
    })
    this.options.log?.info(`microsandbox: image prepared in ${((performance.now() - started) / 1000).toFixed(1)}s`)
  }

  driverFor(environment: MicrosandboxEnvironment): SpawnDriver {
    return { launch: (request) => this.launch(environment, request) }
  }

  async withShim<T>(environment: MicrosandboxEnvironment, work: (shim: MicrosandboxShim) => Promise<T>): Promise<T> {
    const { state, release } = this.acquire(environment)
    let resolve!: () => void
    const pending = new Promise<void>((done) => {
      resolve = done
    })
    state.pending.add(pending)
    try {
      state.shim ??= (async () => {
        const sandbox = await state.sandbox
        if (!this.options.nextShimGeneration) throw new Error('microsandbox shim generation allocator is unavailable')
        return startMicrosandboxShim({
          sdk: this.options.sdk,
          sandbox,
          subject: environment.id,
          agentId: environment.id.split('/')[0]!,
          workspaceRoot: environment.workspaceRoot,
          generation: await this.options.nextShimGeneration(environment.id),
          failed: () => this.stopFailedEnvironment(environment.id),
          log: this.options.log
        })
      })()
      const shim = await state.shim
      if (this.closed || state.closing || state.failed) throw new Error('microsandbox environment is stopping')
      return await work(shim)
    } catch (error) {
      if (state.shim) void state.shim.catch(() => this.stopFailedEnvironment(environment.id))
      throw error
    } finally {
      state.pending.delete(pending)
      resolve()
      release()
    }
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
      await Promise.all([
        (async () => {
          for await (const chunk of runtime.fromAgent) append(stdout, chunk)
        })(),
        (async () => {
          const writer = runtime.toAgent.getWriter()
          try {
            if (options.stdin !== undefined) {
              const input = Buffer.from(options.stdin, 'utf8')
              for (let offset = 0; offset < input.length; offset += 64 * 1024) {
                options.abort?.throwIfAborted()
                await writer.write(input.subarray(offset, offset + 64 * 1024))
              }
            }
            await writer.close()
          } finally {
            writer.releaseLock()
          }
        })()
      ])
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

  private spec(environment: MicrosandboxEnvironment, image = this.options.config.image): string {
    return stableJson({
      version: 2,
      config: { ...this.options.config, image },
      environment: {
        ...environment,
        ...(environment.secrets
          ? { secrets: environment.secrets.map(({ env, placeholder, host }) => ({ env, placeholder, host })) }
          : {}),
        // Keep ordinary bind identities stable when the public configuration changes from readOnly to mode.
        mounts: environment.mounts
          .map(({ mode, ...mount }) =>
            mode === 'overlay' ? { ...mount, mode } : { ...mount, readOnly: mode === 'readonly' }
          )
          .sort((a, b) => a.target.localeCompare(b.target))
      },
      sockets: this.options.sockets
    })
  }

  private builder(name: string, mounts: SandboxMount[], secrets: MicrosandboxSecret[] = []) {
    const builder = this.options.sdk.Sandbox.builder(name)
      .image(this.options.config.image)
      .rootDisk((disk) => disk.size(this.options.config.diskGiB * 1024))
      .cpus(this.options.config.cpus)
      .memory(this.options.config.memoryMiB)
      .deploymentProfile('single-tenant')
      .detached(true)
      .ephemeral(false)
      .volume('/run', (volume) => volume.tmpfs())
      .volume('/var/lib/docker', (volume) =>
        volume.namedWith(`${name}-docker`, 'create', 'disk', this.options.config.diskGiB * 1024)
      )
      .quietLogs()
    for (const secret of secrets) {
      builder.secret((entry) =>
        [secret.host]
          .flat()
          .reduce(
            (entry, host) => entry.allowHost(host),
            entry.env(secret.env).value(secret.readValue()).placeholder(secret.placeholder)
          )
          .injectBasicAuth(false)
          .injectQuery(false)
          .injectBody(false)
      )
    }
    const overlays = overlayMounts(mounts)
    if (overlays.length) {
      builder.volume(OVERLAY_STATE_ROOT, (volume) =>
        volume.namedWith(`${name}-overlays`, 'create', 'disk', this.options.config.diskGiB * 1024)
      )
      for (const mount of overlays) {
        builder.volume(`${OVERLAY_BASE_ROOT}/${mount.key}`, (volume) => volume.bind(mount.source).readonly())
      }
    }
    for (const mount of mounts.filter((mount) => mount.mode !== 'overlay')) {
      builder.volume(mount.target, (volume) => {
        volume.bind(mount.source)
        return mount.mode === 'readonly' ? volume.readonly() : volume
      })
    }
    return builder
  }

  private async probe(): Promise<K8sRuntimeTable> {
    // Without this, an unreachable /dev/kvm surfaces only as the guest's SIGABRT, minutes after an image pull.
    ;(this.options.kvmPreflight ?? assertKvmAvailable)()
    const bindings = join(this.options.root, 'microsandbox', 'bindings')
    await mkdir(bindings, { recursive: true, mode: 0o700 })
    const keep = new Set([this.options.config.image])
    for (const id of await this.persistedIds()) {
      const binding = await this.readBinding(id)
      // A retained VM boots from the image it was created with, so that image is not garbage.
      if (binding) keep.add(SpecImageSchema.parse(JSON.parse(binding.spec)).config.image)
      const handle = await this.find(this.name(id))
      if (handle) {
        if (handle.id !== binding?.sandboxId) throw new Error('microsandbox persisted environment identity changed')
        if (handle.status === 'running' || handle.status === 'starting' || handle.status === 'draining') {
          await handle.stopWithTimeout(STOP_TIMEOUT_MS)
        }
      }
    }
    const name = this.name('probe')
    await this.reclaimPreparation(name)
    // Free the retired releases before the pull, so a tight disk is not asked to hold both.
    await this.collectImages(keep)
    await this.prepareImage()
    let sandbox = await this.serializeStart(() => this.builder(name, []).create())
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
      await sandbox.detach()
      sandbox = await this.startVm(name, async () => (await this.options.sdk.Sandbox.get(name)).startDetached())
      await sandbox.ping()
      this.options.log?.info('microsandbox: image, Node, Python/vsock, runtime table and disk resume verified')
      return table
    } finally {
      await (await this.options.sdk.Sandbox.get(name)).destroy({ timeoutMs: STOP_TIMEOUT_MS })
      await sandbox.detach()
      await this.removeVolume(`${name}-docker`)
    }
  }

  /** A daemon killed mid-preparation leaves this VM behind, and with it a pin on the image it booted. */
  private async reclaimPreparation(name: string): Promise<void> {
    const existing = await this.find(name)
    if (!existing) return
    this.options.log?.warn('microsandbox: removing the preparation VM an earlier start left behind')
    await existing.destroy({ timeoutMs: STOP_TIMEOUT_MS })
    await this.removeVolume(`${name}-docker`)
  }

  /** Release the images of retired releases; msb refuses one a sandbox still boots from, which is the last word. */
  private async collectImages(keep: ReadonlySet<string>): Promise<void> {
    const images = await this.options.sdk.Image.list().catch((error: unknown) => {
      this.options.log?.warn(`microsandbox: could not read the image cache — ${formatErr(error)}`)
      return []
    })
    for (const image of images) {
      if (keep.has(image.reference)) continue
      try {
        await this.options.sdk.Image.remove(image.reference)
        const size = image.sizeBytes === null ? '' : ` (${(image.sizeBytes / 1024 ** 2).toFixed(0)} MiB)`
        this.options.log?.info(`microsandbox: removed the unused image ${image.reference}${size}`)
      } catch (error) {
        if (error instanceof this.options.sdk.ImageInUseError) {
          this.options.log?.warn(`microsandbox: kept image ${image.reference}, a sandbox outside this daemon uses it`)
          continue
        }
        this.options.log?.warn(`microsandbox: could not remove image ${image.reference} — ${formatErr(error)}`)
      }
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

  private async removeVolume(name: string): Promise<void> {
    try {
      await this.retryDiskOperation(() => this.options.sdk.Volume.remove(name))
    } catch (error) {
      if (!(error instanceof this.options.sdk.VolumeNotFoundError)) throw error
    }
  }

  private async retryDiskOperation<T>(operation: () => Promise<T>, deadlineMs = 1_000): Promise<T> {
    const deadline = Date.now() + deadlineMs
    for (;;) {
      try {
        return await operation()
      } catch (error) {
        if (
          !(error instanceof this.options.sdk.InvalidConfigError) ||
          !/volume ".+" is (?:currently attached by a running sandbox|already attached with an incompatible disk mode)$/.test(
            error.message
          ) ||
          Date.now() >= deadline
        )
          throw error
        // The pinned SDK can observe stopped state before disk locks are released.
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
    }
  }

  // The SDK clears CLOEXEC on a starting VM's disk locks, so a start spawned beside another one inherits its locks
  // and keeps them after that VM stops (superradcompany/microsandbox#1558). One start at a time closes that window.
  private async serializeStart<T>(operation: () => Promise<T>): Promise<T> {
    const ahead = this.startGate
    let done!: () => void
    this.startGate = new Promise<void>((resolve) => (done = resolve))
    await ahead
    try {
      return await operation()
    } finally {
      done()
    }
  }

  /** The one place a VM starts: serialized, and retried once after an unrelated sandbox's inherited disk lock is released. */
  private async startVm<T>(subject: string, start: () => Promise<T>): Promise<T> {
    return this.serializeStart(async () => {
      try {
        return await this.retryDiskOperation(start)
      } catch (error) {
        const volume = lockedVolume(error, this.options.sdk)
        if (!volume) throw error
        const holder = await this.lockHolder(volume)
        if (!(await this.releaseIdleHolder(volume, holder))) throw lockError(subject, volume, holder, error)
        // The supervisor releases the lock as it exits, which the SDK can observe a moment later.
        return await this.retryDiskOperation(start, 5_000)
      }
    })
  }

  /** The process whose inherited fd still locks this volume's disk, and the sandbox it belongs to. */
  private async lockHolder(volume: string): Promise<LockHolder | undefined> {
    if (this.options.lockHolder) return this.options.lockHolder(volume)
    if (process.platform !== 'linux') return undefined
    const disk = join(this.options.root, 'microsandbox', 'volumes', volume, 'disk.raw')
    const entries = await readdir('/proc').catch(() => [])
    for (const pid of entries.filter((entry) => /^\d+$/.test(entry))) {
      const fds = await readdir(`/proc/${pid}/fd`).catch(() => [])
      for (const fd of fds) {
        if ((await readlink(`/proc/${pid}/fd/${fd}`).catch(() => undefined)) !== disk) continue
        const argv = (await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '')).split('\0')
        const named = argv.indexOf('--name')
        return { pid: Number(pid), sandbox: named < 0 ? undefined : argv[named + 1] }
      }
    }
    return undefined
  }

  /** Suspend the idle environment whose supervisor inherited this lock; refuse while that environment still has work. */
  private async releaseIdleHolder(volume: string, holder?: LockHolder): Promise<boolean> {
    if (!holder?.sandbox) return false
    let id: string | undefined
    for (const candidate of await this.environmentIds()) if (this.name(candidate) === holder.sandbox) id = candidate
    // A sandbox this daemon has no binding for can be running work no counter here can see.
    if (id === undefined) return false
    const state = this.environments.get(id)
    // Only a settled start can be suspended: awaiting one queued behind this start would deadlock on the gate.
    if (state && !(state.started && !state.closing && !state.failed && !state.active && !state.processes.size))
      return false
    this.options.log?.warn(
      `microsandbox: suspending idle environment ${id} — it inherited the disk lock of volume "${volume}"`
    )
    if (state) await this.suspend(id)
    else await (await this.find(holder.sandbox))?.stopWithTimeout(STOP_TIMEOUT_MS)
    return true
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
        typeof binding.configHash !== 'string' ||
        (binding.dockerVolume !== undefined && binding.dockerVolume !== `${this.name(id)}-docker`) ||
        (binding.overlayVolume !== undefined && binding.overlayVolume !== `${this.name(id)}-overlays`)
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
    const stateRoot = canonicalPath(join(this.options.root, 'microsandbox'), process.env)
    for (const mount of environment.mounts) {
      const source = canonicalPath(mount.source, process.env)
      if (contains(source, stateRoot) || contains(stateRoot, source))
        throw new Error('microsandbox mounts cannot expose host sandbox state')
    }
    const name = this.name(environment.id)
    const binding = await this.readBinding(environment.id)
    // Image changes apply to new environments; retained disks keep their original image.
    const image = binding ? SpecImageSchema.parse(JSON.parse(binding.spec)).config.image : this.options.config.image
    const spec = this.spec(environment, image)
    const existing = await this.find(name)
    if (binding || existing) {
      let matchingSpec = binding?.spec === spec
      if (binding && !matchingSpec) {
        const helper = canonicalPath(
          join(this.options.root, 'run', 'microsandbox-helpers', 'git-credential'),
          process.env
        )
        const legacyMounts = environment.mounts.map((mount) =>
          mount.source === helper && mount.target === gitcredShimPath(this.options.root) && mount.mode === 'readonly'
            ? {
                ...mount,
                source: canonicalPath(join(this.options.root, 'microsandbox', 'helpers', 'git-credential'), process.env)
              }
            : mount
        )
        // Retained VMs may still own the old exact read-only helper mount; new mounts use the public support directory.
        matchingSpec = binding.spec === this.spec({ ...environment, mounts: legacyMounts }, image)
        const source = await realpath(join(this.options.root, 'microsandbox', 'helpers', 'guest.js')).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return undefined
            throw error
          }
        )
        // Retain an older VM's disk when only the retired, read-only guest helper mount differs.
        if (source && !matchingSpec) {
          matchingSpec =
            binding.spec ===
            this.spec(
              {
                ...environment,
                mounts: [...legacyMounts, { source, target: '/opt/agentconnect-local/guest.js', mode: 'readonly' }]
              },
              image
            )
        }
      }
      if (
        !binding ||
        !existing ||
        !matchingSpec ||
        binding.sandboxId !== existing.id ||
        binding.configHash !== hash(stableJson(existing.config()))
      ) {
        throw new Error(
          `microsandbox environment ${environment.id} has missing or changed persisted configuration. Restore the previous configuration and runtime credentials, or start a new session. Existing session data has been retained.`
        )
      }
      if (existing.status === 'running' || existing.status === 'starting' || existing.status === 'draining') {
        await existing.stopWithTimeout(STOP_TIMEOUT_MS)
      }
      if (environment.secrets?.length) {
        const result = await existing.modify({
          secrets: Object.fromEntries(environment.secrets.map((secret) => [secret.env, { value: secret.readValue() }])),
          policy: 'next_start'
        })
        if (!result.applied && (result.changes.length || result.conflicts.length))
          throw new Error('microsandbox could not update its host-side credentials')
        const configHash = hash(stableJson((await this.options.sdk.Sandbox.get(name)).config()))
        if (binding.configHash !== configHash) {
          binding.configHash = configHash
          await this.writeBinding(binding)
        }
      }
      const sandbox = await this.startVm(environment.id, () => existing.connectOrStart({ detached: true }))
      try {
        await prepareOverlayMounts(sandbox, environment.mounts)
        await this.startBridge(environment.id, sandbox)
        return sandbox
      } catch (error) {
        await sandbox.stopWithTimeout(STOP_TIMEOUT_MS)
        await sandbox.detach()
        throw error
      }
    }
    const sandbox = await this.startVm(environment.id, () =>
      this.builder(name, environment.mounts, environment.secrets)
        .vsock(this.options.sockets.mcp, 5000)
        .vsock(this.options.sockets.gitcred, 5001)
        .create()
    )
    try {
      const persisted = await this.options.sdk.Sandbox.get(name)
      const binding: Binding = {
        version: 1,
        environmentId: environment.id,
        spec,
        sandboxId: persisted.id,
        configHash: hash(stableJson(persisted.config())),
        dockerVolume: `${name}-docker`,
        ...(overlayMounts(environment.mounts).length ? { overlayVolume: `${name}-overlays` } : {})
      }
      await this.writeBinding(binding)
      await prepareOverlayMounts(sandbox, environment.mounts)
      await this.startBridge(environment.id, sandbox)
      return sandbox
    } catch (error) {
      await sandbox.destroy({ timeoutMs: STOP_TIMEOUT_MS })
      await sandbox.detach()
      await this.removeVolume(`${name}-docker`)
      if (overlayMounts(environment.mounts).length) await this.removeVolume(`${name}-overlays`)
      await rm(this.bindingPath(environment.id), { force: true })
      throw error
    }
  }

  private async writeBinding(binding: Binding): Promise<void> {
    const path = this.bindingPath(binding.environmentId)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const temporary = `${path}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify(binding), { mode: 0o600, flag: 'wx' })
      await rename(temporary, path)
    } finally {
      await rm(temporary, { force: true })
    }
  }

  private async startBridge(id: string, sandbox: Sandbox): Promise<void> {
    const handle = await openExecStream(
      this.options.sdk,
      sandbox,
      MICROSANDBOX_SOCKET_BRIDGE_COMMAND,
      MICROSANDBOX_SOCKET_BRIDGE_ARGS
    )
    const stdin = await handle.takeStdin()
    if (!stdin) {
      await handle.close()
      throw new Error('microsandbox socket bridge did not provide a stream')
    }
    const bridge = new MicrosandboxProcess(
      handle,
      stdin,
      (data) => process.stderr.write(data),
      () => {},
      () => this.stopFailedEnvironment(id)
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
          this.stopFailedEnvironment(id)
        }
      })
    } catch (error) {
      await bridge.stop(STOP_TIMEOUT_MS)
      throw error
    }
  }

  private stopFailedEnvironment(id: string): void {
    const state = this.environments.get(id)
    if (state) state.failed = true
    void this.closeEnvironment(id, false, true).catch((error: unknown) => {
      this.options.log?.error(`microsandbox: failed to stop environment ${id}: ${String(error)}`)
    })
  }

  private acquire(environment: MicrosandboxEnvironment): { state: EnvironmentState; release: () => void } {
    if (this.closed) throw new Error('microsandbox manager is shutting down')
    let state = this.environments.get(environment.id)
    if (state?.closing) throw new Error(`microsandbox environment ${environment.id} is stopping`)
    if (state?.failed) {
      this.stopFailedEnvironment(environment.id)
      throw new Error(`microsandbox environment ${environment.id} transport failed; stopping before retry`)
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
      void state.sandbox.then(
        () => (opening.started = true),
        () => {
          if (this.environments.get(environment.id) === opening) this.environments.delete(environment.id)
        }
      )
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
    options: Pick<MicrosandboxExecOptions, 'env' | 'cwd' | 'abort' | 'inheritEnv'>,
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
      const handle = await openExecStream(this.options.sdk, sandbox, command, args, {
        cwd: options.cwd ?? environment.workspaceRoot,
        env,
        inheritEnv: options.inheritEnv
      })
      const stdin = await handle.takeStdin()
      if (!stdin) {
        await handle.close()
        throw new Error('microsandbox did not provide process stdin')
      }
      if (state.failed || state.closing) {
        await handle.close()
        throw new Error(`microsandbox environment ${environment.id} is stopping`)
      }
      const runtime = new MicrosandboxProcess(
        handle,
        stdin,
        stderr,
        () => {
          state.processes.delete(runtime)
          release()
        },
        () => this.stopFailedEnvironment(environment.id)
      )
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
        if (state?.shim)
          await state.shim.then(
            (shim) => shim.stop(),
            () => {}
          )
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
        if (state) await (await state.sandbox).detach()
        this.environments.delete(id)
        if (remove) {
          for (const volume of [binding?.dockerVolume, binding?.overlayVolume]) {
            if (volume) await this.removeVolume(volume)
          }
        }
        if (remove) await rm(this.bindingPath(id), { force: true })
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
  private finishing?: Promise<void>
  private failure?: unknown

  constructor(
    private readonly handle: MicrosandboxExecStream,
    private readonly stdin: MicrosandboxExecStdin,
    private readonly stderr: (data: Uint8Array) => void,
    private readonly release: () => void,
    private readonly transportFailure: () => void
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
    void this.pump().catch((error: unknown) => {
      this.failure ??= error
      return this.finish()
    })
  }

  onExit(listener: () => void): void {
    if (this.finished) queueMicrotask(listener)
    else this.listeners.add(listener)
  }

  async closeStdin(): Promise<void> {
    if (this.finishing) return this.finishing
    try {
      await this.stdin.close()
    } catch (error) {
      if (this.finishing) return this.finishing
      throw error
    }
  }

  stop(deadlineMs: number, eofGraceMs = 0): Promise<void> {
    if (this.finishing) return this.finishing
    if (!this.stopping) {
      const stopping = this.stopProcess(deadlineMs, eofGraceMs).catch((error: unknown) => {
        if (this.finishing) return this.finishing
        throw error
      })
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
    void this.handle.kill().catch((killError: unknown) => {
      if (this.finishing) return this.finishing
      this.failure = new AggregateError([error, killError], 'microsandbox process failure and cleanup failure')
      return this.finish()
    })
    if (!(await this.waitExit(STOP_TIMEOUT_MS))) await this.finish()
  }

  private finish(code?: number): Promise<void> {
    return (this.finishing ??= (async () => {
      if (!this.handle.terminal) this.transportFailure()
      try {
        await this.handle.close()
      } catch (error) {
        this.failure ??= error
      }
      if (this.failure !== undefined) {
        if (!this.outputCancelled) this.output.error(this.failure)
        this.rejectExit(this.failure)
      } else {
        if (!this.outputCancelled) this.output.close()
        this.finishExit(code!)
      }
      this.finished = true
      this.wakeOutput?.()
      this.release()
      for (const listener of this.listeners) listener()
      this.listeners.clear()
    })())
  }

  private async pump(): Promise<void> {
    for await (const event of this.handle) {
      if (event.kind === 'stdout' && !this.discardOutput) {
        while ((this.output.desiredSize ?? 0) <= 0 && !this.discardOutput && !this.finished) {
          await new Promise<void>((resolve) => {
            this.wakeOutput = resolve
          })
        }
        if (!this.discardOutput && !this.finished) this.output.enqueue(event.data)
      } else if (event.kind === 'stderr' && !this.discardOutput) {
        try {
          this.stderr(event.data)
        } catch (error) {
          void this.fail(error)
        }
      } else if (event.kind === 'exited') {
        if (this.finished) return
        await this.finish(event.code)
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

/** The named volume a start refused to lock, or undefined for any other failure. */
function lockedVolume(error: unknown, sdk: MicrosandboxManagerOptions['sdk']): string | undefined {
  if (!(error instanceof sdk.InvalidConfigError)) return undefined
  return /volume "(.+)" is already attached with an incompatible disk mode$/.exec(error.message)?.[1]
}

function lockError(subject: string, volume: string, holder: LockHolder | undefined, cause: unknown): Error {
  const held = holder
    ? `pid ${holder.pid}${holder.sandbox === undefined ? '' : ` (sandbox ${holder.sandbox})`}`
    : 'a process this daemon could not identify'
  return new Error(
    `microsandbox could not start ${subject}: volume "${volume}" is still locked by ${held}. A starting VM's disk ` +
      'locks leak into unrelated sandbox processes (superradcompany/microsandbox#1558); stop that sandbox to release it.',
    { cause }
  )
}
