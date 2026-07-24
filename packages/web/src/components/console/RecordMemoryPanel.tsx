'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import {
  ApiError,
  createMemoryRecord,
  deleteMemoryRecord,
  fetchMemoryAdminSurface,
  getMemoryRecord,
  listMemoryRecordHistory,
  listMemoryRecords,
  searchMemoryRecords,
  updateMemoryRecord,
  type CanonicalMemoryRecordDto,
  type MemoryAdminSurfaceDto,
  type MemoryRecordHistoryEventDto
} from '@/lib/api'
import { Spinner } from '@/components/marks'
import { Button } from '@/components/ui'

function timestamp(record: CanonicalMemoryRecordDto): string | null {
  return record.updatedAt ?? record.createdAt ?? null
}

function formatTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function message(error: unknown): string {
  if (error instanceof ApiError && error.status === 503) return 'The owning daemon or memory plugin is unavailable.'
  return error instanceof Error ? error.message : String(error)
}

/** Capability-driven canonical-record console for an external memory provider. */
export function RecordMemoryPanel({ agentId, canEdit }: { agentId: string; canEdit: boolean }) {
  const request = useRef(0)
  const recordsRequest = useRef(0)
  const detailRequest = useRef(0)
  const historyRequest = useRef(0)
  const [surface, setSurface] = useState<MemoryAdminSurfaceDto | null>(null)
  const [records, setRecords] = useState<CanonicalMemoryRecordDto[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [selected, setSelected] = useState<CanonicalMemoryRecordDto | null>(null)
  const [editing, setEditing] = useState<'create' | 'update' | null>(null)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [mutationError, setMutationError] = useState<string | null>(null)
  const [history, setHistory] = useState<MemoryRecordHistoryEventDto[] | null>(null)
  const [historyNextCursor, setHistoryNextCursor] = useState<string | null>(null)
  const [historyLoading, setHistoryLoading] = useState(false)

  const capabilities = useMemo(() => new Set(surface?.capabilities ?? []), [surface])

  const loadList = useCallback(
    async (cursor?: string, append = false) => {
      const generation = request.current
      const id = ++recordsRequest.current
      if (append) setLoadingMore(true)
      else {
        setLoading(true)
        setLoadingMore(false)
        setSearching(false)
        setSelected(null)
        setHistory(null)
        setHistoryNextCursor(null)
        detailRequest.current += 1
        historyRequest.current += 1
      }
      setError(null)
      try {
        const page = await listMemoryRecords(agentId, { ...(cursor ? { cursor } : {}), limit: 20 })
        if (generation !== request.current || id !== recordsRequest.current) return
        setRecords((current) => (append ? [...current, ...page.records] : page.records))
        setNextCursor(page.nextCursor)
      } catch (cause) {
        if (generation !== request.current || id !== recordsRequest.current) return
        setError(message(cause))
      } finally {
        if (generation === request.current && id === recordsRequest.current) {
          setLoading(false)
          setLoadingMore(false)
        }
      }
    },
    [agentId]
  )

  const loadSurface = useCallback(async () => {
    const id = ++request.current
    setLoading(true)
    setError(null)
    setSurface(null)
    setRecords([])
    setNextCursor(null)
    setQuery('')
    setSelected(null)
    setHistory(null)
    setHistoryNextCursor(null)
    setSearching(false)
    setLoadingMore(false)
    setSaving(false)
    setHistoryLoading(false)
    setEditing(null)
    setDraft('')
    setMutationError(null)
    recordsRequest.current += 1
    detailRequest.current += 1
    historyRequest.current += 1
    try {
      const next = await fetchMemoryAdminSurface(agentId)
      if (id !== request.current) return
      setSurface(next)
      if (next.shape !== 'records') {
        setLoading(false)
        return
      }
      if (next.capabilities.includes('list')) await loadList()
      else setLoading(false)
    } catch (cause) {
      if (id !== request.current) return
      setError(message(cause))
      setLoading(false)
    }
  }, [agentId, loadList])

  useEffect(() => {
    void loadSurface()
    return () => {
      request.current += 1
      recordsRequest.current += 1
      detailRequest.current += 1
      historyRequest.current += 1
    }
  }, [loadSurface])

  const search = async (event: FormEvent) => {
    event.preventDefault()
    const text = query.trim()
    if (!text || searching) return
    const generation = request.current
    const id = ++recordsRequest.current
    setSearching(true)
    setLoading(false)
    setLoadingMore(false)
    setError(null)
    try {
      const page = await searchMemoryRecords(agentId, text, { topK: 20, maxBytes: 32768 })
      if (generation !== request.current || id !== recordsRequest.current) return
      setRecords(page.records)
      setNextCursor(null)
      setSelected(null)
      setHistory(null)
      setHistoryNextCursor(null)
      detailRequest.current += 1
      historyRequest.current += 1
      setHistoryLoading(false)
    } catch (cause) {
      if (generation !== request.current || id !== recordsRequest.current) return
      setError(message(cause))
    } finally {
      if (generation === request.current && id === recordsRequest.current) setSearching(false)
    }
  }

  const choose = async (record: CanonicalMemoryRecordDto) => {
    const id = ++detailRequest.current
    historyRequest.current += 1
    setSelected(record)
    setHistory(null)
    setHistoryNextCursor(null)
    setHistoryLoading(false)
    setMutationError(null)
    setEditing(null)
    if (!capabilities.has('get')) return
    try {
      const current = await getMemoryRecord(agentId, record.id)
      if (id !== detailRequest.current) return
      if (current) setSelected(current)
    } catch (cause) {
      if (id !== detailRequest.current) return
      setMutationError(message(cause))
    }
  }

  const save = async () => {
    const text = draft.trim()
    if (!text || !editing || saving) return
    const id = request.current
    const detailId = detailRequest.current
    setSaving(true)
    setMutationError(null)
    try {
      const record =
        editing === 'create'
          ? await createMemoryRecord(agentId, { text })
          : await updateMemoryRecord(agentId, selected!.id, {
              text,
              ...(selected?.version ? { version: selected.version } : {})
            })
      if (id !== request.current || detailId !== detailRequest.current) return
      setRecords((current) => {
        const index = current.findIndex((item) => item.id === record.id)
        if (index < 0) return [record, ...current]
        return current.map((item) => (item.id === record.id ? record : item))
      })
      setSelected(record)
      setEditing(null)
      setDraft('')
    } catch (cause) {
      if (id !== request.current || detailId !== detailRequest.current) return
      setMutationError(
        cause instanceof ApiError && cause.status === 409
          ? 'This record changed since it was opened. Refresh it before saving.'
          : message(cause)
      )
    } finally {
      if (id === request.current) setSaving(false)
    }
  }

  const remove = async () => {
    if (!selected || saving || !window.confirm('Delete this durable memory record?')) return
    const id = request.current
    const detailId = detailRequest.current
    setSaving(true)
    setMutationError(null)
    try {
      const result = await deleteMemoryRecord(agentId, selected.id, selected.version)
      if (id !== request.current || detailId !== detailRequest.current) return
      if (result.deleted) {
        setRecords((current) => current.filter((record) => record.id !== selected.id))
        setSelected(null)
        setHistory(null)
        setHistoryNextCursor(null)
      }
    } catch (cause) {
      if (id !== request.current || detailId !== detailRequest.current) return
      setMutationError(
        cause instanceof ApiError && cause.status === 409
          ? 'This record changed since it was opened. Refresh it before deleting.'
          : message(cause)
      )
    } finally {
      if (id === request.current) setSaving(false)
    }
  }

  const loadHistory = async (cursor?: string, append = false) => {
    if (!selected || historyLoading) return
    const id = ++historyRequest.current
    const recordId = selected.id
    setHistoryLoading(true)
    setMutationError(null)
    try {
      const page = await listMemoryRecordHistory(agentId, recordId, { ...(cursor ? { cursor } : {}), limit: 20 })
      if (id !== historyRequest.current) return
      setHistory((current) => (append && current ? [...current, ...page.events] : page.events))
      setHistoryNextCursor(page.nextCursor)
    } catch (cause) {
      if (id !== historyRequest.current) return
      setMutationError(message(cause))
    } finally {
      if (id === historyRequest.current) setHistoryLoading(false)
    }
  }

  if (loading && !surface) {
    return (
      <div className="mt-4 flex items-center justify-center rounded-md border border-(--border-subtle) py-8">
        <Spinner />
      </div>
    )
  }

  if (surface?.shape !== 'records') {
    return (
      <div className="mt-4 rounded-md border border-(--border-subtle) p-4 text-[12.5px] text-(--text-secondary)">
        {error ?? 'The selected backend does not currently expose a record administration surface.'}
      </div>
    )
  }

  return (
    <div className="mt-4 rounded-(--radius-lg) border border-(--border-subtle)">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-(--border-subtle) px-4 py-3">
        <div>
          <div className="text-[13px] font-semibold text-(--text-primary)">Memory records</div>
          <div className="mt-0.5 text-[11px] text-(--text-tertiary)">
            Canonical records are proxied live; AgentConnect does not store their bodies in the control plane.
          </div>
        </div>
        {canEdit && capabilities.has('create') ? (
          <Button
            size="xs"
            onClick={() => {
              setEditing('create')
              setDraft('')
              setMutationError(null)
            }}
          >
            New record
          </Button>
        ) : null}
      </div>

      {capabilities.has('recall') ? (
        <form className="flex gap-2 border-b border-(--border-subtle) p-3" onSubmit={(event) => void search(event)}>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search durable memory…"
            className="min-w-0 flex-1 rounded-md border border-(--border-subtle) bg-(--surface-sunken) px-3 py-2 text-[12.5px] outline-none focus:border-(--brand-soft-text)"
          />
          <Button type="submit" size="sm" variant="secondary" disabled={!query.trim() || searching}>
            {searching ? 'Searching…' : 'Search'}
          </Button>
          {capabilities.has('list') && query ? (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => {
                setQuery('')
                void loadList()
              }}
            >
              Clear
            </Button>
          ) : null}
        </form>
      ) : null}

      {editing ? (
        <div className="border-b border-(--border-subtle) p-4">
          <div className="mb-2 text-[12px] font-semibold">{editing === 'create' ? 'New record' : 'Edit record'}</div>
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            className="min-h-28 w-full resize-y rounded-md border border-(--border-subtle) bg-(--surface-sunken) p-3 text-[12.5px] leading-[1.55] outline-none focus:border-(--brand-soft-text)"
            placeholder="A concise, durable fact or decision…"
          />
          {mutationError ? <div className="mt-2 text-[12px] text-(--red-600)">{mutationError}</div> : null}
          <div className="mt-3 flex gap-2">
            <Button size="sm" disabled={saving || !draft.trim()} onClick={() => void save()}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
            <Button size="sm" variant="secondary" disabled={saving} onClick={() => setEditing(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      {error ? (
        <div className="p-4 text-[12.5px] text-(--red-600)">
          {error}{' '}
          <button type="button" className="lnk" onClick={() => void loadSurface()}>
            Retry
          </button>
        </div>
      ) : records.length === 0 ? (
        <div className="p-5 text-[12.5px] text-(--text-tertiary)">
          {capabilities.has('list') ? 'No memory records yet.' : 'This backend supports search but not record listing.'}
        </div>
      ) : (
        <div className="grid min-h-64 desktop:grid-cols-[minmax(220px,0.8fr)_minmax(0,1.4fr)]">
          <div className="max-h-[520px] overflow-auto border-b border-(--border-subtle) desktop:border-r desktop:border-b-0">
            {records.map((record) => (
              <button
                key={record.id}
                type="button"
                onClick={() => void choose(record)}
                className={`block w-full border-0 border-b border-(--border-subtle) px-4 py-3 text-left last:border-b-0 ${
                  selected?.id === record.id ? 'bg-(--surface-sunken)' : 'bg-transparent hover:bg-(--surface-hover)'
                }`}
              >
                <div className="line-clamp-3 text-[12.5px] leading-[1.45] text-(--text-primary)">{record.text}</div>
                <div className="mt-1.5 truncate font-mono text-[10px] text-(--text-tertiary)">{record.id}</div>
              </button>
            ))}
            {nextCursor ? (
              <div className="p-3 text-center">
                <Button
                  size="xs"
                  variant="secondary"
                  disabled={loadingMore}
                  onClick={() => void loadList(nextCursor, true)}
                >
                  {loadingMore ? 'Loading…' : 'Load more'}
                </Button>
              </div>
            ) : null}
          </div>

          <div className="min-w-0 p-4">
            {!selected ? (
              <div className="py-8 text-center text-[12.5px] text-(--text-tertiary)">
                Select a record to inspect it.
              </div>
            ) : (
              <>
                <div className="whitespace-pre-wrap text-[13px] leading-[1.6] text-(--text-primary)">
                  {selected.text}
                </div>
                <dl className="mt-4 grid grid-cols-[72px_minmax(0,1fr)] gap-x-3 gap-y-2 text-[11px]">
                  <dt className="text-(--text-tertiary)">ID</dt>
                  <dd className="break-all font-mono text-(--text-secondary)">{selected.id}</dd>
                  <dt className="text-(--text-tertiary)">Scope</dt>
                  <dd className="break-all font-mono text-(--text-secondary)">
                    {selected.scope.kind} · {selected.scope.key}
                  </dd>
                  {timestamp(selected) ? (
                    <>
                      <dt className="text-(--text-tertiary)">Updated</dt>
                      <dd className="text-(--text-secondary)">{formatTime(timestamp(selected)!)}</dd>
                    </>
                  ) : null}
                  {selected.version ? (
                    <>
                      <dt className="text-(--text-tertiary)">Version</dt>
                      <dd className="break-all font-mono text-(--text-secondary)">{selected.version}</dd>
                    </>
                  ) : null}
                </dl>
                {selected.metadata && Object.keys(selected.metadata).length ? (
                  <pre className="mt-4 max-h-40 overflow-auto rounded-md bg-(--surface-sunken) p-3 text-[10.5px] text-(--text-secondary)">
                    {JSON.stringify(selected.metadata, null, 2)}
                  </pre>
                ) : null}
                {mutationError && !editing ? (
                  <div className="mt-3 text-[12px] text-(--red-600)">{mutationError}</div>
                ) : null}
                <div className="mt-4 flex flex-wrap gap-2">
                  {canEdit && capabilities.has('update') ? (
                    <Button
                      size="xs"
                      variant="secondary"
                      onClick={() => {
                        setDraft(selected.text)
                        setEditing('update')
                        setMutationError(null)
                      }}
                    >
                      Edit
                    </Button>
                  ) : null}
                  {canEdit && capabilities.has('delete') ? (
                    <Button size="xs" variant="secondary" disabled={saving} onClick={() => void remove()}>
                      Delete
                    </Button>
                  ) : null}
                  {capabilities.has('history') ? (
                    <Button size="xs" variant="secondary" disabled={historyLoading} onClick={() => void loadHistory()}>
                      {historyLoading ? 'Loading history…' : 'History'}
                    </Button>
                  ) : null}
                </div>
                {history ? (
                  <div className="mt-4 border-t border-(--border-subtle) pt-3">
                    <div className="mb-2 text-[11px] font-semibold text-(--text-secondary)">History</div>
                    {history.length === 0 ? (
                      <div className="text-[11.5px] text-(--text-tertiary)">No history events.</div>
                    ) : (
                      <div className="flex flex-col gap-2">
                        {history.map((event) => (
                          <div key={event.id} className="rounded-md bg-(--surface-sunken) px-3 py-2 text-[11px]">
                            <span className="font-semibold">{event.event}</span>
                            <span className="ml-2 text-(--text-tertiary)">{formatTime(event.at)}</span>
                            {event.record?.text ? (
                              <div className="mt-1 line-clamp-2 text-(--text-secondary)">{event.record.text}</div>
                            ) : null}
                          </div>
                        ))}
                        {historyNextCursor ? (
                          <div className="pt-1">
                            <Button
                              size="xs"
                              variant="secondary"
                              disabled={historyLoading}
                              onClick={() => void loadHistory(historyNextCursor, true)}
                            >
                              {historyLoading ? 'Loading…' : 'Load more history'}
                            </Button>
                          </div>
                        ) : null}
                      </div>
                    )}
                  </div>
                ) : null}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
