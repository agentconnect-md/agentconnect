import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { link, mkdir, readFile, readdir, readlink, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, posix } from 'node:path'
import { promisify } from 'node:util'
import type { ImageHandle, Sandbox, SandboxBuilder, SandboxHandle } from 'microsandbox'
import type { SecretBuilder } from 'microsandbox/native'
import { z } from 'zod'
import type { SpawnDriver, SpawnedRuntime, SpawnRequest } from '../acp/spawn-driver.js'
import type { SandboxMount } from '../config/config-schema.js'
import type { EnvironmentDescriptor } from '../execution/strategies.js'
import { pidAlive } from '../lock.js'
import type { Logger } from '../log.js'
import { formatErr } from '../daemon/text.js'
import { shareStartup, awaitStartup, withStartupPhase } from '../session/startup-progress.js'
import { K8sRuntimeTableSchema, type K8sRuntimeTable } from '../runtimes/k8s-runtimes.js'
import { canonicalPath, contains } from '../runtimes/read-roots.js'
import { createRemoteRuntime } from '../remote/remote-runtime.js'
import { SinkRelPathSchema } from '../shim/file-sink.js'
import { SANDBOX_MCP_BRIDGE_ENTRY } from '../shim/sandbox-paths.js'
import { assertKvmAvailable } from './kvm.js'
import { overlayMounts, OVERLAY_BASE_ROOT, OVERLAY_STATE_ROOT, prepareOverlayMounts } from './overlay.js'
import type { MicrosandboxSecret } from './secrets.js'
import { startGuestShim, startMicrosandboxShim, type GuestShim, type MicrosandboxShim } from './shim.js'
import {
  MICROSANDBOX_NODE,
  imageEnv,
  openExecStream,
  type MicrosandboxExecuteOptions,
  type MicrosandboxExecStdin,
  type MicrosandboxExecStream
} from './exec.js'

const runFile = promisify(execFile)
const STOP_TIMEOUT_MS = 10_000
const IMAGE_LOCK_POLL_MS = 250
// Twice the pull timeout; a reused pid reads as a live holder, so a waiter fails at this cap instead of racing it.
const IMAGE_LOCK_WAIT_MS = 10 * 60_000
// Image-cache lock files this process holds, whichever manager took them.
const heldImageLocks = new Set<string>()
const REPLACEMENT_LABEL = 'io.agentconnect.vm-replacement'
const RUNTIME_TABLE_PATH = '/opt/agentconnect/runtime/k8s-runtimes.json'
const IMAGE_PROBE_SCRIPT = `
const { existsSync, readFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
execFileSync('/usr/bin/python3', ['-I', '-c', 'import shutil, sys; assert sys.version_info >= (3, 11) and shutil.rmtree.avoids_symlink_attacks, "Python 3.11+ with safe directory removal is required"'], { timeout: 10000 });
const table = JSON.parse(readFileSync(process.argv[1], 'utf8'));
const bridge = process.argv[2];
if (existsSync(bridge)) table.mcpBridge = { command: process.execPath, args: [bridge] };
process.stdout.write(JSON.stringify(table));
`

const MOUNT_PROBE_SCRIPT = String.raw`
const fs = require('node:fs');
const unescape = value => value.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
const mounted = new Map(fs.readFileSync('/proc/self/mountinfo', 'utf8').trim().split('\n').map(line => {
  const fields = line.split(' ');
  return [unescape(fields[4]), fields[5].split(',')];
}));
for (const mount of JSON.parse(process.argv[1])) {
  fs.statSync(mount.target);
  const flags = mounted.get(mount.target);
  if (!flags || flags.includes('ro') !== (mount.mode === 'readonly')) throw new Error('workspace mount verification failed: ' + mount.target);
}
`

/** A VM's environment is the descriptor a strategy launcher takes (session-executors.md §11 step 3); a local one leaves `hosted` unset, so its spec is unchanged. */
export type MicrosandboxEnvironment = EnvironmentDescriptor

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
    | 'SandboxAlreadyExistsError'
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
  // Overridden by tests; the real one stages this daemon's shim into the VM and dials it.
  startShim?: typeof startMicrosandboxShim
}

interface EnvironmentState {
  environment: MicrosandboxEnvironment
  spec: string
  sandbox: Promise<Sandbox>
  started?: boolean
  active: number
  closing?: Promise<void>
  failed?: boolean
  processes: Set<SpawnedRuntime>
  pending: Set<Promise<void>>
  lastUsed: number
  // Live launches that asked for their runtime's stderr to be dropped.
  quiet: number
}

interface OwnedSandbox {
  sandboxName?: string
  sandboxId: string
  configHash: string
  dockerVolume?: string
  overlayVolume?: string
}

