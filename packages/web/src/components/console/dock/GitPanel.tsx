'use client'

// The dock's Git tab (§3.3): the open session's worktree as a REVIEW surface — branch and ahead/behind, the staged and unstaged file lists with their `+`/`−` counts, and the newest commits with unpushed markers. A row opens that file's diff in the left-pane viewer, which this panel does not own.
// M2 ships the read half only. Stage toggles, Stage all / Unstage all and the commit box are ABSENT rather than disabled: a control that cannot work is worse than a surface that does not claim to have one, and §9's M3 is where the write frames arrive.
// Status, diff and log all come live from the owning daemon through the CP (body-locality), so an offline daemon, a from-scratch workspace, a clean tree, a capped status list and a daemon too old for the log are all expected answers, each drawn as data.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Spinner } from '@/components/marks'
import { Icon } from '@/components/ui'
import { formatFileMtime } from '@/components/console/FileBrowser'
import { StatusBadge, useWorkspaceGitStatus } from '@/components/console/workspace-tree'
import { ApiError, fetchWorkspaceGitLog, type WorkspaceGitFileDto, type WorkspaceGitLogDto } from '@/lib/api'
import type { DockTabStatus } from './SessionDock'

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))
const statusOf = (e: unknown) => (e instanceof ApiError ? e.status : null)
const codeOf = (e: unknown) => (e instanceof ApiError && e.code ? e.code : null)

/** How many commits the panel asks for. The wire caps a page at 50; a review surface beside a conversation wants the recent history, not the branch. */
const LOG_LIMIT = 20

/** What the Git tab reports upward. The caller owns the tab descriptor, so the panel reports its verdict rather than applying it — the same shape the Files tab uses. */
export interface GitPanelVerdict {
  /** The scoped git status has answered, one way or another. */
  settled: boolean
  /** Changed paths for the tab's badge; null while unknown, and for a workspace that is not a checkout. */
  changed: number | null
}

/** The Git tab's status: `loading` covers the first status read only. */
// Never `empty`: a clean tree, a from-scratch workspace and an offline daemon each have a branch line and copy explaining themselves, and copy is content — `empty` would trade that for the dock's centred "Nothing to show" and put `vacant` (every tab non-ready) back in reach, where the dock withholds its whole tab strip.
export function gitTabStatus(settled: boolean): DockTabStatus {
  return settled ? 'ready' : 'loading'
}

/** One log read. Its failures are distinguishable from the status read's: a daemon can be new enough to report status and too old to answer a git-review frame at all. */
interface LogRead {
  loading: boolean
  err: string | null
  errStatus: number | null
  errCode: string | null
  log: WorkspaceGitLogDto | null
}

const LOG_PENDING: LogRead = { loading: true, err: null, errStatus: null, errCode: null, log: null }

// Why the log is missing. 409 `DAEMON_FEATURE_MISSING` is the version answer the CP added for the git-review frames; everything else folds into the offline story the rest of the workspace surfaces tell.
function logNoticeText(status: number | null, code: string | null): string {
  if (status === 409 && code === 'DAEMON_FEATURE_MISSING') {
    return 'This agent runs a daemon version that cannot list commits. Update the agent to review its history here.'
  }
  if (status === 409) return 'This agent runs a daemon version that cannot read a session worktree.'
  if (status === 404) return 'This worktree is not available to read.'
  return 'Commits are unavailable — the owning daemon may be offline.'
}

function useWorkspaceGitLog(agentId: string, sessionId: string | undefined, refreshTick: number): LogRead {
  const [read, setRead] = useState<LogRead>(LOG_PENDING)
  useEffect(() => {
    let active = true
    setRead(LOG_PENDING)
    fetchWorkspaceGitLog(agentId, { limit: LOG_LIMIT, ...(sessionId ? { sessionId } : {}) }).then(
      (log) => {
        if (active) setRead({ ...LOG_PENDING, loading: false, log })
      },
      (e) => {
        if (active) {
          setRead({ ...LOG_PENDING, loading: false, err: msg(e), errStatus: statusOf(e), errCode: codeOf(e) })
        }
      }
    )
    return () => {
      active = false
    }
  }, [agentId, refreshTick, sessionId])
  return read
}

// One git status char, as a section decides whether the file belongs to it. ' ' and '' both mean "nothing on this side"; '?' is untracked, which git reports on the WORKING side only.
const marked = (ch: string | undefined): boolean => {
  const c = (ch ?? '').trim()
  return c !== '' && c !== '?'
}

