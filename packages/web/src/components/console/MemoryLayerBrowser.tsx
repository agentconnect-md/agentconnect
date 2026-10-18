'use client'

import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import dynamic from 'next/dynamic'
import type {
  MemoryEntryCapabilities,
  MemoryEntryContent,
  MemoryEntryLink,
  MemoryEntryListResult,
  MemoryEntrySummary
} from '@agentconnect.md/protocol'
import {
  ApiError,
  clearAgentMemoryChannel,
  createAgentMemoryEntry,
  deleteAgentMemoryEntry,
  describeAgentMemoryEntries,
  fetchAgentMemoryChannels,
  fetchAgentMemoryFull,
  fetchMyAgentMemoryFull,
  getAgentMemoryEntry,
  listAgentMemoryEntries,
  listMyAgentMemory,
  updateAgentMemoryEntry,
  type MemoryChannelDto,
  type MemoryFileEntry
} from '@/lib/api'
import { readCompleteMemoryEntry } from '@/lib/memory-entry-content'
import { useIsMobile } from '@/lib/use-is-mobile'
import { Spinner } from '@/components/marks'
import { Button, Icon } from '@/components/ui'
import { ConfirmationDialog } from '@/components/console/ConfirmationDialog'
import { formatFileMtime } from '@/components/console/FileBrowser'
import { resolveFileBrowserMarkdownLink } from '@/components/console/file-browser-links'
import { linkedMemoryRef, memoryEntryError } from '@/components/console/memory-entry-helpers'
import { memoryFileFromHref } from '@/components/console/memory-links'
import { placeLayerLabel, placeLayerName } from '@/components/console/memory-place-label'
import { useSandboxWake, type SandboxReadState } from '@/components/console/sandbox-wake'
import {
  MEMORY_SANDBOX_ASLEEP_NOTICE,
  SandboxAsleepNotice,
  SandboxStartingNotice
} from '@/components/console/SandboxWakeNotice'
import { UnifiedMemoryHistory } from '@/components/console/UnifiedMemoryHistory'
import { SANDBOX_ASLEEP_CODE } from '@/components/console/workspace-tree'

// Loaded lazily like the file preview so react-markdown never ships in the main console bundle.
const MarkdownView = dynamic(() => import('@/components/console/MarkdownView'), {
  ssr: false,
  loading: () => <p className="text-(--text-tertiary)">{'Loading…'}</p>
})

// A layer's key: the shared layer, the caller's own, or a place layer by its folder key.
const SHARED = 'shared'
const PERSONAL = 'personal'
const PLACE = 'place:'
const channelKeyOf = (layer: string) => (layer.startsWith(PLACE) ? layer.slice(PLACE.length) : undefined)

interface EntryListing {
  status: 'loading' | 'ready' | 'failed' | 'unsupported'
  caps?: MemoryEntryCapabilities
  entries: MemoryEntrySummary[]
  cursor?: string
  paging?: boolean
  /** The last next-page read failed; a filter stops following the cursor until Load more succeeds. */
  pageFailed?: boolean
  error?: string
  errorCode?: string
}
type PersonalListing = { status: 'loading' } | { status: 'ready'; files: MemoryFileEntry[] } | { status: 'failed' }
type Selection =
  | { kind: 'overview'; layer: string }
  | { kind: 'entry'; layer: string; ref: string }
  | { kind: 'personal'; name: string }
  | { kind: 'hidden'; channelKey: string }
  | { kind: 'create'; layer: string }
interface MemoryFile {
  exists: boolean
  content: string
  mtime: string | null
}

const isEntryLayer = (selection: Selection | null): selection is Extract<Selection, { layer: string }> =>
  !!selection && 'layer' in selection

function TreeRow({
  depth,
  icon,
  name,
  open,
  mono = true,
  layer = false,
  muted = false,
  aside,
  title,
  selected = false,
  disabled = false,
  className = '',
  onClick
}: {
  depth: number
  icon: string
  name: string
  /** A layer's disclosure state; absent for a row that does not expand. */
  open?: boolean
  mono?: boolean
  layer?: boolean
  muted?: boolean
  aside?: ReactNode
  title?: string
  selected?: boolean
  disabled?: boolean
  className?: string
  onClick: () => void
}) {
  const weight = layer ? 'font-semibold' : selected ? 'font-medium' : 'font-normal'
  return (
    <button
      type="button"
      className={`flex h-[30px] w-full cursor-pointer items-center gap-[6px] border-0 pr-3 text-left [font:inherit] hover:bg-(--surface-hover) disabled:cursor-default disabled:opacity-60 ${
        selected ? 'bg-(--surface-sunken) shadow-[inset_2px_0_0_var(--brand)]' : 'bg-transparent'
      } ${className}`}
      style={{ paddingLeft: 12 + depth * 16 }}
      title={title}
      aria-expanded={open}
      aria-current={selected ? 'page' : undefined}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="flex w-[14px] flex-none text-(--text-tertiary)">
        {open !== undefined ? (
          <Icon
            name="chevron-right"
            size={14}
            strokeWidth={2}
            className={`transition-transform duration-[120ms] ${open ? 'rotate-90' : ''}`}
          />
        ) : null}
      </span>
      <Icon
        name={icon}
        size={15}
        color={selected || (layer && !muted) ? 'var(--text-secondary)' : 'var(--text-tertiary)'}
        className="flex-none"
      />
      <span
        className={`min-w-0 flex-1 truncate text-[13px] leading-normal ${mono ? 'font-mono' : 'font-sans'} ${weight} ${
          muted ? 'text-(--text-tertiary)' : 'text-(--text-primary)'
        }`}
      >
        {name}
      </span>
      {aside ? (
        <span className="flex-none font-mono text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
          {aside}
        </span>
      ) : null}
    </button>
  )
}

