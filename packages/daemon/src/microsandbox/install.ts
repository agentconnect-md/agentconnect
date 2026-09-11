import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { RuntimeStore } from '../runtimes/runtime-store.js'
import { MicrosandboxManager } from './driver.js'
import { MicrosandboxConfigSchema, type Config } from '../config/config-schema.js'
import type { Logger } from '../log.js'
import { resolveMicrosandboxImage } from '../release-image.js'

export const MICROSANDBOX_VERSION = '0.6.17'

export async function installMicrosandbox(opts: {
  root: string
  config: Config['sandbox']['microsandbox']
  sockets: { mcp: string; gitcred: string }
  log: Logger
  nextShimGeneration?: (subject: string) => Promise<number>
}): Promise<MicrosandboxManager> {
  if (process.platform !== 'linux') throw new Error('microsandbox currently requires a Linux host with KVM')
  const config = MicrosandboxConfigSchema.parse(opts.config ?? {})
  const image = resolveMicrosandboxImage(config.image)
  const state = join(opts.root, 'microsandbox')
  mkdirSync(state, { recursive: true, mode: 0o700 })
  // The SDK has process-wide local state; this daemon owns its home for its entire lifetime.
  process.env.MSB_HOME = state
  process.env.MSB_BACKEND = 'local'
  const installed = await new RuntimeStore({ root: opts.root, log: opts.log }).ensure({
    name: 'microsandbox',
    range: MICROSANDBOX_VERSION,
    bin: 'msb',
    args: []
  })
  if (installed.version !== MICROSANDBOX_VERSION) {
    throw new Error(`microsandbox requires version ${MICROSANDBOX_VERSION}; found ${installed.version}`)
  }
  const installedRequire = createRequire(join(installed.tree, 'package.json'))
  const sdk = (await import(
    pathToFileURL(installedRequire.resolve('microsandbox')).href
  )) as typeof import('microsandbox')
  const platform = `@superradcompany/microsandbox-linux-${process.arch}-gnu`
  const command = join(dirname(installedRequire.resolve(`${platform}/package.json`)), 'bin', 'msb')
  return new MicrosandboxManager({ ...opts, config: { ...config, image }, sdk, msbCommand: { command, args: [] } })
}
