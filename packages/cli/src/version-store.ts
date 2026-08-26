/**
 * The on-disk daemon version store (cli-daemon-split.md §3/§5). Layout under
 * `<root>`:
 *   versions/<v>/        — one extracted, self-contained daemon bundle
 *   current -> versions/<v>  — the active version (symlink; directory junction on Windows)
 *   versions.json        — CLI-private metadata (channel + rollback target)
 *
 * All MUTATING operations here must run inside the version lock (version-lock.ts);
 * the read helpers (`listInstalled`, `currentVersion`, `readMeta`) do not lock —
 * symlink/rename atomicity is enough for readers.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { currentLink, versionsDir, versionsJsonPath } from './paths.js'
import { CLI_VERSION } from './version.js'

export type Channel = 'stable' | 'rc'

export interface VersionsMeta {
  /** Default channel `upgrade` resolves against when no explicit version is given. */
  channel: Channel
  /** The version `current` pointed at before the last switch — the rollback target. */
  previous: string | null
}

/**
 * The channel the CLI tracks when none has been explicitly stored/chosen: the CLI
 * follows its OWN release channel, so a release-candidate CLI (`…-rc.N`, published
 * on npm's `rc` dist-tag) pulls rc daemons, while any other build (stable `latest`,
 * or an unpublished `…-dev`) tracks `stable`. This is only the DEFAULT — once a user
 * runs `install`/`upgrade --channel <ch>` it is persisted in versions.json and wins.
 */
export function defaultChannel(): Channel {
  return CLI_VERSION.includes('-rc') ? 'rc' : 'stable'
}

export function readMeta(root: string): VersionsMeta {
  const file = versionsJsonPath(root)
  if (!existsSync(file)) return { channel: defaultChannel(), previous: null }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<VersionsMeta>
    return {
      channel: raw.channel === 'rc' ? 'rc' : raw.channel === 'stable' ? 'stable' : defaultChannel(),
      previous: typeof raw.previous === 'string' ? raw.previous : null
    }
  } catch {
    // A corrupt metadata file must not wedge version management: fall back to the
    // CLI-derived default (the installed dirs + current symlink remain the truth).
    return { channel: defaultChannel(), previous: null }
  }
}

/** Persist metadata atomically (tmp + rename). Call inside the version lock. */
export function writeMeta(root: string, meta: VersionsMeta): void {
  const file = versionsJsonPath(root)
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(meta, null, 2) + '\n')
  renameSync(tmp, file)
}

/** Installed version directory names, newest-mtime-irrelevant (sorted for stable output). */
export function listInstalled(root: string): string[] {
  const dir = versionsDir(root)
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.endsWith('.tmp'))
    .map((e) => e.name)
    .sort()
}

/** The active version (basename of the `current` symlink target), or null. */
export function currentVersion(root: string): string | null {
  const link = currentLink(root)
  try {
    return basename(readlinkSync(link))
  } catch {
    if (process.platform !== 'win32') return null
    try {
      renameSync(`${link}.previous`, link)
      return basename(readlinkSync(link))
    } catch {
      try {
        return basename(readlinkSync(link))
      } catch {
        return null
      }
    }
  }
}

export function isInstalled(root: string, version: string): boolean {
  return listInstalled(root).includes(version)
}
