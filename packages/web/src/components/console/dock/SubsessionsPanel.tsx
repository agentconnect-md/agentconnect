'use client'

// The dock's Sub-sessions tab (assistant-mode.md §1.3, §5.6): the background sub-sessions this conversation opened, read from the agent's daemon through the CP and kept nowhere else.
// Each row links to its own session page where the reader may open it; Stop interrupts its current turn exactly as the composer's stop would, and undoes nothing it already did.

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useFormatter, useTranslations } from 'next-intl'
import { Spinner } from '@/components/marks'
import { Button, Icon } from '@/components/ui'
import { useDockRefresh } from '@/components/console/dock/auto-refresh'
import {
  ApiError,
  fetchAssistantSubsessions,
  stopAssistantSubsession,
  type AssistantSubsessionDto,
  type AssistantSubsessionsPageDto
} from '@/lib/api'
import { useOrgs } from '@/lib/org-context'
import type { DockTabStatus } from './SessionDock'

/** Rows one read asks for; "Show more" pages on by the cursor the last one returned. */
export const SUBSESSIONS_PAGE = 20

/** The listing route's own cap on one page, which a refresh asks for at most. */
const SUBSESSIONS_READ_MAX = 50

/** Re-read cadence while one runs, while none does, and while the tab is not the selected one. */
const POLL_MS = 5_000
const IDLE_POLL_MS = 20_000
// A hidden panel still reads, slowly: its verdict is what puts the tab in the strip once the conversation opens its first one.
const HIDDEN_POLL_MS = 60_000

/** What the tab needs from the panel; the caller owns the descriptor, as for every dock tab. */
export interface SubsessionsPanelVerdict {
  /** The first read of this conversation has answered. */
  settled: boolean
  /** Rows on screen; 0 drops the tab. */
  count: number
  /** Running rows on screen, for the badge. */
  running: number
  /** The read failed with nothing to show, so the tab stays to say why. */
  failed: boolean
}

export const SUBSESSIONS_UNSETTLED: SubsessionsPanelVerdict = { settled: false, count: 0, running: 0, failed: false }

/** Offered once the conversation has opened one, or when the read failed and the tab has to say why. */
export function subsessionsTabShown(verdict: SubsessionsPanelVerdict): boolean {
  return verdict.settled && (verdict.failed || verdict.count > 0)
}

