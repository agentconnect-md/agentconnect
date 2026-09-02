'use client'

// The dock's Files tab: the open session's worktree as ONE narrow column at 380–760px — lazily expanded rows with git status tags, a path filter over the tree already loaded, and the checkout's last fetch time.
// The file itself opens in the left-pane viewer (§4), which this panel does not own: a file row reports the path and nothing more.

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Spinner } from '@/components/marks'
import { Icon } from '@/components/ui'
import { FileBrowserRow, formatFileMtime, formatFileSize } from '@/components/console/FileBrowser'
import {
  SANDBOX_ASLEEP_CODE,
  sessionWorktreeAbsentNotice,
  StatusBadge,
  useWorkspaceGitStatus,
  useWorkspaceTree,
  workspaceDirtyMap,
  workspaceEntryIcon,
  workspaceRootReadState
} from '@/components/console/workspace-tree'
import { useSandboxWake } from '@/components/console/sandbox-wake'
import {
  SANDBOX_ASLEEP_NOTICE,
  SandboxAsleepNotice,
  SandboxStartingNotice
} from '@/components/console/SandboxWakeNotice'
import { DOCK_POLL_MS, useDockRefresh } from '@/components/console/dock/auto-refresh'
import type { DockTabStatus } from './SessionDock'

/** The Files tab's status: `loading` covers the first root listing only, and everything after it is `ready` — an offline daemon, a non-repo workspace and an empty directory are each something this panel has copy for, and copy is content. */
// Never `empty`: a workspace with no files still draws its branch line, its filter and the notice saying WHY it is empty, so `empty` would trade that explanation for the dock's centred "Nothing to show" — and it would put `vacant` (every tab non-ready) back in reach beside a settled-empty Sessions tab, where the dock withholds all its chrome and the tab a reader asked for cannot be opened at all.
export function filesTabStatus(rootSettled: boolean): DockTabStatus {
  return rootSettled ? 'ready' : 'loading'
}

// The root listing failed. 409, 404 and a sandbox that is asleep are distinguishable answers; everything else (503 for both an offline daemon and an unplaced agent, plus network failures) is the offline story.
function rootNoticeText(status: number | null, scoped: boolean, code?: string | null): string {
  // Ahead of the status checks: this one arrives as a 503 and would otherwise read as an outage, when
  // in fact the files are fine and reachable again on the agent's next turn.
  if (code === SANDBOX_ASLEEP_CODE) return SANDBOX_ASLEEP_NOTICE
  if (status === 409) {
    return 'This agent runs a daemon version that cannot browse a session checkout. Update the agent, or read the files from its workspace page.'
  }
  if (status === 404) {
    return scoped
      ? "This session's checkout is not available to browse — it may have been cleaned up, or this session may not have one of its own."
      : 'This workspace is not available to browse.'
  }
  return "Couldn't browse the workspace — the owning daemon may be offline. Files live only on that machine and are read live from it, so they are unavailable while it is disconnected."
}

