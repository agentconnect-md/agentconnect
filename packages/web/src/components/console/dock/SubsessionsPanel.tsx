'use client'

// The Tasks tab's Tasks and Follow-ups groups (assistant-mode.md §1.3, §5.6, §5.12): this conversation's delegated tasks, approved proposals and follow-ups, read from the agent's daemon and kept nowhere else.
// Each row links to its own page where the reader may open it; Stop interrupts its current turn exactly as the composer's stop would, and undoes nothing it already did.

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button, Icon } from '@/components/ui'
import { useDockRefresh } from '@/components/console/dock/auto-refresh'
import {
  ApiError,
  fetchAssistantSubsessions,
  type AssistantSubsessionDto,
  type AssistantSubsessionsPageDto
} from '@/lib/api'
import { followUpOf, taskRunning } from '@/components/console/follow-up'
import { BackgroundTaskRow, TaskGroup, taskFinished, useTaskStops } from '@/components/console/task-list'

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
  showFinished = false,
  onVerdictChange
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
  /** The finished toggle is open, so finished rows are drawn dimmed in their groups. */
  showFinished?: boolean
  onVerdictChange?: (verdict: SubsessionsPanelVerdict) => void
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

  // Open rows lead each group; finished ones follow, dimmed, once the toggle is open.
  const shown = [...rows.filter((row) => !taskFinished(row)), ...(showFinished ? rows.filter(taskFinished) : [])]
  const followUps = shown.filter((row) => followUpOf(row) !== null)
  const tasks = shown.filter((row) => followUpOf(row) === null)
  const drawRow = (row: AssistantSubsessionDto, i: number) => (
    <BackgroundTaskRow
      key={`${row.startedAt}:${row.sessionId ?? 'hidden'}:${i}`}
      row={row}
      now={now}
      stop={stopOf(row)}
      onStop={stop}
      dim={taskFinished(row)}
    />
  )

  return (
    <div data-subsessions-panel="" className="flex flex-none flex-col gap-3">
      {current?.error ? (
        <PanelNotice
          text={t(noticeKey(current.error.status, current.error.code))}
          warn={current.error.status !== 503}
        />
      ) : null}
      {tasks.length > 0 ? (
        <TaskGroup id="tasks" title={tl('groups.tasks')} count={tasks.length}>
          {tasks.map(drawRow)}
        </TaskGroup>
      ) : null}
      {followUps.length > 0 ? (
        <TaskGroup id="follow-ups" title={tl('groups.followUps')} count={followUps.length}>
          {followUps.map(drawRow)}
        </TaskGroup>
      ) : null}
      {/* Older pages hold what finished long ago, so "Show more" sits with the finished rows. */}
      {current?.cursor && showFinished ? (
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
