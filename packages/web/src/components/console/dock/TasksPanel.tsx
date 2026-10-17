'use client'

// The dock's Tasks tab (§3.5): one session's background work in four groups — Tasks and Follow-ups that AgentConnect manages and can stop, then the Subagents and Commands the runtime reports, read-only.
// Runtime rows are READ-ONLY by measurement: no agent-protocol primitive can address ONE background command, so the composer's turn-scoped stop is the escape hatch.
// Both reads are proxied from the owning daemon and stored nowhere (body-locality, §2), so an offline daemon, an old daemon and an untracked session are expected answers drawn as data.
// What the runtime cannot supply is absent rather than faked: no progress bar, no step line, no command line and no "Logs" link (§3.5).

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Icon } from '@/components/ui'
import { formatFileMtime } from '@/components/console/FileBrowser'
import { ApiError, fetchAgentTasks, type AgentTaskDto, type AgentTasksDto } from '@/lib/api'
import { useDockRefresh } from '@/components/console/dock/auto-refresh'
import {
  FinishedToggle,
  MetaLine,
  TaskGroup,
  TaskRow,
  formatTaskElapsed,
  type MarkTone
} from '@/components/console/task-list'
import type { DockTabStatus } from './SessionDock'
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
  /** Every read of this scope has answered once. */
  settled: boolean
  /** Running tasks across the groups, for the badge; null while unknown and when no read has a count. */
  running: number | null
  /** A group has something to show, or the runtime tracks this session. */
  shown: boolean
}

export const TASKS_UNSETTLED: TasksPanelVerdict = { settled: false, running: null, shown: false }

/** Offered while its reads are pending, then only when a group has something to show. */
export function tasksTabShown(verdict: TasksPanelVerdict): boolean {
  return !verdict.settled || verdict.shown
}

/** The runtime read's own answer, which the panel folds into {@link TasksPanelVerdict}. */
interface TurnVerdict {
  settled: boolean
  running: number | null
  /** The runtime tracks this session, or the read failed and the panel stays to say why. */
  shown: boolean
  finished: number
  failed: boolean
}

const TURN_UNSETTLED: TurnVerdict = { settled: false, running: null, shown: false, finished: 0, failed: false }

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

/** Every group in one scroll, and one verdict for the tab: settled when both reads are, badged with what runs in either. */
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
  /** The ACP session whose tasks this reads; the daemon keys both reads by it. */
  sessionId: string
  /** Whether the Tasks and Follow-ups are read: the agent is in assistant mode, or its daemon lists every agent's tasks. */
  delegated?: boolean
  /** Whether this tab is the visible one. */
  active?: boolean
  /** Whether a turn is streaming in this session; its falling edge is where new tasks come from. */
  turnActive?: boolean
  /** Bumped by the tab's `refresh-cw` action: re-reads both without remounting. */
  refreshTick?: number
  onVerdictChange?: (verdict: TasksPanelVerdict) => void
}) {
  const t = useTranslations('Sessions.detail.tasksPanel')
  const scope = `${agentId}\n${sessionId}`
  // Held per scope, so a switch never folds the previous session's answer into the new one's verdict.
  const [turnHeard, setTurnHeard] = useState<{ scope: string; verdict: TurnVerdict } | null>(null)
  const [delegatedHeard, setDelegatedHeard] = useState<{ scope: string; verdict: SubsessionsPanelVerdict } | null>(null)
  const [finishedOpen, setFinishedOpen] = useState<string | null>(null)
  const showFinished = finishedOpen === scope
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
  const finished = turn.finished + (delegatedVerdict?.finished ?? 0)
  const delegatedOpen = delegatedVerdict ? delegatedVerdict.count - delegatedVerdict.finished : 0
  // Nothing open in any group and no read to explain: say so once instead of drawing empty groups.
  const idle = (turn.running ?? 0) + delegatedOpen === 0 && !turn.failed && !delegatedVerdict?.failed

  // Reported on the EDGE: the caller's callback is a fresh closure per render and a poll usually finds the same census.
  const reported = useRef<string | null>(null)
  useEffect(() => {
    const key = `${settled}:${running ?? ''}:${shown}`
    if (reported.current === key) return
    reported.current = key
    onVerdictChange?.({ settled, running, shown })
  }, [onVerdictChange, running, settled, shown])

  // Mounted while pending so both reads run; drawn only once both have answered, so the dock's own placeholder speaks alone.
  return (
    <div
      data-tasks-panel={settled ? '' : undefined}
      className={settled ? 'flex min-h-0 flex-1 flex-col overflow-auto px-3 py-[10px]' : 'hidden'}
    >
      <div className="flex flex-none flex-col gap-3">
        {delegated ? (
          <SubsessionsPanel
            agentId={agentId}
            sessionId={sessionId}
            active={active}
            turnActive={turnActive}
            refreshTick={refreshTick}
            showFinished={showFinished}
            onVerdictChange={onDelegatedVerdict}
          />
        ) : null}
        <TurnTasksGroups
          agentId={agentId}
          sessionId={sessionId}
          active={active}
          turnActive={turnActive}
          refreshTick={refreshTick}
          showFinished={showFinished}
          onVerdictChange={onTurnVerdict}
        />
        {idle && !showFinished ? <PanelNotice text={t('idle')} /> : null}
        {finished > 0 ? (
          <FinishedToggle
            count={finished}
            open={showFinished}
            onToggle={() => setFinishedOpen(showFinished ? null : scope)}
          />
        ) : null}
      </div>
    </div>
  )
}

