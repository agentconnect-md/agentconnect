import { lstatSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { WorkspaceFs } from './workspace-fs.js'

// The on-disk shape of an agent's workspace roots (multi-repository-workspaces.md §"Directory
// layout"), separate from the manager so the launch path can read it without the whole workspace
// module: a sandboxed runtime's boundary is computed from these paths before any session exists.

/** The agent's own checkout, the root every session worktree is cut from. */
export const PRIMARY_CHECKOUT_DIR = 'workspace'
/** Secondary roots live under one agent-owned parent, one subtree per authorized repository. */
export const SECONDARY_ROOTS_DIR = 'repos'
/** Every root's per-session worktrees hang off this leaf of it — the agent root for the primary, the subtree for a secondary. */
export const WORKTREES_DIR = 'worktrees'
/** What a secondary root's subtree records about the checkout beside it. */
export const SECONDARY_MATERIALIZATION_FILE = '.materialization.json'

/** Where a root's subtree records that one session's working directory is ITS worktree, not the
 *  primary's — durable, because a restart re-prepares the same session from the disk alone. */
export function sessionCwdMarkerIn(subtree: string, sessionWorktreeId: string): string {
  return join(subtree, `.session-cwd-${sessionWorktreeId}.json`)
}
/** GitHub's own owner/repository charset, which is also a plain path segment. */
const REPO_SEGMENT = /^[A-Za-z0-9._-]+$/

/** A plain path segment that is also a legal GitHub owner or repository name. */
export function isRepoSegment(value: string | undefined): value is string {
  return value !== undefined && value !== '.' && value !== '..' && REPO_SEGMENT.test(value)
}

/** `<agentRoot>/workspace` — the primary checkout, whether or not it holds a repository. */
export function primaryCheckoutIn(agentRoot: string): string {
  return join(agentRoot, PRIMARY_CHECKOUT_DIR)
}

/** `<agentRoot>/repos` — the parent every secondary root's subtree hangs off. */
export function secondaryRootsDirIn(agentRoot: string): string {
  return join(agentRoot, SECONDARY_ROOTS_DIR)
}

/** One secondary subtree's daemon-owned paths, in the shape a `WorkspaceRoot` needs. */
export interface SecondarySubtree {
  repoFullName: string
  /** The whole `repos/<owner>/<repo>` subtree — what retirement removal deletes. */
  subtree: string
  /** The clone itself. */
  path: string
  /** Where this root's per-session worktrees live. */
  worktreesPath: string
}

/**
 * Every `repos/<owner>/<repo>` subtree ON DISK, authorized or retired, sorted by name.
 *
 * Reading the disk rather than the agent's rows is the point: a root that left the set still owns
 * worktrees and a checkout, and nothing else would ever look at them again. A symlinked parent or
 * entry is skipped rather than followed — no destructive caller may be redirected by one.
 */
export function secondarySubtreesIn(agentRoot: string): SecondarySubtree[] {
  const parent = secondaryRootsDirIn(agentRoot)
  const out: SecondarySubtree[] = []
  for (const owner of realDirEntries(parent)) {
    for (const repo of realDirEntries(join(parent, owner))) {
      const subtree = join(parent, owner, repo)
      out.push({
        repoFullName: `${owner}/${repo}`,
        subtree,
        path: join(subtree, 'checkout'),
        worktreesPath: join(subtree, WORKTREES_DIR)
      })
    }
  }
  return out
}

/**
 * The same subtrees under one parent, read through a workspace filesystem rather than `node:fs`.
 *
 * `parent` is already in that filesystem's coordinates — `<agentRoot>/repos` on this disk,
 * `<mount>/repos` on a sandbox volume — and `stat` never follows a symlink, so an entry that is not
 * a real directory is skipped exactly as the synchronous twin above skips it. Unlike that twin it
 * RAISES when the filesystem cannot answer (see {@link realDirEntriesUnder}). The twin stays for the
 * launch path, which computes a sandbox boundary before any agent seam exists, and where an
 * unreadable directory means one less carve-back rather than one less safety check.
 */
export async function secondarySubtreesUnder(fs: WorkspaceFs, parent: string): Promise<SecondarySubtree[]> {
  const out: SecondarySubtree[] = []
  for (const owner of await realDirEntriesUnder(fs, parent)) {
    for (const repo of await realDirEntriesUnder(fs, join(parent, owner))) {
      const subtree = join(parent, owner, repo)
      out.push({
        repoFullName: `${owner}/${repo}`,
        subtree,
        path: join(subtree, 'checkout'),
        worktreesPath: join(subtree, WORKTREES_DIR)
      })
    }
  }
  return out
}

/**
 * {@link realDirEntries} over a workspace filesystem.
 *
 * Absence is data and raises nothing; a filesystem that could not ANSWER is not, and must not read
 * as an empty tree. An empty answer here licenses resuming a cross-repository session in the primary
 * checkout and licenses judging only the primary worktree, so a dropped shim channel — or a
 * directory this process cannot list — has to abort the operation instead.
 */
async function realDirEntriesUnder(fs: WorkspaceFs, dir: string): Promise<string[]> {
  if ((await fs.stat(dir)) !== 'dir') return []
  const names: string[] = []
  for (const name of await fs.readdir(dir)) {
    if (!isRepoSegment(name)) continue
    if ((await fs.stat(join(dir, name))) !== 'dir') continue
    names.push(name)
  }
  return names.sort()
}

/** The materialized secondary checkouts under `<agentRoot>/repos`, for callers that only need those. */
export function secondaryCheckoutsIn(agentRoot: string): string[] {
  return secondarySubtreesIn(agentRoot).map((entry) => entry.path)
}

/** Real (never symlinked) child directories whose names are legal repository segments. */
function realDirEntries(dir: string): string[] {
  try {
    if (lstatSync(dir).isSymbolicLink()) return []
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && isRepoSegment(entry.name))
      .map((entry) => entry.name)
      .sort()
  } catch {
    // No `repos` parent, no owner directory, or one this process cannot read: no subtrees.
    return []
  }
}
