'use client'

// The dock's Tasks tab (§3.5): one session's tasks in two groups — what the runtime reports for this turn, read-only, and the tasks AgentConnect manages for it (delegated tasks, patrols, approved proposals), which can be stopped.
// The runtime group is READ-ONLY by measurement: no agent-protocol primitive can address ONE background command, so a per-row control could only cancel unrelated work; the composer's turn-scoped stop is the escape hatch.
// Both reads are proxied through the CP from the owning daemon and stored nowhere (body-locality, §2), so an offline daemon, an old daemon and an untracked session are expected answers drawn as data.
// What the runtime cannot supply is absent rather than faked: no progress bar, no step line, no command line, and no "Logs" link (§3.5 records the measurement behind each).

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Spinner } from '@/components/marks'
import { Icon } from '@/components/ui'
import { formatFileMtime } from '@/components/console/FileBrowser'
import { ApiError, fetchAgentTasks, type AgentTaskDto, type AgentTasksDto } from '@/lib/api'
import { useDockRefresh } from '@/components/console/dock/auto-refresh'
import type { DockTabStatus } from './SessionDock'
import { TaskGroupHeading, formatTaskElapsed } from './task-group'
import {
  SUBSESSIONS_UNSETTLED,
  SubsessionsPanel,
  subsessionsTabShown,
  type SubsessionsPanelVerdict
} from './SubsessionsPanel'

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))
const statusOf = (e: unknown) => (e instanceof ApiError ? e.status : null)
const codeOf = (e: unknown) => (e instanceof ApiError && e.code ? e.code : null)

/** How often a visible panel re-reads while something is running. */
const POLL_MS = 5_000

/** A visible idle panel still polls, backed off: the session can start a task at any time and nothing else bumps this read. */
const IDLE_POLL_MS = 20_000

/** How often a running row's elapsed time redraws. Client-side arithmetic, no request. */
const TICK_MS = 1_000

/** What the Tasks tab reports upward; the caller owns the tab descriptor, as for the Files and Git tabs. */
export interface TasksPanelVerdict {
  /** Every group's first read of this scope has answered. */
  settled: boolean
  /** Running tasks in both groups, for the badge; null while unknown and when neither group has a count. */
  running: number | null
  /** Either group has something to show, or the runtime tracks this session. */
  shown: boolean
}

export const TASKS_UNSETTLED: TasksPanelVerdict = { settled: false, running: null, shown: false }

/** Offered while its reads are pending, then only when a group has something to show. */
export function tasksTabShown(verdict: TasksPanelVerdict): boolean {
  return !verdict.settled || verdict.shown
}

/** The runtime group's own answer, which the panel folds into {@link TasksPanelVerdict}. */
interface TurnVerdict {
  settled: boolean
  running: number | null
  /** The runtime tracks this session, or the read failed and the group stays to say why. */
  shown: boolean
}

const TURN_UNSETTLED: TurnVerdict = { settled: false, running: null, shown: false }

export { formatTaskElapsed }

/** `loading` covers the first read of a scope only; never `empty`, since a settled panel with nothing to show drops its tab instead. */
export function tasksTabStatus(settled: boolean): DockTabStatus {
  return settled ? 'ready' : 'loading'
}

interface TasksRead {
  loading: boolean
  err: string | null
  errStatus: number | null
  errCode: string | null
  data: AgentTasksDto | null
}

const PENDING: TasksRead = { loading: true, err: null, errStatus: null, errCode: null, data: null }

// Why the list is missing: 409 `DAEMON_FEATURE_MISSING` is the version answer, 404 a session this reader cannot see; everything else (503, network) is the offline story.
function noticeKey(
  status: number | null,
  code: string | null
): 'upgradeDaemon' | 'oldDaemon' | 'notReadable' | 'unavailable' {
  if (status === 409 && code === 'DAEMON_FEATURE_MISSING') return 'upgradeDaemon'
  if (status === 409) return 'oldDaemon'
  if (status === 404) return 'notReadable'
  return 'unavailable'
}