export function FilesPanel({
  agentId,
  sessionId,
  workdir,
  refreshTick = 0,
  active = true,
  turnActive = false,
  openFilePath,
  onOpenFile,
  onRootSettledChange
}: {
  agentId: string
  /** Whether the Files tab is the one selected. The dock keeps every panel mounted, and a hidden panel must not start a pod: the sandbox wake and its polling run only while this is true. */
  active?: boolean
  /** Whether a turn is streaming in this session. Its falling edge re-reads the tree — that is when the agent's file writes have landed — but only for a tab the reader is looking at: this panel carries no badge, so a hidden one owes itself the read and spends it on the reveal edge instead. */
  turnActive?: boolean
  /** ACP session id selecting that session's isolated worktree; omit for the agent's primary checkout. Pass it only when the session's `workspaceIsolation` is `'session'` — the daemon answers a shared-workspace sessionId with BAD_PAYLOAD, which the CP maps to a 503 that reads as "the daemon may be offline". */
  sessionId?: string
  /** The agent's working directory, shown beside the branch. */
  workdir?: string
  /** Bumped by the tab's `refresh-cw` action: re-reads the tree and the git status. */
  refreshTick?: number
  /** The path the viewer currently holds, so the tree marks its row. */
  openFilePath?: string | null
  /** A file row was pressed. The viewer is the caller's (§4). */
  onOpenFile: (path: string) => void
  /** Whether the first root listing has answered — the input to {@link filesTabStatus}. The caller owns the tab descriptor, so the verdict is reported rather than applied. */
  onRootSettledChange?: (settled: boolean) => void
}) {
  // The wake's own refresh rides beside the tab's: a poll re-reads the tree the same way the refresh action does.
  const [wakeTick, setWakeTick] = useState(0)
  // The automatic re-read (turn edge, poll, reveal) is the same counter shape, so an auto refresh takes
  // the identical read path a pressed one does — expanded folders and the filter text survive both.
  const [autoTick, setAutoTick] = useState(0)
  const tick = refreshTick + wakeTick + autoTick
  const { dirs, root, expanded, toggleDir, loadMoreDir } = useWorkspaceTree(agentId, sessionId, tick)
  const { git, outcome, primaryBranch } = useWorkspaceGitStatus(agentId, sessionId, tick)
  const retryRoot = useCallback(() => setWakeTick((current) => current + 1), [])
  // `pollWhileHidden`: the page keeps its workspace fresh whatever tab is selected — the whole open
  // page is what the operator left watching, and the same visibility fence gates the sandbox hold.
  useDockRefresh({
    active,
    turnActive,
    pollWhileHidden: true,
    intervalMs: DOCK_POLL_MS,
    onRefresh: () => setAutoTick((n) => n + 1)
  })
  const wake = useSandboxWake(agentId, workspaceRootReadState(root), retryRoot, { active })
  const [query, setQuery] = useState('')
  const scope = `${agentId}:${sessionId ?? 'primary'}`
  // Latched per scope, so the tab reports `ready` once and a refresh keeps the panel — and the reader's filter text — on screen behind an in-tree spinner.
  const [settledScope, setSettledScope] = useState<string | null>(null)
  useEffect(() => {
    if (root && !root.loading && settledScope !== scope) setSettledScope(scope)
  }, [root, scope, settledScope])
  const settled = settledScope === scope
  // Reported on the EDGE: the callback the caller passes is usually a fresh closure per render, and a re-report of the value the tab already has is a state write for nothing.
  const reported = useRef<boolean | null>(null)
  useEffect(() => {
    if (reported.current === settled) return
    reported.current = settled
    onRootSettledChange?.(settled)
  }, [onRootSettledChange, settled])
  // A filter is over one tree; another session's is a different set of paths.
  useEffect(() => setQuery(''), [scope])

  const dirtyMap = useMemo(() => workspaceDirtyMap(git), [git])
  // Every FILE the tree has actually loaded — the only corpus a client-side filter can honestly search, since `workspace/list` is per-directory and no path-search frame exists.
  const loadedFiles = useMemo(() => {
    const out: Array<{ path: string; name: string; icon: string; clickable: boolean; meta: string }> = []
    for (const [dirPath, dir] of Object.entries(dirs)) {
      for (const entry of dir.entries ?? []) {
        if (entry.type === 'dir') continue
        out.push({
          path: dirPath ? `${dirPath}/${entry.name}` : entry.name,
          name: entry.name,
          icon: workspaceEntryIcon(entry),
          clickable: entry.type === 'file',
          meta: [formatFileSize(entry.size), formatFileMtime(entry.mtime)].filter(Boolean).join(' · ')
        })
      }
    }
    return out.sort((a, b) => a.path.localeCompare(b.path))
  }, [dirs])
  const q = query.trim().toLowerCase()
  const matches = useMemo(
    () => (q ? loadedFiles.filter((file) => file.path.toLowerCase().includes(q)) : []),
    [loadedFiles, q]
  )

  if (!settled) return null

  // One directory level, rendered inline into the flat DOM its indent describes.
  const renderLevel = (dirPath: string, depth: number): ReactNode => {
    const dir = dirs[dirPath]
    if (!dir) return null
    if (dir.loading && !dir.entries) {
      return (
        <div key={`${dirPath}::spin`} className="py-2 pr-3" style={{ paddingLeft: 12 + depth * 14 }}>
          <Spinner size={15} />
        </div>
      )
    }
    if (dir.err && !dir.entries) {
      return (
        <div
          key={`${dirPath}::err`}
          className="py-[7px] pr-3 font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)"
          style={{ paddingLeft: 12 + depth * 14 }}
        >
          Couldn&apos;t load — the daemon may be offline.
        </div>
      )
    }
    return (
      <>
        {dir.entries?.map((entry) => {
          const full = dirPath ? `${dirPath}/${entry.name}` : entry.name
          if (entry.type === 'dir') {
            const open = expanded.has(full)
            return (
              <Fragment key={full}>
                <FileBrowserRow
                  depth={depth}
                  chevron={open ? 'chevron-down' : 'chevron-right'}
                  icon={open ? 'folder-open' : 'folder'}
                  name={entry.name}
                  onClick={() => toggleDir(full)}
                />
                {open && renderLevel(full, depth + 1)}
              </Fragment>
            )
          }
          const status = dirtyMap.get(full)
          return (
            <FileBrowserRow
              key={full}
              depth={depth}
              icon={workspaceEntryIcon(entry)}
              name={entry.name}
              title={[formatFileSize(entry.size), formatFileMtime(entry.mtime)].filter(Boolean).join(' · ')}
              trailing={status ? <StatusBadge ch={status} /> : undefined}
              selected={openFilePath === full}
              onClick={entry.type === 'file' ? () => onOpenFile(full) : undefined}
            />
          )
        })}
        {dir.nextCursor && (
          <div className="flex flex-col gap-1 py-[6px] pr-3" style={{ paddingLeft: 12 + depth * 14 }}>
            <button className="lnk text-[12px]" onClick={() => loadMoreDir(dirPath)}>
              {dir.loadingMore ? 'Loading…' : dir.moreErr ? 'Retry' : 'Load more'}
            </button>
          </div>
        )}
      </>
    )
  }

  // Which of the tree's states the body draws. Every branch here is data — none of them may take the panel, the dock or the transcript down (§2).
  const body = (): ReactNode => {
    if (root?.err && !root.entries) {
      if (wake.phase === 'starting') return <SandboxStartingNotice compact />
      return (
        <SandboxAsleepNotice
          wake={wake}
          startable={root.errCode === SANDBOX_ASLEEP_CODE}
          compact
          notice={<PanelNotice warn text={rootNoticeText(root.errStatus, Boolean(sessionId), root.errCode)} />}
        />
      )
    }
    if (root && !root.loading && !root.err && !root.exists) {
      return (
        <PanelNotice
          text={
            sessionId
              ? sessionWorktreeAbsentNotice()
              : 'The workspace has no files yet — the agent creates them as it works.'
          }
        />
      )
    }
    if (root?.entries && root.exists && root.entries.length === 0)
      return <PanelNotice text="This workspace is empty." />
    if (q) {
      return (
        <>
          <div className="px-3 pb-[7px] font-sans text-[11.5px] font-normal leading-[1.5] text-(--text-tertiary)">
            {matches.length > 0
              ? `Matched ${matches.length} of ${loadedFiles.length} loaded files. This filters the folders you have opened, not the whole repository.`
              : `No loaded file path contains “${query.trim()}”. Open more folders to load more of the tree — this filter never searches the whole repository.`}
          </div>
          {matches.map((file) => {
            const status = dirtyMap.get(file.path)
            return (
              <FileBrowserRow
                key={file.path}
                icon={file.icon}
                name={file.path}
                title={[file.path, file.meta].filter(Boolean).join('\n')}
                trailing={status ? <StatusBadge ch={status} /> : undefined}
                selected={openFilePath === file.path}
                onClick={file.clickable ? () => onOpenFile(file.path) : undefined}
              />
            )
          })}
        </>
      )
    }
    return renderLevel('', 0)
  }

  const branch = sessionId ? primaryBranch : (git?.branch ?? null)
  // A session worktree is detached, so the branch on screen is the primary checkout's — say so rather than implying the worktree is on it.
  const branchTitle = sessionId
    ? "Branch of the agent's primary checkout; this session's worktree is detached from it"
    : 'Current branch of the workspace checkout'
  const gitNote =
    outcome === 'none'
      ? 'Not a git checkout — no branch or file status'
      : outcome === 'asleep'
        ? 'Git status not available — this agent’s sandbox is not running'
        : outcome === 'unavailable'
          ? 'Git status unavailable — the daemon may be offline'
          : null

  return (
    <div data-files-panel="" className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-none flex-col gap-[7px] border-b border-(--border-subtle) px-3 py-[10px]">
        <div className="relative flex items-center">
          <Icon
            name="search"
            size={13}
            color="var(--text-tertiary)"
            className="pointer-events-none absolute left-[9px]"
          />
          <input
            className="inp mn h-8 min-h-8 w-full py-1 pr-2 pl-[27px] text-[12px]"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find file by path…"
            aria-label="Find file by path"
            spellCheck={false}
          />
        </div>
        <div className="flex min-w-0 items-center gap-2">
          {/* The note outranks the branch: the SCOPED status is where the row tags come from, so a reader looking at an untagged tree is owed the reason, not a branch label borrowed from the primary checkout. */}
          {outcome === 'repo' && branch ? (
            <span
              className="mono flex min-w-0 max-w-[55%] flex-none items-center gap-[4px] text-[11px] font-medium text-(--text-secondary)"
              title={branchTitle}
            >
              <Icon name="git-branch" size={11} color="var(--text-tertiary)" className="flex-none" />
              <span className="truncate">{branch}</span>
            </span>
          ) : gitNote ? (
            <span className="flex-none font-sans text-[11px] font-normal leading-normal text-(--text-tertiary)">
              {gitNote}
            </span>
          ) : null}
          {workdir ? (
            // The agent's configured directory either way, so in session scope it names the primary checkout rather than the worktree listed below — same disclaimer the branch beside it carries.
            <span
              className="mono min-w-0 flex-1 truncate text-right text-[11px] font-normal text-(--text-tertiary)"
              title={sessionId ? `${workdir} — the agent's workspace; this session runs in its own worktree` : workdir}
            >
              {workdir}
            </span>
          ) : null}
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-auto py-[6px]">{body()}</div>
      {/* `lastFetchAt` is `.git/FETCH_HEAD`'s mtime, which a linked worktree has no directory for — so session scope has no footer at all, by construction rather than by omission. The design's file count and total size are dropped: neither exists without a daemon-side walk. */}
      {git?.lastFetchAt || git?.truncated ? (
        <div
          data-files-footer=""
          className="flex flex-none items-center gap-2 border-t border-(--border-subtle) px-3 py-[7px]"
        >
          {git.lastFetchAt ? (
            <span
              className="mono flex-none text-[11px] font-normal text-(--text-tertiary)"
              title="When this checkout last fetched from its remote"
            >
              {`synced ${formatFileMtime(git.lastFetchAt)}`}
            </span>
          ) : null}
          {git.truncated ? (
            <span className="min-w-0 flex-1 truncate font-sans text-[11px] font-normal leading-normal text-(--text-tertiary)">
              {`status tags cover the first ${git.files.length} changed files`}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

// A degraded state, drawn calmly: a workspace nobody can read still has something to say about why.
function PanelNotice({ text, warn = false }: { text: string; warn?: boolean }) {
  return (
    <div className="flex items-start gap-2 px-3 py-[10px] font-sans text-[12px] font-normal leading-[1.55] text-(--text-secondary)">
      <Icon
        name={warn ? 'triangle-alert' : 'folder'}
        size={14}
        color={warn ? 'var(--amber-500)' : 'var(--text-tertiary)'}
        className="mt-[2px] flex-none"
      />
      <span>{text}</span>
    </div>
  )
}
