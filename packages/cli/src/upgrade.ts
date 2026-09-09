// Install and prepare before activation; the caller holds the version lock through restart and rollback.
import { resolveController } from './service/index.js'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawnDaemon } from './delegate.js'
import { versionDir } from './paths.js'
import { checkServiceHealthy, type HealthResult } from './health.js'
import { installTarget, resolveTarget } from './install.js'
import type { ResolvedTarget } from './registry.js'
import { currentVersion, readMeta, writeMeta, type Channel } from './version-store.js'
import { autoPrune, DEFAULT_KEEP_VERSIONS, useVersion, type AutoPruneOpts } from './version-ops.js'

export interface UpgradeOpts {
  to?: string
  channel?: Channel
  restart?: boolean
  configPath?: string
  /** Retention for the post-upgrade prune (default DEFAULT_KEEP_VERSIONS); 0 disables it. */
  keep?: number
}

export interface UpgradeDeps {
  resolve: (o: { to?: string; channel: Channel }) => Promise<ResolvedTarget>
  install: (root: string, target: ResolvedTarget, log: (m: string) => void) => Promise<string>
  prepare: (root: string, version: string, configPath?: string) => Promise<void>
  serviceInstalled: () => boolean
  restartService: () => Promise<void>
  health: () => Promise<HealthResult>
  /** Drop old versions once the new one is in place; returns what was removed. */
  prune: (opts: AutoPruneOpts) => string[]
  log: (m: string) => void
}

export function realUpgradeDeps(root: string, log: (m: string) => void): UpgradeDeps {
  return {
    resolve: resolveTarget,
    install: installTarget,
    prepare: prepareDaemonUpgrade,
    serviceInstalled: () => resolveController({ root }).isInstalled(),
    restartService: async () => {
      const c = resolveController({ root })
      await c.down()
      await c.up()
    },
    health: () => checkServiceHealthy(() => resolveController({ root }).status()),
    prune: (opts) => autoPrune(root, log, opts),
    log
  }
}

// The target bundle owns sandbox configuration and release image selection.
export async function prepareDaemonUpgrade(root: string, version: string, configPath?: string): Promise<void> {
  const entry = join(versionDir(root, version), 'dist', 'prepare-upgrade.js')
  if (!existsSync(entry)) return
  const args = ['--root', root, ...(configPath ? ['--config', configPath] : [])]
  const result = await spawnDaemon(entry, args).done
  if (result.code !== 0) {
    throw new Error(`daemon ${version} upgrade preparation failed (${result.signal ?? result.code}); current unchanged`)
  }
}

export async function upgrade(root: string, opts: UpgradeOpts, deps: UpgradeDeps): Promise<void> {
  const meta = readMeta(root)
  const channel = opts.channel ?? meta.channel

  const target = await deps.resolve({ to: opts.to, channel })
  await deps.install(root, target, deps.log)

  const keep = opts.keep ?? DEFAULT_KEEP_VERSIONS
  // The prune always protects the target; `autoPrune` defers entirely while a daemon we did not restart is live.
  const prune = (assumeIdle = false): void => {
    deps.prune({ keep, protect: [target.version], assumeIdle })
  }

  const before = currentVersion(root)
  if (before === target.version && !opts.restart) {
    deps.log(`already on ${target.version}`)
    prune()
    return
  }

  await deps.prepare(root, target.version, opts.configPath)
  useVersion(root, target.version) // records `before` as previous (rollback target)
  if (opts.channel && opts.channel !== meta.channel) {
    writeMeta(root, { ...readMeta(root), channel: opts.channel })
  }
  deps.log(`current → ${target.version}`)

  if (!opts.restart) {
    deps.log('not restarting (pass --restart to apply now); the new version takes effect on the next daemon restart')
    prune()
    return
  }
  if (!deps.serviceInstalled()) {
    deps.log(
      'no OS service installed — current switched, but nothing to restart (foreground run applies it on relaunch)'
    )
    prune()
    return
  }

  await deps.restartService()
  const h = await deps.health()
  if (h.healthy) {
    deps.log(`upgraded to ${target.version} — healthy (${h.reason})`)
    // The restart put the live daemon on the new `current`, so no process is holding an older bundle open.
    prune(true)
    return
  }

  // Auto-rollback: flip back to the previous version and restart it.
  deps.log(`health check failed (${h.reason}) — rolling back`)
  if (!before) {
    throw new Error(
      `upgrade to ${target.version} failed its health check and there is no previous version to roll back to`
    )
  }
  useVersion(root, before)
  await deps.restartService()
  throw new Error(`upgrade to ${target.version} failed its health check — rolled back to ${before}`)
}
