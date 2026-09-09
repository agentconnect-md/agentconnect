'use client'

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { MemoryEntryCapabilities, MemoryEntryContent, MemoryEntrySummary } from '@agentconnect.md/protocol'
import {
  ApiError,
  describeAgentMemoryEntries,
  listAgentMemoryEntries,
  getAgentMemoryEntry,
  createAgentMemoryEntry,
  updateAgentMemoryEntry,
  deleteAgentMemoryEntry
} from '@/lib/api'
import { readCompleteMemoryEntry } from '@/lib/memory-entry-content'
import { Button } from '@/components/ui'

interface Props {
  agentId: string
  channelKey?: string
  canEdit: boolean
  children: ReactNode
  onOpenLegacy?: () => Promise<void>
}
export function UnifiedMemoryPanel(props: Props) {
  return <Entries key={`${props.agentId}:${props.channelKey ?? ''}`} {...props} />
}
function errorMessage(error: unknown) {
  if (error instanceof ApiError) {
    if (error.code === 'CONFLICT' || error.code === 'STALE_BINDING')
      return 'Memory changed. Your draft is kept; reload the saved version before editing again.'
    if (error.code === 'CURSOR_EXPIRED') return 'This list expired. Refresh memory to start again.'
    if (error.code === 'TOO_LARGE') return 'This change is too large to save here. Reduce its size and try again.'
    if (error.code === 'AMBIGUOUS_WRITE')
      return 'The change could not be confirmed. Check saved memory before making another change.'
    if (error.status === 403) return 'You no longer have permission to change this memory.'
    if (error.status === 503) return 'Memory is temporarily unavailable. Try loading it again.'
  }
  return error instanceof Error ? error.message : 'Memory is unavailable.'
}
function Entries({ agentId, channelKey, canEdit, children, onOpenLegacy }: Props) {
  const generation = useRef(0)
  const detailRequest = useRef(0)
  const [capabilities, setCapabilities] = useState<MemoryEntryCapabilities | null>(null)
  const [legacy, setLegacy] = useState(false)
  const [entries, setEntries] = useState<MemoryEntrySummary[]>([])
  const [cursor, setCursor] = useState<string>()
  const [busy, setBusy] = useState(true)
  const [reading, setReading] = useState(false)
  const [error, setError] = useState<string>()
  const [document, setDocument] = useState<MemoryEntryContent | null>(null)
  const [draft, setDraft] = useState('')
  const [label, setLabel] = useState('')
  const [mode, setMode] = useState<'create' | 'update' | null>(null)
  const [saving, setSaving] = useState(false)
  const [blocked, setBlocked] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [notice, setNotice] = useState<string>()
  const reload = useCallback(
    async (reconcileEmpty = false) => {
      const id = ++generation.current
      ++detailRequest.current
      setReading(false)
      setBusy(true)
      setError(undefined)
      try {
        const caps = await describeAgentMemoryEntries(agentId, channelKey)
        if (id !== generation.current) return
        if (!caps.operations.includes('list') || !caps.operations.includes('get')) {
          setLegacy(true)
          return
        }
        setCapabilities(caps)
        const page = await listAgentMemoryEntries(agentId, channelKey)
        if (id !== generation.current) return
        setEntries(page.entries)
        setCursor(page.nextCursor)
        if (reconcileEmpty && page.entries.length === 0 && !page.nextCursor) {
          setBlocked(false)
          setNotice(
            'No saved memory found. An earlier request may still complete; review your draft before saving again.'
          )
        }
      } catch (err) {
        if (id !== generation.current) return
        if (err instanceof ApiError && (err.status === 404 || err.status === 501 || err.code === 'UNSUPPORTED'))
          setLegacy(true)
        else setError(errorMessage(err))
      } finally {
        if (id === generation.current) setBusy(false)
      }
    },
    [agentId, channelKey]
  )
  useEffect(() => {
    void reload()
    return () => {
      generation.current++
      detailRequest.current++
    }
  }, [reload])
  async function more() {
    const id = generation.current
    setBusy(true)
    setError(undefined)
    try {
      const page = await listAgentMemoryEntries(agentId, channelKey, cursor)
      if (id !== generation.current) return
      setEntries((old) => [...old, ...page.entries])
      setCursor(page.nextCursor)
    } catch (err) {
      if (id === generation.current) setError(errorMessage(err))
    } finally {
      if (id === generation.current) setBusy(false)
    }
  }
  async function open(entry: MemoryEntrySummary) {
    const id = ++detailRequest.current
    setReading(true)
    setDocument(null)
    setError(undefined)
    setConfirmDelete(false)
    try {
      const result = await readCompleteMemoryEntry(
        (cursor) => getAgentMemoryEntry(agentId, entry.ref, channelKey, cursor),
        capabilities!.limits.maxItemBytes
      )
      if (id !== detailRequest.current) return
      setDocument(result)
      setMode(null)
      setDraft('')
      setBlocked(false)
      if (!result) setError('This memory no longer exists. Refresh the list.')
    } catch (err) {
      if (id === detailRequest.current) setError(errorMessage(err))
    } finally {
      if (id === detailRequest.current) setReading(false)
    }
  }
  const supports = (operation: 'create' | 'update' | 'delete') =>
    canEdit && capabilities?.operations.includes(operation)
  const editable =
    document?.entry.editable && (capabilities?.writeConsistency !== 'conditional' || !!document.entry.revision)
  const request =
    mode === 'create'
      ? { text: draft, ...(label.trim() ? { label: label.trim() } : {}) }
      : { ref: document?.entry.ref ?? '', revision: document?.entry.revision, text: draft }
  const tooLarge =
    !!capabilities &&
    (new TextEncoder().encode(draft).byteLength > capabilities.limits.maxItemBytes ||
      (capabilities.limits.maxMutationRequestBytes !== undefined &&
        new TextEncoder().encode(
          JSON.stringify({ agentId, ...(channelKey ? { channelKey } : {}), operation: mode, request })
        ).byteLength > capabilities.limits.maxMutationRequestBytes))
  async function mutate(remove = false) {
    const id = generation.current
    setSaving(true)
    setError(undefined)
    setNotice(undefined)
    try {
      if (remove)
        await deleteAgentMemoryEntry(
          agentId,
          { ref: document!.entry.ref, revision: document!.entry.revision },
          channelKey
        )
      else if (mode === 'create') await createAgentMemoryEntry(agentId, request, channelKey)
      else await updateAgentMemoryEntry(agentId, { ...request, ref: document!.entry.ref }, channelKey)
      if (id !== generation.current) return
      setMode(null)
      setDraft('')
      setDocument(null)
      setConfirmDelete(false)
      setNotice(remove ? 'Memory deleted. Inherited memory may now be visible.' : 'Memory saved.')
      await reload()
    } catch (err) {
      if (id !== generation.current) return
      const uncertain = !(err instanceof ApiError) || err.status >= 500
      setBlocked(uncertain || (err instanceof ApiError && (err.code === 'CONFLICT' || err.code === 'STALE_BINDING')))
      setError(
        uncertain
          ? 'The change could not be confirmed. Your draft is kept; check saved memory before making another change.'
          : errorMessage(err)
      )
    } finally {
      setSaving(false)
    }
  }
  async function openLegacy() {
    const id = generation.current
    setBusy(true)
    try {
      await onOpenLegacy?.()
      if (id === generation.current) setLegacy(true)
    } catch (err) {
      if (id === generation.current) setError(errorMessage(err))
    } finally {
      if (id === generation.current) setBusy(false)
    }
  }
  if (legacy)
    return (
      <>
        {capabilities && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setLegacy(false)
              void reload()
            }}
          >
            Memory entries
          </Button>
        )}
        {children}
      </>
    )
  return (
    <section
      className="rounded-lg border border-(--border-subtle) bg-(--surface-card) p-4 font-sans text-[13px] leading-normal"
      aria-label="Memory entries"
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="m-0 font-semibold">Memory</h3>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={busy || saving || (!!mode && !blocked)}
            onClick={() => void reload(blocked)}
          >
            Refresh
          </Button>
          {supports('create') && (
            <Button
              size="sm"
              disabled={busy || reading || saving || !!mode || blocked}
              onClick={() => {
                setMode('create')
                setDocument(null)
                setDraft('')
                setLabel('')
                setError(undefined)
              }}
            >
              New memory
            </Button>
          )}
          <Button variant="secondary" size="sm" disabled={busy || saving || !!mode} onClick={() => void openLegacy()}>
            More memory tools
          </Button>
        </div>
      </div>
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p role="alert" className="text-(--text-secondary)">
          {error}
        </p>
      )}
      <div className="grid gap-4 desktop:grid-cols-[240px_minmax(0,1fr)]">
        <div className="flex flex-col gap-2">
          {busy && <p role="status">Loading memory…</p>}
          {!busy && !error && entries.length === 0 && <p>No memory entries on this page.</p>}
          {entries.map((entry, index) => (
            <button
              key={`${entry.ref}:${index}`}
              className="rounded-sm border border-(--border-subtle) p-2 text-left text-(--text-primary) hover:bg-(--surface-hover) disabled:opacity-50"
              disabled={saving || (!!mode && !blocked)}
              onClick={() => void open(entry)}
            >
              <span className="block break-words font-semibold">{entry.label ?? 'Untitled memory'}</span>
              <span className="text-[11px] text-(--text-secondary)">
                {entry.origin === 'active' ? '' : 'Inherited · '}
                {entry.byteSize} bytes
              </span>
            </button>
          ))}
          {cursor && (
            <Button variant="secondary" size="sm" disabled={busy || saving} onClick={() => void more()}>
              Load more
            </Button>
          )}
        </div>
        <div className="min-w-0">
          {reading ? (
            <p role="status">Loading complete memory…</p>
          ) : mode ? (
            <>
              {mode === 'create' && (
                <label className="mb-2 block">
                  Name
                  <input
                    aria-label="Memory name"
                    value={label}
                    maxLength={512}
                    disabled={saving}
                    onChange={(e) => setLabel(e.target.value)}
                    className="mt-1 w-full rounded-sm border border-(--border-subtle) bg-(--surface-card) p-2"
                  />
                </label>
              )}
              <label className="block">
                Content
                <textarea
                  aria-label="Memory content"
                  value={draft}
                  disabled={saving}
                  onChange={(e) => setDraft(e.target.value)}
                  className="mt-1 min-h-64 w-full rounded-sm border border-(--border-subtle) bg-(--surface-card) p-2 font-mono text-[12px] leading-[1.5]"
                />
              </label>
              {tooLarge && <p role="alert">This change is too large to save here. Reduce its size.</p>}
              <div className="mt-2 flex flex-wrap gap-2">
                <Button
                  size="sm"
                  disabled={saving || blocked || tooLarge || !supports(mode === 'create' ? 'create' : 'update')}
                  onClick={() => void mutate()}
                >
                  {saving ? 'Saving…' : 'Save memory'}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={saving}
                  onClick={() => {
                    setMode(null)
                    setDraft('')
                  }}
                >
                  Cancel edit
                </Button>
                {blocked && document && (
                  <Button variant="secondary" size="sm" disabled={saving} onClick={() => void open(document.entry)}>
                    Reload saved version
                  </Button>
                )}
              </div>
            </>
          ) : document ? (
            <>
              <h4 className="mt-0 break-words">{document.entry.label ?? 'Memory'}</h4>
              <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-sm bg-(--surface-sunken) p-3 font-mono text-[12px] leading-[1.5]">
                {document.text}
              </pre>
              <div className="flex flex-wrap gap-2">
                {supports('update') && editable && (
                  <Button
                    size="sm"
                    disabled={saving || blocked}
                    onClick={() => {
                      setDraft(document.text)
                      setMode('update')
                      setError(undefined)
                    }}
                  >
                    Edit memory
                  </Button>
                )}
                {supports('delete') && editable && (
                  <Button
                    variant="danger"
                    size="sm"
                    disabled={saving || blocked}
                    onClick={() => setConfirmDelete(true)}
                  >
                    Delete memory
                  </Button>
                )}
              </div>
              {confirmDelete && (
                <div className="mt-3 rounded-sm border border-(--border-subtle) p-3">
                  <p>
                    Delete “{document.entry.label ?? 'this memory'}”? Deleting an override can reveal inherited memory.
                  </p>
                  <Button
                    variant="danger"
                    size="sm"
                    disabled={saving || blocked || !supports('delete')}
                    onClick={() => void mutate(true)}
                  >
                    Confirm deletion
                  </Button>
                  <Button variant="secondary" size="sm" disabled={saving} onClick={() => setConfirmDelete(false)}>
                    Keep memory
                  </Button>
                </div>
              )}
            </>
          ) : (
            <p className="text-(--text-secondary)">Select a memory to read its complete content.</p>
          )}
        </div>
      </div>
    </section>
  )
}
