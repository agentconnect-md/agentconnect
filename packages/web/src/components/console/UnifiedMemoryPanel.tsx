'use client'

import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import dynamic from 'next/dynamic'
import type {
  MemoryEntryCapabilities,
  MemoryEntryContent,
  MemoryEntryLink,
  MemoryEntrySearchHit,
  MemoryEntrySummary
} from '@agentconnect.md/protocol'
import {
  ApiError,
  describeAgentMemoryEntries,
  listAgentMemoryEntries,
  getAgentMemoryEntry,
  searchAgentMemoryEntries,
  createAgentMemoryEntry,
  updateAgentMemoryEntry,
  deleteAgentMemoryEntry
} from '@/lib/api'
import { readCompleteMemoryEntry } from '@/lib/memory-entry-content'
import { Spinner } from '@/components/marks'
import { Button, Icon } from '@/components/ui'
import { memoryFileFromHref } from '@/components/console/memory-links'
import { useSandboxWake, type SandboxReadState } from '@/components/console/sandbox-wake'
import {
  MEMORY_SANDBOX_ASLEEP_NOTICE,
  SandboxAsleepNotice,
  SandboxStartingNotice
} from '@/components/console/SandboxWakeNotice'
import { SANDBOX_ASLEEP_CODE } from '@/components/console/workspace-tree'
import { UnifiedMemoryHistory } from '@/components/console/UnifiedMemoryHistory'
import { resolveFileBrowserMarkdownLink } from '@/components/console/file-browser-links'
import {
  FileBrowserLayout,
  FileBrowserPreviewSummary,
  FileBrowserShell,
  formatFileMtime,
  formatFileSize
} from '@/components/console/FileBrowser'

// Loaded lazily like the file preview so react-markdown never ships in the main console bundle.
const MarkdownView = dynamic(() => import('@/components/console/MarkdownView'), {
  ssr: false,
  loading: () => <p className="text-(--text-tertiary)">Rendering…</p>
})