function TreeNote({
  depth,
  children,
  tone = 'muted'
}: {
  depth: number
  children: ReactNode
  tone?: 'muted' | 'error'
}) {
  return (
    <div
      className={`py-[6px] pr-3 font-sans text-[12px] font-normal leading-[1.45] ${tone === 'error' ? 'text-(--status-error)' : 'text-(--text-tertiary)'}`}
      style={{ paddingLeft: 32 + depth * 16 }}
    >
      {children}
    </div>
  )
}

/** Managed memory as one tree of layers — Shared, each place the caller can read, Personal — beside one reader. */
export function MemoryLayerBrowser({
  agentId,
  canEdit,
  sandboxed = false,
  header
}: {
  agentId: string
  canEdit: boolean
  /** The managed tree sits on a pool sandbox volume: a read refused as asleep presses the wake. */
  sandboxed?: boolean
  /** The settings line above the card. */
  header?: ReactNode
}) {
  const t = useTranslations('Agents.detail.memory')
  const tFiles = useTranslations('Sessions.fileBrowser')
  const isMobile = useIsMobile()
  const alive = useRef(true)
  const [channels, setChannels] = useState<MemoryChannelDto[]>([])
  const [listings, setListings] = useState<Record<string, EntryListing>>({})
  const listingGen = useRef<Record<string, number>>({})
  const [personal, setPersonal] = useState<PersonalListing | null>(null)
  const [overviewMtimes, setOverviewMtimes] = useState<Record<string, string | null>>({})
  const [open, setOpen] = useState<Set<string>>(() => new Set([SHARED]))
  const [query, setQuery] = useState('')
  const [selection, setSelection] = useState<Selection | null>(null)
  const autoSelected = useRef(false)
  const [mobileReader, setMobileReader] = useState(false)

  // The reader: one selected file, read whole, viewed or edited in place.
  const readRequest = useRef(0)
  const [reading, setReading] = useState(false)
  const [doc, setDoc] = useState<MemoryEntryContent | null>(null)
  const [file, setFile] = useState<MemoryFile | null>(null)
  const [topic, setTopic] = useState<(MemoryFile & { name: string }) | null>(null)
  const [mode, setMode] = useState<'update' | null>(null)
  const [draft, setDraft] = useState('')
  const [label, setLabel] = useState('')
  const [saving, setSaving] = useState(false)
  const [blocked, setBlocked] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [confirmingClear, setConfirmingClear] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [clearError, setClearError] = useState<string | null>(null)

  const readable = channels.filter((entry) => entry.visible !== false)
  const hidden = channels.filter((entry) => entry.visible === false)
  const layerName = (layer: string) => {
    if (layer === SHARED) return t('sharedLayer')
    if (layer === PERSONAL) return t('personalLayer')
    const entry = channels.find((candidate) => candidate.channelKey === channelKeyOf(layer))
    return entry ? placeLayerName(entry) : (channelKeyOf(layer) ?? layer)
  }

  const loadLayer = useCallback(
    async (layer: string): Promise<MemoryEntryListResult | undefined> => {
      const id = (listingGen.current[layer] ?? 0) + 1
      listingGen.current[layer] = id
      const live = () => alive.current && listingGen.current[layer] === id
      const channelKey = channelKeyOf(layer)
      const put = (next: EntryListing) => setListings((old) => ({ ...old, [layer]: next }))
      put({ status: 'loading', entries: [] })
      try {
        const caps = await describeAgentMemoryEntries(agentId, channelKey)
        if (!live()) return
        if (!caps.operations.includes('list') || !caps.operations.includes('get')) {
          put({ status: 'unsupported', entries: [] })
          return
        }
        const page = await listAgentMemoryEntries(agentId, channelKey)
        if (!live()) return
        put({ status: 'ready', caps, entries: page.entries, cursor: page.nextCursor })
        return page
      } catch (err) {
        if (!live()) return
        if (err instanceof ApiError && (err.status === 404 || err.status === 501 || err.code === 'UNSUPPORTED'))
          put({ status: 'unsupported', entries: [] })
        else
          put({
            status: 'failed',
            entries: [],
            error: memoryEntryError(err),
            errorCode: err instanceof ApiError ? err.code : undefined
          })
      }
    },
    [agentId]
  )

  const loadChannels = useCallback(async () => {
    try {
      const result = await fetchAgentMemoryChannels(agentId)
      if (alive.current) setChannels(result.channels)
    } catch {
      if (alive.current) setChannels([])
    }
  }, [agentId])

  const loadPersonal = useCallback(async () => {
    setPersonal({ status: 'loading' })
    try {
      const page = await listMyAgentMemory(agentId)
      if (alive.current) setPersonal({ status: 'ready', files: page.files })
    } catch {
      if (alive.current) setPersonal({ status: 'failed' })
    }
  }, [agentId])

  useEffect(() => {
    alive.current = true
    void loadLayer(SHARED)
    void loadChannels()
    return () => {
      alive.current = false
      readRequest.current++
    }
  }, [loadLayer, loadChannels])

  // A layer loads the first time it is shown: opened, or reached by a filter that searches every layer.
  const ensureLoaded = (layer: string) => {
    if (layer === PERSONAL) {
      if (!personal || personal.status === 'failed') void loadPersonal()
    } else if (!listings[layer] || listings[layer].status === 'failed') void loadLayer(layer)
  }
  const loadMore = useCallback(
    async (layer: string, listing: EntryListing) => {
      if (!listing.cursor) return
      const id = listingGen.current[layer]
      const live = () => alive.current && listingGen.current[layer] === id
      setListings((old) => ({ ...old, [layer]: { ...listing, paging: true, pageFailed: false } }))
      try {
        const page = await listAgentMemoryEntries(agentId, channelKeyOf(layer), listing.cursor)
        if (!live()) return
        setListings((old) => ({
          ...old,
          [layer]: {
            ...listing,
            entries: [...listing.entries, ...page.entries],
            cursor: page.nextCursor,
            paging: false
          }
        }))
      } catch (err) {
        if (!live()) return
        setListings((old) => ({ ...old, [layer]: { ...listing, paging: false, pageFailed: true } }))
        setError(memoryEntryError(err))
      }
    },
    [agentId]
  )
  const filtering = query.trim().length > 0
  const readableKey = readable.map((entry) => entry.channelKey).join('\n')
  useEffect(() => {
    if (!filtering) return
    for (const layer of [
      SHARED,
      ...readableKey
        .split('\n')
        .filter(Boolean)
        .map((key) => PLACE + key)
    ])
      if (!listings[layer]) void loadLayer(layer)
    if (!personal) void loadPersonal()
    // A filter reads every page, so a file past the first one is never reported missing.
    for (const [layer, listing] of Object.entries(listings))
      if (listing.status === 'ready' && listing.cursor && !listing.paging && !listing.pageFailed)
        void loadMore(layer, listing)
  }, [filtering, readableKey, listings, personal, loadLayer, loadPersonal, loadMore])

  const resetReader = () => {
    ++readRequest.current
    setReading(false)
    setDoc(null)
    setFile(null)
    setTopic(null)
    setMode(null)
    setDraft('')
    setLabel('')
    setBlocked(false)
    setConfirmDelete(false)
    setShowHistory(false)
    setError(undefined)
    setNotice(undefined)
  }

  const select = async (next: Selection, reveal = true) => {
    resetReader()
    setSelection(next)
    if (reveal) setMobileReader(true)
    if (next.kind === 'hidden' || next.kind === 'create') return
    const id = readRequest.current
    const current = () => alive.current && id === readRequest.current
    setReading(true)
    try {
      if (next.kind === 'overview') {
        const result = await fetchAgentMemoryFull(agentId, undefined, channelKeyOf(next.layer))
        if (!current()) return
        setFile(result)
        setOverviewMtimes((old) => ({ ...old, [next.layer]: result.mtime }))
      } else if (next.kind === 'personal') {
        const result = await fetchMyAgentMemoryFull(agentId, next.name)
        if (current()) setFile(result)
      } else {
        const caps = listings[next.layer]?.caps
        if (!caps) return
        const result = await readCompleteMemoryEntry(
          (cursor) => getAgentMemoryEntry(agentId, next.ref, channelKeyOf(next.layer), cursor),
          caps.limits.maxItemBytes
        )
        if (!current()) return
        setDoc(result)
        if (!result) setError('This memory no longer exists. Refresh the list.')
      }
    } catch (err) {
      if (current()) setError(next.kind === 'personal' ? t('yourMemoryUnavailable') : memoryEntryError(err))
    } finally {
      if (current()) setReading(false)
    }
  }

  // On desktop the shared index opens once the shared layer answers; a phone starts on the tree.
  const sharedListing = listings[SHARED]
  useEffect(() => {
    if (autoSelected.current || sharedListing?.status !== 'ready') return
    autoSelected.current = true
    if (!selection && !isMobile) void select({ kind: 'overview', layer: SHARED }, false)
  })

  // A topic the index links to, by filename, read through the same route; refs never name files, so it stays read-only.
  const openTopic = async (layer: string, name: string) => {
    const id = ++readRequest.current
    const current = () => alive.current && id === readRequest.current
    setReading(true)
    setError(undefined)
    try {
      const result = await fetchAgentMemoryFull(agentId, name, channelKeyOf(layer))
      if (current()) setTopic({ name, ...result })
    } catch (err) {
      if (current()) setError(memoryEntryError(err))
    } finally {
      if (current()) setReading(false)
    }
  }

  const toggle = (layer: string) => {
    const opening = !open.has(layer)
    setOpen((old) => {
      const next = new Set(old)
      if (opening) next.add(layer)
      else next.delete(layer)
      return next
    })
    if (opening) ensureLoaded(layer)
  }

  const refresh = async () => {
    void loadChannels()
    if (personal) void loadPersonal()
    const pages = await Promise.all(
      Object.keys(listings).map(async (layer) => [layer, await loadLayer(layer)] as const)
    )
    // After an unconfirmed create, an empty layer is the one proof the draft may be saved again.
    if (blocked && selection?.kind === 'create') {
      const page = pages.find(([layer]) => layer === selection.layer)?.[1]
      if (page && page.entries.length === 0 && !page.nextCursor) {
        setBlocked(false)
        setNotice(t('createUnconfirmed'))
      }
    }
  }

  // The wake watches the shared layer's read; its poll re-issues that read until the sandbox answers or the bound passes.
  const readState: SandboxReadState = !sharedListing
    ? 'pending'
    : sharedListing.errorCode === SANDBOX_ASLEEP_CODE
      ? 'asleep'
      : sharedListing.status === 'loading'
        ? 'pending'
        : sharedListing.status === 'failed'
          ? 'failed'
          : 'ready'
  const retry = useCallback(() => {
    void loadLayer(SHARED)
    void loadChannels()
  }, [loadLayer, loadChannels])
  const wake = useSandboxWake(agentId, readState, retry, { sandboxed })
  const asleep = readState === 'asleep'
  const asleepView = asleep || (wake.phase === 'starting' && sharedListing?.status === 'failed')

  const selectedLayer = isEntryLayer(selection) ? selection.layer : undefined
  const selectedCaps = selectedLayer ? listings[selectedLayer]?.caps : undefined
  const supports = (operation: 'create' | 'update' | 'delete', caps = selectedCaps) =>
    canEdit && !!caps?.operations.includes(operation)
  const creating = selection?.kind === 'create'
  const editing = creating || mode === 'update'
  const rowsLocked = saving || (editing && !blocked)
  // New memory goes into the layer being read, or Shared when that layer takes none.
  const createLayer = selectedLayer && supports('create', listings[selectedLayer]?.caps) ? selectedLayer : SHARED
  const canCreate = supports('create', listings[createLayer]?.caps)
  const editable = doc?.entry.editable && (selectedCaps?.writeConsistency !== 'conditional' || !!doc.entry.revision)
  const request = creating
    ? { text: draft, ...(label.trim() ? { label: label.trim() } : {}) }
    : { ref: doc?.entry.ref ?? '', revision: doc?.entry.revision, text: draft }
  const tooLarge =
    editing &&
    !!selectedCaps &&
    (new TextEncoder().encode(draft).byteLength > selectedCaps.limits.maxItemBytes ||
      (selectedCaps.limits.maxMutationRequestBytes !== undefined &&
        new TextEncoder().encode(
          JSON.stringify({
            agentId,
            ...(channelKeyOf(selectedLayer ?? '') ? { channelKey: channelKeyOf(selectedLayer ?? '') } : {}),
            operation: creating ? 'create' : 'update',
            request
          })
        ).byteLength > selectedCaps.limits.maxMutationRequestBytes))

  async function mutate(remove = false) {
    if (!selectedLayer) return
    const layer = selectedLayer
    const channelKey = channelKeyOf(layer)
    setSaving(true)
    setError(undefined)
    setNotice(undefined)
    try {
      if (remove)
        await deleteAgentMemoryEntry(agentId, { ref: doc!.entry.ref, revision: doc!.entry.revision }, channelKey)
      else if (creating) await createAgentMemoryEntry(agentId, request, channelKey)
      else await updateAgentMemoryEntry(agentId, { ...request, ref: doc!.entry.ref }, channelKey)
      if (!alive.current) return
      resetReader()
      setSelection(null)
      setNotice(remove ? t('memoryDeleted') : t('memorySaved'))
      void loadLayer(layer)
    } catch (err) {
      if (!alive.current) return
      const uncertain = !(err instanceof ApiError) || err.status >= 500
      setBlocked(uncertain || (err instanceof ApiError && (err.code === 'CONFLICT' || err.code === 'STALE_BINDING')))
      setError(
        uncertain
          ? 'The change could not be confirmed. Your draft is kept; check saved memory before making another change.'
          : memoryEntryError(err)
      )
    } finally {
      if (alive.current) setSaving(false)
    }
  }

  const hiddenSelected =
    selection?.kind === 'hidden' ? hidden.find((entry) => entry.channelKey === selection.channelKey) : undefined
  const clearHidden = async () => {
    if (!hiddenSelected || clearing) return
    setClearing(true)
    setClearError(null)
    try {
      await clearAgentMemoryChannel(agentId, hiddenSelected.channelKey)
      setChannels((old) => old.filter((entry) => entry.channelKey !== hiddenSelected.channelKey))
      resetReader()
      setSelection(null)
      setConfirmingClear(false)
    } catch (e) {
      setClearError(e instanceof Error ? e.message : String(e))
    } finally {
      setClearing(false)
    }
  }

  // The filter narrows what is loaded by name and description; a layer with nothing left drops out while it is on.
  const needle = query.trim().toLowerCase()
  const matches = (...texts: Array<string | undefined>) =>
    !needle || texts.some((text) => text?.toLowerCase().includes(needle))
  const isOpen = (layer: string) => filtering || open.has(layer)

  const rows: ReactNode[] = []
  let fileRows = 0
  const entryLayer = (layer: string, name: string, icon: string, mono: boolean, title?: string) => {
    const listing = listings[layer]
    const shown = isOpen(layer)
    const indexMatches = matches(t('memoryFile'))
    // An inherited entry is the Shared layer's own file, already listed there.
    const entries = (listing?.status === 'ready' ? listing.entries : []).filter(
      (entry) => entry.origin !== 'inherited' && matches(entry.label, entry.description)
    )
    if (filtering && listing?.status === 'ready' && !listing.cursor && !indexMatches && entries.length === 0) return
    rows.push(
      <TreeRow
        key={layer}
        depth={0}
        icon={icon}
        name={name}
        mono={mono}
        layer
        title={title}
        open={shown}
        className={rows.length ? 'mt-1' : ''}
        onClick={() => toggle(layer)}
      />
    )
    if (!shown) return
    if (!listing || listing.status === 'loading') {
      rows.push(
        <div key={`${layer}:loading`} className="flex py-[6px] pl-12" role="status" aria-label={t('loadingMemory')}>
          <Spinner size={14} />
        </div>
      )
      return
    }
    if (listing.status === 'unsupported') {
      rows.push(
        <TreeNote key={`${layer}:unsupported`} depth={0}>
          {t('unsupportedTitle')}
        </TreeNote>
      )
      return
    }
    if (listing.status === 'failed') {
      if (layer === SHARED && asleepView) return
      rows.push(
        <TreeNote key={`${layer}:failed`} depth={0} tone="error">
          {listing.error}
        </TreeNote>
      )
      return
    }
    if (indexMatches) fileRows++
    if (indexMatches)
      rows.push(
        <TreeRow
          key={`${layer}:index`}
          depth={1}
          icon="book-bookmark"
          name={t('memoryFile')}
          title={t('overviewTitle')}
          aside={formatFileMtime(overviewMtimes[layer] ?? null)}
          selected={selection?.kind === 'overview' && selection.layer === layer}
          disabled={rowsLocked}
          onClick={() => void select({ kind: 'overview', layer })}
        />
      )
    fileRows += entries.length
    for (const [index, entry] of entries.entries())
      rows.push(
        <TreeRow
          key={`${layer}:${entry.ref}:${index}`}
          depth={1}
          icon={entry.format === 'markdown' ? 'file-text' : 'sticky-note'}
          name={entry.label || 'Untitled memory'}
          title={entry.description ?? entry.label}
          aside={entry.origin === 'inherited' ? 'inherited' : entry.updatedAt ? formatFileMtime(entry.updatedAt) : ''}
          selected={selection?.kind === 'entry' && selection.layer === layer && selection.ref === entry.ref}
          disabled={rowsLocked}
          onClick={() => void select({ kind: 'entry', layer, ref: entry.ref })}
        />
      )
    if (listing.cursor && (!filtering || listing.pageFailed))
      rows.push(
        <div key={`${layer}:more`} className="py-1 pl-11">
          <Button
            variant="ghost"
            size="xs"
            disabled={listing.paging || saving}
            onClick={() => void loadMore(layer, listing)}
          >
            {listing.paging ? t('loading') : t('loadMore')}
          </Button>
        </div>
      )
  }

  if (!(asleepView && filtering)) {
    entryLayer(SHARED, t('sharedLayer'), 'globe', false)
    for (const entry of readable)
      entryLayer(PLACE + entry.channelKey, placeLayerName(entry), 'lock', true, placeLayerLabel(entry))
    if (!filtering)
      for (const entry of hidden)
        rows.push(
          <TreeRow
            key={`hidden:${entry.channelKey}`}
            depth={0}
            icon="lock"
            name={placeLayerName(entry)}
            layer
            muted
            title={t('notVisibleToYou', { name: placeLayerLabel(entry) })}
            aside={<Icon name="eye-off" size={13} />}
            selected={selection?.kind === 'hidden' && selection.channelKey === entry.channelKey}
            disabled={rowsLocked}
            className="mt-1"
            onClick={() => void select({ kind: 'hidden', channelKey: entry.channelKey })}
          />
        )
    const personalFiles = (personal?.status === 'ready' ? personal.files : []).filter((entry) => matches(entry.name))
    if (!(filtering && personal?.status === 'ready' && personalFiles.length === 0)) {
      const shown = isOpen(PERSONAL)
      rows.push(
        <TreeRow
          key={PERSONAL}
          depth={0}
          icon="user"
          name={t('personalLayer')}
          mono={false}
          layer
          open={shown}
          className="mt-1"
          onClick={() => toggle(PERSONAL)}
        />
      )
      if (shown) {
        if (!personal || personal.status === 'loading')
          rows.push(
            <div key="personal:loading" className="flex py-[6px] pl-12" role="status" aria-label={t('loadingMemory')}>
              <Spinner size={14} />
            </div>
          )
        else if (personal.status === 'failed')
          rows.push(
            <TreeNote key="personal:failed" depth={0}>
              {t('yourMemoryUnavailable')}
            </TreeNote>
          )
        else if (personal.files.length === 0)
          rows.push(
            <TreeNote key="personal:empty" depth={0}>
              {t('yourMemoryEmpty')}
            </TreeNote>
          )
        else {
          fileRows += personalFiles.length
          for (const entry of personalFiles)
            rows.push(
              <TreeRow
                key={`personal:${entry.name}`}
                depth={1}
                icon="file-text"
                name={entry.name}
                aside={formatFileMtime(entry.mtime)}
                selected={selection?.kind === 'personal' && selection.name === entry.name}
                disabled={rowsLocked}
                onClick={() => void select({ kind: 'personal', name: entry.name })}
              />
            )
        }
      }
    }
  }
  const settled =
    Object.values(listings).every(
      (listing) =>
        listing.status !== 'loading' && !(listing.status === 'ready' && listing.cursor && !listing.pageFailed)
    ) && personal?.status !== 'loading'
  const noMatches = filtering && settled && fileRows === 0

  const newMemory = canCreate ? (
    <Button
      variant="secondary"
      size="xs"
      className="flex-none"
      disabled={saving || reading || (editing && !blocked) || blocked}
      onClick={() => {
        resetReader()
        setSelection({ kind: 'create', layer: createLayer })
        setMobileReader(true)
      }}
    >
      <Icon name="file-plus" size={13} />
      {t('newMemory')}
    </Button>
  ) : null

  // The reader's header: the file, where it lives and when it last changed, then what may be done with it.
  const selectedPersonal =
    selection?.kind === 'personal' && personal?.status === 'ready'
      ? personal.files.find((entry) => entry.name === selection.name)
      : undefined
  const headerName = creating
    ? t('newMemory')
    : selection?.kind === 'hidden'
      ? hiddenSelected
        ? placeLayerName(hiddenSelected)
        : ''
      : selection?.kind === 'personal'
        ? selection.name
        : topic
          ? topic.name
          : selection?.kind === 'overview'
            ? t('memoryFile')
            : (doc?.entry.label ?? '')
  const updatedAt =
    selection?.kind === 'entry'
      ? doc?.entry.updatedAt
      : selection?.kind === 'personal'
        ? (file?.mtime ?? selectedPersonal?.mtime)
        : selection?.kind === 'overview'
          ? (topic ?? file)?.mtime
          : undefined
  const headerLayer =
    selection?.kind === 'personal' ? t('personalLayer') : selectedLayer ? layerName(selectedLayer) : undefined
  const headerActions = topic ? (
    <Button variant="ghost" size="sm" onClick={() => setTopic(null)}>
      <Icon name="arrow-left" size={13} />
      {t('backToOverview')}
    </Button>
  ) : editing ? (
    <>
      <Button
        variant="ghost"
        size="sm"
        disabled={saving}
        onClick={() => {
          if (creating) {
            resetReader()
            setSelection(null)
          } else {
            setMode(null)
            setDraft('')
          }
        }}
      >
        {t('cancel')}
      </Button>
      <Button
        size="sm"
        disabled={saving || blocked || tooLarge || !supports(creating ? 'create' : 'update')}
        onClick={() => void mutate()}
      >
        {saving ? t('saving') : t('saveMemory')}
      </Button>
    </>
  ) : doc && !reading ? (
    <>
      {selectedCaps?.operations.includes('history') ? (
        <Button
          variant="ghost"
          size="sm"
          ariaLabel={showHistory ? t('hideHistory') : t('history')}
          ariaExpanded={showHistory}
          onClick={() => setShowHistory((value) => !value)}
        >
          <Icon name="rotate-ccw-clock" size={14} className="desktop:hidden" />
          <span className="max-desktop:hidden">{showHistory ? t('hideHistory') : t('history')}</span>
        </Button>
      ) : null}
      {supports('delete') && editable ? (
        <Button
          variant="ghost"
          size="sm"
          ariaLabel={t('deleteMemory')}
          disabled={saving || blocked || confirmDelete}
          onClick={() => setConfirmDelete(true)}
        >
          <Icon name="trash" size={14} className="desktop:hidden" />
          <span className="max-desktop:hidden">{t('delete')}</span>
        </Button>
      ) : null}
      {supports('update') && editable ? (
        <Button
          variant="secondary"
          size="sm"
          ariaLabel={t('editMemory')}
          disabled={saving || blocked}
          onClick={() => {
            setDraft(doc.text)
            setMode('update')
            setError(undefined)
          }}
        >
          <Icon name="pencil" size={14} className="desktop:hidden" />
          <span className="max-desktop:hidden">{t('edit')}</span>
        </Button>
      ) : null}
    </>
  ) : null

  const docLink = (href: string) =>
    resolveFileBrowserMarkdownLink(
      href,
      (candidate) => {
        const name = memoryFileFromHref(candidate)
        const ref = name && doc ? linkedMemoryRef(doc, name) : undefined
        return name && ref ? { path: name, name, ref } : null
      },
      (target) => {
        if (selectedLayer && target.ref) void select({ kind: 'entry', layer: selectedLayer, ref: target.ref })
      }
    )
  const indexLink = (href: string) =>
    resolveFileBrowserMarkdownLink(
      href,
      (candidate) => {
        const name = memoryFileFromHref(candidate)
        return name ? { path: name, name } : null
      },
      (target) => {
        if (selectedLayer) void openTopic(selectedLayer, target.path)
      }
    )

  const shownFile = topic ?? file
  const body = reading ? (
    <div className="flex flex-1 items-center justify-center py-10">
      <Spinner size={24} />
    </div>
  ) : selection?.kind === 'hidden' && hiddenSelected ? (
    <div
      data-memory-hidden-layer
      className="m-5 flex flex-col gap-3 rounded-md border border-(--border-subtle) p-4 desktop:flex-row desktop:items-center desktop:justify-between"
    >
      <span className="font-sans text-[13px] font-normal leading-[1.5] text-(--text-secondary)">
        {t('notVisibleBody')}
      </span>
      {hiddenSelected.clearable ? (
        <Button
          variant="danger"
          size="sm"
          className="self-start desktop:self-auto"
          onClick={() => {
            setClearError(null)
            setConfirmingClear(true)
          }}
        >
          {t('clearLayer')}
        </Button>
      ) : null}
    </div>
  ) : editing ? (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
      {creating ? (
        <input
          aria-label={t('memoryName')}
          placeholder={t('nameOptional')}
          value={label}
          maxLength={512}
          disabled={saving}
          onChange={(e) => setLabel(e.target.value)}
          className="inp mono h-8 min-h-8 px-[10px] py-1 text-[12.5px]"
          spellCheck={false}
        />
      ) : null}
      <textarea
        aria-label={t('memoryContent')}
        value={draft}
        disabled={saving}
        onChange={(e) => setDraft(e.target.value)}
        className="inp mono min-h-[300px] flex-1 resize-y px-3 py-[10px] leading-[1.6] focus:border-(--brand) focus:outline-none"
        spellCheck={false}
        autoFocus
      />
      {tooLarge ? (
        <div role="alert" className="font-sans text-[12.5px] font-normal leading-normal text-(--status-error)">
          {t('tooLarge')}
        </div>
      ) : null}
      {blocked && doc && selection?.kind === 'entry' ? (
        <div>
          <Button variant="secondary" size="xs" disabled={saving} onClick={() => void select(selection)}>
            {t('reloadSaved')}
          </Button>
        </div>
      ) : null}
    </div>
  ) : doc && showHistory && selectedLayer ? (
    <div className="min-h-0 flex-1 overflow-auto px-5 pb-4 pt-1 font-sans text-[12.5px] leading-normal">
      <UnifiedMemoryHistory agentId={agentId} entryRef={doc.entry.ref} channelKey={channelKeyOf(selectedLayer)} />
    </div>
  ) : doc ? (
    <div className="min-h-0 flex-1 overflow-auto px-6 pb-8 pt-5">
      <div className="max-w-[640px]">
        {doc.entry.description ? (
          <p className="mb-[14px] mt-0 font-sans text-[15px] font-normal leading-[1.6] text-(--text-secondary)">
            {doc.entry.description}
          </p>
        ) : null}
        {doc.entry.format === 'markdown' ? (
          <MarkdownView content={doc.text} resolveLink={docLink} />
        ) : (
          <pre className="m-0 whitespace-pre-wrap break-words font-sans text-[14px] font-normal leading-[1.6] text-(--text-primary)">
            {doc.text}
          </pre>
        )}
        {doc.links?.length || doc.backlinks?.length ? (
          <div className="mt-4 flex flex-col gap-1 border-t border-(--border-subtle) pt-3 font-sans text-[12px] font-normal leading-normal">
            {(
              [
                ['Links', doc.links],
                ['Backlinks', doc.backlinks]
              ] as Array<[string, MemoryEntryLink[] | undefined]>
            ).map(([title, edges]) =>
              edges?.length ? (
                <p key={title} className="m-0">
                  <span className="font-semibold text-(--text-secondary)">{title}:</span>{' '}
                  {edges.map((edge, index) => (
                    <span key={`${edge.label}:${index}`}>
                      {index > 0 ? ', ' : ''}
                      {edge.ref && selectedLayer ? (
                        <button
                          type="button"
                          className="lnk text-[12px]"
                          disabled={rowsLocked}
                          onClick={() => void select({ kind: 'entry', layer: selectedLayer, ref: edge.ref! })}
                        >
                          {edge.label}
                        </button>
                      ) : (
                        <span className="text-(--text-tertiary)">
                          {edge.label} {t('missing')}
                        </span>
                      )}
                    </span>
                  ))}
                </p>
              ) : null
            )}
          </div>
        ) : null}
        {doc.metadata && Object.keys(doc.metadata).length ? (
          <dl className="mt-4 grid grid-cols-[minmax(72px,auto)_minmax(0,1fr)] gap-x-3 gap-y-1 border-t border-(--border-subtle) pt-3 font-sans text-[11.5px] font-normal leading-normal">
            {Object.entries(doc.metadata).map(([key, value]) => (
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
    </div>
  ) : shownFile ? (
    shownFile.exists && shownFile.content.trim() ? (
      <div className="min-h-0 flex-1 overflow-auto px-6 pb-8 pt-5">
        <div className="max-w-[640px]">
          <MarkdownView
            content={shownFile.content}
            resolveLink={selection?.kind === 'overview' ? indexLink : undefined}
          />
        </div>
      </div>
    ) : (
      <div className="px-6 py-6 font-sans text-[13px] font-normal leading-normal text-(--text-tertiary)">
        {topic ? t('topicMissing') : selection?.kind === 'overview' ? t('noOverview') : t('yourMemoryUnavailable')}
      </div>
    )
  ) : null

  const showReader = isMobile && mobileReader && selection !== null
  const readerHasHeader = selection !== null && !(selection.kind === 'hidden' && !hiddenSelected)

  return (
    <div className="flex flex-col gap-4">
      {header}
      <div className="card overflow-hidden max-desktop:rounded-lg desktop:grid desktop:h-[620px] desktop:grid-cols-[320px_minmax(0,1fr)]">
        <div
          data-memory-pane="tree"
          className={`${showReader ? 'hidden desktop:flex' : 'flex'} min-h-0 flex-col desktop:border-r desktop:border-(--border-subtle)`}
        >
          <div className="flex items-center gap-[6px] border-b border-(--border-subtle) p-[10px]">
            <label className="flex h-[30px] min-w-0 flex-1 items-center gap-2 rounded-sm border border-(--border-default) bg-(--surface-card) px-[10px]">
              <Icon name="search" size={14} strokeWidth={2} color="var(--text-tertiary)" className="flex-none" />
              <input
                aria-label={t('filterFiles')}
                placeholder={t('filterFiles')}
                value={query}
                maxLength={256}
                onChange={(e) => setQuery(e.target.value)}
                className="min-w-0 flex-1 border-0 bg-transparent p-0 font-sans text-[13px] font-normal leading-normal text-(--text-primary) outline-none placeholder:text-(--text-tertiary)"
              />
            </label>
            <button
              type="button"
              className="iconbtn flex-none"
              title={t('refresh')}
              aria-label={t('refresh')}
              disabled={saving || (editing && !blocked)}
              onClick={() => void refresh()}
            >
              <Icon name="refresh-cw" size={15} strokeWidth={1.9} />
            </button>
            {newMemory}
          </div>
          <div className="min-h-0 flex-1 overflow-auto pb-[10px] pt-[6px]">
            {asleepView && sharedListing?.status !== 'loading' ? (
              wake.phase === 'starting' ? (
                <SandboxStartingNotice compact />
              ) : (
                <SandboxAsleepNotice
                  wake={wake}
                  startable={sandboxed || asleep}
                  compact
                  notice={
                    <div className="px-3 py-[10px] font-sans text-[12px] font-normal leading-[1.55] text-(--text-secondary)">
                      {MEMORY_SANDBOX_ASLEEP_NOTICE}
                    </div>
                  }
                />
              )
            ) : null}
            {rows}
            {noMatches ? (
              <div className="p-4 font-sans text-[13px] font-normal leading-normal text-(--text-tertiary)">
                {t('noFilesMatch')}
              </div>
            ) : null}
          </div>
          <div className="border-t border-(--border-subtle) px-[14px] py-[9px] font-mono text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
            {t('layersYouCanSee', { count: readable.length + 2 })}
          </div>
        </div>
        <div
          data-memory-pane="reader"
          className={`${showReader ? 'flex' : 'hidden desktop:flex'} min-h-0 min-w-0 flex-col max-desktop:min-h-[360px]`}
        >
          {readerHasHeader ? (
            <div className="flex min-h-[51px] flex-none items-center gap-3 border-b border-(--border-subtle) py-2 pl-5 pr-3 max-desktop:pl-2 desktop:h-[51px]">
              {isMobile ? (
                <button
                  type="button"
                  className="iconbtn h-7 w-7 flex-none"
                  disabled={editing && !blocked}
                  onClick={() => setMobileReader(false)}
                  title={tFiles('backToFiles')}
                  aria-label={tFiles('backToFiles')}
                >
                  <Icon name="arrow-left" size={15} />
                </button>
              ) : null}
              <div className="flex min-w-0 flex-1 max-desktop:flex-col desktop:items-baseline desktop:gap-[10px]">
                <span className="min-w-0 max-w-full truncate font-mono text-[13.5px] font-medium leading-normal text-(--text-primary)">
                  {headerName}
                </span>
                {headerLayer ? (
                  <span className="min-w-0 max-w-full shrink-[4] truncate font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
                    <span className="font-mono text-(--text-secondary)">{headerLayer}</span>
                    {updatedAt ? (
                      <>
                        {' · '}
                        {t('updated', { date: formatFileMtime(updatedAt) })}
                      </>
                    ) : null}
                  </span>
                ) : null}
              </div>
              <div className="flex flex-none gap-[6px]">{headerActions}</div>
            </div>
          ) : null}
          {confirmDelete && doc ? (
            <div className="flex flex-wrap items-center gap-2 border-b border-(--border-subtle) bg-(--surface-sunken) px-5 py-2 font-sans text-[12.5px] font-normal leading-normal text-(--text-primary)">
              <span className="min-w-0 flex-1">
                {t('deleteConfirm', {
                  name: doc.entry.label || t('thisMemory'),
                  override: channelKeyOf(selectedLayer ?? '') ? t('overrideWarning') : ''
                })}
              </span>
              <Button
                variant="danger"
                size="xs"
                disabled={saving || blocked || !supports('delete')}
                onClick={() => void mutate(true)}
              >
                {t('confirmDeletion')}
              </Button>
              <Button variant="secondary" size="xs" disabled={saving} onClick={() => setConfirmDelete(false)}>
                {t('keepMemory')}
              </Button>
            </div>
          ) : null}
          {notice ? (
            <div
              role="status"
              className="border-b border-(--border-subtle) px-5 py-2 font-sans text-[12px] font-normal leading-normal text-(--text-secondary)"
            >
              {notice}
            </div>
          ) : null}
          {error ? (
            <div
              role="alert"
              className="border-b border-(--border-subtle) px-5 py-2 font-sans text-[12px] font-normal leading-normal text-(--status-error)"
            >
              {error}
            </div>
          ) : null}
          {selection === null ? (
            <div className="flex flex-1 items-center justify-center px-4 py-10 font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
              {t('selectMemory')}
            </div>
          ) : (
            body
          )}
        </div>
      </div>
      {confirmingClear && hiddenSelected ? (
        <ConfirmationDialog
          title={t('clearLayerTitle')}
          confirmLabel={t('clearLayer')}
          busyLabel={t('clearingLayer')}
          destructive
          busy={clearing}
          error={clearError}
          onClose={() => {
            if (!clearing) setConfirmingClear(false)
          }}
          onConfirm={() => void clearHidden()}
        >
          <p className="m-0">{t('clearLayerBody', { name: placeLayerLabel(hiddenSelected) })}</p>
        </ConfirmationDialog>
      ) : null}
    </div>
  )
}