interface Binding extends OwnedSandbox {
  version: 1
  spec: string
  environmentId: string
  imageIdentity?: string
  replacement?: string
  retired?: OwnedSandbox[]
}

export interface LockHolder {
  pid: number
  sandbox?: string
}

const SpecImageSchema = z.object({ config: z.object({ image: z.string().min(1) }) })
// The runtime table an image's first preparation read, so a restart on the same image boots no probe VM.
const ImageRuntimesRecordSchema = z.object({
  version: z.literal(1),
  image: z.string().min(1),
  identity: z.string().min(1),
  table: K8sRuntimeTableSchema
})
const FlatRefSchema = z.object({ manifest_digest: z.string(), artifact_digest: z.string() })

/** Owns VM lifecycle while exposing the existing ACP process-stream contract. */
export class MicrosandboxManager {
  private readonly environments = new Map<string, EnvironmentState>()
  // One per running VM, up before anything runs in it: the runtime, its two helper tunnels and the workspace channels all ride it.
  private readonly shims = new Map<string, MicrosandboxShim>()
  // The same, for a hosted environment: started and left for the executor facet's pipe, with nothing bound here.
  private readonly guests = new Map<string, GuestShim>()
  private preparation?: Promise<K8sRuntimeTable>
  private recovery?: Promise<void>
  private closed = false
  private startGate: Promise<void> = Promise.resolve()
  private readonly imageIdentities = new Map<string, Promise<string | undefined>>()

  constructor(private readonly options: MicrosandboxManagerOptions) {}

  /** The image and its runtime table, prepared once by the first use; a failure is retried by the next (session-executors.md §5). */
  prepare(): Promise<K8sRuntimeTable> {
    if (!this.preparation) {
      const preparation = this.probe()
      this.preparation = preparation
      preparation.catch(() => {
        if (this.preparation === preparation) this.preparation = undefined
      })
    }
    return this.preparation
  }

  /** The table an earlier preparation recorded for the configured image, when the cache still holds that image; it pulls and boots nothing. */
  async cachedTable(): Promise<K8sRuntimeTable | undefined> {
    const record = ImageRuntimesRecordSchema.safeParse(
      parseJson(await readFile(this.imageRuntimesPath(), 'utf8').catch(() => ''))
    )
    if (!record.success || record.data.image !== this.options.config.image) return undefined
    const identity = await this.imageIdentity(this.options.config.image)
    if (!identity || identity !== record.data.identity) return undefined
    this.preparation ??= Promise.resolve(record.data.table)
    return record.data.table
  }

  /** Fence what an earlier daemon left: stop its running VMs and reclaim the preparation VM; it pulls no image (§5). */
  recover(): Promise<void> {
    if (!this.recovery) {
      const recovery = this.recoverState()
      this.recovery = recovery
      recovery.catch(() => {
        if (this.recovery === recovery) this.recovery = undefined
      })
    }
    return this.recovery
  }

  private imageRuntimesPath(): string {
    return join(this.options.root, 'microsandbox', 'image-runtimes.json')
  }

  async prepareImage(): Promise<void> {
    await this.withImageCache(true, () => this.pullImage())
  }