// One read per revision, held PER SCOPE so a new session reads as pending at once and a re-read of the same one replaces rows in place.
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

/** Both groups in one scroll, and one verdict for the tab: settled when both are, badged with what runs in either. */
export function TasksPanel({
  agentId,
  sessionId,
  delegated = false,
  active = true,
  turnActive = false,
  refreshTick = 0,
  onVerdictChange
}: {
  agentId: string
  /** The ACP session whose tasks this reads; the daemon keys both groups by it. */
  sessionId: string
  /** Whether the delegated group is read: the agent is in assistant mode, or its daemon lists every agent's tasks. */
  delegated?: boolean
  /** Whether this tab is the visible one. */
  active?: boolean
  /** Whether a turn is streaming in this session; its falling edge is where new tasks come from. */
  turnActive?: boolean
  /** Bumped by the tab's `refresh-cw` action: re-reads both groups without remounting. */
  refreshTick?: number
  onVerdictChange?: (verdict: TasksPanelVerdict) => void
}) {
  const scope = `${agentId}\n${sessionId}`
  // Held per scope, so a switch never folds the previous session's answer into the new one's verdict.
  const [turnHeard, setTurnHeard] = useState<{ scope: string; verdict: TurnVerdict } | null>(null)
  const [delegatedHeard, setDelegatedHeard] = useState<{ scope: string; verdict: SubsessionsPanelVerdict } | null>(null)
  const onTurnVerdict = useCallback((verdict: TurnVerdict) => setTurnHeard({ scope, verdict }), [scope])
  const onDelegatedVerdict = useCallback(
    (verdict: SubsessionsPanelVerdict) => setDelegatedHeard({ scope, verdict }),
    [scope]
  )
  const turn = turnHeard?.scope === scope ? turnHeard.verdict : TURN_UNSETTLED
  const delegatedVerdict = !delegated
    ? null
    : delegatedHeard?.scope === scope
      ? delegatedHeard.verdict
      : SUBSESSIONS_UNSETTLED
  const settled = turn.settled && (delegatedVerdict?.settled ?? true)
  const delegatedRunning = delegatedVerdict?.running ?? 0
  const running = turn.running === null && delegatedVerdict === null ? null : (turn.running ?? 0) + delegatedRunning
  const shown = turn.shown || (delegatedVerdict !== null && subsessionsTabShown(delegatedVerdict))

  // Reported on the EDGE: the caller's callback is a fresh closure per render and a poll usually finds the same census.
  const reported = useRef<string | null>(null)
  useEffect(() => {
    const key = `${settled}:${running ?? ''}:${shown}`
    if (reported.current === key) return
    reported.current = key
    onVerdictChange?.({ settled, running, shown })
  }, [onVerdictChange, running, settled, shown])

  // Mounted while pending so both groups read; drawn only once both have answered, so the dock's own placeholder speaks alone.
  return (
    <div
      data-tasks-panel={settled ? '' : undefined}
      className={settled ? 'flex min-h-0 flex-1 flex-col overflow-auto px-3 py-[10px]' : 'hidden'}
    >
      <div className="flex flex-none flex-col gap-4">
        <TurnTasksGroup
          agentId={agentId}
          sessionId={sessionId}
          active={active}
          turnActive={turnActive}
          refreshTick={refreshTick}
          onVerdictChange={onTurnVerdict}
        />
        {delegated ? (
          <SubsessionsPanel
            agentId={agentId}
            sessionId={sessionId}
            active={active}
            turnActive={turnActive}
            refreshTick={refreshTick}
            onVerdictChange={onDelegatedVerdict}
          />
        ) : null}
      </div>
    </div>
  )
}