/** Split the status file list into the two sections the design draws. A file edited after being staged appears in BOTH — that is what git reports, and hiding either half would misdescribe the tree. */
export function splitGitSections(files: WorkspaceGitFileDto[]): {
  staged: WorkspaceGitFileDto[]
  changes: WorkspaceGitFileDto[]
} {
  const staged: WorkspaceGitFileDto[] = []
  const changes: WorkspaceGitFileDto[] = []
  for (const file of files) {
    if (marked(file.index)) staged.push(file)
    // Untracked files have no staged half at all, so they belong to Changes whichever column carries the '?'.
    if (marked(file.workingDir) || (file.index ?? '').trim() === '?' || (file.workingDir ?? '').trim() === '?') {
      changes.push(file)
    }
  }
  return { staged, changes }
}

export function GitPanel({
  agentId,
  sessionId,
  refreshTick = 0,
  openPath,
  openStaged = false,
  onOpenDiff,
  onVerdictChange
}: {
  agentId: string
  /** ACP session id selecting that session's isolated worktree; omit for the agent's primary checkout. Pass it only when the session's `workspaceIsolation` is `'session'` — the daemon answers a shared-workspace sessionId with BAD_PAYLOAD, which the CP maps to a 503 that reads as "the daemon may be offline". */
  sessionId?: string
  /** Bumped by the tab's `refresh-cw` action: re-reads status and log without remounting. */
  refreshTick?: number
  /** The path the viewer currently holds, so the matching row is marked. */
  openPath?: string | null
  /** Whether that open path is the STAGED diff, so the mark lands in the right section. */
  openStaged?: boolean
  /** A file row was pressed: open this path's diff, on this side of the index. The viewer is the caller's (§4). */
  /** A row was pressed. `untracked` rows have no diff to show — git prints nothing for a path it has never seen — so the caller opens the FILE instead. */
  onOpenDiff: (path: string, staged: boolean, untracked: boolean) => void
  /** The inputs to {@link gitTabStatus} and the tab's badge. */
  onVerdictChange?: (verdict: GitPanelVerdict) => void
}) {
  const { git, outcome, primaryBranch } = useWorkspaceGitStatus(agentId, sessionId, refreshTick)
  const log = useWorkspaceGitLog(agentId, sessionId, refreshTick)
  const scope = `${agentId}:${sessionId ?? 'primary'}`
  // The last answer, latched per scope like the Files panel's settle flag — and carrying the badge's count with it, so the tab reports `ready` once and a refresh keeps both the panel and its count on screen instead of blinking them off and back on behind an in-tree read.
  const [answer, setAnswer] = useState<{ scope: string; changed: number | null } | null>(null)
  useEffect(() => {
    if (outcome === 'pending') return
    // Distinct PATHS: a file staged and then edited again is one changed file, in two sections.
    const next = outcome === 'repo' && git ? new Set(git.files.map((file) => file.path)).size : null
    setAnswer((current) => (current?.scope === scope && current.changed === next ? current : { scope, changed: next }))
  }, [git, outcome, scope])
  const settled = answer?.scope === scope
  const changed = settled ? answer.changed : null

  const sections = useMemo(() => splitGitSections(git?.files ?? []), [git])
  // Reported on the EDGE: the caller's callback is a fresh closure per render, and re-reporting a verdict the tab already has is a state write for nothing.
  const reported = useRef<string | null>(null)
  useEffect(() => {
    const key = `${settled}:${changed ?? ''}`
    if (reported.current === key) return
    reported.current = key
    onVerdictChange?.({ settled, changed })
  }, [changed, onVerdictChange, settled])

  if (!settled) return null

  const branch = sessionId ? primaryBranch : (git?.branch ?? null)
  // A session worktree is detached, so the branch on screen is the primary checkout's — say so rather than implying the worktree sits on it.
  const branchTitle = sessionId
    ? "Branch of the agent's primary checkout; this session's worktree is detached from it"
    : 'Current branch of the workspace checkout'

  const fileRow = (file: WorkspaceGitFileDto, staged: boolean) => {
    const name = file.path.split('/').at(-1) ?? file.path
    const dir = file.path.slice(0, Math.max(0, file.path.length - name.length - 1))
    const selected = openPath === file.path && openStaged === staged
    // `??` on either half: git has never seen this path, so `git diff` prints nothing for it and a Diff view would say "no unstaged changes" about a file whose whole content is the change. Its content IS the diff, so the row opens the file.
    const untracked = file.index === '?' || file.workingDir === '?'
    return (
      <button
        key={`${staged ? 'staged' : 'changes'}:${file.path}`}
        type="button"
        data-git-row={file.path}
        // The Files tree's own row affordance, so a path hovers and marks itself the same way in both tabs.
        className={`file-browser-item flex w-full cursor-pointer items-center gap-2 border-0 border-r-2 py-[5px] pr-[10px] pl-3 text-left [font:inherit] ${selected ? 'border-r-(--brand) bg-(--brand-soft)' : 'border-r-transparent bg-transparent'}`}
        title={`${file.path}\n${untracked ? 'Untracked — open the file' : staged ? 'Staged — open its diff' : 'Not staged — open its diff'}`}
        onClick={() => onOpenDiff(file.path, staged, untracked)}
      >
        <StatusBadge ch={staged ? (file.index ?? 'M') : (file.workingDir ?? 'M')} />
        <span className="mono flex min-w-0 flex-1 items-baseline text-[12px] leading-normal">
          {dir ? <span className="min-w-0 truncate font-normal text-(--text-tertiary)">{`${dir}/`}</span> : null}
          <span className="flex-none truncate font-normal text-(--text-primary)">{name}</span>
        </span>
        {/* Counted by `git diff HEAD --numstat`, so they describe the file's WHOLE change against HEAD rather than this section's half — absent for an untracked file, a binary change, and a daemon too old to count. */}
        {file.additions != null || file.deletions != null ? (
          <span
            className="mono flex-none text-[11px] font-medium leading-normal"
            title="Lines added and removed against the last commit (staged and unstaged together)"
          >
            {file.additions != null ? <span className="text-(--status-online)">{`+${file.additions}`}</span> : null}
            {file.additions != null && file.deletions != null ? ' ' : null}
            {file.deletions != null ? <span className="text-(--status-error)">{`−${file.deletions}`}</span> : null}
          </span>
        ) : null}
      </button>
    )
  }

  const section = (title: string, files: WorkspaceGitFileDto[], staged: boolean) =>
    files.length > 0 ? (
      <div data-git-section={staged ? 'staged' : 'changes'} className="flex flex-none flex-col">
        <div className="flex items-center gap-2 px-3 pt-[10px] pb-[5px] font-sans text-[10.5px] font-semibold tracking-[0.04em] uppercase leading-normal text-(--text-disabled)">
          <span>{title}</span>
          <span className="mono font-medium normal-case tracking-normal">{files.length}</span>
        </div>
        {files.map((file) => fileRow(file, staged))}
      </div>
    ) : null

  // Which of the status reads' answers the file half draws. Every branch is data — none may take the panel, the dock or the transcript down (§2).
  const files = (): ReactNode => {
    if (outcome === 'unavailable') {
      return (
        <PanelNotice
          warn
          text="Couldn't read this worktree's git status — the owning daemon may be offline. Status is read live from that machine, so it is unavailable while it is disconnected."
        />
      )
    }
    if (outcome === 'none') {
      return (
        <PanelNotice text="This workspace is not a git checkout, so it has no branch, no changes and no commits. The agent's files are still in the Files tab." />
      )
    }
    if (sections.staged.length === 0 && sections.changes.length === 0) {
      return <PanelNotice text="Nothing has changed in this worktree — every tracked file matches the last commit." />
    }
    return (
      <>
        {section('Staged', sections.staged, true)}
        {section('Changes', sections.changes, false)}
        {git?.truncated ? (
          <div className="px-3 py-[7px] font-sans text-[11.5px] font-normal leading-[1.5] text-(--text-tertiary)">
            {`This tree has more changed files than one status read carries — the first ${git.files.length} are listed.`}
          </div>
        ) : null}
      </>
    )
  }

  const commits = (): ReactNode => {
    if (log.loading) {
      return (
        <div className="px-3 py-2">
          <Spinner size={15} />
        </div>
      )
    }
    if (log.err) return <PanelNotice text={logNoticeText(log.errStatus, log.errCode)} />
    if (!log.log?.isRepo) return null
    if (log.log.commits.length === 0) {
      return <PanelNotice text="No commits yet — this checkout has no history of its own." />
    }
    const tracked = log.log.tracking !== null
    return (
      <>
        {log.log.commits.map((commit) => (
          <div
            key={commit.sha}
            data-git-commit={commit.sha}
            className="flex items-start gap-2 px-3 py-[5px]"
            title={`${commit.sha}\n${commit.author}\n${commit.committedAt}`}
          >
            {/* An unpushed marker is only honest against a known upstream: a branch that tracks nothing reports `pushed:false` for everything, which is "not known to be on a remote", not "ahead". */}
            <span className="mt-[3px] flex h-[13px] w-[13px] flex-none items-center justify-center">
              <Icon
                name={tracked && !commit.pushed ? 'circle-dot' : 'git-commit-horizontal'}
                size={13}
                color={tracked && !commit.pushed ? 'var(--status-info)' : 'var(--text-disabled)'}
              />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate font-sans text-[12px] font-normal leading-[1.45] text-(--text-primary)">
                {commit.subject || '(no message)'}
              </span>
              <span className="mono truncate text-[10.5px] font-normal leading-normal text-(--text-tertiary)">
                {[commit.shortSha, commit.author, formatFileMtime(commit.committedAt)].filter(Boolean).join(' · ')}
              </span>
            </span>
            {tracked && !commit.pushed ? (
              <span
                className="mono flex-none text-[10.5px] font-medium leading-normal text-(--status-info)"
                title={`Not yet on ${log.log?.tracking}`}
              >
                unpushed
              </span>
            ) : null}
          </div>
        ))}
        {!tracked ? (
          <div className="px-3 py-[7px] font-sans text-[11.5px] font-normal leading-[1.5] text-(--text-tertiary)">
            This branch tracks no remote branch, so the console cannot tell which of these commits are pushed.
          </div>
        ) : null}
        {log.log.truncated ? (
          <div className="px-3 py-[7px] font-sans text-[11.5px] font-normal leading-[1.5] text-(--text-tertiary)">
            {`Newest ${log.log.commits.length} commits.`}
          </div>
        ) : null}
      </>
    )
  }

  return (
    <div data-git-panel="" className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-none items-center gap-2 border-b border-(--border-subtle) px-3 py-[10px]">
        {outcome === 'repo' && branch ? (
          <span
            className="mono flex min-w-0 flex-1 items-center gap-[4px] text-[11px] font-medium text-(--text-secondary)"
            title={branchTitle}
          >
            <Icon name="git-branch" size={11} color="var(--text-tertiary)" className="flex-none" />
            <span className="truncate">{branch}</span>
          </span>
        ) : (
          <span className="min-w-0 flex-1 font-sans text-[11px] font-normal leading-normal text-(--text-tertiary)">
            {outcome === 'none' ? 'Not a git checkout' : 'Git status unavailable'}
          </span>
        )}
        {/* Ahead/behind describe the branch against its upstream, so they are withheld when there is none — a `↑0 ↓0` beside an untracked branch reads as "in sync with a remote" and there is no remote. */}
        {git?.tracking && (git.ahead !== null || git.behind !== null) ? (
          <span
            data-git-divergence=""
            className="mono flex flex-none items-center gap-[6px] text-[11px] font-medium leading-normal text-(--text-secondary)"
            title={`Against ${git.tracking}`}
          >
            <span className="flex items-center gap-px" title={`${git.ahead ?? 0} commits to push`}>
              <Icon name="arrow-up" size={10} color="var(--text-tertiary)" />
              {git.ahead ?? 0}
            </span>
            <span className="flex items-center gap-px" title={`${git.behind ?? 0} commits to pull`}>
              <Icon name="arrow-down" size={10} color="var(--text-tertiary)" />
              {git.behind ?? 0}
            </span>
          </span>
        ) : null}
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-auto pb-2">
        {files()}
        {outcome === 'repo' ? (
          <div data-git-section="commits" className="flex flex-none flex-col border-t border-(--border-subtle)">
            <div className="px-3 pt-[10px] pb-[5px] font-sans text-[10.5px] font-semibold tracking-[0.04em] uppercase leading-normal text-(--text-disabled)">
              Commits
            </div>
            {commits()}
          </div>
        ) : null}
      </div>
      {/* Staging, Stage all / Unstage all and the commit box are M3 (§9). The tab says what it is instead of showing controls that cannot work yet. */}
      <div className="flex flex-none items-center gap-2 border-t border-(--border-subtle) px-3 py-[7px] font-sans text-[11px] font-normal leading-normal text-(--text-tertiary)">
        <Icon name="eye" size={12} color="var(--text-tertiary)" className="flex-none" />
        <span>Review only — staging and committing are not available here yet.</span>
      </div>
    </div>
  )
}

// A degraded state, drawn calmly: a worktree nobody can read still has something to say about why.
function PanelNotice({ text, warn = false }: { text: string; warn?: boolean }) {
  return (
    <div className="flex items-start gap-2 px-3 py-[10px] font-sans text-[12px] font-normal leading-[1.55] text-(--text-secondary)">
      <Icon
        name={warn ? 'triangle-alert' : 'git-commit-horizontal'}
        size={14}
        color={warn ? 'var(--amber-500)' : 'var(--text-tertiary)'}
        className="mt-[2px] flex-none"
      />
      <span>{text}</span>
    </div>
  )
}