type StopState = 'busy' | 'stopped' | 'not_running' | 'failed' | 'upgrade'

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
  onVerdictChange
}: {
  agentId: string
  /** The conversation's own session: only the sub-sessions it opened are listed. */
  sessionId: string
  /** Whether this tab is the selected one; a hidden panel reads slowly. */
  active?: boolean
  /** A turn streaming in this conversation; its falling edge is where a delegation lands. */
  turnActive?: boolean
  /** Bumped by the tab's refresh action. */
  refreshTick?: number
  onVerdictChange?: (verdict: SubsessionsPanelVerdict) => void
}) {
  const t = useTranslations('Sessions.detail.subsessionsPanel')
  const scope = `${agentId}\n${sessionId}`
  const [ownTick, setOwnTick] = useState(0)
  const [list, setList] = useState<ListState | null>(null)
  const [stops, setStops] = useState<{ scope: string; byId: Record<string, StopState> }>({ scope, byId: {} })
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
  const running = rows.filter((row) => row.state === 'open').length
  const settled = current !== null
  const failed = current?.error != null && rows.length === 0
  const stopById = stops.scope === scope ? stops.byId : {}

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
    onRefresh: () => setOwnTick((tick) => tick + 1)
  })

  // Reported on the edge, so a poll that finds the same rows does not re-render the whole session page.
  const reported = useRef<string | null>(null)
  useEffect(() => {
    const key = `${settled}:${rows.length}:${running}:${failed}`
    if (reported.current === key) return
    reported.current = key
    onVerdictChange?.({ settled, count: rows.length, running, failed })
  }, [failed, onVerdictChange, rows.length, running, settled])

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

  const stop = useCallback(
    async (id: string) => {
      const mark = (state: StopState) =>
        setStops((prev) => ({ scope, byId: { ...(prev.scope === scope ? prev.byId : {}), [id]: state } }))
      mark('busy')
      try {
        mark((await stopAssistantSubsession(agentId, id)).result)
      } catch (e) {
        mark(e instanceof ApiError && e.code === 'DAEMON_FEATURE_MISSING' ? 'upgrade' : 'failed')
      }
      setOwnTick((tick) => tick + 1)
    },
    [agentId, scope]
  )

  // The dock's own placeholder speaks until the first read answers.
  if (!settled) return null

  return (
    <div data-subsessions-panel="" className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col gap-[6px] overflow-auto px-3 py-[10px]">
        {current?.error ? (
          <PanelNotice
            text={t(noticeKey(current.error.status, current.error.code))}
            warn={current.error.status !== 503}
          />
        ) : null}
        {rows.length === 0 && !current?.error ? <PanelNotice text={t('empty')} /> : null}
        {rows.map((row, i) => (
          <SubsessionRow
            key={`${row.startedAt}:${row.sessionId ?? 'hidden'}:${i}`}
            row={row}
            stop={row.sessionId ? stopById[row.sessionId] : undefined}
            onStop={stop}
          />
        ))}
        {current?.cursor ? (
          <div className="flex flex-wrap items-center gap-2 pt-1">
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
    </div>
  )
}

const ACCENT: Record<AssistantSubsessionDto['state'], string> = {
  open: 'var(--status-info)',
  done: 'var(--status-online)',
  failed: 'var(--red-600)'
}

// Every side named, as on the Tasks rows, so which left colour wins never depends on emit order.
const BORDER: Record<AssistantSubsessionDto['state'], string> = {
  open: 'border-l-(--status-info)',
  done: 'border-l-(--status-online)',
  failed: 'border-l-(--red-600)'
}

const STOP_RESULT: Record<Exclude<StopState, 'busy'>, 'stopped' | 'notRunning' | 'stopFailed' | 'upgradeDaemon'> = {
  stopped: 'stopped',
  not_running: 'notRunning',
  failed: 'stopFailed',
  upgrade: 'upgradeDaemon'
}

function SubsessionRow({
  row,
  stop,
  onStop
}: {
  row: AssistantSubsessionDto
  stop: StopState | undefined
  onStop: (sessionId: string) => Promise<void>
}) {
  const t = useTranslations('Sessions.detail.subsessionsPanel')
  const format = useFormatter()
  const { orgPath } = useOrgs()
  const runningNow = row.state === 'open'
  const stoppable = runningNow && row.canStop && row.sessionId !== null
  return (
    <div
      data-subsession-row={row.state}
      className={`flex flex-none flex-col gap-[5px] rounded-md border-y border-r border-l-2 border-y-(--border-subtle) border-r-(--border-subtle) bg-(--surface-card) px-[10px] py-2 ${BORDER[row.state]}`}
    >
      <div className="flex min-w-0 items-center gap-2">
        {runningNow ? (
          <span className="flex flex-none items-center">
            <Spinner size={12} />
          </span>
        ) : (
          <Icon
            name={row.state === 'failed' ? 'circle-x' : 'circle-check'}
            size={13}
            color={ACCENT[row.state]}
            className="flex-none"
          />
        )}
        <span className="min-w-0 flex-1 truncate font-sans text-[12.5px] font-medium leading-normal">
          {row.sessionId ? (
            <Link
              className="lnk"
              href={orgPath(`/sessions/${encodeURIComponent(row.sessionId)}`)}
              title={row.title ?? undefined}
            >
              {row.title ?? t('untitled')}
            </Link>
          ) : row.visible ? (
            <span className="font-normal text-(--text-secondary)">{t('starting')}</span>
          ) : (
            <span className="inline-flex items-center gap-[6px] font-normal text-(--text-tertiary)">
              <Icon name="lock" size={12} />
              {t('hidden')}
            </span>
          )}
        </span>
        {stoppable ? (
          <Button
            variant="secondary"
            size="xs"
            className="flex-none"
            disabled={stop === 'busy'}
            onClick={() => void onStop(row.sessionId!)}
          >
            <Icon name="square" size={11} />
            {t('stop')}
          </Button>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-x-2 pl-[21px] font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
        <span data-subsession-state="">{t(`state.${row.state}`)}</span>
        <span aria-hidden="true">·</span>
        <time dateTime={row.startedAt}>
          {t('started', {
            time: format.dateTime(new Date(row.startedAt), { dateStyle: 'medium', timeStyle: 'short' })
          })}
        </time>
      </div>
      {stop && stop !== 'busy' ? (
        <div
          role="status"
          data-subsession-stop={stop}
          className={`pl-[21px] font-sans text-[11.5px] font-normal leading-normal ${
            stop === 'failed' || stop === 'upgrade' ? 'text-(--status-error)' : 'text-(--text-secondary)'
          }`}
        >
          {t(STOP_RESULT[stop])}
        </div>
      ) : null}
    </div>
  )
}

function PanelNotice({ text, warn = false }: { text: string; warn?: boolean }) {
  return (
    <div className="flex items-start gap-2 px-3 py-[10px] font-sans text-[12px] font-normal leading-[1.55] text-(--text-secondary)">
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

export function subsessionsTabStatus(settled: boolean): DockTabStatus {
  return settled ? 'ready' : 'loading'
}
