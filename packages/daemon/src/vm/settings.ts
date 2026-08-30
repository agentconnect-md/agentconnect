import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ByteCountFromEnv, positiveIntFromEnv } from './env.js'

/** Where a `--vm` daemon keeps guest state, under the daemon root it was given. */
export const VM_STATE_DIR = 'vms'
export const VM_IMAGE_DIR = join('vm', 'image')
export const VM_BIN = join('vm', 'bin', 'agentconnect-vmm')

/** Deployment-owned, so env rather than `config.json`: these describe what this machine can
 *  actually boot, which is the host's to state and not a per-agent preference. */
export const VM_IMAGE_ENV = 'AC_VM_IMAGE'
export const VM_BINARY_ENV = 'AC_VM_BINARY'
export const VM_CPUS_ENV = 'AC_VM_CPUS'
export const VM_MEMORY_ENV = 'AC_VM_MEMORY'
export const VM_DATA_DISK_ENV = 'AC_VM_DATA_DISK'
export const VM_MAX_GUESTS_ENV = 'AC_VM_MAX_GUESTS'
export const VM_TOTAL_VCPUS_ENV = 'AC_VM_TOTAL_VCPUS'

export interface VmSettings {
  /** Base image bundle: kernel, initrd.img, disk.img, manifest.json. Cloned, never written to. */
  imagePath: string
  /** The signed `agentconnect-vmm` helper. */
  binaryPath: string
  statePath: string
  cpuPerVm: number
  memoryBytes: number
  dataDiskBytes: number
  maxConcurrentVms?: number
  maxTotalVcpus?: number
}

/** One vCPU by default: more guests at one beat fewer at two for work that waits on a network. */
const DEFAULT_CPUS = 1
const DEFAULT_MEMORY_BYTES = 2 * 1024 ** 3
/** Sparse, so this is a ceiling the guest can grow into rather than space taken up front. */
const DEFAULT_DATA_DISK_BYTES = 32 * 1024 ** 3

export function resolveVmSettings(root: string, env: NodeJS.ProcessEnv = process.env): VmSettings {
  return {
    imagePath: env[VM_IMAGE_ENV] ?? join(root, VM_IMAGE_DIR),
    binaryPath: env[VM_BINARY_ENV] ?? join(root, VM_BIN),
    statePath: join(root, VM_STATE_DIR),
    cpuPerVm: positiveIntFromEnv(env[VM_CPUS_ENV], VM_CPUS_ENV) ?? DEFAULT_CPUS,
    memoryBytes: ByteCountFromEnv(env[VM_MEMORY_ENV], VM_MEMORY_ENV) ?? DEFAULT_MEMORY_BYTES,
    dataDiskBytes: ByteCountFromEnv(env[VM_DATA_DISK_ENV], VM_DATA_DISK_ENV) ?? DEFAULT_DATA_DISK_BYTES,
    ...(positiveIntFromEnv(env[VM_MAX_GUESTS_ENV], VM_MAX_GUESTS_ENV) === undefined
      ? {}
      : { maxConcurrentVms: positiveIntFromEnv(env[VM_MAX_GUESTS_ENV], VM_MAX_GUESTS_ENV)! }),
    ...(positiveIntFromEnv(env[VM_TOTAL_VCPUS_ENV], VM_TOTAL_VCPUS_ENV) === undefined
      ? {}
      : { maxTotalVcpus: positiveIntFromEnv(env[VM_TOTAL_VCPUS_ENV], VM_TOTAL_VCPUS_ENV)! })
  }
}

/**
 * Why this host cannot run `--vm`, or undefined when it can.
 *
 * Fail-closed on purpose, exactly as `--k8s` is: degrading to a local child process is the one
 * outcome the mode exists to prevent, because that is agent code on the daemon's own host with the
 * daemon user's authority. So a missing helper or image refuses the boot and says how to build it.
 */
export function vmPreflight(
  settings: VmSettings,
  host: { platform: string; arch: string } = process,
  exists: (path: string) => boolean = existsSync
): string | undefined {
  if (host.platform !== 'darwin') {
    return `--vm needs macOS: Virtualization.framework does not exist on ${host.platform}. On Linux use the OS sandbox (security.requireSandbox) or --k8s.`
  }
  if (host.arch !== 'arm64') {
    return `--vm needs Apple Silicon: the guest image is arm64 and this host is ${host.arch}.`
  }
  if (!exists(settings.binaryPath)) {
    return `--vm needs the VM helper at ${settings.binaryPath}. Build and sign it with: make -C packages/vmm build`
  }
  for (const required of ['kernel', 'disk.img', 'manifest.json']) {
    if (!exists(join(settings.imagePath, required))) {
      return `--vm needs a guest image bundle at ${settings.imagePath} (missing ${required}). Build one with: make -C packages/vmm image`
    }
  }
  return undefined
}
