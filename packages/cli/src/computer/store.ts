// The computer daemon's version store and its upgrade (computer-use.md §3.5), on the agent daemon's store primitives.
import { checkServiceHealthy, type HealthResult } from '../health.js'
import { installTarget, resolveTarget, type StorePackage } from '../install.js'
import { DESKTOP_PKG, type ResolvedTarget } from '../registry.js'
import { autoPrune, DEFAULT_KEEP_VERSIONS, useVersion, type AutoPruneOpts } from '../version-ops.js'
import { currentVersion, readMeta, writeMeta, type Channel } from '../version-store.js'
import { DESKTOP_PACKAGE_ENTRY, storeEntry, versionEntry, type DesktopLaunch } from './launch.js'
import type { EntryRunner } from './run.js'

export const DESKTOP_STORE: StorePackage = { label: 'computer daemon', entry: DESKTOP_PACKAGE_ENTRY }

export interface ComputerServiceState {
  installed: boolean
  running: boolean
  pid?: number
  label: string
}

export interface ComputerOps {
  resolve: (o: { to?: string; channel: Channel }) => Promise<ResolvedTarget>
  install: (root: string, target: ResolvedTarget, log: (m: string) => void) => Promise<string>
  /** Whether this platform's background service runs the store's entry (a systemd user unit); the macOS app and the Windows Run key do not yet. */
  serviceRunsStore: boolean
  status: (version: string) => Promise<ComputerServiceState>
  /** Rewrites the service from that version, so a changed unit or autostart entry reaches the host. */
  refresh: (version: string) => Promise<void>
  restart: (version: string) => Promise<void>
  health: (version: string) => Promise<HealthResult>
  prune: (opts: AutoPruneOpts) => string[]
  log: (m: string) => void
}

export interface ComputerTargetOpts {
  version?: string
  channel?: Channel
  keep?: number
}

const missing = (selfCommand: string) => (version: string) => (): string =>
  `computer daemon ${version} is not installed — run \`${selfCommand} install --version ${version}\``

// Install (or reuse) the resolved version and make it current; the caller holds the version lock.
export async function installComputer(
  root: string,
  opts: ComputerTargetOpts,
  ops: Pick<ComputerOps, 'resolve' | 'install' | 'prune' | 'log'>,
  selfCommand: string
): Promise<string> {
  const channel = opts.channel ?? readMeta(root).channel
  const target = await ops.resolve({ ...(opts.version ? { to: opts.version } : {}), channel })
  await ops.install(root, target, ops.log)
  if (opts.channel && opts.channel !== readMeta(root).channel)
    writeMeta(root, { ...readMeta(root), channel: opts.channel })
  if (currentVersion(root) !== target.version) {
    useVersion(root, target.version, missing(selfCommand)(target.version))
    ops.log(`current → ${target.version}`)
  }
  ops.prune({ keep: opts.keep ?? DEFAULT_KEEP_VERSIONS, protect: [target.version] })
  return target.version
}

// Install side by side, switch `current`, restart a running service and roll back when it fails its health check.
export async function upgradeComputer(
  root: string,
  opts: ComputerTargetOpts,
  ops: ComputerOps,
  selfCommand: string
): Promise<string> {
  const meta = readMeta(root)
  const channel = opts.channel ?? meta.channel
  const target = await ops.resolve({ ...(opts.version ? { to: opts.version } : {}), channel })
  await ops.install(root, target, ops.log)
  if (opts.channel && opts.channel !== meta.channel) writeMeta(root, { ...readMeta(root), channel: opts.channel })
  const prune = (): void => void ops.prune({ keep: opts.keep ?? DEFAULT_KEEP_VERSIONS, protect: [target.version] })

  const before = currentVersion(root)
  if (before === target.version) {
    ops.log(`already on ${target.version}`)
    prune()
    return target.version
  }
  // The running version answers for the service, so a broken target cannot hide a running one.
  const service = before && ops.serviceRunsStore ? await ops.status(before) : undefined
  useVersion(root, target.version, missing(selfCommand)(target.version))
  ops.log(`current → ${target.version}`)

  if (!service?.installed) {
    ops.log(
      ops.serviceRunsStore
        ? `no service installed — the new version runs the next time the computer daemon starts (\`${selfCommand} setup\` installs the service)`
        : `restart the computer daemon to run ${target.version}`
    )
    prune()
    return target.version
  }

  const rollback = async (reason: string): Promise<never> => {
    ops.log(`${reason} — rolling back to ${before}`)
    useVersion(root, before!, missing(selfCommand)(before!))
    await ops
      .refresh(before!)
      .catch((err: Error) => ops.log(`could not restore the service from ${before}: ${err.message}`))
    if (service.running) await ops.restart(before!)
    throw new Error(`upgrade to ${target.version} failed (${reason}) — rolled back to ${before}`)
  }

  try {
    await ops.refresh(target.version)
  } catch (err) {
    return rollback(`service install from ${target.version} failed: ${(err as Error).message}`)
  }
  if (!service.running) {
    ops.log(`service ${service.label} is not running (no desktop session?) — ${target.version} starts with it`)
    prune()
    return target.version
  }
  try {
    await ops.restart(target.version)
  } catch (err) {
    return rollback(`restart failed: ${(err as Error).message}`)
  }
  const health = await ops.health(target.version)
  if (!health.healthy) return rollback(`health check failed: ${health.reason}`)
  ops.log(`upgraded to ${target.version} — healthy (${health.reason})`)
  prune()
  return target.version
}

