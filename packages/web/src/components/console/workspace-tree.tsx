'use client'

// The live workspace read model, shared by the agent-detail file browser and the dock's Files panel: the per-directory listing cache with its cursor paging and expand set, the git status a tree's badges join against, and that badge.
// Listings and status are proxied through the CP straight from the owning daemon (body-locality), so a rejected read means that daemon is offline or the agent is unplaced — an expected state every consumer renders as data.

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ApiError,
  fetchWorkspaceFiles,
  fetchWorkspaceGitStatus,
  type WorkspaceEntryDto,
  type WorkspaceGitStatusDto
} from '@/lib/api'
import { fileBrowserGlyph } from '@/components/console/FileBrowser'
import type { SandboxReadState } from '@/components/console/sandbox-wake'

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))
// The CP's status separates an offline daemon (503) from one too old for session worktrees (409) and a session whose worktree the viewer cannot read (404); a consumer that wants those apart needs the number, not the flattened message.
const statusOf = (e: unknown) => (e instanceof ApiError ? e.status : null)
// ...and the status alone is not enough for one case: a sandbox that is asleep is a 503 like an offline daemon, and only the code tells them apart.
const codeOf = (e: unknown) => (e instanceof ApiError ? (e.code ?? null) : null)

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
  /** That failure's machine code, when the CP named one — the only thing separating a sandbox that is asleep from an offline daemon, since both are 503. */
  errCode: string | null
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
  errCode: null,
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

