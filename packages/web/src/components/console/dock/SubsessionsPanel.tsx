'use client'

// The Tasks tab's task and follow-up groups (assistant-mode.md §1.3, §5.6, §5.12; auto-session-mode.md §11): this conversation's tasks with their summaries, approved proposals and follow-ups, read from the agent's daemon and kept nowhere else.
// Each row links to its own page where the reader may open it; Stop interrupts its current turn exactly as the composer's stop would, and undoes nothing it already did.

import { useCallback, useEffect, useRef, useState } from 'react'
import { useFormatter, useTranslations } from 'next-intl'
import { Button, Icon } from '@/components/ui'
import { useDockRefresh } from '@/components/console/dock/auto-refresh'
import {
  ApiError,
  fetchAssistantSubsessions,
  type AssistantSubsessionDto,
  type AssistantSubsessionsPageDto
} from '@/lib/api'
import { followUpOf, taskRunning, taskStopKey } from '@/components/console/follow-up'
import {
  PlaceMark,
  StopNote,
  taskFinished,
  taskStateKey,
  taskTone,
  useShortTime,
  useTaskStops,
  type StopState
} from '@/components/console/task-list'
import { ConfirmStrip } from '@/components/console/ConfirmStrip'
import { FoldToggle, LineGroup, LineRow, foldRows, runningFirst } from '@/components/console/dock/task-lines'
import { useOrgs } from '@/lib/org-context'
import Link from 'next/link'
import type { TaskLink } from '@/components/console/task-link'

/** Rows one read asks for; "Show more" pages on by the cursor the last one returned. */
export const SUBSESSIONS_PAGE = 20

/** The listing route's own cap on one page, which a refresh asks for at most. */
const SUBSESSIONS_READ_MAX = 50

/** Re-read cadence while one runs, while none does, and while the tab is not the selected one. */
const POLL_MS = 5_000
const IDLE_POLL_MS = 20_000
// A hidden panel still reads, slowly: its verdict is what puts the tab in the strip once the conversation opens its first one.
const HIDDEN_POLL_MS = 60_000
/** How often a running row's start time redraws; arithmetic, no request. */
const TICK_MS = 15_000

/** What the Tasks panel needs from these groups. */
export interface SubsessionsPanelVerdict {
  /** The first read of this conversation has answered. */
  settled: boolean
  /** Rows read, finished ones included; 0 drops both groups. */
  count: number
  /** Running rows, for the badge. */
  running: number
  /** Rows that reported, failed or ended, which wait behind the finished toggle. */
  finished: number
  /** The read failed with nothing to show, so the groups stay to say why. */
  failed: boolean
}

export const SUBSESSIONS_UNSETTLED: SubsessionsPanelVerdict = {
  settled: false,
  count: 0,
  running: 0,
  finished: 0,
  failed: false
}

/** Shown once the conversation has one, or when the read failed and the groups have to say why. */
export function subsessionsTabShown(verdict: SubsessionsPanelVerdict): boolean {
  return verdict.settled && (verdict.failed || verdict.count > 0)
}

interface ListState {
  scope: string
  rows: AssistantSubsessionDto[]
  /** Where "Show more" continues; null once the oldest is on screen. */
  cursor: string | null
  error: { status: number | null; code: string | null } | null
}

const failureOf = (e: unknown) => ({
  status: e instanceof ApiError ? e.status : null,
  code: e instanceof ApiError ? (e.code ?? null) : null
})

/** Every row already on screen read afresh, page by page from the newest, so none keeps a state or a Stop the daemon no longer reports. */
async function readLoaded(
  agentId: string,
  sessionId: string,
  loaded: number
): Promise<Pick<ListState, 'rows' | 'cursor'>> {
  const want = Math.max(SUBSESSIONS_PAGE, loaded)
  const rows: AssistantSubsessionDto[] = []
  let cursor: string | null = null
  do {
    const page: AssistantSubsessionsPageDto = await fetchAssistantSubsessions(agentId, {
      parentSessionId: sessionId,
      limit: Math.min(SUBSESSIONS_READ_MAX, want - rows.length),
      ...(cursor ? { cursor } : {})
    })
    rows.push(...page.subsessions)
    cursor = page.nextCursor
  } while (cursor !== null && rows.length < want)
  return { rows, cursor }
}

function noticeKey(status: number | null, code: string | null): 'upgradeDaemon' | 'notReadable' | 'unavailable' {
  if (code === 'DAEMON_FEATURE_MISSING') return 'upgradeDaemon'
  if (status === 404 || code === 'ASSISTANT_MODE_OFF') return 'notReadable'
  return 'unavailable'
}

