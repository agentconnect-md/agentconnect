'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, listMemoryFileHistory, type MemoryFileHistoryEventDto } from '@/lib/api'
import { Spinner } from '@/components/marks'
import { Button, Icon } from '@/components/ui'
import { LineDiff } from '@/components/console/LineDiff'

const PAGE_SIZE = 5

function formatHistoryTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

function eventLabel(event: MemoryFileHistoryEventDto['event']): string {
  if (event === 'add') return 'Created'
  if (event === 'delete') return 'Deleted'
  return 'Updated'
}

function sourceLabel(source: MemoryFileHistoryEventDto['source']): string {
  if (source === 'console') return 'Console'
  if (source === 'distill') return 'Automatic distillation'
  if (source === 'dream') return 'Dream adoption'
  return 'Agent tool'
}

function Snapshot({ label, value, tone }: { label: string; value: string; tone: 'before' | 'after' }) {
  return (
    <div className="min-w-0 overflow-hidden rounded-md border border-(--border-subtle)">
      <div
        className={`border-b border-(--border-subtle) px-3 py-2 font-sans text-[10.5px] font-semibold leading-normal ${
          tone === 'before'
            ? 'bg-(--status-error-soft) text-(--red-600)'
            : 'bg-(--status-online-soft) text-(--green-500)'
        }`}
      >
        {label}
      </div>
      <pre className="mono m-0 max-h-64 min-h-14 overflow-auto whitespace-pre-wrap break-words bg-(--surface-sunken) p-3 text-[11px] leading-[1.55] text-(--text-secondary)">
        {value || '(empty)'}
      </pre>
    </div>
  )
}

function HistoryEvent({ event }: { event: MemoryFileHistoryEventDto }) {
  const hasBefore = event.before !== undefined
  const canDiff = hasBefore || event.event === 'add'
  const [expanded, setExpanded] = useState(false)

  return (
    <details
      className="group rounded-md border border-(--border-subtle) bg-(--surface-card)"
      onToggle={(toggleEvent) => setExpanded(toggleEvent.currentTarget.open)}
    >
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 px-3 py-[10px] font-sans [&::-webkit-details-marker]:hidden">
        <Icon
          name="chevron-right"
          size={14}
          className="flex-none text-(--text-tertiary) transition-transform group-open:rotate-90"
        />
        <span className="text-[11.5px] font-semibold leading-normal text-(--text-primary)">
          {eventLabel(event.event)}
        </span>
        <span className="rounded-full bg-(--surface-sunken) px-2 py-1 text-[10px] font-medium leading-normal text-(--text-secondary)">
          {sourceLabel(event.source)}
        </span>
        <time
          className="ml-[22px] w-full text-left text-[10.5px] font-normal leading-normal text-(--text-tertiary) desktop:ml-auto desktop:w-auto desktop:text-right"
          dateTime={event.at}
        >
          {formatHistoryTime(event.at)}
        </time>
      </summary>
      {expanded ? (
        <div className="border-t border-(--border-subtle) p-3">
          {canDiff ? (
            <LineDiff before={event.before ?? ''} after={event.after} />
          ) : (
            <>
              <Snapshot label="After" value={event.after} tone="after" />
              <div className="mt-2 flex items-start gap-1.5 text-[10.5px] leading-[1.45] text-(--text-tertiary)">
                <Icon name="info" size={12} className="mt-px flex-none" />
                The before snapshot was not recorded for this older change.
              </div>
            </>
          )}
          {event.truncated ? (
            <div className="mt-2 flex items-start gap-1.5 text-[10.5px] leading-[1.45] text-(--text-tertiary)">
              <Icon name="info" size={12} className="mt-px flex-none" />
              Long snapshots were shortened when this change was recorded.
            </div>
          ) : null}
        </div>
      ) : null}
    </details>
  )
}

/** Read-only panel over managed memory's hidden `.history` sidecar; its summary action mounts this lazily. */
export function ManagedMemoryHistory({ agentId, path }: { agentId: string; path: string }) {
  const request = useRef(0)
  const [events, setEvents] = useState<MemoryFileHistoryEventDto[] | null>(null)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(
    async (cursor?: string, append = false) => {
      const id = ++request.current
      setLoading(true)
      setError(null)
      try {
        const page = await listMemoryFileHistory(agentId, path, { ...(cursor ? { cursor } : {}), limit: PAGE_SIZE })
        if (id !== request.current) return
        setEvents((current) => (append ? [...(current ?? []), ...page.events] : page.events))
        setNextCursor(page.nextCursor)
      } catch (caught) {
        if (id !== request.current) return
        setError(
          caught instanceof ApiError && caught.status === 503
            ? "Couldn't load change history — this agent is currently unavailable."
            : caught instanceof Error
              ? caught.message
              : String(caught)
        )
      } finally {
        if (id === request.current) setLoading(false)
      }
    },
    [agentId, path]
  )

  useEffect(() => {
    request.current += 1
    setEvents(null)
    setNextCursor(null)
    setLoading(false)
    setError(null)
    void load()
    return () => {
      request.current += 1
    }
  }, [load])

  return (
    <section
      className="flex flex-1 flex-col bg-(--surface-sunken) p-3"
      aria-label={`Change history for ${path}`}
      aria-live="polite"
    >
      {loading && events === null ? (
        <div className="flex items-center justify-center gap-2 py-6 text-[11.5px] text-(--text-tertiary)">
          <Spinner size={16} />
          Loading change history…
        </div>
      ) : error && events === null ? (
        <div className="flex flex-col items-start gap-2 py-3 text-[11.5px] text-(--red-600)" role="alert">
          <span>{error}</span>
          <Button size="xs" variant="secondary" onClick={() => void load()}>
            Retry
          </Button>
        </div>
      ) : events?.length === 0 ? (
        <div className="py-3 text-[11.5px] text-(--text-tertiary)">No recorded changes for this file yet.</div>
      ) : (
        <div className="flex flex-col gap-2">
          {events?.map((event, index) => (
            <HistoryEvent key={event.id ?? `${event.at}:${event.source}:${event.event}:${index}`} event={event} />
          ))}
          {error ? (
            <div className="flex flex-wrap items-center gap-2 py-1 text-[11.5px] text-(--red-600)" role="alert">
              <span>{error}</span>
              <Button size="xs" variant="secondary" onClick={() => void load(nextCursor ?? undefined, true)}>
                Retry
              </Button>
            </div>
          ) : null}
          {nextCursor && !error ? (
            <div className="pt-1">
              <Button size="xs" variant="secondary" disabled={loading} onClick={() => void load(nextCursor, true)}>
                {loading ? 'Loading…' : 'Load older changes'}
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </section>
  )
}
