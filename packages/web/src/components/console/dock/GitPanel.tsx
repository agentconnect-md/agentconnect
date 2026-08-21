'use client'

// The dock's Git tab (§3.3): the open session's worktree as a WORKING surface — branch and ahead/behind, the staged and unstaged file lists with their `+`/`−` counts and a per-row stage toggle, Stage all / Unstage all, the commit box, and last of all a collapsed history of what this branch adds over its base, with unpushed markers. A row opens that file's diff in the left-pane viewer, which this panel does not own.
// M3 adds the write half. Every write runs on the OWNING DAEMON in the session's own worktree (§2) and answers with the fresh status, so the panel draws the result of its own action without a second read.
// Status, diff, log and every write come live from that daemon through the CP (body-locality), so an offline daemon, a from-scratch workspace, a clean tree, a capped status list, a daemon too old for the log or for git writes, and a busy agent that refuses the write are all expected answers, each drawn as data.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Spinner } from '@/components/marks'
import { Icon } from '@/components/ui'
import { formatFileMtime } from '@/components/console/FileBrowser'
import { CommitBox } from '@/components/console/dock/CommitBox'
import { DOCK_POLL_MS, useDockRefresh } from '@/components/console/dock/auto-refresh'
import { gitWriteRequestFailureText } from '@/components/console/dock/git-write'
import { StatusBadge, useWorkspaceGitStatus, type WorkspaceGitOutcome } from '@/components/console/workspace-tree'
import {
  ApiError,
  fetchWorkspaceGitLog,
  stageWorkspacePaths,
  unstageWorkspacePaths,
  type WorkspaceGitFileDto,
  type WorkspaceGitLogDto,
  type WorkspaceGitStatusDto
} from '@/lib/api'
import type { DockTabStatus } from './SessionDock'

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))
const statusOf = (e: unknown) => (e instanceof ApiError ? e.status : null)
const codeOf = (e: unknown) => (e instanceof ApiError && e.code ? e.code : null)

/** How many commits the panel asks for. The wire caps a page at 50; a session branch's own work is a handful of commits, so 20 is a page nobody reaches. */
const LOG_LIMIT = 20

/** What the Git tab reports upward. The caller owns the tab descriptor, so the panel reports its verdict rather than applying it — the same shape the Files tab uses. */
export interface GitPanelVerdict {
  /** The scoped git status has answered, one way or another. */
  settled: boolean
  /** Changed paths for the tab's badge; null while unknown, and for a workspace that is not a checkout — so a non-null count is also exactly "the last settled read found a checkout". */
  changed: number | null
  /** The branch this scope's checkout is on; null while unknown, for a detached HEAD, and for a non-repo workspace. */
  branch: string | null
  /** The remote branch it tracks, or null when it tracks none — what tells the PR tab whether a pull request is reachable yet or the branch still has to be published. */
  tracking: string | null
  /** The base branch this scope's commits are measured against — the workspace's CONFIGURED branch, which is what a pull request from here targets and is not necessarily the repository default. Null while the log has not answered, and wherever the daemon excluded nothing (§3.3's three cases: no configured branch, HEAD already on it, or a base ref this checkout never fetched). */
  base: string | null
}