export function SubsessionsPanel({
  agentId,
  sessionId,
  active = true,
  turnActive = false,
  refreshTick = 0,
  onVerdictChange,
  onOpenThread,
  onOpenRoot
}: {
  agentId: string
  /** The conversation's own session: only its tasks are listed. */
  sessionId: string
  /** Whether the Tasks tab is the selected one; a hidden panel reads slowly. */
  active?: boolean
  /** A turn streaming in this conversation; its falling edge is where a delegation lands. */
  turnActive?: boolean
  /** Bumped by the tab's refresh action. */
  refreshTick?: number
  onVerdictChange?: (verdict: SubsessionsPanelVerdict) => void
  /** Opens a threaded task's thread beside the conversation, where its row would follow a link to its page. */
  onOpenThread?: (link: TaskLink) => void
  /** Opens a thread of the conversation by its root, as a getting-to-know task's row opens the one its introduction is in. */
  onOpenRoot?: (rootId: string) => void
}) {
  const t = useTranslations('Sessions.detail.subsessionsPanel')
  const tl = useTranslations('Common.taskList')
  const scope = `${agentId}\n${sessionId}`
  const [ownTick, setOwnTick] = useState(0)
  const [list, setList] = useState<ListState | null>(null)
  const [moreState, setMore] = useState({ scope, loading: false, failed: false })
  const more = moreState.scope === scope ? moreState : { scope, loading: false, failed: false }
  const revision = refreshTick + ownTick
  // How many rows this conversation has on screen, so a refresh re-reads as far as "Show more" reached.
  const loaded = useRef({ scope, rows: 0 })

  useEffect(() => {
    let live = true
    readLoaded(agentId, sessionId, loaded.current.scope === scope ? loaded.current.rows : 0).then(
      (fresh) => {
        if (live) setList({ scope, ...fresh, error: null })
      },
      (e: unknown) => {
        // A failed re-read keeps the rows it already showed and says it could not refresh them.
        if (live)
          setList((prev) =>
            prev?.scope === scope
              ? { ...prev, error: failureOf(e) }
              : { scope, rows: [], cursor: null, error: failureOf(e) }
          )
      }
    )
    return () => {
      live = false
    }
  }, [agentId, sessionId, scope, revision])

  const current = list?.scope === scope ? list : null
  const rows = current?.rows ?? []
  useEffect(() => {
    loaded.current = { scope, rows: rows.length }
  }, [rows.length, scope])
  const running = rows.filter(taskRunning).length
  const settled = current !== null
  const failed = current?.error != null && rows.length === 0
  const finished = rows.filter(taskFinished).length
  const reread = useCallback(() => setOwnTick((tick) => tick + 1), [])
  const { stopOf, stop } = useTaskStops(agentId, scope, reread)
  const [now, setNow] = useState(() => Date.now())
  // Groups the reader closed and folds they opened, keyed by conversation and group.
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set())
  const [foldOpen, setFoldOpen] = useState<ReadonlySet<string>>(() => new Set())

  // The activation edge reads once, so a tab opened after a quiet minute is not stale.
  const wasActive = useRef(active)
  useEffect(() => {
    if (active && !wasActive.current) setOwnTick((tick) => tick + 1)
    wasActive.current = active
  }, [active])

  useDockRefresh({
    active,
    turnActive,
    whileHidden: true,
    pollWhileHidden: true,
    intervalMs: !active ? HIDDEN_POLL_MS : running > 0 ? POLL_MS : IDLE_POLL_MS,
    onRefresh: reread
  })

  // "started 4m ago" redraws from `startedAt` alone while one runs on screen.
  useEffect(() => {
    if (!active || running === 0) return
    const timer = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(timer)
  }, [active, running])

  // Reported on the edge, so a poll that finds the same rows does not re-render the whole session page.
  const reported = useRef<string | null>(null)
  useEffect(() => {
    const key = `${settled}:${rows.length}:${running}:${finished}:${failed}`
    if (reported.current === key) return
    reported.current = key
    onVerdictChange?.({ settled, count: rows.length, running, finished, failed })
  }, [failed, finished, onVerdictChange, rows.length, running, settled])

  const loadMore = useCallback(async () => {
    const cursor = current?.cursor
    if (!cursor || more.loading) return
    setMore({ scope, loading: true, failed: false })
    try {
      const page = await fetchAssistantSubsessions(agentId, {
        parentSessionId: sessionId,
        cursor,
        limit: SUBSESSIONS_PAGE
      })
      setList((prev) =>
        prev?.scope === scope && prev.cursor === cursor
          ? { ...prev, rows: [...prev.rows, ...page.subsessions], cursor: page.nextCursor }
          : prev
      )
      setMore({ scope, loading: false, failed: false })
    } catch {
      setMore({ scope, loading: false, failed: true })
    }
  }, [agentId, current?.cursor, more.loading, scope, sessionId])

  // The dock's own placeholder speaks until the first read answers; an empty conversation has no group at all.
  if (!settled || !subsessionsTabShown({ settled, count: rows.length, running, finished, failed })) return null

  // Running first, then by the latest word from each, so live work never falls past a group's fold.
  const sorted = runningFirst(rows, taskRunning, latestAt)
  // One Tasks group, with or without a thread (auto-session-mode.md §6.9.5); a getting-to-know task follows nothing, so it is listed there too.
  const watches = (row: AssistantSubsessionDto) => {
    const followUp = followUpOf(row)
    return followUp !== null && !followUp.gettingToKnow
  }
  const followUps = sorted.filter(watches)
  const tasks = sorted.filter((row) => !watches(row))
  const group = (id: string, title: string, members: AssistantSubsessionDto[]) => {
    if (members.length === 0) return null
    // A task with a thread never finishes, so only the others and follow-ups fold their ended rows away.
    const live = members.filter((row) => !taskFinished(row))
    const rest = members.filter(taskFinished)
    const folded = foldRows(live, rest, members.filter(taskRunning).length, foldOpen.has(`${scope}\n${id}`))
    const open = !closed.has(`${scope}\n${id}`)
    return (
      <LineGroup
        id={id}
        title={title}
        open={open}
        onToggle={() => setClosed((prev) => toggled(prev, `${scope}\n${id}`))}
      >
        {folded.rows.map((row, i) => (
          <SubsessionLine
            key={`${row.startedAt}:${row.sessionId ?? 'hidden'}:${i}`}
            row={row}
            now={now}
            stop={stopOf(row)}
            onStop={stop}
            {...(onOpenRoot && row.shownThreadId
              ? { onOpen: () => onOpenRoot(row.shownThreadId!) }
              : onOpenThread && row.threaded && row.sessionId
                ? { onOpen: () => onOpenThread({ title: row.title ?? '', sessionId: row.sessionId!, how: 'opened' }) }
                : {})}
          />
        ))}
        {folded.hidden > 0 ? (
          <FoldToggle
            hidden={folded.hidden}
            open={foldOpen.has(`${scope}\n${id}`)}
            onToggle={() => setFoldOpen((prev) => toggled(prev, `${scope}\n${id}`))}
          />
        ) : null}
      </LineGroup>
    )
  }

  return (
    <div data-subsessions-panel="" className="flex flex-none flex-col gap-2">
      {current?.error ? (
        <PanelNotice
          text={t(noticeKey(current.error.status, current.error.code))}
          warn={current.error.status !== 503}
        />
      ) : null}
      {group('tasks', tl('groups.tasks'), tasks)}
      {group('follow-ups', tl('groups.followUps'), followUps)}
      {/* Pages run by start time, so an older page can still hold open work. */}
      {current?.cursor ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" size="xs" disabled={more.loading} onClick={() => void loadMore()}>
            {t('more')}
          </Button>
          {more.failed ? (
            <span role="alert" className="font-sans text-[11.5px] font-normal leading-normal text-(--status-error)">
              {t('moreFailed')}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** The latest word from a task or follow-up: its newest reply, summary or check, else when it started. */
function latestAt(row: AssistantSubsessionDto): string {
  const followUp = followUpOf(row)
  return row.lastReplyAt ?? row.summaryUpdatedAt ?? followUp?.recentChecks[0]?.at ?? row.startedAt
}

function toggled(set: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(set)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  return next
}

/** One task or follow-up on one line: a threaded task opens its thread, others their page; Stop (End, confirmed, for a follow-up) shows on hover. */
function SubsessionLine({
  row,
  now,
  stop,
  onStop,
  onOpen
}: {
  row: AssistantSubsessionDto
  now: number
  stop: StopState | undefined
  onStop: (row: AssistantSubsessionDto) => Promise<void>
  onOpen?: () => void
}) {
  const t = useTranslations('Common.taskList')
  const tf = useTranslations('Common.followUp')
  const format = useFormatter()
  const shortTime = useShortTime()
  const { orgPath } = useOrgs()
  const [confirming, setConfirming] = useState(false)
  const followUp = followUpOf(row)
  const finished = taskFinished(row)
  const stoppable = row.state === 'open' && row.canStop && taskStopKey(row) !== null
  const name = row.title ?? t('untitled')
  const nextCheck =
    followUp?.status === 'waiting' && followUp.nextCheck
      ? tf('nextCheck', { time: shortTime(followUp.nextCheck) })
      : null
  // A follow-up's hover is the same wherever the pointer rests on its row: its name, its next check or state, and what counts as done.
  const tip = followUp
    ? [name, nextCheck ?? tf(`status.${followUp.status}`), followUp.doneWhen].filter(Boolean).join('\n')
    : name
  const title =
    row.sessionId && onOpen ? (
      <button
        type="button"
        data-task-open-thread=""
        title={tip}
        className="min-w-0 cursor-pointer truncate border-0 bg-transparent p-0 text-left font-[inherit] text-inherit after:absolute after:-inset-x-2 after:-inset-y-[6px] after:z-10"
        onClick={onOpen}
      >
        {name}
      </button>
    ) : row.sessionId ? (
      <Link
        title={tip}
        className="min-w-0 cursor-pointer truncate text-inherit no-underline after:absolute after:-inset-x-2 after:-inset-y-[6px] after:z-10"
        href={orgPath(`/sessions/${encodeURIComponent(row.sessionId)}`)}
      >
        {name}
      </Link>
    ) : row.visible && (followUp || row.state !== 'open') ? (
      <span title={tip} className="min-w-0 truncate after:absolute after:-inset-x-2 after:-inset-y-[6px] after:z-10">
        {name}
      </span>
    ) : row.visible ? (
      <span className="min-w-0 truncate font-normal text-(--text-secondary)">{t('starting')}</span>
    ) : (
      <span className="min-w-0 truncate font-normal text-(--text-tertiary)">{t('hidden')}</span>
    )
  // A task with a thread wears its platform's mark: its people read it there, and a getting-to-know task's introduction is there.
  const home = row.threaded || row.shownThreadId ? (row.parent?.platform ?? row.place?.platform ?? null) : null
  const at = latestAt(row)
  const ago =
    now - new Date(at).getTime() < 60_000 ? t('now') : format.relativeTime(new Date(at), { now, style: 'narrow' })
  // A finished row says when it ended, a live one how fresh its latest word is; a follow-up's time carries its row's hover.
  const time = finished ? shortTime(at) : ago
  const timeTip = followUp
    ? tip
    : finished
      ? t('finishedAt', { time: shortTime(at) })
      : ago === t('now')
        ? t('updatedNow')
        : t('lastUpdate', { time: ago })
  return (
    <LineRow
      state={taskTone(row, followUp)}
      stateLabel={followUp ? tf(`status.${followUp.status}`) : t(taskStateKey(row))}
      title={
        home ? (
          <>
            {title}
            <span data-task-home={home} className="ml-[6px] flex flex-none">
              <PlaceMark platform={home} />
            </span>
          </>
        ) : (
          title
        )
      }
      time={time}
      timeTip={timeTip}
      done={finished}
      attrs={{ 'data-subsession-row': row.state, 'data-follow-up': followUp?.status }}
      {...(stoppable && !confirming
        ? {
            stop: {
              label: followUp ? t('end') : t('stop'),
              disabled: stop === 'busy',
              onClick: () => (followUp ? setConfirming(true) : void onStop(row))
            }
          }
        : {})}
      note={
        confirming ? (
          <ConfirmStrip
            prompt={tf('endConfirm')}
            confirm={tf('end')}
            keep={tf('keep')}
            busy={stop === 'busy'}
            onConfirm={() => void onStop(row).then(() => setConfirming(false))}
            onKeep={() => setConfirming(false)}
          />
        ) : stop && stop !== 'busy' ? (
          <StopNote row={row} stop={stop} />
        ) : null
      }
    />
  )
}

function PanelNotice({ text, warn = false }: { text: string; warn?: boolean }) {
  return (
    <div className="flex items-start gap-2 px-[2px] font-sans text-[12px] font-normal leading-[1.55] text-(--text-secondary)">
      <Icon
        name={warn ? 'triangle-alert' : 'split'}
        size={14}
        color={warn ? 'var(--amber-500)' : 'var(--text-tertiary)'}
        className="mt-[2px] flex-none"
      />
      <span>{text}</span>
    </div>
  )
}
