/**
 * Activation + cleanup for the version store (cli-daemon-split.md §5). Both MUTATE
 * and must run inside the version lock (version-lock.ts).
 */
import { existsSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { DeferredVersionPrune, VERSION_PRUNE_DEFERRED_FILE } from '@agentconnect.md/protocol'
import { liveDaemonPid } from './daemon-live.js'
import { currentLink, versionDir } from './paths.js'
import { cliCommand } from './invocation.js'
import { currentVersion, isInstalled, listInstalled, readMeta, writeMeta } from './version-store.js'

/**
 * Atomically point `current` at an installed version (symlink + rename). Records
 * the version it replaced as `previous` (the rollback target). No-op if already
 * current. §5 / §5.4.
 */
export function useVersion(
  root: string,
  version: string,
  missing = (): string =>
    `daemon ${version} is not installed — run \`${cliCommand({ root })} version install ${version}\` first`
): void {
  if (!isInstalled(root, version)) throw new Error(missing())
  const prev = currentVersion(root)
  if (prev === version) return

  const link = currentLink(root)
  const tmp = `${link}.tmp`
  rmSync(tmp, { recursive: true, force: true })
  if (process.platform === 'win32') replaceWindowsCurrentJunction(root, version, link, tmp)
  else {
    symlinkSync(`versions/${version}`, tmp)
    renameSync(tmp, link)
  }

  if (prev && prev !== version) {
    writeMeta(root, { ...readMeta(root), previous: prev })
  }
}

/** Publish a Windows junction without requiring Developer Mode or administrator symlink privileges. */
function replaceWindowsCurrentJunction(root: string, version: string, link: string, tmp: string): void {
  const backup = `${link}.previous`
  if (!existsSync(link) && existsSync(backup)) renameSync(backup, link)
  rmSync(backup, { recursive: true, force: true })
  symlinkSync(versionDir(root, version), tmp, 'junction')
  let movedCurrent = false
  try {
    if (existsSync(link)) {
      renameSync(link, backup)
      movedCurrent = true
    }
    renameSync(tmp, link)
  } catch (error) {
    if (movedCurrent && !existsSync(link)) renameSync(backup, link)
    throw error
  } finally {
    rmSync(tmp, { recursive: true, force: true })
    if (existsSync(link)) rmSync(backup, { recursive: true, force: true })
  }
}

const collate = (a: string, b: string): number => a.localeCompare(b, 'en', { numeric: true })

/** Default retention for automatic and manual pruning: how many installed versions to keep in total. */
export const DEFAULT_KEEP_VERSIONS = 3

/** Keep the newest `keep` installed versions by mtime; `current`/`previous` plus `protect` are never removed and count against `keep`. §5.4 */
export function pruneVersions(root: string, keep = DEFAULT_KEEP_VERSIONS, protect: string[] = []): string[] {
  const meta = readMeta(root)
  const cur = currentVersion(root)
  const installed = listInstalled(root)
  const protectedSet = new Set(
    [cur, meta.previous, ...protect].filter((v): v is string => Boolean(v) && installed.includes(v as string))
  )

  const prunable = installed
    .filter((v) => !protectedSet.has(v))
    .map((v) => ({ v, mtime: statSync(versionDir(root, v)).mtimeMs }))
    // Newest install first; equal mtimes (same-second installs) fall back to version order.
    .sort((a, b) => b.mtime - a.mtime || collate(b.v, a.v))

  const slots = Math.max(0, keep - protectedSet.size)
  const toRemove = prunable.slice(slots).map((x) => x.v)
  for (const v of toRemove) {
    rmSync(versionDir(root, v), { recursive: true, force: true })
  }
  return toRemove
}

export interface AutoPruneOpts {
  /** Versions to keep in total (default DEFAULT_KEEP_VERSIONS); 0 disables the prune. */
  keep?: number
  /** Extra versions this operation must not lose — e.g. the one it just installed. */
  protect?: string[]
  /** The caller knows no daemon is executing an older bundle (it just restarted the live one onto `current`). */
  assumeIdle?: boolean
}

/** Best-effort prune for the automatic call sites: cleanup failure must never fail the install/upgrade. Lock held by caller. */
export function autoPrune(root: string, log: (m: string) => void, opts: AutoPruneOpts = {}): string[] {
  const keep = opts.keep ?? DEFAULT_KEEP_VERSIONS
  if (keep <= 0) return []
  // A daemon we did not just restart is still running the bundle it was launched under, which may be any installed version.
  const livePid = opts.assumeIdle ? null : liveDaemonPid(root)
  if (livePid !== null) {
    deferPrune(root, keep, opts.protect ?? [], log)
    log(`kept old versions: daemon pid ${livePid} is still running — its next start on \`current\` prunes them`)
    return []
  }
  try {
    const removed = pruneVersions(root, keep, opts.protect ?? [])
    rmSync(deferredPrunePath(root), { force: true })
    if (removed.length) log(`pruned ${removed.length} old version(s): ${removed.join(', ')}`)
    return removed
  } catch (err) {
    log(`could not prune old versions: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
}

export function deferredPrunePath(root: string): string {
  return join(root, VERSION_PRUNE_DEFERRED_FILE)
}

/** The deferred prune on disk, or undefined when absent or unreadable (an unreadable record defers nothing). */
export function readDeferredPrune(root: string): DeferredVersionPrune | undefined {
  try {
    const parsed = DeferredVersionPrune.safeParse(JSON.parse(readFileSync(deferredPrunePath(root), 'utf8')))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

// Merged with an earlier deferral: the latest retention wins, and every version some deferral protected stays protected.
function deferPrune(root: string, keep: number, protect: string[], log: (m: string) => void): void {
  const earlier = readDeferredPrune(root)
  const record: DeferredVersionPrune = { keep, protect: [...new Set([...(earlier?.protect ?? []), ...protect])] }
  const file = deferredPrunePath(root)
  try {
    writeFileSync(`${file}.tmp`, JSON.stringify(record, null, 2) + '\n')
    renameSync(`${file}.tmp`, file)
  } catch (err) {
    log(`could not record the deferred prune: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** Run the prune a live daemon deferred, once the daemon reports it runs `current`; lock held by caller. */
export function runDeferredPrune(root: string, running: string): { removed: string[] } | { skipped: string } {
  const deferred = readDeferredPrune(root)
  if (!deferred) return { skipped: 'no deferred prune' }
  const active = currentVersion(root)
  // A daemon on any other bundle may still load files from a version the prune would remove.
  if (active !== running) return { skipped: `the daemon runs ${running}, not current ${active ?? '(none)'}` }
  const removed = pruneVersions(root, deferred.keep, deferred.protect)
  rmSync(deferredPrunePath(root), { force: true })
  return { removed }
}

/** Basename of an installed version dir (helper for callers that resolve paths). */
export function versionName(dir: string): string {
  return basename(dir)
}