  /** Collect what a retention pass unpinned; skips the round while another live process holds the image cache. */
  async collectImages(): Promise<void> {
    if (!this.recovery || this.closed) return
    const collected = await this.withImageCache(false, async () => {
      const keep = await this.boundImages()
      // The last pull may be an upgrade's pre-pull of the next release, which runs while this daemon still does.
      const pulled = await readFile(this.pulledImagePath(), 'utf8').catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      })
      if (pulled) keep.add(pulled)
      await this.collect((image) => keep.has(image.reference))
    })
    if (!collected) this.options.log?.info('microsandbox: image collection skipped, another process holds the cache')
  }

  private pulledImagePath(): string {
    return join(this.options.root, 'microsandbox', 'pulled-image')
  }

  // Called only under the image-cache lock, so a collection never reads the record halfway through a pull.
  private async pullImage(): Promise<void> {
    const started = performance.now()
    const { command, args } = this.options.msbCommand
    this.options.log?.info(`microsandbox: preparing image ${this.options.config.image}`)
    await runFile(command, [...args, 'pull', this.options.config.image, '--materialize', 'layered', '--quiet'], {
      env: { ...process.env, MSB_HOME: join(this.options.root, 'microsandbox'), MSB_BACKEND: 'local' },
      timeout: 5 * 60_000,
      maxBuffer: 1024 * 1024
    })
    // No cache timestamp marks a pull: a same-digest re-pull keeps the tag's creation time, and every create refreshes its update time.
    await writeFileAtomic(this.pulledImagePath(), this.options.config.image)
    this.options.log?.info(`microsandbox: image prepared in ${((performance.now() - started) / 1000).toFixed(1)}s`)
  }

  driverFor(environment: MicrosandboxEnvironment): SpawnDriver {
    return { launch: (request) => this.launch(environment, request) }
  }

  // Warm only the VM and mounts; ACP starts when a caller launches a runtime.
  async prepareEnvironment(environment: MicrosandboxEnvironment): Promise<void> {
    const { state, release } = this.acquire(environment)
    let ready!: () => void
    const pending = new Promise<void>((resolve) => {
      ready = resolve
    })
    state.pending.add(pending)
    try {
      await awaitStartup(state.sandbox)
    } finally {
      state.pending.delete(pending)
      release()
      ready()
    }
  }

  // Agent activation refreshes retained VMs in the background without waking unchanged ones.
  async refreshEnvironment(environment: MicrosandboxEnvironment): Promise<void> {
    const binding = await this.readBinding(environment.id)
    if (!binding) return
    const desired = await this.desiredSpec(environment, binding)
    if (binding.spec === desired.spec && desired.sameImage && !binding.replacement && !binding.retired?.length) return
    await this.prepareEnvironment(environment)
  }

  async withShim<T>(environment: MicrosandboxEnvironment, work: (shim: MicrosandboxShim) => Promise<T>): Promise<T> {
    const { state, release } = this.acquire(environment)
    let resolve!: () => void
    const pending = new Promise<void>((done) => {
      resolve = done
    })
    state.pending.add(pending)
    try {
      await awaitStartup(state.sandbox)
      const shim = this.shims.get(environment.id)
      if (this.closed || state.closing || state.failed || !shim) throw new Error('microsandbox environment is stopping')
      return await work(shim)
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

  /** Stop the VM, keeping its disk; `drain` ends what still runs in it first instead of refusing. */
  async suspend(id: string, options: { drain?: boolean } = {}): Promise<void> {
    await this.closeEnvironment(id, false, options.drain === true)
  }

  /** Stop the VM unless something still runs in it, leaving a busy one to the idle sweep or shutdown; says whether it stopped. */
  async suspendUnlessBusy(id: string): Promise<boolean> {
    if (this.environments.get(id)?.active) return false
    await this.suspend(id)
    return true
  }

  async discard(id: string): Promise<void> {
    await this.closeEnvironment(id, true)
  }

  environment(id: string): MicrosandboxEnvironment | undefined {
    return this.environments.get(id)?.environment
  }

  /** The exposed shim of a hosted environment, which the executor facet pipes a remote holder to (§6). */
  guestShim(id: string): GuestShim | undefined {
    return this.guests.get(id)
  }

  async environmentIds(): Promise<string[]> {
    return [...new Set([...this.environments.keys(), ...(await this.persistedIds())])]
  }

  async suspendIdle(idleBefore: number): Promise<void> {
    for (const [id, state] of this.environments) {
      // A hosted environment's idle judge is the executor facet's linger, not this machine's session ttl (§7).
      if (state.environment.hosted) continue
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

  private sandboxName(id: string, binding?: OwnedSandbox): string {
    return binding?.sandboxName ?? this.name(id)
  }

  private imageIdentity(reference: string): Promise<string | undefined> {
    let identity = this.imageIdentities.get(reference)
    if (!identity) {
      identity = this.options.sdk.Image.get(reference).then(
        (image) =>
          image.manifestDigest && image.os && image.architecture
            ? `${image.os}/${image.architecture}@${image.manifestDigest}`
            : undefined,
        () => undefined
      )
      this.imageIdentities.set(reference, identity)
    }
    return identity
  }

  private async desiredSpec(environment: MicrosandboxEnvironment, binding?: Binding) {
    const imageIdentity = await this.imageIdentity(this.options.config.image)
    if (!imageIdentity) throw new Error('microsandbox configured image has no cached platform manifest identity')
    const previousImage = binding ? SpecImageSchema.parse(JSON.parse(binding.spec)).config.image : undefined
    const sameImage = imageIdentity === binding?.imageIdentity
    return {
      spec: this.spec(environment, sameImage ? previousImage! : this.options.config.image),
      imageIdentity,
      sameImage
    }
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
      // Typed here because the SDK types this callback `any`, which hid its 0.7 renames from the typecheck.
      builder.secret((entry: SecretBuilder) =>
        [secret.host]
          .flat()
          .reduce(
            (entry, host) => entry.allow(host),
            entry.env(secret.env).value(secret.readValue()).placeholder(secret.placeholder)
          )
          .substituteInHeaders(true)
          .substituteInQuery(false)
          .substituteInBody(false)
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

  private async recoverState(): Promise<void> {
    const bindings = join(this.options.root, 'microsandbox', 'bindings')
    await mkdir(bindings, { recursive: true, mode: 0o700 })
    for (const id of await this.persistedIds()) {
      try {
        const binding = await this.readBinding(id)
        const handle = await this.find(this.sandboxName(id, binding))
        if (handle) {
          if (handle.id !== binding?.sandboxId) throw new Error('microsandbox persisted environment identity changed')
          if (handle.status === 'running' || handle.status === 'starting' || handle.status === 'draining') {
            await handle.stopWithTimeout(STOP_TIMEOUT_MS)
          }
        }
        if (binding) {
          // Capture legacy cache identity before pulling a tag that could have moved.
          if (!binding.imageIdentity) {
            const imageIdentity = await this.imageIdentity(SpecImageSchema.parse(JSON.parse(binding.spec)).config.image)
            if (imageIdentity) await this.writeBinding({ ...binding, imageIdentity })
          }
        }
      } catch (error) {
        this.options.log?.warn(`microsandbox: environment ${id} is unavailable — ${formatErr(error)}`)
      }
    }
    await this.reclaimPreparation(this.name('probe'))
  }

  private async probe(): Promise<K8sRuntimeTable> {
    // Without this, an unreachable /dev/kvm surfaces only as the guest's SIGABRT, minutes after an image pull.
    ;(this.options.kvmPreflight ?? assertKvmAvailable)()
    await this.recover()
    const name = this.name('probe')
    await this.withImageCache(true, async () => {
      // Free the retired releases before the pull, so a tight disk is not asked to hold both.
      const keep = await this.boundImages()
      await this.collect((image) => keep.has(image.reference))
      await this.pullImage()
    })
    this.imageIdentities.delete(this.options.config.image)
    let sandbox = await this.serializeStart(() => this.createReclaiming(name, () => this.builder(name, [])))
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
      this.options.log?.info('microsandbox: image, Node, Python, runtime table and disk resume verified')
      await this.recordTable(table)
      return table
    } finally {
      await (await this.options.sdk.Sandbox.get(name)).destroy({ timeoutMs: STOP_TIMEOUT_MS })
      await sandbox.detach()
      await this.removeVolume(`${name}-docker`)
    }
  }

  /** Best effort: a record that cannot be written costs the next restart one probe VM, never a session. */
  private async recordTable(table: K8sRuntimeTable): Promise<void> {
    const identity = await this.imageIdentity(this.options.config.image)
    if (!identity) return
    await writeFileAtomic(
      this.imageRuntimesPath(),
      JSON.stringify({ version: 1, image: this.options.config.image, identity, table })
    ).catch((error: unknown) =>
      this.options.log?.warn(`microsandbox: could not record the image's runtime table — ${formatErr(error)}`)
    )
  }

  /** A daemon killed mid-preparation leaves this VM behind, and with it a pin on the image it booted. */
  private async reclaimPreparation(name: string): Promise<void> {
    const existing = await this.find(name)
    if (existing) {
      this.options.log?.warn('microsandbox: removing the preparation VM an earlier start left behind')
      await existing.destroy({ timeoutMs: STOP_TIMEOUT_MS })
    }
    // The disk outlives a VM destroyed just before cleanup, and this name is fixed, so creation would collide.
    await this.removeVolume(`${name}-docker`)
  }

  /** The configured image and every image a persisted binding records. */
  private async boundImages(): Promise<Set<string>> {
    const keep = new Set([this.options.config.image])
    for (const id of await this.persistedIds()) {
      const binding = await this.readBinding(id).catch(() => undefined)
      const image = binding && SpecImageSchema.safeParse(parseJson(binding.spec)).data?.config.image
      if (image) keep.add(image)
    }
    return keep
  }

  /** Release the images of retired releases; msb refuses one a sandbox still boots from, which is the last word. */
  private async collect(keep: (image: ImageHandle) => boolean): Promise<void> {
    const images = await this.options.sdk.Image.list().catch((error: unknown) => {
      this.options.log?.warn(`microsandbox: could not read the image cache — ${formatErr(error)}`)
      return []
    })
    for (const image of images) {
      if (keep(image)) continue
      try {
        await this.options.sdk.Image.remove(image.reference)
        const size = image.sizeBytes === null ? '' : ` (${(image.sizeBytes / 1024 ** 2).toFixed(0)} MiB)`
        this.options.log?.info(`microsandbox: removed the unused image ${image.reference}${size}`)
      } catch (error) {
        if (error instanceof this.options.sdk.ImageInUseError) {
          this.options.log?.warn(`microsandbox: kept image ${image.reference}, a sandbox still boots from its digest`)
          continue
        }
        this.options.log?.warn(`microsandbox: could not remove image ${image.reference} — ${formatErr(error)}`)
      }
    }
    await this.sweepFlat().catch((error: unknown) =>
      this.options.log?.warn(`microsandbox: could not sweep flat rootfs artifacts — ${formatErr(error)}`)
    )
  }

  /** msb's image removal never touches the flat rootfs store v1.55 filled, and nothing has read it since v1.56. */
  private async sweepFlat(): Promise<void> {
    const flat = join(this.options.root, 'microsandbox', 'cache', 'flat')
    const refs = (await listDirectory(join(flat, 'refs'))).filter((file) => file.endsWith('.json'))
    const blobs = (await listDirectory(join(flat, 'blobs'))).filter((file) => file.endsWith('.raw'))
    if (!refs.length && !blobs.length) return
    const manifests = new Set((await this.options.sdk.Image.list()).flatMap((image) => image.manifestDigest ?? []))
    const named = new Set<string>()
    let removed = 0
    let bytes = 0
    const drop = async (path: string) => {
      // Blobs are sparse, so what they hold on disk is their allocated blocks, not their length.
      bytes += (await stat(path)).blocks * 512
      await rm(path, { force: true })
      removed++
    }
    for (const file of refs) {
      const ref = FlatRefSchema.safeParse(parseJson(await readFile(join(flat, 'refs', file), 'utf8')))
      if (!ref.success) continue
      if (manifests.has(ref.data.manifest_digest)) named.add(`${ref.data.artifact_digest.replace(':', '_')}.raw`)
      else await drop(join(flat, 'refs', file))
    }
    for (const file of blobs) if (!named.has(file)) await drop(join(flat, 'blobs', file))
    if (removed)
      this.options.log?.info(
        `microsandbox: removed ${removed} flat rootfs file(s) no cached image names (${(bytes / 1024 ** 2).toFixed(0)} MiB)`
      )
  }

  /** Hold the lock every process sharing this cache takes: a removal deletes layer files a concurrent pull has chosen to reuse. */
  private async withImageCache(wait: boolean, work: () => Promise<void>): Promise<boolean> {
    const path = join(this.options.root, 'microsandbox', 'image-cache.lock')
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const deadline = Date.now() + IMAGE_LOCK_WAIT_MS
    for (;;) {
      let holder = process.pid
      if (!heldImageLocks.has(path)) {
        if (await createLock(path)) break
        const pid = await lockHolderPid(path)
        // Reclaimed only when provably gone; this pid without the in-process mark is an earlier incarnation's, as a restarted container reuses it.
        if (pid === undefined || pid === process.pid || !pidAlive(pid)) {
          await rm(path, { force: true })
          continue
        }
        holder = pid
      }
      if (!wait) return false
      if (Date.now() >= deadline)
        throw new Error(
          `microsandbox image cache lock ${path} is still held by pid ${holder}; stop that process or remove the lock`
        )
      await new Promise((resolve) => setTimeout(resolve, IMAGE_LOCK_POLL_MS))
    }
    heldImageLocks.add(path)
    try {
      await work()
    } finally {
      // The file goes first: another manager here that saw it unmarked would take this pid for a stale holder.
      if ((await lockHolderPid(path)) === process.pid) await rm(path, { force: true })
      heldImageLocks.delete(path)
    }
    return true
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

  /** Create a fixed-name VM, taking back the name a failed create left claimed: msb writes its directory before the database row `get` reads. */
  private async createReclaiming(name: string, build: () => SandboxBuilder): Promise<Sandbox> {
    try {
      return await build().create()
    } catch (error) {
      if (!(error instanceof this.options.sdk.SandboxAlreadyExistsError) || (await this.find(name))) throw error
      this.options.log?.warn(`microsandbox: reclaiming ${name}, which a failed create left behind`)
      // With no database row, replace refuses a live runtime and otherwise clears only the leftover directory.
      return await build().replace().create()
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
    for (const candidate of await this.environmentIds()) {
      if (this.sandboxName(candidate, await this.readBinding(candidate)) === holder.sandbox) id = candidate
    }
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
      const validOwned = (owned: OwnedSandbox): boolean => {
        const name = this.sandboxName(id, owned)
        return (
          (name === this.name(id) || new RegExp(`^${this.name(id)}-[a-f0-9]{32}$`).test(name)) &&
          typeof owned.sandboxId === 'string' &&
          typeof owned.configHash === 'string' &&
          (owned.dockerVolume === undefined || owned.dockerVolume === `${name}-docker`) &&
          (owned.overlayVolume === undefined || owned.overlayVolume === `${name}-overlays`)
        )
      }
      if (
        binding.version !== 1 ||
        binding.environmentId !== id ||
        typeof binding.spec !== 'string' ||
        !validOwned(binding as Binding) ||
        (binding.imageIdentity !== undefined && typeof binding.imageIdentity !== 'string') ||
        (binding.replacement !== undefined && !/^[a-f0-9]{32}$/.test(binding.replacement)) ||
        (binding.retired !== undefined && (!Array.isArray(binding.retired) || !binding.retired.every(validOwned)))
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
    let binding = await this.readBinding(environment.id)
    if (binding) {
      await this.cleanReplacement(binding)
      binding = await this.cleanRetired(binding)
    }
    const name = this.sandboxName(environment.id, binding)
    const { spec, imageIdentity: targetIdentity, sameImage } = await this.desiredSpec(environment, binding)
    const existing = await this.find(name)
    if (binding || existing) {
      const matchingSpec = binding?.spec === spec
      if (
        !binding ||
        !existing ||
        binding.sandboxId !== existing.id ||
        binding.configHash !== hash(stableJson(existing.config()))
      ) {
        throw new Error(
          `microsandbox environment ${environment.id} has missing or changed persisted configuration. Restore its recorded VM identity and configuration before retrying. Existing session data has been retained.`
        )
      }
      if (existing.status === 'running' || existing.status === 'starting' || existing.status === 'draining') {
        await existing.stopWithTimeout(STOP_TIMEOUT_MS)
      }
      if (!matchingSpec || !sameImage) return this.replace(environment, binding, targetIdentity)
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
        await this.startShim(environment, sandbox)
        return sandbox
      } catch (error) {
        await sandbox.stopWithTimeout(STOP_TIMEOUT_MS)
        await sandbox.detach()
        throw error
      }
    }
    const sandbox = await this.startVm(environment.id, () =>
      this.createReclaiming(name, () => this.builder(name, environment.mounts, environment.secrets))
    )
    try {
      const persisted = await this.options.sdk.Sandbox.get(name)
      const binding: Binding = {
        version: 1,
        environmentId: environment.id,
        spec,
        sandboxId: persisted.id,
        configHash: hash(stableJson(persisted.config())),
        imageIdentity: targetIdentity,
        dockerVolume: `${name}-docker`,
        ...(overlayMounts(environment.mounts).length ? { overlayVolume: `${name}-overlays` } : {})
      }
      await this.writeBinding(binding)
      await prepareOverlayMounts(sandbox, environment.mounts)
      await this.startShim(environment, sandbox)
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

  private async destroyOwned(id: string, owned: OwnedSandbox): Promise<void> {
    const handle = await this.find(this.sandboxName(id, owned))
    if (handle) {
      if (handle.id !== owned.sandboxId || hash(stableJson(handle.config())) !== owned.configHash)
        throw new Error('microsandbox retired environment identity changed')
      await handle.destroy({ timeoutMs: STOP_TIMEOUT_MS })
    }
    for (const volume of [owned.dockerVolume, owned.overlayVolume]) if (volume) await this.removeVolume(volume)
  }

  private async cleanRetired(binding: Binding): Promise<Binding> {
    if (!binding.retired?.length) return binding
    try {
      for (const owned of binding.retired) await this.destroyOwned(binding.environmentId, owned)
      delete binding.retired
      await this.writeBinding(binding)
    } catch (error) {
      this.options.log?.warn(`microsandbox: retired VM cleanup will retry — ${formatErr(error)}`)
    }
    return binding
  }

  private async cleanReplacement(binding: Binding): Promise<void> {
    if (!binding.replacement) return
    const name = `${this.name(binding.environmentId)}-${binding.replacement}`
    const handle = await this.find(name)
    if (handle) {
      const { labels } = z.object({ labels: z.record(z.string(), z.string()) }).parse(handle.config())
      if (labels[REPLACEMENT_LABEL] !== binding.replacement)
        throw new Error('microsandbox replacement environment identity changed')
      await handle.destroy({ timeoutMs: STOP_TIMEOUT_MS })
    }
    await this.removeVolume(`${name}-docker`)
    await this.removeVolume(`${name}-overlays`)
    delete binding.replacement
    await this.writeBinding(binding)
  }

  private async replace(
    environment: MicrosandboxEnvironment,
    binding: Binding,
    imageIdentity: string
  ): Promise<Sandbox> {
    const token = randomUUID().replaceAll('-', '')
    const name = `${this.name(environment.id)}-${token}`
    binding.replacement = token
    await this.writeBinding(binding)
    this.options.log?.info(`microsandbox: replacing environment ${environment.id}; host workspace mounts are retained`)
    let sandbox: Sandbox | undefined
    let next: Binding
    try {
      sandbox = await this.startVm(environment.id, () =>
        this.builder(name, environment.mounts, environment.secrets).label(REPLACEMENT_LABEL, token).create()
      )
      await prepareOverlayMounts(sandbox, environment.mounts)
      const checked = await sandbox.exec(MICROSANDBOX_NODE, [
        '-e',
        MOUNT_PROBE_SCRIPT,
        JSON.stringify(environment.mounts)
      ])
      if (!checked.success) throw new Error(`microsandbox replacement mount check failed: ${checked.stderr().trim()}`)
      await this.startShim(environment, sandbox)
      const persisted = await this.options.sdk.Sandbox.get(name)
      const old: OwnedSandbox = {
        sandboxName: binding.sandboxName,
        sandboxId: binding.sandboxId,
        configHash: binding.configHash,
        dockerVolume: binding.dockerVolume,
        overlayVolume: binding.overlayVolume
      }
      next = {
        version: 1,
        environmentId: environment.id,
        sandboxName: name,
        sandboxId: persisted.id,
        configHash: hash(stableJson(persisted.config())),
        spec: this.spec(environment),
        imageIdentity,
        dockerVolume: `${name}-docker`,
        ...(overlayMounts(environment.mounts).length ? { overlayVolume: `${name}-overlays` } : {}),
        retired: [...(binding.retired ?? []), old]
      }
      await this.writeBinding(next)
    } catch (error) {
      await this.stopShims(environment.id).catch(() => {})
      await sandbox?.stopWithTimeout(STOP_TIMEOUT_MS).catch(() => {})
      await sandbox?.detach().catch(() => {})
      await this.cleanReplacement(binding).catch((cleanup: unknown) =>
        this.options.log?.warn(`microsandbox: replacement cleanup will retry — ${formatErr(cleanup)}`)
      )
      throw error
    }
    // The new binding is durable before the old VM or its disposable disks are removed.
    await this.cleanRetired(next)
    this.options.log?.info(`microsandbox: environment ${environment.id} updated; ACP remains on demand`)
    return sandbox
  }

  private async writeBinding(binding: Binding): Promise<void> {
    const path = this.bindingPath(binding.environmentId)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFileAtomic(path, JSON.stringify(binding))
  }

  /** End whichever shim an environment has: the one bound here, or the exposed one a hosted environment keeps. */
  private async stopShims(id: string): Promise<void> {
    const shim = this.shims.get(id)
    this.shims.delete(id)
    const guest = this.guests.get(id)
    this.guests.delete(id)
    await shim?.stop()
    await guest?.stop()
  }

  // Runs inside the VM's start, so nothing can launch into a VM whose shim or helper tunnels are missing.
  private async startShim(environment: MicrosandboxEnvironment, sandbox: Sandbox): Promise<void> {
    const id = environment.id
    if (environment.hosted) {
      // No binding and no complete environment here: the daemon that drives this session is on another machine (§6).
      this.guests.set(
        id,
        await startGuestShim({
          sdk: this.options.sdk,
          sandbox,
          workspaceRoot: environment.workspaceRoot,
          completeEnv: false,
          seedEnv: environment.hosted.env,
          runtimeStderr: (text) => this.options.log?.debug(`microsandbox ${id}: ${text.trimEnd()}`),
          failed: (error) => {
            this.options.log?.error(`microsandbox: the hosted shim of ${id} ended — ${error.message}`)
            // Fenced as a bound shim's loss is: the VM stops, and the executor facet's next prepare starts it again.
            this.stopFailedEnvironment(id)
          },
          ...(this.options.log ? { log: this.options.log } : {})
        })
      )
      return
    }
    if (!this.options.nextShimGeneration) throw new Error('microsandbox shim generation allocator is unavailable')
    const shim = await (this.options.startShim ?? startMicrosandboxShim)({
      sdk: this.options.sdk,
      sandbox,
      subject: id,
      agentId: id.split('/')[0]!,
      workspaceRoot: environment.workspaceRoot,
      generation: await this.options.nextShimGeneration(id),
      sockets: this.options.sockets,
      runtimeStderr: (text) => {
        if (!this.environments.get(id)?.quiet) process.stderr.write(text)
      },
      failed: () => {
        this.options.log?.error(`microsandbox: shim exited for ${id}`)
        this.stopFailedEnvironment(id)
      },
      log: this.options.log
    })
    this.shims.set(id, shim)
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
    let stopping: Promise<void> | undefined
    if (state && state.spec !== spec) {
      if (state.active || state.pending.size || state.processes.size)
        throw new Error(`microsandbox environment ${environment.id} configuration changed while active`)
      stopping = this.closeEnvironment(environment.id, false)
      state = undefined
    }
    if (!state) {
      state = {
        environment,
        spec,
        sandbox: shareStartup(() =>
          withStartupPhase('sandbox', async () => {
            if (stopping) await stopping
            return await this.open(environment)
          })
        ),
        active: 0,
        processes: new Set(),
        pending: new Set(),
        lastUsed: Date.now(),
        quiet: 0
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
    stderr: (data: Uint8Array) => void
  ): Promise<MicrosandboxProcess> {
    const { state, release } = this.acquire(environment)
    let ready!: () => void
    const pending = new Promise<void>((resolve) => {
      ready = resolve
    })
    state.pending.add(pending)
    try {
      const sandbox = await awaitStartup(state.sandbox)
      if (this.closed) throw new Error('microsandbox manager is shutting down')
      options.abort?.throwIfAborted()
      if (!this.shims.has(environment.id))
        throw new Error(`microsandbox environment ${environment.id} shim is not running`)
      const handle = await openExecStream(this.options.sdk, sandbox, command, args, {
        cwd: options.cwd ?? environment.workspaceRoot,
        env: options.env,
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

  // The runtime starts through the VM's shim, the way a pool member starts one in a pod; the shim resolves the command and its hints in the guest.
  private async launch(environment: MicrosandboxEnvironment, request: SpawnRequest): Promise<SpawnedRuntime> {
    const { state, release } = this.acquire(environment)
    let ready!: () => void
    const pending = new Promise<void>((resolve) => {
      ready = resolve
    })
    state.pending.add(pending)
    try {
      const sandbox = await awaitStartup(state.sandbox)
      if (this.closed) throw new Error('microsandbox manager is shutting down')
      for (const file of request.files ?? []) {
        SinkRelPathSchema.parse(file.relPath)
        if (!posix.isAbsolute(file.root)) throw new Error('microsandbox materialization root must be absolute')
        const path = posix.join(file.root, ...file.relPath)
        await sandbox.fs().mkdir(posix.dirname(path))
        await sandbox.fs().write(path, file.content)
        const output = await sandbox.exec('chmod', ['0600', path])
        if (!output.success) throw new Error('microsandbox could not protect materialized file permissions')
      }
      // A process in the VM starts from the image's environment, which the shim's own allowlist would otherwise drop.
      const env = { ...(await imageEnv(sandbox)), ...request.env }
      const shim = this.shims.get(environment.id)
      if (state.failed || state.closing || !shim)
        throw new Error(`microsandbox environment ${environment.id} is stopping`)
      const runtime = createRemoteRuntime({
        session: shim.session,
        request: { ...request, env },
        cwd: environment.workspaceRoot,
        log: { info: (message) => this.options.log?.info(message), warn: (message) => this.options.log?.warn(message) }
      })
      if (request.suppressChildStderr) state.quiet++
      state.processes.add(runtime)
      let exited = false
      runtime.onExit(() => {
        exited = true
        if (request.suppressChildStderr) state.quiet--
        state.processes.delete(runtime)
        release()
      })
      return {
        ...runtime,
        stop: async (deadlineMs, eofGraceMs) => {
          await runtime.stop(deadlineMs, eofGraceMs)
          // A stop the shim never confirmed leaves a runtime nobody can reach, so the VM is fenced as it was for a lost exec stream.
          if (!exited) this.stopFailedEnvironment(environment.id)
        }
      }
    } catch (error) {
      release()
      throw error
    } finally {
      state.pending.delete(pending)
      ready()
    }
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
        await this.stopShims(id)
        if (binding) await this.cleanReplacement(binding)
        const handle = await this.find(this.sandboxName(id, binding))
        if (handle) {
          if (!binding || handle.id !== binding.sandboxId)
            throw new Error(`microsandbox environment ${id} identity changed`)
          if (remove) await handle.destroy({ timeoutMs: STOP_TIMEOUT_MS })
          else await handle.stopWithTimeout(STOP_TIMEOUT_MS)
        }
        if (state) await (await state.sandbox).detach()
        if (this.environments.get(id) === state) this.environments.delete(id)
        if (remove) {
          for (const owned of binding?.retired ?? []) await this.destroyOwned(id, owned)
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

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

async function writeFileAtomic(path: string, data: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, data, { mode: 0o600, flag: 'wx' })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

async function listDirectory(path: string): Promise<string[]> {
  try {
    return await readdir(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

/** Exclusive create with the pid already inside, so a reader never sees an empty lock. */
async function createLock(path: string): Promise<boolean> {
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, `${process.pid}\n`, { mode: 0o600, flag: 'wx' })
  try {
    await link(temporary, path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  } finally {
    await rm(temporary, { force: true })
  }
}

async function lockHolderPid(path: string): Promise<number | undefined> {
  const pid = Number.parseInt(await readFile(path, 'utf8').catch(() => ''), 10)
  return Number.isInteger(pid) && pid > 0 ? pid : undefined
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
