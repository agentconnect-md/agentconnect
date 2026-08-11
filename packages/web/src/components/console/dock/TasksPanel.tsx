'use client'

// The dock's Tasks tab (§3.5): the open session's background tasks, live ones first and then the daemon's bounded settled history, each with its state, its description, how long it has been running or how long ago it ended, and the outcome the runtime reported when it named one.
// A READ-ONLY surface, by measurement rather than by omission: no agent-protocol primitive can address ONE background task, so a per-row control could only cancel unrelated work or report a stop it did not perform. There is no cancel frame or route to wire, and the escape hatch is the composer's own turn-scoped stop.
// The lease lives only in the owning daemon's memory and is proxied through the CP without being stored (body-locality, §2), so an offline daemon, a daemon too old for the frame, a runtime that reports no task lifecycle, and a session that simply has no tasks are all expected answers drawn as data.
// What the design asked for and the runtime cannot supply is absent rather than faked: no progress bar, no step line, no command line, and no "Logs" link (§3.5 records the measurement behind each).

import { useEffect, useRef, useState } from 'react'
import { Spinner } from '@/components/marks'
import { Icon } from '@/components/ui'
import { formatFileMtime } from '@/components/console/FileBrowser'
import { ApiError, fetchAgentTasks, type AgentTaskDto, type AgentTasksDto } from '@/lib/api'
import type { DockTabStatus } from './SessionDock'

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))
const statusOf = (e: unknown) => (e instanceof ApiError ? e.status : null)
const codeOf = (e: unknown) => (e instanceof ApiError && e.code ? e.code : null)

/** How often a visible panel re-reads while something is running. A state transition is the only thing a read can reveal — elapsed ticks from `startedAt` without one. */
const POLL_MS = 5_000

/** How often a running row's elapsed time redraws. Client-side arithmetic, no request. */
const TICK_MS = 1_000

/** What the Tasks tab reports upward. The caller owns the tab descriptor, so the panel reports its verdict rather than applying it — the same shape the Files and Git tabs use. */
export interface TasksPanelVerdict {
  /** The scoped read has answered, one way or another. */
  settled: boolean
  /** Running tasks for the tab's badge; null while unknown, and for a session the daemon does not track. */
  running: number | null
}

/** The Tasks tab's status: `loading` covers the first read of a scope only. */
// Never `empty` — and here, unlike the Files and Git tabs that inherit the choice for a corner case, it is the decision about this panel's NORMAL state. `empty` costs four things, measured against the dock: the dock's centred "Nothing to show" replaces the body, and it cannot tell an untracked session from an idle one; it only reads correctly if the panel returns null there, which throws away the sentence that draws exactly that distinction; it marks the steady state as non-ready in the strip, so a reader who opens Tasks is told nothing is there rather than that nothing is running; and it puts `vacant` (every tab non-ready) back in reach, where the dock withholds its whole tab strip and the tab a reader asked for cannot be opened at all. What `ready` costs instead is one click to learn nothing is running — the cheaper half, because the answer is a sentence and a sentence needs a panel to draw it.
export function tasksTabStatus(settled: boolean): DockTabStatus {
  return settled ? 'ready' : 'loading'
}