/** The runtime's own background work for this session: its Subagents and its Commands, read-only. */
function TurnTasksGroups({
  agentId,
  sessionId,
  active,
  turnActive,
  refreshTick,
  showFinished,
  onVerdictChange
}: {
  agentId: string
  sessionId: string
  active: boolean
  turnActive: boolean
  refreshTick: number
  showFinished: boolean
  onVerdictChange: (verdict: TurnVerdict) => void
}) {
  const t = useTranslations('Sessions.detail.tasksPanel')
  const tl = useTranslations('Common.taskList')
  // Reads the groups ask for ITSELF (polls and the reveal edge), summed with the tab action's counter so every source names one read.
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

  // A visible panel always polls (an idle session still has the 0 -> running edge to discover); a hidden one reads on a turn's falling edge, which is what reveals the tab once the runtime starts tracking the session.
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
  const finished = read.data?.tracked ? tasks.length - running : 0
  const failed = read.err !== null
  const reported = useRef<string | null>(null)
  useEffect(() => {
    const key = `${settled}:${counted ?? ''}:${shown}:${finished}:${failed}`
    if (reported.current === key) return
    reported.current = key
    onVerdictChange({ settled, running: counted, shown, finished, failed })
  }, [counted, failed, finished, onVerdictChange, settled, shown])

  // An untracked session has nothing here: a runtime that reports no task lifecycle is not an idle one.
  if (!settled || !shown) return null
  if (read.err) return <PanelNotice text={t(noticeKey(read.errStatus, read.errCode))} warn={read.errStatus !== 503} />

  const listed = [
    ...tasks.filter((task) => task.state === 'running'),
    ...(showFinished ? tasks.filter((task) => task.state !== 'running') : [])
  ]
  const subagents = listed.filter((task) => task.subagent)
  const commands = listed.filter((task) => !task.subagent)
  return (
    <>
      {subagents.length > 0 ? (
        <TaskGroup id="subagents" title={tl('groups.subagents')} count={subagents.length}>
          {subagents.map((task) => (
            <RuntimeTaskRow key={task.id} task={task} now={now} />
          ))}
        </TaskGroup>
      ) : null}
      {commands.length > 0 ? (
        <TaskGroup id="commands" title={tl('groups.commands')} count={commands.length}>
          {commands.map((task) => (
            <RuntimeTaskRow key={task.id} task={task} now={now} />
          ))}
        </TaskGroup>
      ) : null}
      {showFinished && read.data?.truncated ? (
        <div className="px-[2px] font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
          {t('olderTasksHidden')}
        </div>
      ) : null}
    </>
  )
}

const TONE: Record<AgentTaskDto['state'], MarkTone> = { running: 'running', done: 'done', failed: 'failed' }

function RuntimeTaskRow({ task, now }: { task: AgentTaskDto; now: number }) {
  const t = useTranslations('Sessions.detail.tasksPanel')
  const tl = useTranslations('Common.taskList')
  const running = task.state === 'running'
  return (
    <TaskRow
      tone={TONE[task.state]}
      dim={!running}
      attrs={{ 'data-task-row': task.state }}
      title={
        // An unnamed task still gets a row: it is what fences host reclaim, so a reader needs to be told about it.
        <span
          className={`min-w-0 truncate ${task.description ? (task.subagent ? '' : 'font-mono text-[12.5px]') : 'font-normal italic text-(--text-tertiary)'}`}
          title={task.description ?? undefined}
        >
          {task.description ?? (task.subagent ? t('unnamedSubagent') : t('unnamedTask'))}
        </span>
      }
      meta={
        <MetaLine
          parts={[
            tl(`runtimeState.${task.state}`),
            // The terminal status the runtime reported, when it named one; most settle edges carry none.
            task.detail,
            running ? formatTaskElapsed(task.startedAt, now) : formatFileMtime(task.endedAt)
          ]}
        />
      }
    />
  )
}

// A degraded or empty state, drawn calmly: a session nobody can read tasks for still has something to say about why.
function PanelNotice({ text, warn = false }: { text: string; warn?: boolean }) {
  return (
    <div className="flex items-start gap-2 px-[2px] py-1 font-sans text-[12px] font-normal leading-[1.55] text-(--text-secondary)">
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
