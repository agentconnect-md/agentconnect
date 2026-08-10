'use client'

// The live workspace read model, shared by the agent-detail file browser and the dock's Files panel: the per-directory listing cache with its cursor paging and expand set, the git status a tree's badges join against, and that badge.
// Listings and status are proxied through the CP straight from the owning daemon (body-locality), so a rejected read means that daemon is offline or the agent is unplaced — an expected state every consumer renders as data.

import { useCallback, useEffect, useState } from 'react'
import {
  ApiError,
  fetchWorkspaceFiles,
  fetchWorkspaceGitStatus,
  type WorkspaceEntryDto,
  type WorkspaceGitStatusDto
} from '@/lib/api'
import { fileBrowserGlyph } from '@/components/console/FileBrowser'

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))
// The CP's status separates an offline daemon (503) from one too old for session worktrees (409) and a session whose worktree the viewer cannot read (404); a consumer that wants those apart needs the number, not the flattened message.
const statusOf = (e: unknown) => (e instanceof ApiError ? e.status : null)

/** Per-directory listing state, keyed by directory path ('' = workspace root). Loaded lazily: the root on mount, each folder on first expand. */
export interface WorkspaceDirState {
  entries: WorkspaceEntryDto[] | null
  exists: boolean
  nextCursor: string | null
  loading: boolean
  loadingMore: boolean
  /** Initial-load failure — no entries yet. */
  err: string | null
  /** That failure's HTTP status, when it had one. */
  errStatus: number | null
  /** Append (Load more) failure — keeps the rows already loaded. */
  moreErr: string | null
}

const LOADING_DIR: WorkspaceDirState = {
  entries: null,
  exists: true,
  nextCursor: null,
  loading: true,
  loadingMore: false,
  err: null,
  errStatus: null,
  moreErr: null
}

export interface WorkspaceTree {
  /** Every directory fetched so far. Nothing is evicted — the cache lives as long as the mount, and is cleared only by a scope change or a refresh. */
  dirs: Record<string, WorkspaceDirState>
  /** The root listing; undefined only before the first fetch is dispatched. */
  root: WorkspaceDirState | undefined
  expanded: ReadonlySet<string>
  toggleDir: (path: string) => void
  loadMoreDir: (path: string) => void
  /** Open every directory in `paths`, loading each on first open. */
  openPath: (paths: string[]) => void
}

/** The tree half of the read model for one daemon-local checkout. `refreshTick` re-runs the root load, deliberately wiping the cache and the expand set with it. */
// `sessionId` selects that session's isolated worktree; omit it for the primary checkout, and pass it only for a session whose `workspaceIsolation` is `'session'` — the daemon answers a shared-workspace sessionId with BAD_PAYLOAD, which the CP maps to a 503 that reads as "the daemon may be offline".
export function useWorkspaceTree(agentId: string, sessionId?: string, refreshTick = 0): WorkspaceTree {
  const [dirs, setDirs] = useState<Record<string, WorkspaceDirState>>({})
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())

  // Patch one directory's state, seeding from LOADING_DIR when first seen.
  const patchDir = useCallback(
    (path: string, patch: Partial<WorkspaceDirState>) =>
      setDirs((prev) => ({ ...prev, [path]: { ...(prev[path] ?? LOADING_DIR), ...patch } })),
    []
  )

  // Fetch a folder's first page (a folder on first expand, or one typed into a path).
  const loadDir = useCallback(
    (path: string) => {
      patchDir(path, { loading: true, err: null, errStatus: null })
      fetchWorkspaceFiles(agentId, { path, ...(sessionId ? { sessionId } : {}) }).then(
        (page) =>
          setDirs((prev) => ({
            ...prev,
            [path]: {
              entries: page.entries,
              exists: page.exists,
              nextCursor: page.nextCursor,
              loading: false,
              loadingMore: false,
              err: null,
              errStatus: null,
              moreErr: null
            }
          })),
        (e) => patchDir(path, { loading: false, err: msg(e), errStatus: statusOf(e) })
      )
    },
    [agentId, patchDir, sessionId]
  )

  const loadMoreDir = useCallback(
    (path: string) => {
      const d = dirs[path]
      if (!d?.nextCursor || d.loadingMore) return
      patchDir(path, { loadingMore: true, moreErr: null })
      fetchWorkspaceFiles(agentId, { path, cursor: d.nextCursor, ...(sessionId ? { sessionId } : {}) }).then(
        (page) =>
          setDirs((prev) => {
            const cur = prev[path]
            if (!cur) return prev
            return {
              ...prev,
              [path]: {
                ...cur,
                entries: [...(cur.entries ?? []), ...page.entries],
                nextCursor: page.nextCursor,
                loadingMore: false
              }
            }
          }),
        (e) => patchDir(path, { loadingMore: false, moreErr: msg(e) })
      )
    },
    [agentId, dirs, patchDir, sessionId]
  )

  const toggleDir = useCallback(
    (path: string) => {
      const willOpen = !expanded.has(path)
      setExpanded((prev) => {
        const next = new Set(prev)
        if (next.has(path)) next.delete(path)
        else next.add(path)
        return next
      })
      // Collapsing keeps the cached listing, so re-expanding is instant.
      if (willOpen && !dirs[path]) loadDir(path)
    },
    [dirs, expanded, loadDir]
  )

  const openPath = useCallback(
    (paths: string[]) => {
      setExpanded((current) => new Set([...current, ...paths]))
      for (const path of paths) {
        if (!dirs[path]) loadDir(path)
      }
    },
    [dirs, loadDir]
  )

  // Reset the tree and load the root whenever the scope changes or a refresh lands.
  useEffect(() => {
    let active = true
    setDirs({ '': { ...LOADING_DIR } })
    setExpanded(new Set())
    fetchWorkspaceFiles(agentId, { path: '', ...(sessionId ? { sessionId } : {}) }).then(
      (page) => {
        if (!active) return
        setDirs({
          '': {
            entries: page.entries,
            exists: page.exists,
            nextCursor: page.nextCursor,
            loading: false,
            loadingMore: false,
            err: null,
            errStatus: null,
            moreErr: null
          }
        })
      },
      (e) => {
        if (active) setDirs({ '': { ...LOADING_DIR, loading: false, err: msg(e), errStatus: statusOf(e) } })
      }
    )
    return () => {
      active = false
    }
  }, [agentId, refreshTick, sessionId])

  return { dirs, root: dirs[''], expanded, toggleDir, loadMoreDir, openPath }
}