/** The log's base REF as the branch a pull request can target. The daemon builds that ref as `origin/<configured branch>` from the one remote it clones, so the prefix is exactly that and stripping it is not a guess. */
export function baseBranchOf(ref: string | null | undefined): string | null {
  if (!ref) return null
  return (ref.startsWith('origin/') ? ref.slice('origin/'.length) : ref) || null
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
  active = true,
  turnActive = false,
  openPath,
  openStaged = false,
  canWrite = false,
  onOpenDiff,
  onVerdictChange,
  onWrote
}: {
  agentId: string
  /** Whether the Git tab is the one selected — the poll's gate. The panel stays MOUNTED either way, because its verdict is what keeps its own tab out of the dock's vacant state. */
  active?: boolean
  /** Whether a turn is streaming in this session. Its falling edge re-reads even while the tab is hidden: the agent's commits and pushes are what this panel counts, and that count is on the tab's badge. */
  turnActive?: boolean
  /** ACP session id selecting that session's isolated worktree; omit for the agent's primary checkout. Pass it only when the session's `workspaceIsolation` is `'session'` — the daemon answers a shared-workspace sessionId with BAD_PAYLOAD, which the CP maps to a 503 that reads as "the daemon may be offline". */
  sessionId?: string
  /** Bumped by the tab's `refresh-cw` action: re-reads status and log without remounting. */
  refreshTick?: number
  /** The path the viewer currently holds, so the matching row is marked. */
  openPath?: string | null
  /** Whether that open path is the STAGED diff, so the mark lands in the right section. */
  openStaged?: boolean
  /** Whether the reader's role may mutate this agent's checkout. The write routes 403 a viewer, so its controls are WITHHELD rather than drawn to fail — the same rule that kept them absent in M2. Defaults closed: a caller that has not resolved a role has not established one. */
  canWrite?: boolean
  /** A file row was pressed: open this path's diff, on this side of the index. The viewer is the caller's (§4). */
  /** A row was pressed. `untracked` rows have no diff to show — git prints nothing for a path it has never seen — so the caller opens the FILE instead. */
  onOpenDiff: (path: string, staged: boolean, untracked: boolean) => void
  /** The inputs to {@link gitTabStatus} and the tab's badge. */
  onVerdictChange?: (verdict: GitPanelVerdict) => void
  /** This panel changed the checkout, so every OTHER reader of it is stale — the Files tree's status badges and any diff the viewer holds open. The panel's own status and log it refreshes itself. */
  onWrote?: () => void
}) {
  // The panel's own re-read, summed with the tab action's: a commit empties the index and adds a commit, so status AND log have to come again — a stage does not, because its reply carries the fresh status. Both counters only ever increase, so their sum names a distinct read.
  const [writeTick, setWriteTick] = useState(0)
  // The automatic re-read (turn edge, poll, reveal), a third counter on the same sum so an auto refresh
  // is byte-identical to a pressed one — there is no second read path to keep in step.
  const [autoTick, setAutoTick] = useState(0)
  const statusTick = refreshTick + writeTick + autoTick
  const { git: readGit, outcome, primaryBranch } = useWorkspaceGitStatus(agentId, sessionId, statusTick)
  const log = useWorkspaceGitLog(agentId, sessionId, statusTick)
  const scope = `${agentId}:${sessionId ?? 'primary'}`
  // The fresh status a stage/unstage answered with (§6: "the fresh `WorkspaceGitStatus`, so the panel never re-polls"). Keyed by the READ it replaces, so a refresh landing meanwhile wins and this is simply ignored rather than painting a pre-refresh tree over a newer one.
  const [applied, setApplied] = useState<{ key: string; git: WorkspaceGitStatusDto } | null>(null)
  const appliedKey = `${scope}:${statusTick}`
  const git = applied?.key === appliedKey ? applied.git : readGit
  // Whether the history is open. A reader preference, not per checkout: someone who wants to see commits wants them in the next scope too, and it starts closed because the working half above it is what the panel is for.
  const [commitsOpen, setCommitsOpen] = useState(false)
  // Which staging write is in flight, by its own key, so the pressed control alone shows the spinner. One at a time: the daemon serialises workspace mutations anyway, and two replies would race to be the applied status.
  const [staging, setStaging] = useState<string | null>(null)
  const [stageErr, setStageErr] = useState<string | null>(null)
  // The re-entry latch is a REF, not `staging`: two clicks dispatched in one task both read the same pre-update state and the same not-yet-disabled button, so a double-click would send two writes. Measured on the commit box, which has the same shape.
  const writing = useRef(false)

  // Automatic re-reads, on the dock's shared cadence. Skipped while a write of THIS panel's is in
  // flight: that write answers with the fresh status, and a read racing it would land the pre-write
  // tree over the reply — the write's own `writeTick` is the re-read for that case.
  useDockRefresh({
    active,
    turnActive,
    whileHidden: true,
    // The page's state, not the selected tab's: this read is also what tells the daemon whether the
    // session's sandbox is worth holding, so it keeps polling behind another tab (document visible).
    pollWhileHidden: true,
    intervalMs: DOCK_POLL_MS,
    onRefresh: () => {
      if (writing.current) return
      setApplied(null)
      setAutoTick((tick) => tick + 1)
    }
  })

  // Move paths across the index on the daemon. Only paths the checkout reports as changed on the relevant side are ever passed in, so an empty selection is the one no-op this refuses locally.
  const moveIndex = async (kind: 'stage' | 'unstage', paths: string[], busyKey: string) => {
    if (writing.current || paths.length === 0) return
    writing.current = true
    const key = appliedKey
    setStaging(busyKey)
    setStageErr(null)
    try {
      const write = kind === 'stage' ? stageWorkspacePaths : unstageWorkspacePaths
      const fresh = await write(agentId, { paths, ...(sessionId ? { sessionId } : {}) })
      // A from-scratch workspace answers `isRepo:false`; there are no sections to draw from it, so the read's own answer stands.
      if (fresh.isRepo) setApplied({ key, git: fresh })
      onWrote?.()
    } catch (e) {
      setStageErr(gitWriteRequestFailureText(statusOf(e), codeOf(e)))
    } finally {
      writing.current = false
      setStaging(null)
    }
  }
  // The last answer, latched per scope like the Files panel's settle flag — and carrying the badge's count and the branch facts with it, so the tab reports `ready` once and a refresh keeps them on screen instead of blinking them off and back on behind an in-tree read.
  const [answer, setAnswer] = useState<{
    scope: string
    changed: number | null
    branch: string | null
    tracking: string | null
    base: string | null
    /** What the last settled read WAS, so a re-read's `pending` does not repaint the panel as unreadable. */
    outcome: WorkspaceGitOutcome
  } | null>(null)
  useEffect(() => {
    if (outcome === 'pending') return
    setAnswer((current) => {
      const held = current?.scope === scope ? current : null
      // Distinct PATHS: a file staged and then edited again is one changed file, in two sections.
      const next = {
        scope,
        outcome,
        changed: outcome === 'repo' && git ? new Set(git.files.map((file) => file.path)).size : null,
        branch: outcome === 'repo' ? (git?.branch ?? null) : null,
        tracking: outcome === 'repo' ? (git?.tracking ?? null) : null,
        // The log settles on its own schedule, so a pending one KEEPS the base this scope already reported instead of blinking it off behind a refresh — the same latch the counts above get.
        base: outcome === 'repo' ? (log.loading ? (held?.base ?? null) : baseBranchOf(log.log?.base)) : null
      }
      return held &&
        held.outcome === next.outcome &&
        held.changed === next.changed &&
        held.branch === next.branch &&
        held.tracking === next.tracking &&
        held.base === next.base
        ? held
        : next
    })
  }, [git, log, outcome, scope])
  const settled = answer?.scope === scope
  const changed = settled ? answer.changed : null
  // What the panel DRAWS. A re-read puts the live outcome back to `pending` for a round trip, and every
  // branch keyed on it would then repaint: the branch line would read "Git status unavailable", an
  // offline notice would become "nothing has changed", and the Commits section would unmount. On the
  // dock's timer that is a flicker every few seconds, so the last settled interpretation stands until
  // the new one lands — the same latch the commit box below already applies for the same reason.
  const shown: WorkspaceGitOutcome = outcome === 'pending' && settled ? answer.outcome : outcome

  const sections = useMemo(() => splitGitSections(git?.files ?? []), [git])
  // Reported on the EDGE: the caller's callback is a fresh closure per render, and re-reporting a verdict the tab already has is a state write for nothing.
  const reported = useRef<string | null>(null)
  const reportedBranch = settled ? answer.branch : null
  const reportedTracking = settled ? answer.tracking : null
  const reportedBase = settled ? answer.base : null
  useEffect(() => {
    const key = `${settled}:${changed ?? ''}:${reportedBranch ?? ''}:${reportedTracking ?? ''}:${reportedBase ?? ''}`
    if (reported.current === key) return
    reported.current = key
    onVerdictChange?.({ settled, changed, branch: reportedBranch, tracking: reportedTracking, base: reportedBase })
  }, [changed, onVerdictChange, reportedBase, reportedBranch, reportedTracking, settled])

  if (!settled) return null

  // Why a push cannot work here, from the status the panel already holds. `branch:null` is exactly a detached HEAD, and a session worktree is created detached — those are the same two conditions the daemon answers with `detached-head` and `no-upstream`, so asking is a round trip whose answer is already on screen.
  const pushHint =
    git?.branch == null
      ? 'This worktree has no branch checked out, so there is nothing to push. Commit here, then push from the agent’s primary checkout — or ask the agent to.'
      : git.tracking == null
        ? `Branch ${git.branch} tracks no remote branch, so the daemon has no ref to push it to.`
        : null

  // A session worktree checks out its own generated `dev/<user>/<words>` branch, so its OWN branch is the answer when it has one; only a detached worktree falls back to naming the primary checkout's.
  const branch = git?.branch ?? (settled ? answer.branch : null) ?? (sessionId ? primaryBranch : null)
  const branchTitle = !sessionId
    ? 'Current branch of the workspace checkout'
    : git?.branch
      ? "Branch this session's worktree is checked out on"
      : "Branch of the agent's primary checkout; this session's worktree is detached from it"

  const fileRow = (file: WorkspaceGitFileDto, staged: boolean) => {
    const name = file.path.split('/').at(-1) ?? file.path
    const dir = file.path.slice(0, Math.max(0, file.path.length - name.length - 1))
    const selected = openPath === file.path && openStaged === staged
    // `??` on either half: git has never seen this path, so `git diff` prints nothing for it and a Diff view would say "no unstaged changes" about a file whose whole content is the change. Its content IS the diff, so the row opens the file.
    const untracked = file.index === '?' || file.workingDir === '?'
    const busyKey = `${staged ? 'staged' : 'changes'}:${file.path}`
    return (
      // A row with two targets, so it is a div with two buttons rather than a button inside a button: the path opens the diff, the trailing toggle moves it across the index.
      <div
        key={busyKey}
        // The Files tree's own row affordance, so a path hovers and marks itself the same way in both tabs.
        className={`file-browser-item group flex w-full items-center border-0 border-r-2 pr-[6px] ${selected ? 'border-r-(--brand) bg-(--brand-soft)' : 'border-r-transparent bg-transparent'}`}
      >
        <button
          type="button"
          data-git-row={file.path}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 border-0 bg-transparent py-[5px] pr-1 pl-3 text-left [font:inherit]"
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
        {/* Revealed on hover (§11), and on keyboard focus — an invisible control in the tab order is one a keyboard reader cannot see they have reached. Always visible at ≤768px, where there is no hover to reveal it with. */}
        {canWrite ? (
          <button
            type="button"
            data-git-toggle={file.path}
            className="iconbtn h-[22px] w-[22px] flex-none rounded-xs opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 disabled:pointer-events-none max-desktop:opacity-100"
            disabled={staging !== null}
            aria-label={staged ? `Unstage ${file.path}` : `Stage ${file.path}`}
            title={staged ? 'Unstage this file' : 'Stage this file'}
            onClick={() => void moveIndex(staged ? 'unstage' : 'stage', [file.path], busyKey)}
          >
            {staging === busyKey ? <Spinner size={11} /> : <Icon name={staged ? 'minus' : 'plus'} size={13} />}
          </button>
        ) : null}
      </div>
    )
  }

  const section = (title: string, files: WorkspaceGitFileDto[], staged: boolean) =>
    files.length > 0 ? (
      <div data-git-section={staged ? 'staged' : 'changes'} className="flex flex-none flex-col">
        <div className="flex items-center gap-2 px-3 pt-[10px] pb-[5px] font-sans text-[10.5px] font-semibold tracking-[0.04em] uppercase leading-normal text-(--text-disabled)">
          <span>{title}</span>
          <span className="mono font-medium normal-case tracking-normal">{files.length}</span>
          {/* One REQ for the whole section: the wire carries 500 paths and a status page is capped at 500, so a section can never overflow it. */}
          {canWrite ? (
            <button
              type="button"
              data-git-stage-all={staged ? 'staged' : 'changes'}
              className="lnk ml-auto font-sans text-[11px] font-medium normal-case tracking-normal disabled:pointer-events-none disabled:opacity-50"
              disabled={staging !== null}
              title={
                staged
                  ? 'Take every file here out of the index; nothing in the working tree is touched'
                  : 'Add every changed file here to the index'
              }
              onClick={() =>
                void moveIndex(
                  staged ? 'unstage' : 'stage',
                  files.map((file) => file.path),
                  `all:${staged ? 'staged' : 'changes'}`
                )
              }
            >
              {staging === `all:${staged ? 'staged' : 'changes'}` ? 'Working…' : staged ? 'Unstage all' : 'Stage all'}
            </button>
          ) : null}
        </div>
        {files.map((file) => fileRow(file, staged))}
      </div>
    ) : null

  // Which of the status reads' answers the file half draws. Every branch is data — none may take the panel, the dock or the transcript down (§2).
  const files = (): ReactNode => {
    // Ahead of `unavailable`, which it arrives as (both are 503): the workspace is fine and comes
    // back on the agent's next turn, so this must not read as an outage — and must not read as "not
    // a git checkout" either, which is what a suspended pod used to answer.
    if (shown === 'asleep') {
      return (
        <PanelNotice text="Git status is not available right now — this agent runs in a cluster sandbox and its pod is not running. It starts again on the agent's next turn, and the checkout comes back with it." />
      )
    }
    if (shown === 'unavailable') {
      return (
        <PanelNotice
          warn
          text="Couldn't read this worktree's git status — the owning daemon may be offline. Status is read live from that machine, so it is unavailable while it is disconnected."
        />
      )
    }
    if (shown === 'none') {
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

  // The closed row's count, null until a log read has answered about a checkout — a `0` before the answer would claim an empty branch.
  const commitCount = log.log?.isRepo === true ? `${log.log.commits.length}${log.log.truncated ? '+' : ''}` : null

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
      return (
        <PanelNotice
          text={
            log.log.base
              ? `Nothing committed on this branch yet — it holds no commit that ${log.log.base} does not already have.`
              : 'No commits yet — this checkout has no history of its own.'
          }
        />
      )
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
        {shown === 'repo' && branch ? (
          <span
            className="mono flex min-w-0 flex-1 items-center gap-[4px] text-[11px] font-medium text-(--text-secondary)"
            title={branchTitle}
          >
            <Icon name="git-branch" size={11} color="var(--text-tertiary)" className="flex-none" />
            <span className="truncate">{branch}</span>
          </span>
        ) : (
          <span className="min-w-0 flex-1 font-sans text-[11px] font-normal leading-normal text-(--text-tertiary)">
            {shown === 'none'
              ? 'Not a git checkout'
              : shown === 'asleep'
                ? 'Sandbox not running'
                : 'Git status unavailable'}
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
      <div className="flex min-h-0 flex-1 flex-col overflow-auto pb-2">{files()}</div>
      {/* A staging write that never got an answer — a busy agent, a daemon too old for git writes, a disconnected one. It sits above the commit box because it belongs to the lists, not to the message. */}
      {stageErr ? (
        <div
          data-git-stage-error=""
          className="flex flex-none items-start gap-[6px] border-t border-(--border-subtle) px-3 py-[7px] font-sans text-[11.5px] font-normal leading-[1.5] text-(--red-600)"
        >
          <Icon name="triangle-alert" size={13} color="var(--red-600)" className="mt-[2px] flex-none" />
          <span>{stageErr}</span>
        </div>
      ) : null}
      {/* The commit box only over a checkout: a from-scratch workspace has nothing to commit, and an unreadable one cannot be told what state it is in. A reader whose role cannot write gets the same sentence M2 gave everyone, because for them nothing changed.
          Gated on the LATCHED verdict rather than the live `outcome`, unlike the Commits section above it: a refresh puts the read back to `pending` for a round trip, and unmounting this box would throw away a message the reader had typed — or paid a model to write. `changed !== null` is exactly "the last settled read found a checkout". */}
      {changed !== null ? (
        canWrite ? (
          <CommitBox
            agentId={agentId}
            {...(sessionId ? { sessionId } : {})}
            stagedCount={sections.staged.length}
            {...(pushHint ? { pushHint } : {})}
            onWrote={() => {
              // A commit empties the index and adds a commit; a push moves the pushed markers and the ahead count. Neither reply carries a status, so both are re-read here — and the caller's own readers are stale too.
              setApplied(null)
              setWriteTick((tick) => tick + 1)
              onWrote?.()
            }}
          />
        ) : (
          <div className="flex flex-none items-center gap-2 border-t border-(--border-subtle) px-3 py-[7px] font-sans text-[11px] font-normal leading-normal text-(--text-tertiary)">
            <Icon name="eye" size={12} color="var(--text-tertiary)" className="flex-none" />
            <span>Review only — your role in this organization cannot change this checkout.</span>
          </div>
        )
      ) : null}
      {/* History LAST and closed by default: what a reader does in this panel is read the changed files and commit them, and an open commit list pushed both off a 480px dock. The count is on the closed row because the log is read anyway — collapsing hides the list, not the fact that there is one. */}
      {shown === 'repo' ? (
        <div data-git-section="commits" className="flex min-h-0 flex-none flex-col border-t border-(--border-subtle)">
          <button
            type="button"
            data-git-commits-toggle={commitsOpen ? 'open' : 'closed'}
            className="flex w-full cursor-pointer items-center gap-[6px] border-0 bg-transparent px-3 py-[7px] text-left [font:inherit] hover:bg-(--surface-hover)"
            aria-expanded={commitsOpen}
            title={
              log.log?.base
                ? `Commits this branch has and ${log.log.base} does not — the work opened for review, newest first`
                : 'Commits of this checkout, newest first'
            }
            onClick={() => setCommitsOpen((open) => !open)}
          >
            <Icon
              name={commitsOpen ? 'chevron-down' : 'chevron-right'}
              size={12}
              color="var(--text-tertiary)"
              className="flex-none"
            />
            <span className="font-sans text-[10.5px] font-semibold tracking-[0.04em] uppercase leading-normal text-(--text-disabled)">
              {log.log?.base ? 'Commits ahead' : 'Commits'}
            </span>
            {/* A `+` says the count is a FLOOR — the page carries `limit` commits and the range has more. */}
            {commitCount !== null ? (
              <span className="mono flex-none text-[11px] font-medium leading-normal text-(--text-tertiary)">
                {commitCount}
              </span>
            ) : null}
            {log.log?.base ? (
              <span className="mono min-w-0 truncate text-[10.5px] font-normal leading-normal text-(--text-disabled)">
                {`vs ${log.log.base}`}
              </span>
            ) : null}
          </button>
          {commitsOpen ? (
            <div className="flex max-h-[240px] min-h-0 flex-col overflow-auto pb-2">{commits()}</div>
          ) : null}
        </div>
      ) : null}
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