/** The tree half of the read model for one daemon-local checkout. `refreshTick` re-reads the root AND every open folder, keeping the expand set; a SCOPE change is the one thing that wipes both. */
// `sessionId` selects that session's isolated worktree; omit it for the primary checkout, and pass it only for a session whose `workspaceIsolation` is `'session'` — the daemon answers a shared-workspace sessionId with BAD_PAYLOAD, which the CP maps to a 503 that reads as "the daemon may be offline".
// `repo` selects one of the agent's authorized additional repositories, browsing that secondary root; the two scopes compose, so a `repo` with a `sessionId` is that root's own worktree for the session.
export function useWorkspaceTree(agentId: string, sessionId?: string, refreshTick = 0, repo?: string): WorkspaceTree {
  const [dirs, setDirs] = useState<Record<string, WorkspaceDirState>>({})
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  // Which checkout this is, as one value: what tells a refresh (re-read what is open) from a scope
  // change (a different tree entirely, where the previous expand set names paths that may not exist).
  const scope = `${agentId}\u0000${sessionId ?? ''}\u0000${repo ?? ''}`
  const lastScope = useRef<string | null>(null)
  // The expand set as the refresh effect reads it. A REF because the effect must not re-run when a
  // folder opens — that would re-read the whole tree on every expand.
  const expandedRef = useRef(expanded)
  expandedRef.current = expanded
  // Which checkout+refresh a reply was asked for. The panel SURVIVES a scope change, so an in-flight directory read from the previous agent or worktree would otherwise splice its entries into the new one's cache — and worse, leave `dirs[path]` populated, so expanding that folder in the new scope skips the fetch that would have corrected it.
  const generation = useRef(0)

  // Patch one directory's state, seeding from LOADING_DIR when first seen.
  const patchDir = useCallback(
    (path: string, patch: Partial<WorkspaceDirState>) =>
      setDirs((prev) => ({ ...prev, [path]: { ...(prev[path] ?? LOADING_DIR), ...patch } })),
    []
  )

  // Fetch a folder's first page (a folder on first expand, or one typed into a path).
  const loadDir = useCallback(
    (path: string) => {
      const gen = generation.current
      patchDir(path, { loading: true, err: null, errStatus: null, errCode: null })
      fetchWorkspaceFiles(agentId, { path, ...(sessionId ? { sessionId } : {}), ...(repo ? { repo } : {}) }).then(
        (page) => {
          if (gen !== generation.current) return
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
              errCode: null,
              moreErr: null
            }
          }))
        },
        (e) => {
          if (gen !== generation.current) return
          patchDir(path, { loading: false, err: msg(e), errStatus: statusOf(e), errCode: codeOf(e) })
        }
      )
    },
    [agentId, patchDir, repo, sessionId]
  )

  const loadMoreDir = useCallback(
    (path: string) => {
      const d = dirs[path]
      if (!d?.nextCursor || d.loadingMore) return
      const gen = generation.current
      patchDir(path, { loadingMore: true, moreErr: null })
      fetchWorkspaceFiles(agentId, {
        path,
        cursor: d.nextCursor,
        ...(sessionId ? { sessionId } : {}),
        ...(repo ? { repo } : {})
      }).then(
        (page) => {
          if (gen !== generation.current) return
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
          })
        },
        (e) => {
          if (gen !== generation.current) return
          patchDir(path, { loadingMore: false, moreErr: msg(e) })
        }
      )
    },
    [agentId, dirs, patchDir, repo, sessionId]
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

  // Load the root whenever the scope changes or a refresh lands. A SCOPE change resets the tree: the
  // previous expand set names paths in another checkout, which may not exist in this one. A REFRESH
  // does NOT — collapsing every open folder back to root is not what "re-read this" means, and on the
  // dock's timer it would also shrink the path filter's corpus (which is derived from `dirs`) to
  // root-level hits every few seconds. It re-reads the root and each OPEN folder instead.
  useEffect(() => {
    // Bumped FIRST, so any directory read still in flight for the previous checkout is already fenced by the time this one's root lands.
    generation.current += 1
    const gen = generation.current
    const active = () => gen === generation.current
    const scopeChanged = lastScope.current !== scope
    lastScope.current = scope
    const reopen = scopeChanged ? [] : [...expandedRef.current]
    if (scopeChanged) {
      setDirs({ '': { ...LOADING_DIR } })
      setExpanded(new Set())
    } else {
      // Marked loading in place: the rows stay on screen behind their spinners rather than vanishing.
      patchDir('', { loading: true, err: null, errStatus: null, errCode: null })
    }
    fetchWorkspaceFiles(agentId, { path: '', ...(sessionId ? { sessionId } : {}), ...(repo ? { repo } : {}) }).then(
      (page) => {
        if (!active()) return
        const root = {
          entries: page.entries,
          exists: page.exists,
          nextCursor: page.nextCursor,
          loading: false,
          loadingMore: false,
          err: null,
          errStatus: null,
          errCode: null,
          moreErr: null
        }
        // Merged on a refresh, replaced on a scope change — the open folders being re-read below are in
        // this map, and dropping them here would collapse the tree by another route.
        setDirs((prev) => (scopeChanged ? { '': root } : { ...prev, '': root }))
      },
      (e) => {
        if (!active()) return
        const failed = { ...LOADING_DIR, loading: false, err: msg(e), errStatus: statusOf(e), errCode: codeOf(e) }
        setDirs((prev) => (scopeChanged ? { '': failed } : { ...prev, '': failed }))
      }
    )
    // Every folder that was open, re-read on its own. Each one fences on the generation bumped above,
    // so a scope change landing mid-refresh discards all of them.
    for (const path of reopen) loadDir(path)
    return () => {
      // A teardown is its own generation change: the next mount's reads must not be answered by this one's.
      generation.current += 1
    }
  }, [agentId, loadDir, patchDir, refreshTick, repo, scope, sessionId])

  return { dirs, root: dirs[''], expanded, toggleDir, loadMoreDir, openPath }
}

/** What the scoped git status resolved to. `none` is a from-scratch workspace, `asleep` a cluster agent whose sandbox is not running, and `unavailable` an offline daemon or unplaced agent — a null status alone cannot tell the three apart. `asleep` is its own outcome because it is the only one that resolves itself: the workspace is there and reachable again on the agent's next turn, so the copy must not read as an outage or as an empty checkout. */
export type WorkspaceGitOutcome = 'pending' | 'repo' | 'none' | 'asleep' | 'unavailable'

