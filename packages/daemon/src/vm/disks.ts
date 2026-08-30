import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, openSync, rmSync, closeSync, ftruncateSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { VmPlacement } from './driver.js'

/** Where the guest mounts the share carrying this boot's shim secret, and the file inside it. */
export const BOOT_SHARE_TAG = 'acboot'
export const BOOT_SECRET_FILE = 'token'

export interface VmDiskLayoutOptions {
  /** Base image bundle: kernel, initrd.img, disk.img, manifest.json. Never written to. */
  baseBundlePath: string
  /** Per-daemon root holding every agent's VM state, e.g. `<agentconnect root>/vms`. */
  root: string
  cpuCount: number
  memoryBytes: number
  /** Size of a freshly created data disk. It is sparse, so this is a ceiling, not an allocation. */
  dataDiskBytes: number
  log: { info: (m: string) => void; warn: (m: string) => void }
}

/**
 * The two-disk layout, which is what makes suspend and resume work.
 *
 * `/dev/vda` is a per-boot clone of the base image and is thrown away with the boot, so an unclean
 * stop leaves a dirty filesystem nobody ever reads again — the failure mode that otherwise surfaces
 * as `EBADMSG` on a damaged block and looks like a missing shared library. `/dev/vdb` is the
 * agent's and survives: the workspace checkout and the container image store live there, so a
 * resumed guest finds its work and its pulled images where it left them.
 *
 * An image upgrade needs no migration for the same reason: the next boot clones the new base.
 */
export class VmDiskLayout {
  constructor(private readonly opts: VmDiskLayoutOptions) {}

  agentRoot(agentId: string): string {
    return join(this.opts.root, agentId)
  }

  dataDiskPath(agentId: string): string {
    return join(this.agentRoot(agentId), 'data.img')
  }

  private bootRoot(agentId: string, vmName: string): string {
    return join(this.agentRoot(agentId), 'boots', vmName)
  }

  /** Build everything one boot needs and hand back what the helper must be told. */
  place(agentId: string, vmName: string, bootSecret: string): VmPlacement {
    const boot = this.bootRoot(agentId, vmName)
    const bundle = join(boot, 'bundle')
    const share = join(boot, 'share')
    mkdirSync(bundle, { recursive: true })
    mkdirSync(share, { recursive: true })

    for (const name of ['kernel', 'initrd.img', 'manifest.json']) {
      const source = join(this.opts.baseBundlePath, name)
      // No initrd is a valid bundle; a missing kernel is not, and the helper says so far better.
      if (existsSync(source)) copyFileSync(source, join(bundle, name))
    }
    cloneFile(join(this.opts.baseBundlePath, 'disk.img'), join(bundle, 'disk.img'))
    this.ensureDataDisk(agentId)
    // 0600: the secret is the guest's proof of which boot it is, and the share is read-only inside.
    writeFileSync(join(share, BOOT_SECRET_FILE), bootSecret, { mode: 0o600 })

    return {
      bundlePath: bundle,
      dataDiskPath: this.dataDiskPath(agentId),
      consoleLogPath: join(this.agentRoot(agentId), 'console.log'),
      cpuCount: this.opts.cpuCount,
      memoryBytes: this.opts.memoryBytes,
      bootShare: { tag: BOOT_SHARE_TAG, path: share }
    }
  }

  /** Give back everything that belonged to one boot. The data disk is deliberately not touched. */
  unplace(agentId: string, vmName: string): void {
    rmSync(this.bootRoot(agentId, vmName), { recursive: true, force: true })
  }

  /** Remove an agent's VM state entirely, data disk included. For agent REMOVAL only. */
  discard(agentId: string): void {
    rmSync(this.agentRoot(agentId), { recursive: true, force: true })
  }

  /** Created once and kept: this is the disk the agent's work lives on. */
  private ensureDataDisk(agentId: string): void {
    const path = this.dataDiskPath(agentId)
    if (existsSync(path)) return
    mkdirSync(this.agentRoot(agentId), { recursive: true })
    const fd = openSync(path, 'w')
    try {
      ftruncateSync(fd, this.opts.dataDiskBytes)
    } finally {
      closeSync(fd)
    }
    this.opts.log.info(`vm: created data disk for agent "${agentId}" at ${path}`)
  }
}

/** APFS copy-on-write clone, which costs nothing and is why a per-boot rootfs is affordable at all.
 *  Falls back to a real copy wherever the filesystem cannot clone. */
export function cloneFile(source: string, destination: string, run = spawnSync): void {
  const cloned = run('cp', ['-c', source, destination], { stdio: 'ignore' })
  if (cloned.status === 0) return
  copyFileSync(source, destination)
}
