/**
 * Activation + cleanup for the version store (cli-daemon-split.md §5). Both MUTATE
 * and must run inside the version lock (version-lock.ts).
 */
import { renameSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { basename } from 'node:path'
import { currentLink, versionDir } from './paths.js'
import { commandSelector } from './service/instance.js'
import { currentVersion, isInstalled, listInstalled, readMeta, writeMeta } from './version-store.js'

/**
 * Atomically point `current` at an installed version (symlink + rename). Records
 * the version it replaced as `previous` (the rollback target). No-op if already
 * current. §5 / §5.4.
 */
export function useVersion(root: string, version: string): void {
  if (!isInstalled(root, version)) {
    throw new Error(
      `daemon ${version} is not installed — run \`agentconnect${commandSelector({ root })} version install ${version}\` first`
    )
  }
  const prev = currentVersion(root)
  if (prev === version) return

  const link = currentLink(root)
  const tmp = `${link}.tmp`
  rmSync(tmp, { force: true })
  // Relative target so the whole root stays relocatable.
  symlinkSync(`versions/${version}`, tmp)
  renameSync(tmp, link) // atomic replace of the existing symlink

  if (prev && prev !== version) {
    writeMeta(root, { ...readMeta(root), previous: prev })
  }
}

/**
 * Remove old installed versions, keeping the newest `keep` prunable ones. `current`
 * and `previous` (the rollback target) are NEVER removed. §5.4.
 */
export function pruneVersions(root: string, keep = 2): string[] {
  const meta = readMeta(root)
  const cur = currentVersion(root)
  const protectedSet = new Set([cur, meta.previous].filter((v): v is string => Boolean(v)))

  const prunable = listInstalled(root)
    .filter((v) => !protectedSet.has(v))
    .map((v) => ({ v, mtime: statSync(versionDir(root, v)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime) // newest first

  const toRemove = prunable.slice(keep).map((x) => x.v)
  for (const v of toRemove) {
    rmSync(versionDir(root, v), { recursive: true, force: true })
  }
  return toRemove
}

/** Basename of an installed version dir (helper for callers that resolve paths). */
export function versionName(dir: string): string {
  return basename(dir)
}