/** What the scoped git status resolved to. `none` is a from-scratch workspace and `unavailable` an offline daemon or unplaced agent — a null status alone cannot tell those two apart. */
export type WorkspaceGitOutcome = 'pending' | 'repo' | 'none' | 'unavailable'

export interface WorkspaceGitRead {
  /** The live status, or null for a non-repo workspace, an offline daemon, and the window before the first answer. */
  git: WorkspaceGitStatusDto | null
  outcome: WorkspaceGitOutcome
  /** The PRIMARY checkout's branch. Fetched separately in session scope, where the worktree is detached and its own `branch` names no branch. */
  primaryBranch: string | null
}

/** The git half of the read model: status for the badges and the footer, plus the branch label a session worktree cannot supply itself. */
export function useWorkspaceGitStatus(agentId: string, sessionId?: string, refreshTick = 0): WorkspaceGitRead {
  const [git, setGit] = useState<WorkspaceGitStatusDto | null>(null)
  const [outcome, setOutcome] = useState<WorkspaceGitOutcome>('pending')
  const [primaryBranch, setPrimaryBranch] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    setOutcome('pending')
    fetchWorkspaceGitStatus(agentId, sessionId).then(
      (s) => {
        if (!active) return
        setGit(s.isRepo ? s : null)
        setOutcome(s.isRepo ? 'repo' : 'none')
        if (!sessionId) setPrimaryBranch(s.isRepo ? s.branch : null)
      },
      () => {
        if (!active) return
        setGit(null)
        setOutcome('unavailable')
        if (!sessionId) setPrimaryBranch(null)
      }
    )
    if (sessionId) {
      fetchWorkspaceGitStatus(agentId).then(
        (s) => {
          if (active) setPrimaryBranch(s.isRepo ? s.branch : null)
        },
        () => {
          if (active) setPrimaryBranch(null)
        }
      )
    }
    return () => {
      active = false
    }
  }, [agentId, refreshTick, sessionId])

  return { git, outcome, primaryBranch }
}

/** Map browse-relative path → one git status letter for the tree badges. git paths are repo-relative, so when the browse root sits in a repo subdir (`agentDir`) the subdir-relative form is indexed too and badges match whichever root the daemon listed from; first write wins. */
// The XY pair collapses to one letter: untracked ('?' on either side) reads as 'U', otherwise the INDEX char wins — so a staged-then-edited file ('AM') badges its staged half and the unstaged half is invisible. One letter cannot show both, and a panel needing the split has to keep the raw pair. No directory roll-up: only file rows carry a badge.
export function workspaceDirtyMap(git: WorkspaceGitStatusDto | null): Map<string, string> {
  const m = new Map<string, string>()
  if (!git) return m
  const ad = (git.agentDir ?? '').replace(/^\.?\/*/, '').replace(/\/+$/, '')
  for (const f of git.files) {
    const x = (f.index ?? '').trim()
    const y = (f.workingDir ?? '').trim()
    const ch = x === '?' || y === '?' ? 'U' : (x || y || 'M').charAt(0)
    const put = (p: string) => {
      if (p && !m.has(p)) m.set(p, ch)
    }
    put(f.path)
    if (ad && (f.path === ad || f.path.startsWith(`${ad}/`))) put(f.path.slice(ad.length + 1))
  }
  return m
}

/** The row glyph for one listing entry. */
export function workspaceEntryIcon(entry: WorkspaceEntryDto): string {
  if (entry.type === 'dir') return 'folder'
  if (entry.type === 'symlink') return 'link-2'
  if (entry.type === 'other') return 'file-question-mark'
  return fileBrowserGlyph(entry.name)
}

// A one-letter git status for the tree badge, coloured GitHub-style: modified/renamed amber, added/untracked green, deleted red.
function statusMeta(ch: string): { color: string; title: string } {
  switch (ch) {
    case 'A':
    case 'U':
      return { color: 'var(--green-500)', title: ch === 'U' ? 'Untracked' : 'Added' }
    case 'D':
      return { color: 'var(--red-500)', title: 'Deleted' }
    case 'R':
      return { color: 'var(--amber-500)', title: 'Renamed' }
    default:
      return { color: 'var(--amber-500)', title: 'Modified' }
  }
}

export function StatusBadge({ ch }: { ch: string }) {
  const { color, title } = statusMeta(ch)
  return (
    <span
      className="mono inline-flex h-[15px] w-[15px] flex-none items-center justify-center rounded-xs bg-(--surface-sunken) text-[10px] font-bold"
      title={`${title} (uncommitted)`}
      style={{ color }}
    >
      {ch}
    </span>
  )
}
