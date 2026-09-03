import { existsSync, lstatSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { isRepoSegment, PRIMARY_CHECKOUT_DIR, SECONDARY_ROOTS_DIR } from './secondary-layout.js'
import type { WorkspaceFs } from './workspace-fs.js'

// The on-disk shape of one confined session's directory, `<agentDir>/sessions/<leaf>/{workspace,repos/<owner>/<repo>,home}` (git-workspace-model.md §11) — separate from the manager, like secondary-layout.ts, so the launch path derives a session host's grants without the whole workspace module.

/** Every confined session's directory hangs off one agent-owned parent. */
export const SESSIONS_DIR = 'sessions'

/** `<agentRoot>/sessions` — the parent of every session directory. */
export function sessionsDirIn(agentRoot: string): string {
  return join(agentRoot, SESSIONS_DIR)
}

/** `<agentRoot>/sessions/<leaf>` — one session's own directory. */
export function sessionDirIn(agentRoot: string, leaf: string): string {
  return join(sessionsDirIn(agentRoot), leaf)
}

/** One root's clone inside a session directory: the primary's `workspace`, a secondary's `repos/<owner>/<repo>`. */
export function sessionRootCloneIn(sessionDir: string, repoFullName?: string): string {
  if (repoFullName === undefined) return join(sessionDir, PRIMARY_CHECKOUT_DIR)
  return join(sessionDir, SECONDARY_ROOTS_DIR, ...repoFullName.split('/'))
}

/** `<sessionDir>/home` — the session's own runtime HOME (state, temp, XDG, package caches), gone with the leaf. */
export function sessionHomeIn(sessionDir: string): string {
  return join(sessionDir, 'home')
}

/** Every `repos/<owner>/<repo>` clone ON DISK in a session directory, sorted by name; symlinks are skipped. */
export function sessionSecondaryClonesIn(sessionDir: string): { repoFullName: string; path: string }[] {
  const parent = join(sessionDir, SECONDARY_ROOTS_DIR)
  const out: { repoFullName: string; path: string }[] = []
  for (const owner of realDirEntries(parent)) {
    for (const repo of realDirEntries(join(parent, owner))) {
      out.push({ repoFullName: `${owner}/${repo}`, path: join(parent, owner, repo) })
    }
  }
  return out
}

/** Every clone a session directory holds — the primary's when it has one, then the secondaries'. */
export function sessionClonesIn(sessionDir: string): { repoFullName?: string; path: string }[] {
  const primary = sessionRootCloneIn(sessionDir)
  return [...(isRealDir(primary) ? [{ path: primary }] : []), ...sessionSecondaryClonesIn(sessionDir)]
}

/** {@link sessionClonesIn} asked of the filesystem that HOLDS the directory — a pod's volume as much as this disk. */
export async function sessionClonesUnder(
  fs: Pick<WorkspaceFs, 'stat' | 'readdir'>,
  sessionDir: string
): Promise<{ repoFullName?: string; path: string }[]> {
  const out: { repoFullName?: string; path: string }[] = []
  const primary = sessionRootCloneIn(sessionDir)
  if ((await fs.stat(primary)) === 'dir') out.push({ path: primary })
  const parent = join(sessionDir, SECONDARY_ROOTS_DIR)
  for (const owner of await dirEntriesUnder(fs, parent)) {
    for (const repo of await dirEntriesUnder(fs, join(parent, owner))) {
      out.push({ repoFullName: `${owner}/${repo}`, path: join(parent, owner, repo) })
    }
  }
  return out
}

/** Child directories of `dir` whose names are legal repository segments, sorted, as `fs` reports them; a missing parent is empty. */
async function dirEntriesUnder(fs: Pick<WorkspaceFs, 'stat' | 'readdir'>, dir: string): Promise<string[]> {
  if ((await fs.stat(dir)) !== 'dir') return []
  const names: string[] = []
  for (const name of await fs.readdir(dir)) {
    if (isRepoSegment(name) && (await fs.stat(join(dir, name))) === 'dir') names.push(name)
  }
  return names.sort()
}

/** The `.git` DIRECTORY of every clone in a session directory — a clone's own, never a worktree's link file. */
export function sessionGitDirsIn(sessionDir: string): string[] {
  return sessionClonesIn(sessionDir)
    .map((clone) => join(clone.path, '.git'))
    .filter(isRealDir)
}

/** Whether `path` is a directory in its own right — never a symlink to one. */
export function isRealDir(path: string): boolean {
  try {
    return lstatSync(path).isDirectory()
  } catch {
    return false
  }
}

/** Real (never symlinked) child directories whose names are legal repository segments, sorted. */
function realDirEntries(dir: string): string[] {
  if (!isRealDir(dir)) return []
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && isRepoSegment(entry.name))
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

/** Whether the agent has any session directory at all — the cheap prefilter the retention GC wants. */
export function hasSessionsDirIn(agentRoot: string): boolean {
  return existsSync(sessionsDirIn(agentRoot))
}

/** Every session directory ON DISK under `<agentRoot>/sessions`, by leaf name, sorted; symlinks are skipped. */
export function sessionDirsIn(agentRoot: string): { leaf: string; path: string }[] {
  const parent = sessionsDirIn(agentRoot)
  if (!isRealDir(parent)) return []
  try {
    return readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({ leaf: entry.name, path: join(parent, entry.name) }))
      .sort((a, b) => (a.leaf < b.leaf ? -1 : a.leaf > b.leaf ? 1 : 0))
  } catch {
    return []
  }
}