type MemoryView = 'entries' | 'legacy'
interface Props {
  agentId: string
  channelKey?: string
  canEdit: boolean
  // The retained raw view (files or records); it receives the view switch so the switch sits in its own header.
  children: (viewSwitch: ReactNode) => ReactNode
  // What the retained view is called in the switch: "Files" for a managed directory, "Records" for a plugin.
  legacyLabel?: string
  onOpenLegacy?: () => Promise<void>
  // The managed tree sits on a pool sandbox volume: a read refused as asleep presses the wake, like the file browser.
  sandboxed?: boolean
  // The generated overview (MEMORY.md), read through the compatibility route and shown read-only as a pinned row.
  overview?: OverviewSource
}
export interface OverviewFile {
  exists: boolean
  content: string
  mtime: string | null
}
export interface OverviewSource {
  read: () => Promise<OverviewFile>
  // A topic the overview links to, by filename, read through the same route; refs never name files, so it stays read-only.
  readTopic: (file: string) => Promise<OverviewFile>
}
// The daemon stamps this marker on every index it generates; anything else was written by hand and is kept as-is.
const GENERATED_OVERVIEW_MARKER = '<!-- generated from each topic'
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
// A Markdown link opens a sibling only through a ref the read already annotated; refs are never guessed.
function linkedRef(document: MemoryEntryContent, name: string): string | undefined {
  const label = name.replace(/\.md$/, '')
  return [...(document.links ?? []), ...(document.backlinks ?? [])].find((edge) => edge.ref && edge.label === label)
    ?.ref
}
function ViewSwitch({
  view,
  legacyLabel,
  disabled,
  onChange
}: {
  view: MemoryView
  legacyLabel: string
  disabled?: boolean
  onChange: (view: MemoryView) => void
}) {
  const cls = (on: boolean) => (on ? 'pill on px-[10px] py-[3px] text-[12px]' : 'pill px-[10px] py-[3px] text-[12px]')
  return (
    <div className="pillbar flex-none" role="group" aria-label="Memory view">
      <button
        type="button"
        className={cls(view === 'entries')}
        aria-pressed={view === 'entries'}
        disabled={disabled}
        onClick={() => onChange('entries')}
      >
        Entries
      </button>
      <button
        type="button"
        className={cls(view === 'legacy')}
        aria-pressed={view === 'legacy'}
        disabled={disabled}
        onClick={() => onChange('legacy')}
      >
        {legacyLabel}
      </button>
    </div>
  )
}
// A topic keeps its mono name like a file; a nameless record shows its opening text instead.
function EntryRow({
  entry,
  snippet,
  selected,
  disabled,
  onClick
}: {
  entry: MemoryEntrySummary
  snippet?: string
  selected: boolean
  disabled: boolean
  onClick: () => void
}) {
  const named = entry.format === 'markdown'
  const detail = named ? (snippet ?? entry.description) : undefined
  const trailing = entry.origin === 'inherited' ? 'inherited' : entry.updatedAt ? formatFileMtime(entry.updatedAt) : ''
  return (
    <button
      type="button"
      className={`file-browser-item flex w-full items-start gap-[6px] border-0 border-r-2 py-[6px] pl-2 pr-[10px] text-left [font:inherit] disabled:cursor-default disabled:opacity-60 ${
        selected ? 'border-r-(--brand) bg-(--brand-soft)' : 'border-r-transparent bg-transparent'
      }`}
      aria-current={selected ? 'page' : undefined}
      title={entry.description ?? (named ? entry.label : undefined)}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon
        name={named ? 'file-text' : 'sticky-note'}
        size={15}
        color="var(--text-tertiary)"
        className="mt-[2px] flex-none"
      />
      <span className="flex min-w-0 flex-1 flex-col gap-[2px]">
        <span
          className={
            named
              ? `mono truncate text-[12.5px] ${selected ? 'text-(--text-primary)' : 'text-(--text-secondary)'}`
              : `line-clamp-2 font-sans text-[12.5px] font-normal leading-[1.45] ${selected ? 'text-(--text-primary)' : 'text-(--text-secondary)'}`
          }
        >
          {entry.label || 'Untitled memory'}
        </span>
        {detail ? (
          <span className="line-clamp-2 font-sans text-[11.5px] font-normal leading-[1.4] text-(--text-tertiary)">
            {detail}
          </span>
        ) : null}
      </span>
      {trailing ? (
        <span className="flex-none pt-[1px] font-sans text-[11px] font-normal leading-normal text-(--text-tertiary)">
          {trailing}
        </span>
      ) : null}
    </button>
  )
}
function Entries({
  agentId,
  channelKey,
  canEdit,
  children,
  legacyLabel = 'Files',
  onOpenLegacy,
  sandboxed = false,
  overview
}: Props) {
  const generation = useRef(0)
  const detailRequest = useRef(0)
  const [capabilities, setCapabilities] = useState<MemoryEntryCapabilities | null>(null)
  const [legacy, setLegacy] = useState(false)
  const [entries, setEntries] = useState<MemoryEntrySummary[]>([])
  const [cursor, setCursor] = useState<string>()
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<MemoryEntrySearchHit[] | null>(null)
  const [searchNote, setSearchNote] = useState<string>()
  const [busy, setBusy] = useState(true)
  const [paging, setPaging] = useState(false)
  const [reading, setReading] = useState(false)
  const [selectedRef, setSelectedRef] = useState<string>()
  const [error, setError] = useState<string>()
  const [document, setDocument] = useState<MemoryEntryContent | null>(null)
  const [draft, setDraft] = useState('')
  const [label, setLabel] = useState('')
  const [mode, setMode] = useState<'create' | 'update' | null>(null)
  const [saving, setSaving] = useState(false)
  const [blocked, setBlocked] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [notice, setNotice] = useState<string>()
  const [errorCode, setErrorCode] = useState<string>()
  const [overviewOpen, setOverviewOpen] = useState(false)
  const [overviewBusy, setOverviewBusy] = useState(false)
  const [overviewDoc, setOverviewDoc] = useState<OverviewFile | null>(null)
  const [overviewTopic, setOverviewTopic] = useState<(OverviewFile & { file: string }) | null>(null)
  const [overviewTopicBusy, setOverviewTopicBusy] = useState(false)
  const overviewRequest = useRef(0)
  // A newer action outdates any overview read still in flight and takes its busy flag with it.
  const dropOverviewReads = () => {
    ++overviewRequest.current
    setOverviewBusy(false)
    setOverviewTopicBusy(false)
  }
  const reload = useCallback(
    async (reconcileEmpty = false) => {
      const id = ++generation.current
      ++detailRequest.current
      setReading(false)
      setBusy(true)
      setPaging(false)
      setError(undefined)
      setErrorCode(undefined)
      setHits(null)
      setSearchNote(undefined)
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
        else {
          setErrorCode(err instanceof ApiError ? err.code : undefined)
          setError(errorMessage(err))
        }
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
    setPaging(true)
    setError(undefined)
    try {
      const page = await listAgentMemoryEntries(agentId, channelKey, cursor)
      if (id !== generation.current) return
      setEntries((old) => [...old, ...page.entries])
      setCursor(page.nextCursor)
    } catch (err) {
      if (id === generation.current) setError(errorMessage(err))
    } finally {
      if (id === generation.current) setPaging(false)
    }
  }
  // A search is retrieval over the authorized view, never a listing; the note says what it can prove.
  async function search() {
    const id = generation.current
    const text = query.trim()
    if (!text) return
    setBusy(true)
    setError(undefined)
    try {
      const result = await searchAgentMemoryEntries(agentId, text, channelKey)
      if (id !== generation.current) return
      setHits(result.hits)
      setSearchNote(
        `${result.hits.length} ${result.hits.length === 1 ? 'hit' : 'hits'} · ${result.kind} search · ${result.coverage} coverage. A search is not a complete listing.`
      )
    } catch (err) {
      if (id === generation.current) setError(errorMessage(err))
    } finally {
      if (id === generation.current) setBusy(false)
    }
  }
  async function open(entry: Pick<MemoryEntrySummary, 'ref'>) {
    const id = ++detailRequest.current
    setSelectedRef(entry.ref)
    dropOverviewReads()
    setOverviewOpen(false)
    setOverviewTopic(null)
    setReading(true)
    setDocument(null)
    setError(undefined)
    setConfirmDelete(false)
    setShowHistory(false)
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
      setSelectedRef(undefined)
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
  function switchView(view: MemoryView) {
    if (view === (legacy ? 'legacy' : 'entries')) return
    if (view === 'legacy') void openLegacy()
    else {
      setLegacy(false)
      void reload()
    }
  }
  function startCreate() {
    setMode('create')
    setDocument(null)
    setSelectedRef(undefined)
    dropOverviewReads()
    setOverviewOpen(false)
    setOverviewTopic(null)
    setDraft('')
    setLabel('')
    setError(undefined)
  }
  function cancelEdit() {
    setMode(null)
    setDraft('')
  }
  async function openOverview() {
    if (!overview) return
    dropOverviewReads()
    const id = overviewRequest.current
    ++detailRequest.current
    setReading(false)
    setDocument(null)
    setSelectedRef('overview')
    setOverviewOpen(true)
    setOverviewTopic(null)
    setOverviewBusy(true)
    setError(undefined)
    setConfirmDelete(false)
    try {
      const result = await overview.read()
      if (id === overviewRequest.current) setOverviewDoc(result)
    } catch (err) {
      if (id === overviewRequest.current) setError(errorMessage(err))
    } finally {
      if (id === overviewRequest.current) setOverviewBusy(false)
    }
  }
  // The href's filename is the destination; it is read as the overview was, and a newer action outdates the read.
  async function openOverviewTopic(file: string) {
    if (!overview) return
    dropOverviewReads()
    const id = overviewRequest.current
    setOverviewTopicBusy(true)
    setError(undefined)
    try {
      const result = await overview.readTopic(file)
      if (id === overviewRequest.current) setOverviewTopic({ file, ...result })
    } catch (err) {
      if (id === overviewRequest.current) setError(errorMessage(err))
    } finally {
      if (id === overviewRequest.current) setOverviewTopicBusy(false)
    }
  }
  // The wake watches the root read; its poll re-issues that read until the sandbox answers or the bound passes.
  const readState: SandboxReadState =
    errorCode === SANDBOX_ASLEEP_CODE ? 'asleep' : busy ? 'pending' : error ? 'failed' : 'ready'
  const retry = useCallback(() => void reload(), [reload])
  const wake = useSandboxWake(agentId, readState, retry, { sandboxed })
  const asleep = readState === 'asleep'
  const asleepView = asleep || (wake.phase === 'starting' && !!error)
  const startable = sandboxed || asleep
  // An old peer has no entry view at all, so there is nothing to switch back to.
  if (legacy)
    return (
      <>
        {children(
          capabilities ? (
            <ViewSwitch view="legacy" legacyLabel={legacyLabel} disabled={busy} onChange={switchView} />
          ) : null
        )}
      </>
    )
  const rowsLocked = saving || (!!mode && !blocked)
  const selectedEntry = document?.entry
  const previewMeta =
    mode === 'create'
      ? 'New memory'
      : selectedEntry
        ? [
            formatFileSize(selectedEntry.byteSize),
            selectedEntry.updatedAt ? `edited ${formatFileMtime(selectedEntry.updatedAt)}` : '',
            selectedEntry.origin === 'inherited' ? 'inherited · read-only' : ''
          ]
            .filter(Boolean)
            .join(' · ')
        : ''
  const overviewGenerated = overviewDoc?.content.includes(GENERATED_OVERVIEW_MARKER) === true
  const shownOverview = overviewTopic ?? overviewDoc
  const overviewMeta = shownOverview
    ? [
        overviewTopic?.file ?? '',
        formatFileSize(new TextEncoder().encode(shownOverview.content).byteLength),
        shownOverview.mtime ? `edited ${formatFileMtime(shownOverview.mtime)}` : '',
        overviewTopic
          ? 'read-only · select it in the list to edit'
          : overviewGenerated
            ? 'generated from topic descriptions'
            : 'hand-written · kept as-is'
      ]
        .filter(Boolean)
        .join(' · ')
    : ''
  const overviewLink = (href: string) =>
    resolveFileBrowserMarkdownLink(
      href,
      (candidate) => {
        const file = memoryFileFromHref(candidate)
        return file ? { path: file, name: file } : null
      },
      (target) => void openOverviewTopic(target.path)
    )
  const renderTree = (openPreview: () => void) => (
    <>
      {asleepView && !busy ? (
        wake.phase === 'starting' ? (
          <SandboxStartingNotice compact />
        ) : (
          <SandboxAsleepNotice
            wake={wake}
            startable={startable}
            compact
            notice={
              <div className="px-3 py-[10px] font-sans text-[12px] font-normal leading-[1.55] text-(--text-secondary)">
                {MEMORY_SANDBOX_ASLEEP_NOTICE}
              </div>
            }
          />
        )
      ) : null}
      {overview && !busy && !hits && !asleepView ? (
        <button
          type="button"
          className={`file-browser-item flex w-full items-start gap-[6px] border-0 border-r-2 py-[6px] pl-2 pr-[10px] text-left [font:inherit] disabled:cursor-default disabled:opacity-60 ${
            overviewOpen ? 'border-r-(--brand) bg-(--brand-soft)' : 'border-r-transparent bg-transparent'
          }`}
          aria-current={overviewOpen ? 'page' : undefined}
          title="The overview the agent reads first"
          disabled={rowsLocked}
          onClick={() => {
            void openOverview()
            openPreview()
          }}
        >
          <Icon name="book-bookmark" size={15} color="var(--text-tertiary)" className="mt-[2px] flex-none" />
          <span className="flex min-w-0 flex-1 flex-col gap-[2px]">
            <span
              className={`mono truncate text-[12.5px] ${overviewOpen ? 'text-(--text-primary)' : 'text-(--text-secondary)'}`}
            >
              MEMORY.md
            </span>
            <span className="font-sans text-[11.5px] font-normal leading-[1.4] text-(--text-tertiary)">Overview</span>
          </span>
          {overviewDoc?.mtime ? (
            <span className="flex-none pt-[1px] font-sans text-[11px] font-normal leading-normal text-(--text-tertiary)">
              {formatFileMtime(overviewDoc.mtime)}
            </span>
          ) : null}
        </button>
      ) : null}
      {busy ? (
        <div className="flex justify-center py-4" role="status" aria-label="Loading memory">
          <Spinner size={18} />
        </div>
      ) : null}
      {!busy && hits && searchNote ? (
        <div className="px-4 py-[6px] font-sans text-[11px] font-normal leading-normal text-(--text-tertiary)">
          {searchNote}
        </div>
      ) : null}
      {!busy && !error && hits && hits.length === 0 ? (
        <div className="px-4 py-3 font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
          No memory matched this search.
        </div>
      ) : null}
      {!busy && hits
        ? hits.map((hit, index) => (
            <EntryRow
              key={`${hit.entry.ref}:${index}`}
              entry={hit.entry}
              snippet={hit.snippet}
              selected={selectedRef === hit.entry.ref}
              disabled={rowsLocked}
              onClick={() => {
                void open(hit.entry)
                openPreview()
              }}
            />
          ))
        : null}
      {!busy && !error && !hits && entries.length === 0 && !overview ? (
        <div className="px-4 py-3 font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
          No memory yet.
        </div>
      ) : null}
      {!busy && !hits
        ? entries.map((entry, index) => (
            <EntryRow
              key={`${entry.ref}:${index}`}
              entry={entry}
              selected={selectedRef === entry.ref}
              disabled={rowsLocked}
              onClick={() => {
                void open(entry)
                openPreview()
              }}
            />
          ))
        : null}
      {!busy && !hits && cursor ? (
        <div className="px-3 py-2">
          <Button variant="ghost" size="xs" disabled={paging || saving} onClick={() => void more()}>
            {paging ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      ) : null}
    </>
  )
  const renderPreview = (onBack?: () => void) => (
    <>
      <FileBrowserPreviewSummary
        meta={
          reading || overviewBusy || overviewTopicBusy
            ? 'Loading complete memory…'
            : overviewOpen
              ? overviewMeta
              : previewMeta
        }
        onBack={onBack}
        actions={
          overviewTopic ? (
            <Button variant="secondary" size="xs" onClick={() => setOverviewTopic(null)}>
              <Icon name="arrow-left" size={13} />
              Back to overview
            </Button>
          ) : mode ? (
            <div className="flex flex-none items-center gap-2">
              <Button variant="secondary" size="xs" disabled={saving} onClick={cancelEdit}>
                Cancel
              </Button>
              <Button
                size="xs"
                disabled={saving || blocked || tooLarge || !supports(mode === 'create' ? 'create' : 'update')}
                onClick={() => void mutate()}
              >
                {saving ? 'Saving…' : 'Save memory'}
              </Button>
            </div>
          ) : document && !reading ? (
            <div className="flex flex-none items-center gap-2">
              {capabilities?.operations.includes('history') ? (
                <Button
                  variant="secondary"
                  size="xs"
                  ariaExpanded={showHistory}
                  onClick={() => setShowHistory((open) => !open)}
                >
                  <Icon name="rotate-ccw-clock" size={13} />
                  {showHistory ? 'Hide history' : 'History'}
                </Button>
              ) : null}
              {supports('update') && editable ? (
                <Button
                  variant="secondary"
                  size="xs"
                  disabled={saving || blocked}
                  onClick={() => {
                    setDraft(document.text)
                    setMode('update')
                    setError(undefined)
                  }}
                  ariaLabel="Edit memory"
                >
                  <Icon name="pencil" size={13} />
                  <span className="max-desktop:hidden">Edit memory</span>
                </Button>
              ) : null}
              {supports('delete') && editable ? (
                <Button
                  variant="secondary"
                  size="xs"
                  disabled={saving || blocked || confirmDelete}
                  onClick={() => setConfirmDelete(true)}
                  ariaLabel="Delete memory"
                >
                  <Icon name="trash" size={13} />
                  <span className="max-desktop:hidden">Delete memory</span>
                </Button>
              ) : null}
            </div>
          ) : undefined
        }
      />
      {confirmDelete && document ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-(--border-subtle) bg-(--surface-sunken) px-4 py-2 font-sans text-[12.5px] font-normal leading-normal text-(--text-primary)">
          <span className="min-w-0 flex-1">
            Delete “{document.entry.label || 'this memory'}”?
            {channelKey ? ' Deleting an override can reveal inherited memory.' : ''}
          </span>
          <Button
            variant="danger"
            size="xs"
            disabled={saving || blocked || !supports('delete')}
            onClick={() => void mutate(true)}
          >
            Confirm deletion
          </Button>
          <Button variant="secondary" size="xs" disabled={saving} onClick={() => setConfirmDelete(false)}>
            Keep memory
          </Button>
        </div>
      ) : null}
      {overviewOpen ? (
        overviewBusy || overviewTopicBusy ? (
          <div className="flex flex-1 items-center justify-center py-10">
            <Spinner size={28} />
          </div>
        ) : shownOverview?.exists && shownOverview.content.trim() ? (
          <div className="max-h-[520px] overflow-auto px-[18px] py-4">
            <MarkdownView content={shownOverview.content} resolveLink={overviewLink} />
          </div>
        ) : shownOverview ? (
          <div className="px-4 py-6 font-sans text-[13px] font-normal leading-normal text-(--text-tertiary)">
            {overviewTopic
              ? 'This topic no longer exists.'
              : 'No overview yet. The agent maintains its memory itself as it works.'}
          </div>
        ) : null
      ) : reading ? (
        <div className="flex flex-1 items-center justify-center py-10">
          <Spinner size={28} />
        </div>
      ) : mode ? (
        <div className="flex flex-1 flex-col gap-3 p-4">
          {mode === 'create' ? (
            <input
              aria-label="Memory name"
              placeholder="Name (optional)"
              value={label}
              maxLength={512}
              disabled={saving}
              onChange={(e) => setLabel(e.target.value)}
              className="inp mono h-8 min-h-8 px-[10px] py-1 text-[12.5px]"
              spellCheck={false}
            />
          ) : null}
          <textarea
            aria-label="Memory content"
            value={draft}
            disabled={saving}
            onChange={(e) => setDraft(e.target.value)}
            className="inp mono min-h-[300px] flex-1 resize-y px-3 py-[10px] leading-[1.6] focus:border-(--brand) focus:outline-none"
            spellCheck={false}
            autoFocus={mode === 'update'}
          />
          {tooLarge ? (
            <div role="alert" className="font-sans text-[12.5px] font-normal leading-normal text-(--status-error)">
              This change is too large to save here. Reduce its size.
            </div>
          ) : null}
          {blocked && document ? (
            <div>
              <Button variant="secondary" size="xs" disabled={saving} onClick={() => void open(document.entry)}>
                Reload saved version
              </Button>
            </div>
          ) : null}
        </div>
      ) : document && showHistory ? (
        <div className="max-h-[520px] overflow-auto px-4 pb-4 pt-1 font-sans text-[12.5px] leading-normal">
          <UnifiedMemoryHistory agentId={agentId} entryRef={document.entry.ref} channelKey={channelKey} />
        </div>
      ) : document ? (
        <div className="max-h-[520px] overflow-auto px-[18px] py-4">
          {document.entry.format === 'markdown' ? (
            <MarkdownView
              content={document.text}
              resolveLink={(href) =>
                resolveFileBrowserMarkdownLink(
                  href,
                  (candidate) => {
                    const name = memoryFileFromHref(candidate)
                    const ref = name ? linkedRef(document, name) : undefined
                    return name && ref ? { path: name, name, ref } : null
                  },
                  (target) => void open({ ref: target.ref })
                )
              }
            />
          ) : (
            <pre className="m-0 whitespace-pre-wrap break-words font-sans text-[13.5px] font-normal leading-[1.7] text-(--text-primary)">
              {document.text}
            </pre>
          )}
          {document.links?.length || document.backlinks?.length ? (
            <div className="mt-4 flex flex-col gap-1 border-t border-(--border-subtle) pt-3 font-sans text-[12px] font-normal leading-normal">
              {(
                [
                  ['Links', document.links],
                  ['Backlinks', document.backlinks]
                ] as Array<[string, MemoryEntryLink[] | undefined]>
              ).map(([title, edges]) =>
                edges?.length ? (
                  <p key={title} className="m-0">
                    <span className="font-semibold text-(--text-secondary)">{title}:</span>{' '}
                    {edges.map((edge, index) => (
                      <span key={`${edge.label}:${index}`}>
                        {index > 0 ? ', ' : ''}
                        {edge.ref ? (
                          <button
                            type="button"
                            className="lnk text-[12px]"
                            disabled={rowsLocked}
                            onClick={() => void open({ ref: edge.ref! })}
                          >
                            {edge.label}
                          </button>
                        ) : (
                          <span className="text-(--text-tertiary)">{edge.label} (missing)</span>
                        )}
                      </span>
                    ))}
                  </p>
                ) : null
              )}
            </div>
          ) : null}
          {document.metadata && Object.keys(document.metadata).length ? (
            <dl className="mt-4 grid grid-cols-[minmax(72px,auto)_minmax(0,1fr)] gap-x-3 gap-y-1 border-t border-(--border-subtle) pt-3 font-sans text-[11.5px] font-normal leading-normal">
              {Object.entries(document.metadata).map(([key, value]) => (
                <Fragment key={key}>
                  <dt className="text-(--text-tertiary)">{key}</dt>
                  <dd className="m-0 break-all font-mono text-(--text-secondary)">
                    {typeof value === 'string' ? value : JSON.stringify(value)}
                  </dd>
                </Fragment>
              ))}
            </dl>
          ) : null}
        </div>
      ) : null}
    </>
  )
  return (
    <FileBrowserShell
      title={<span aria-label="Memory entries">Memory</span>}
      headerEnd={
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
          {capabilities ? (
            <ViewSwitch
              view="entries"
              legacyLabel={legacyLabel}
              disabled={busy || saving || !!mode}
              onChange={switchView}
            />
          ) : null}
          <Button
            variant="secondary"
            size="xs"
            disabled={busy || saving || (!!mode && !blocked)}
            onClick={() => void reload(blocked)}
            ariaLabel="Refresh"
          >
            <Icon name="refresh-cw" size={13} />
            <span className="max-desktop:hidden">Refresh</span>
          </Button>
          {supports('create') ? (
            <Button
              variant="secondary"
              size="xs"
              disabled={busy || reading || overviewBusy || overviewTopicBusy || saving || !!mode || blocked}
              onClick={startCreate}
              ariaLabel="New memory"
            >
              <Icon name="plus" size={13} />
              <span className="max-desktop:hidden">New memory</span>
            </Button>
          ) : null}
        </div>
      }
    >
      {capabilities?.operations.includes('search') ? (
        <div className="flex items-center gap-2 border-b border-(--border-subtle) px-3 py-2">
          <input
            aria-label="Search memory"
            placeholder="Search memory…"
            value={query}
            maxLength={2048}
            disabled={busy || saving}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void search()
              }
            }}
            className="inp h-8 min-h-8 min-w-0 flex-1 px-[10px] py-1 text-[12.5px]"
          />
          <Button
            variant="secondary"
            size="xs"
            disabled={busy || saving || !query.trim()}
            onClick={() => void search()}
          >
            <Icon name="search" size={13} />
            Search
          </Button>
          {hits ? (
            <Button
              variant="ghost"
              size="xs"
              disabled={busy || saving}
              onClick={() => {
                setHits(null)
                setSearchNote(undefined)
              }}
            >
              Clear search
            </Button>
          ) : null}
        </div>
      ) : null}
      {notice ? (
        <div
          role="status"
          className="border-b border-(--border-subtle) px-4 py-2 font-sans text-[12px] font-normal leading-normal text-(--text-secondary)"
        >
          {notice}
        </div>
      ) : null}
      {error && !asleepView ? (
        <div
          role="alert"
          className="border-b border-(--border-subtle) px-4 py-2 font-sans text-[12px] font-normal leading-normal text-(--status-error)"
        >
          {error}
        </div>
      ) : null}
      <FileBrowserLayout
        resetKey={`${agentId}:${channelKey ?? ''}`}
        previewOpen={!!mode}
        tree={renderTree}
        preview={reading || mode || document || overviewOpen ? renderPreview : null}
        emptyPreview={
          <div className="flex flex-1 items-center justify-center px-4 py-10 font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
            Select a memory to read it.
          </div>
        }
      />
    </FileBrowserShell>
  )
}
