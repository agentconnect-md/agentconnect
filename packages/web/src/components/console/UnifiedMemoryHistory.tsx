'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import type { MemoryEntryHistoryEvent, MemoryEntryHistoryResult } from '@agentconnect.md/protocol'
import { ApiError, listAgentMemoryEntryHistory } from '@/lib/api'
import { Button } from '@/components/ui'
import { LineDiff } from '@/components/console/LineDiff'

function kindLabel(kind: MemoryEntryHistoryEvent['kind']): 'created' | 'deleted' | 'updated' {
  if (kind === 'create') return 'created'
  if (kind === 'delete') return 'deleted'
  return 'updated'
}
function sourceLabel(source: MemoryEntryHistoryEvent['source']): 'console' | 'distill' | 'dream' | 'tool' | 'backend' {
  if (source === 'console') return 'console'
  if (source === 'distill') return 'distill'
  if (source === 'dream') return 'dream'
  if (source === 'tool') return 'tool'
  return 'backend'
}
function formatTime(value?: string): string {
  if (!value) return 'Time unknown'
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

function HistoryEvent({ event }: { event: MemoryEntryHistoryEvent }) {
  const t = useTranslations('Knowledge.memoryHistory')
  const [expanded, setExpanded] = useState(false)
  const diffable = event.before !== undefined || event.kind === 'create'
  return (
    <details
      className="rounded-md border border-(--border-subtle) bg-(--surface-card)"
      onToggle={(toggle) => setExpanded(toggle.currentTarget.open)}
    >
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 px-3 py-2">
        <span className="font-semibold">{t(`kinds.${kindLabel(event.kind)}`)}</span>
        <span className="rounded-full bg-(--surface-sunken) px-2 py-1 text-[10px] text-(--text-secondary)">
          {t(`sources.${sourceLabel(event.source)}`)}
        </span>
        <time className="text-[10.5px] text-(--text-tertiary)" dateTime={event.at}>
          {formatTime(event.at)}
        </time>
      </summary>
      {expanded ? (
        <div className="border-t border-(--border-subtle) p-3">
          {event.after === undefined && event.before === undefined ? (
            <p className="m-0 text-[11px] text-(--text-tertiary)">{t('noSnapshot')}</p>
          ) : diffable ? (
            <LineDiff before={event.before ?? ''} after={event.after ?? ''} />
          ) : (
            <pre className="m-0 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-sm bg-(--surface-sunken) p-3 font-mono text-[11px] leading-[1.5]">
              {event.after}
            </pre>
          )}
          {event.truncated ? (
            <p className="mb-0 mt-2 text-[10.5px] text-(--text-tertiary)">{t('longSnapshot')}</p>
          ) : null}
        </div>
      ) : null}
    </details>
  )
}

/** The console's audit view over one unified entry: bounded pages, never a claim of completeness beyond what the home keeps. */
export function UnifiedMemoryHistory({
  agentId,
  entryRef,
  channelKey
}: {
  agentId: string
  entryRef: string
  channelKey?: string
}) {
  const t = useTranslations('Knowledge.memoryHistory')
  const request = useRef(0)
  const [events, setEvents] = useState<MemoryEntryHistoryEvent[] | null>(null)
  const [order, setOrder] = useState<MemoryEntryHistoryResult['order']>('newest-first')
  const [nextCursor, setNextCursor] = useState<string>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()

  const load = useCallback(
    async (cursor?: string) => {
      const id = ++request.current
      setLoading(true)
      setError(undefined)
      try {
        const page = await listAgentMemoryEntryHistory(agentId, entryRef, channelKey, cursor)
        if (id !== request.current) return
        setEvents((current) => (cursor ? [...(current ?? []), ...page.events] : page.events))
        setOrder(page.order)
        setNextCursor(page.nextCursor)
      } catch (caught) {
        if (id !== request.current) return
        setError(
          caught instanceof ApiError && caught.status === 503
            ? 'Change history is temporarily unavailable.'
            : caught instanceof Error
              ? caught.message
              : 'Change history is unavailable.'
        )
      } finally {
        if (id === request.current) setLoading(false)
      }
    },
    [agentId, entryRef, channelKey]
  )
  useEffect(() => {
    setEvents(null)
    setNextCursor(undefined)
    void load()
    return () => {
      request.current += 1
    }
  }, [load])

  return (
    <section className="mt-3 flex flex-col gap-2" aria-label={t('changeHistory')} aria-live="polite">
      {loading && events === null ? <p role="status">{t('loading')}</p> : null}
      {error ? (
        <p role="alert" className="text-(--text-secondary)">
          {error}
        </p>
      ) : null}
      {events?.length === 0 ? <p className="text-(--text-tertiary)">{t('noChanges')}</p> : null}
      {events?.map((event, index) => (
        <HistoryEvent key={event.id ?? `${event.at ?? ''}:${event.kind}:${index}`} event={event} />
      ))}
      {events?.length ? (
        <p className="m-0 text-[10.5px] text-(--text-tertiary)">
          {order === 'newest-first' ? t('newestFirst') : t('backendOrder')} {t('onlyHomeKeeps')}
        </p>
      ) : null}
      {nextCursor ? (
        <div>
          <Button size="sm" variant="secondary" disabled={loading} onClick={() => void load(nextCursor)}>
            {loading ? t('loading') : t('loadOlder')}
          </Button>
        </div>
      ) : null}
    </section>
  )
}
