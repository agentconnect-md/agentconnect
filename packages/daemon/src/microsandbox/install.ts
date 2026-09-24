import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { RuntimeStore, installedRuntimeBin, runtimePackageTree } from '../runtimes/runtime-store.js'
import { MicrosandboxManager } from './driver.js'
import { MicrosandboxConfigSchema, type MicrosandboxConfig } from '../config/config-schema.js'
import type { Logger } from '../log.js'
import { resolveMicrosandboxImage } from '../release-image.js'
import { kvmPreflightFailure, observeKvm, type KvmObservation } from './kvm.js'

export const MICROSANDBOX_VERSION = '0.7.2'

const MSB_PACKAGE = { name: 'microsandbox', range: MICROSANDBOX_VERSION, bin: 'msb', args: [] }

export interface MicrosandboxInstallOptions {
  root: string
  config: MicrosandboxConfig | undefined
  sockets: { mcp: string; gitcred: string }
  log: Logger
  nextShimGeneration?: (subject: string) => Promise<number>
}

/** Why this machine cannot run a VM at all; undefined ⇒ Linux with a usable /dev/kvm. Opens a device and nothing else. */
export function microsandboxHostUnavailable(
  platform: NodeJS.Platform = process.platform,
  observe: () => KvmObservation = observeKvm
): string | undefined {
  if (platform !== 'linux') return 'microsandbox requires a Linux host with KVM'
  return kvmPreflightFailure(observe())
}

/** The pinned msb tree this root's store already holds, read without the registry; undefined ⇒ not installed yet, which the first use does. */
export function installedMicrosandbox(root: string): string | undefined {
  const tree = runtimePackageTree(root, MSB_PACKAGE.name, MICROSANDBOX_VERSION)
  if (!existsSync(tree)) return undefined
  if (!installedRuntimeBin(tree, MSB_PACKAGE))
    throw new Error(`microsandbox ${MICROSANDBOX_VERSION} at ${tree} is incomplete`)
  nativeRuntime(tree)
  return tree
}

/** Install the pinned msb if needed and build the manager; it pulls no image and boots no VM (session-executors.md §5). */
export async function installMicrosandbox(opts: MicrosandboxInstallOptions): Promise<MicrosandboxManager> {
  const host = microsandboxHostUnavailable()
  if (host) throw new Error(host)
  const installed = await new RuntimeStore({ root: opts.root, log: opts.log }).ensure(MSB_PACKAGE)
  if (installed.version !== MICROSANDBOX_VERSION) {
    throw new Error(`microsandbox requires version ${MICROSANDBOX_VERSION}; found ${installed.version}`)
  }
  return openMicrosandbox(installed.tree, opts)
}

/** Build the manager over an installed msb tree; nothing here reaches the network. */
export async function openMicrosandbox(tree: string, opts: MicrosandboxInstallOptions): Promise<MicrosandboxManager> {
  const config = MicrosandboxConfigSchema.parse(opts.config ?? {})
  const image = resolveMicrosandboxImage(config.image)
  const native = nativeRuntime(tree)
  const state = join(opts.root, 'microsandbox')
  mkdirSync(state, { recursive: true, mode: 0o700 })
  // The SDK has process-wide local state; this daemon owns its home for its entire lifetime.
  process.env.MSB_HOME = state
  process.env.MSB_BACKEND = 'local'
  const sdk = (await import(
    pathToFileURL(createRequire(join(tree, 'package.json')).resolve('microsandbox')).href
  )) as typeof import('microsandbox')
  return new MicrosandboxManager({
    ...opts,
    config: { ...config, image },
    sdk,
    msbCommand: { command: join(native, 'bin', 'msb'), args: [] }
  })
}

/** The platform package holding msb and the guest kernel; without libkrunfw the first VM would fail long after a probe said yes. */
function nativeRuntime(tree: string): string {
  const platform = `@superradcompany/microsandbox-linux-${process.arch}-gnu`
  const native = dirname(createRequire(join(tree, 'package.json')).resolve(`${platform}/package.json`))
  const libraries = join(native, 'lib')
  const libkrunfw = (() => {
    try {
      return readdirSync(libraries).some((name) => name.startsWith('libkrunfw'))
    } catch {
      return false
    }
  })()
  if (!libkrunfw) throw new Error(`microsandbox found no libkrunfw under ${libraries}`)
  if (!existsSync(join(native, 'bin', 'msb'))) throw new Error(`microsandbox found no msb under ${native}`)
  return native
}