/** The CP's code for "this agent's sandbox is not running". A 503 like an offline daemon — the code is the only thing that separates the two, and a plain 503 keeps the offline story. */
export const SANDBOX_ASLEEP_CODE = 'WORKSPACE_SANDBOX_UNAVAILABLE'

/** What both file surfaces say when a read SUCCEEDS and reports a session-scoped root that is not there. Named no cause on purpose: a checkout the daemon reclaimed and one this session was never given are the same answer from here, and the sentence this replaced asserted the first and promised a recreation the second never gets. */
// It names no MECHANISM either: whether a session's directory is a worktree or its own clone follows the effective boundary (git-workspace-model.md §11), which this read cannot see.
// `repo` names the SELECTED root, because with one chosen the missing checkout is that root's and a bare "it" reads as the session's primary one.
export function sessionWorktreeAbsentNotice(repo?: string): string {
  const of = repo ? ` of ${repo}` : ''
  return `No checkout${of} for this session — it may have been cleaned up, or this session may not have one${repo ? ' for this repository' : ' of its own'}.`
}

/** Whether a failed workspace read was the sandbox being asleep rather than anything being wrong. */
export function isSandboxAsleep(err: unknown): boolean {
  return err instanceof ApiError && err.code === SANDBOX_ASLEEP_CODE
}

/** The root listing as the sandbox wake reads it: `pending` until the first answer, `ready` on any answer that is data (an empty or absent workspace included), `asleep` on the sleeping-sandbox refusal, `failed` on any other. */
export function workspaceRootReadState(root: WorkspaceDirState | undefined): SandboxReadState {
  if (!root || (root.loading && !root.entries && !root.err)) return 'pending'
  if (!root.err) return 'ready'
  return root.errCode === SANDBOX_ASLEEP_CODE ? 'asleep' : 'failed'
}

export interface WorkspaceGitRead {
  /** The live status, or null for a non-repo workspace, an offline daemon, and the window before the first answer. */
  git: WorkspaceGitStatusDto | null
  outcome: WorkspaceGitOutcome
  /** The branch of the SELECTED root's base checkout — the label the checkout picker's non-worktree entry carries. Fetched separately in session scope, where the worktree sits on its own branch and its status names that one instead. */
  primaryBranch: string | null
}

/** The git half of the read model: status for the badges and the footer, plus the branch label a session worktree cannot supply itself. */
// `repo` scopes BOTH reads to one authorized additional repository: the checkout picker beside the browser chooses a worktree of the selected root, so the branch it labels its non-worktree entry with is that root's, not the workspace's.
export function useWorkspaceGitStatus(
  agentId: string,
  sessionId?: string,
  refreshTick = 0,
  repo?: string
): WorkspaceGitRead {
  const [git, setGit] = useState<WorkspaceGitStatusDto | null>(null)
  const [outcome, setOutcome] = useState<WorkspaceGitOutcome>('pending')
  const [primaryBranch, setPrimaryBranch] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    setOutcome('pending')
    fetchWorkspaceGitStatus(agentId, sessionId, repo).then(
      (s) => {
        if (!active) return
        setGit(s.isRepo ? s : null)
        setOutcome(s.isRepo ? 'repo' : 'none')
        if (!sessionId) setPrimaryBranch(s.isRepo ? s.branch : null)
      },
      (e: unknown) => {
        if (!active) return
        setGit(null)
        setOutcome(isSandboxAsleep(e) ? 'asleep' : 'unavailable')
        if (!sessionId) setPrimaryBranch(null)
      }
    )
    if (sessionId) {
      fetchWorkspaceGitStatus(agentId, undefined, repo).then(
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
  }, [agentId, refreshTick, repo, sessionId])

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