interface ServiceStatusJson {
  installed?: boolean
  loaded?: boolean
  pid?: number
  unit?: string
  plist?: string
}

const parseJson = <T>(text: string): T | undefined => {
  try {
    return JSON.parse(text) as T
  } catch {
    return undefined
  }
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export interface RealOpsOptions {
  run: EntryRunner
  log: (m: string) => void
  platform?: NodeJS.Platform
  node?: string
  /** How long the restarted daemon has to answer with the new version on its loopback controls. */
  readyMs?: number
  settleMs?: number
}

// The store operations against the real registry and the installed daemon's own `service` / `status` commands.
export function realComputerOps(root: string, o: RealOpsOptions): ComputerOps {
  const platform = o.platform ?? process.platform
  const node = o.node ?? process.execPath
  const launch = (version: string, args: string[]): DesktopLaunch => ({
    command: node,
    args: [versionEntry(root, version, platform), ...args],
    serviceEntry: storeEntry(root, platform)
  })
  const service = async (version: string, action: string): Promise<void> => {
    const result = await o.run(launch(version, ['service', action]), { capture: true, timeoutMs: 120_000 })
    if (result.code !== 0)
      throw new Error(`service ${action} exited ${result.code}: ${result.stdout.trim().slice(-400)}`)
  }
  const status = async (version: string): Promise<ComputerServiceState> => {
    const result = await o.run(launch(version, ['service', 'status']), { capture: true, timeoutMs: 30_000 })
    const json = result.code === 0 ? parseJson<ServiceStatusJson>(result.stdout) : undefined
    return {
      installed: Boolean(json?.installed),
      running: Boolean(json?.loaded),
      ...(json?.pid ? { pid: json.pid } : {}),
      label: json?.unit ?? json?.plist ?? 'computer daemon service'
    }
  }
  // The daemon is up when its loopback controls answer with the version it was upgraded to.
  const answers = async (version: string): Promise<boolean> => {
    const deadline = Date.now() + (o.readyMs ?? 90_000)
    for (;;) {
      const result = await o.run(launch(version, ['status']), { capture: true, timeoutMs: 10_000 })
      const json = result.code === 0 ? parseJson<{ version?: string }>(result.stdout) : undefined
      if (json?.version === version) return true
      if (Date.now() >= deadline) return false
      await delay(2000)
    }
  }
  return {
    resolve: (opts) => resolveTarget(opts, DESKTOP_PKG),
    install: (r, target, log) => installTarget(r, target, log, { pkg: DESKTOP_STORE }),
    serviceRunsStore: platform === 'linux',
    status,
    refresh: (version) => service(version, 'install'),
    restart: (version) => service(version, 'restart'),
    health: async (version) => {
      const settled = await checkServiceHealthy(
        async () => ({ ...(await status(version)), logPath: '' }),
        o.settleMs === undefined ? {} : { settleMs: o.settleMs }
      )
      if (!settled.healthy) return settled
      return (await answers(version))
        ? { healthy: true, reason: `${settled.reason}, answering as ${version}` }
        : { healthy: false, reason: `the daemon did not answer as ${version} on its loopback controls` }
    },
    // A desktop bundle is one file loaded at start, and `current` and `previous` are always kept.
    prune: (opts) => autoPrune(root, o.log, { ...opts, assumeIdle: true }),
    log: o.log
  }
}