/** How long a running task has been running. Seconds below a minute, `m s` below an hour, `h m` above it — the shape the design draws, and never a negative from a daemon clock ahead of ours. */
export function formatTaskElapsed(startedAt: string, now: number): string {
  const started = new Date(startedAt).getTime()
  if (Number.isNaN(started)) return ''
  const seconds = Math.max(0, Math.round((now - started) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`
}

interface TasksRead {
  loading: boolean
  err: string | null
  errStatus: number | null
  errCode: string | null
  data: AgentTasksDto | null
}

const PENDING: TasksRead = { loading: true, err: null, errStatus: null, errCode: null, data: null }

// Why the list is missing. 409 `DAEMON_FEATURE_MISSING` is the version answer the CP added for the task frame; 404 is an agent or session this reader cannot see, or one whose content was purged. Everything else (503 for both an offline daemon and an unplaced agent, plus network failures) is the offline story.
function noticeText(status: number | null, code: string | null): string {
  if (status === 409 && code === 'DAEMON_FEATURE_MISSING') {
    return 'This agent runs a daemon version that cannot report background tasks. Update the agent to watch them here.'
  }
  if (status === 409) return 'This agent runs a daemon version that cannot report background tasks.'
  if (status === 404) return 'This session’s tasks are not available to read.'
  return 'Background tasks are unavailable — the owning daemon may be offline.'
}

/** One scoped read, re-issued whenever `revision` moves. The answer is held PER SCOPE and the pending state DERIVED from it rather than reset by an effect: a new scope reads as pending on the very render that changes it, so the previous session's rows are never on screen and its census can never reach the tab's badge, while a re-read of the SAME scope replaces the rows in place instead of strobing the list back to a spinner on every poll. */
// Deriving it is also what keeps one read per revision. Measured on the version that reset from an effect and zeroed a separate poll counter beside it: after any poll had fired, a scope switch and a tab-action refresh each issued TWO reads, because zeroing the counter re-triggered the read it was there to describe.
function useAgentTasks(agentId: string, sessionId: string, revision: number): TasksRead {
  const scope = `${agentId}\n${sessionId}`
  const [answered, setAnswered] = useState<{ scope: string; read: TasksRead } | null>(null)
  useEffect(() => {
    let live = true
    const settle = (read: TasksRead) => {
      if (live) setAnswered({ scope, read })
    }
    fetchAgentTasks(agentId, sessionId).then(
      (data) => settle({ ...PENDING, loading: false, data }),
      (e) => settle({ ...PENDING, loading: false, err: msg(e), errStatus: statusOf(e), errCode: codeOf(e) })
    )
    return () => {
      live = false
    }
  }, [agentId, revision, scope, sessionId])
  return answered?.scope === scope ? answered.read : PENDING
}

export function TasksPanel({
  agentId,
  sessionId,
  active = true,
  refreshTick = 0,
  onVerdictChange
}: {
  agentId: string
  /** The ACP session whose lease this reads. REQUIRED, unlike the workspace panels' optional scope: the daemon tracks tasks per (agent, ACP session) and holds no per-agent aggregate to answer with, so an unscoped read would be a 400 rather than a guess. */
  sessionId: string
  /** Whether this tab is the visible one. A hidden panel neither polls nor ticks nor re-reads; its rows are then as fresh as its last read, which is what the Git tab's changed count already is. */
  active?: boolean
  /** Bumped by the tab's `refresh-cw` action: re-reads without remounting. */
  refreshTick?: number
  /** The inputs to {@link tasksTabStatus} and the tab's badge. */
  onVerdictChange?: (verdict: TasksPanelVerdict) => void
}) {
  // Reads the panel asks for ITSELF: one per poll interval while something runs, and one on the edge where the reader opens the tab, because a list read ten minutes ago is not an answer about now. Only ever increasing, and summed with the tab action's counter, so every source names one distinct read.
  const [ownTick, setOwnTick] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const read = useAgentTasks(agentId, sessionId, refreshTick + ownTick)
  const tasks = read.data?.tasks ?? []
  const running = tasks.filter((task) => task.state === 'running').length
  const settled = !read.loading

  // The activation EDGE, not the state: re-reading on `active` itself would re-read on every render while the tab is open.
  const wasActive = useRef(active)
  useEffect(() => {
    if (active && !wasActive.current) setOwnTick((tick) => tick + 1)
    wasActive.current = active
  }, [active])

  // Only a VISIBLE panel with something running polls. An idle list has no transition to find, and a hidden one is a request nobody is looking at.
  useEffect(() => {
    if (!active || running === 0) return
    const timer = setInterval(() => setOwnTick((tick) => tick + 1), POLL_MS)
    return () => clearInterval(timer)
  }, [active, running])

  // Elapsed redraws from `startedAt` alone, so it ticks without a request.
  useEffect(() => {
    if (!active || running === 0) return
    const timer = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(timer)
  }, [active, running])

  // `running` is null for anything that is not a counted answer — a failed read AND an untracked session. A `0` there would assert "nothing is running" about a lease we were never shown.
  const counted = read.data?.tracked ? running : null
  // Reported on the EDGE: the caller's callback is a fresh closure per render and a poll usually finds the same census, so re-reporting the verdict the tab already holds would write parent state — re-rendering the whole session page — once per interval.
  const reported = useRef<string | null>(null)
  useEffect(() => {
    const key = `${settled}:${counted ?? ''}`
    if (reported.current === key) return
    reported.current = key
    onVerdictChange?.({ settled, running: counted })
  }, [counted, onVerdictChange, settled])

  // Withheld until the first read of this scope answers, so the dock's own "Loading…" placeholder speaks alone rather than beside a second one of the panel's making.
  if (!settled) return null

  const body = () => {
    if (read.err) return <PanelNotice text={noticeText(read.errStatus, read.errCode)} warn={read.errStatus !== 503} />
    // Two different answers the design would otherwise collapse into one empty state: a runtime that reports no task lifecycle at all has NO lease, which is not the same statement as a tracked session that happens to be idle.
    if (!read.data?.tracked) {
      return (
        <PanelNotice text="This agent’s runtime doesn’t report background tasks, so there is nothing to watch here. Its work still streams into the conversation." />
      )
    }
    if (tasks.length === 0) {
      return (
        <PanelNotice text="No background tasks in this session — everything the agent ran finished inside its turn." />
      )
    }
    return (
      <>
        {tasks.map((task) => (
          <TaskRow key={task.id} task={task} now={now} />
        ))}
        {read.data.truncated ? (
          <div className="px-3 pt-1 pb-[10px] font-sans text-[11px] font-normal leading-normal text-(--text-tertiary)">
            Older tasks are not shown — the daemon keeps a bounded history.
          </div>
        ) : null}
      </>
    )
  }

  return (
    <div data-tasks-panel="" className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-none items-center gap-2 border-b border-(--border-subtle) px-3 py-[10px]">
        <span
          data-tasks-census=""
          className="min-w-0 flex-1 font-sans text-[11px] font-normal leading-normal text-(--text-secondary)"
        >
          {summaryText(read.data, tasks)}
        </span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-[6px] overflow-auto px-3 py-[10px]">{body()}</div>
    </div>
  )
}

/** The header's one-line census. Counts what is on screen, so it can never disagree with the rows. */
function summaryText(data: AgentTasksDto | null, tasks: AgentTaskDto[]): string {
  if (!data?.tracked) return 'Background tasks'
  if (tasks.length === 0) return 'No background tasks'
  const running = tasks.filter((task) => task.state === 'running').length
  const failed = tasks.filter((task) => task.state === 'failed').length
  const done = tasks.length - running - failed
  const parts = [`${running} running`]
  if (done > 0) parts.push(`${done} done`)
  if (failed > 0) parts.push(`${failed} failed`)
  return parts.join(' · ')
}

/** The accent that carries a row's state, as tokens rather than a colour decision per row. */
// `circle-check` and `circle-x` are names THIS lucide version has; `check-circle-2`, which §8's icon list names, is not one of them and would render nothing at all.
const ACCENT: Record<AgentTaskDto['state'], string> = {
  running: 'var(--status-info)',
  done: 'var(--status-online)',
  failed: 'var(--red-600)'
}

// The row's left edge, coloured per state. Every side is named explicitly rather than painting all four and overriding the left: two colour utilities for the same edge would leave which one wins to the order Tailwind happens to emit them in.
const BORDER: Record<AgentTaskDto['state'], string> = {
  running: 'border-l-(--status-info)',
  done: 'border-l-(--status-online)',
  failed: 'border-l-(--red-600)'
}

function TaskRow({ task, now }: { task: AgentTaskDto; now: number }) {
  const running = task.state === 'running'
  return (
    <div
      data-task-row={task.state}
      className={`flex flex-none flex-col gap-[5px] rounded-md border-y border-r border-l-2 border-y-(--border-subtle) border-r-(--border-subtle) bg-(--surface-card) px-[10px] py-2 ${BORDER[task.state]}`}
    >
      <div className="flex items-center gap-2">
        {running ? (
          <span className="flex flex-none items-center">
            <Spinner size={12} />
          </span>
        ) : (
          <Icon
            name={task.state === 'failed' ? 'circle-x' : 'circle-check'}
            size={13}
            color={ACCENT[task.state]}
            className="flex-none"
          />
        )}
        {/* A runtime that named no description still gets a row — it is the thing fencing host reclaim, and an unnamed task is exactly what a reader needs to be told about. */}
        <span
          className={`min-w-0 flex-1 truncate font-sans text-[12.5px] leading-normal ${
            task.description ? 'font-medium text-(--text-primary)' : 'font-normal italic text-(--text-tertiary)'
          }`}
          title={task.description ?? undefined}
        >
          {task.description ?? 'Unnamed task'}
        </span>
        {/* Subagent rows are CARRIED rather than filtered: the same records fence reclaim, so hiding them here would show "no tasks" beside a host refusing to be reclaimed. Marked instead. */}
        {task.subagent ? (
          <span
            className="flex-none rounded-xs bg-(--surface-active) px-[5px] py-px font-sans text-[10px] font-medium leading-normal text-(--text-tertiary)"
            title="The runtime’s own internal subagent invocation"
          >
            subagent
          </span>
        ) : null}
        <span className="mono flex-none text-[11px] leading-normal text-(--text-tertiary)">
          {running ? formatTaskElapsed(task.startedAt, now) : formatFileMtime(task.endedAt)}
        </span>
      </div>
      {/* The terminal status the runtime reported, when it named one. Most settle edges carry none, which is why `done` never asserts success on its own. */}
      {task.detail ? (
        <div className="pl-[21px] font-sans text-[11.5px] font-normal leading-[1.45] text-(--text-secondary)">
          {task.detail}
        </div>
      ) : null}
    </div>
  )
}

// A degraded or empty state, drawn calmly: a session nobody can read tasks for still has something to say about why.
function PanelNotice({ text, warn = false }: { text: string; warn?: boolean }) {
  return (
    <div className="flex items-start gap-2 px-3 py-[10px] font-sans text-[12px] font-normal leading-[1.55] text-(--text-secondary)">
      <Icon
        name={warn ? 'triangle-alert' : 'list-checks'}
        size={14}
        color={warn ? 'var(--amber-500)' : 'var(--text-tertiary)'}
        className="mt-[2px] flex-none"
      />
      <span>{text}</span>
    </div>
  )
}
