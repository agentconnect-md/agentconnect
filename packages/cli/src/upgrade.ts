/**
 * `agentconnect upgrade` orchestration (cli-daemon-split.md §5.2): install the
 * target → flip `current` → optionally restart → health-check → auto-rollback on
 * failure. The caller wraps this in the version lock; the steps here assume it is
 * held. Dependencies are injected so the control flow (esp. rollback) is testable
 * without a registry or a real service.
 */
import { resolveController } from './service/index.js'
import { checkServiceHealthy, type HealthResult } from './health.js'
import { installTarget, resolveTarget } from './install.js'
import type { ResolvedTarget } from './registry.js'
import { currentVersion, readMeta, writeMeta, type Channel } from './version-store.js'
import { useVersion } from './version-ops.js'

export interface UpgradeOpts {
  to?: string
  channel?: Channel
  restart?: boolean
}

export interface UpgradeDeps {
  resolve: (o: { to?: string; channel: Channel }) => Promise<ResolvedTarget>
  install: (root: string, target: ResolvedTarget, log: (m: string) => void) => Promise<string>
  serviceInstalled: () => boolean
  restartService: () => Promise<void>
  health: () => Promise<HealthResult>
  log: (m: string) => void
}

export function realUpgradeDeps(root: string, log: (m: string) => void): UpgradeDeps {
  return {
    resolve: resolveTarget,
    install: installTarget,
    serviceInstalled: () => resolveController({ root }).isInstalled(),
    restartService: async () => {
      const c = resolveController({ root })
      await c.down()
      await c.up()
    },
    health: () => checkServiceHealthy(() => resolveController({ root }).status()),
    log
  }
}

export async function upgrade(root: string, opts: UpgradeOpts, deps: UpgradeDeps): Promise<void> {
  const meta = readMeta(root)
  const channel = opts.channel ?? meta.channel

  const target = await deps.resolve({ to: opts.to, channel })
  await deps.install(root, target, deps.log)

  const before = currentVersion(root)
  if (before === target.version && !opts.restart) {
    deps.log(`already on ${target.version}`)
    return
  }

  useVersion(root, target.version) // records `before` as previous (rollback target)
  if (opts.channel && opts.channel !== meta.channel) {
    writeMeta(root, { ...readMeta(root), channel: opts.channel })
  }
  deps.log(`current → ${target.version}`)

  if (!opts.restart) {
    deps.log('not restarting (pass --restart to apply now); the new version takes effect on the next daemon restart')
    return
  }
  if (!deps.serviceInstalled()) {
    deps.log(
      'no OS service installed — current switched, but nothing to restart (foreground run applies it on relaunch)'
    )
    return
  }

  await deps.restartService()
  const h = await deps.health()
  if (h.healthy) {
    deps.log(`upgraded to ${target.version} — healthy (${h.reason})`)
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