/** The runtime's own tasks for this session: long commands and its subagents, read-only. */
function TurnTasksGroup({
  agentId,
  sessionId,
  active,
  turnActive,
  refreshTick,
  onVerdictChange
}: {
  agentId: string
  sessionId: string
  active: boolean
  turnActive: boolean
  refreshTick: number
  onVerdictChange: (verdict: TurnVerdict) => void
}) {
  const t = useTranslations('Sessions.detail.tasksPanel')
  // Reads the group asks for ITSELF (polls and the reveal edge), summed with the tab action's counter so every source names one read.
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

  // A visible group always polls (an idle session still has the 0 -> running edge to discover); a hidden one reads on a turn's falling edge, which is what reveals the tab once the runtime starts tracking the session.
  useDockRefresh({
    active,
    turnActive,
    whileHidden: true,
    intervalMs: running > 0 ? POLL_MS : IDLE_POLL_MS,
    onRefresh: () => setOwnTick((tick) => tick + 1)
  })

  // Elapsed redraws from `startedAt` alone, so it ticks without a request.
  useEffect(() => {
    if (!active || running === 0) return
    const timer = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(timer)
  }, [active, running])

  // `running` is null for anything that is not a counted answer: a failed read and an untracked session.
  const counted = read.data?.tracked ? running : null
  const shown = read.err !== null || read.data?.tracked === true
  const reported = useRef<string | null>(null)
  useEffect(() => {
    const key = `${settled}:${counted ?? ''}:${shown}`
    if (reported.current === key) return
    reported.current = key
    onVerdictChange({ settled, running: counted, shown })
  }, [counted, onVerdictChange, settled, shown])

  // An untracked session has nothing in this group: a runtime that reports no task lifecycle is not an idle one, and the tab shows only what the delegated group holds.
  if (!settled || !shown) return null

  const body = () => {
    if (read.err) {
      return <PanelNotice text={t(noticeKey(read.errStatus, read.errCode))} warn={read.errStatus !== 503} />
    }
    if (tasks.length === 0) return <PanelNotice text={t('noTasksInSession')} />
    return (
      <>
        {tasks.map((task) => (
          <TaskRow key={task.id} task={task} now={now} />
        ))}
        {read.data?.truncated ? (
          <div className="px-3 pt-1 pb-[10px] font-sans text-[11px] font-normal leading-normal text-(--text-tertiary)">
            {t('olderTasksHidden')}
          </div>
        ) : null}
      </>
    )
  }

  return (
    <section data-task-group="turn" aria-label={t('groupTurn')} className="flex flex-none flex-col gap-[6px]">
      <TaskGroupHeading
        title={t('groupTurn')}
        hint={t('groupTurnHint')}
        census={read.err ? undefined : summaryText(tasks, t)}
      />
      {body()}
    </section>
  )
}

/** The group's one-line census. Counts what is on screen, so it can never disagree with the rows. */
function summaryText(
  tasks: AgentTaskDto[],
  t: ReturnType<typeof useTranslations<'Sessions.detail.tasksPanel'>>
): string {
  if (tasks.length === 0) return t('noBackgroundTasks')
  const running = tasks.filter((task) => task.state === 'running').length
  const failed = tasks.filter((task) => task.state === 'failed').length
  const done = tasks.length - running - failed
  const parts = [t('census.running', { count: running })]
  if (done > 0) parts.push(t('census.done', { count: done }))
  if (failed > 0) parts.push(t('census.failed', { count: failed }))
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
  const t = useTranslations('Sessions.detail.tasksPanel')
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
          {task.description ?? (task.subagent ? t('unnamedSubagent') : t('unnamedTask'))}
        </span>
        {/* Subagent rows are CARRIED rather than filtered: the same records fence reclaim, so hiding them here would show "no tasks" beside a host refusing to be reclaimed. Marked instead. */}
        {task.subagent ? (
          <span
            className="flex-none rounded-xs bg-(--surface-active) px-[5px] py-px font-sans text-[10px] font-medium leading-normal text-(--text-tertiary)"
            title={t('subagentTitle')}
          >
            {t('subagent')}
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
