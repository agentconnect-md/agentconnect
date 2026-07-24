'use client'

// Agent memory viewer/editor — the memory DIRECTORY at the agent root
// (<agent-root>/memory/): a MEMORY.md index plus topic files the agent maintains
// across sessions. Content is proxied through the CP straight from the owning
// daemon (never stored on the CP, body-locality), so a 503 here just means that
// daemon is offline / the agent is unplaced — an expected state, rendered as a
// friendly notice.
//
// Left: the file list (index + topics). Right: the selected file, viewed as
// markdown or edited in a textarea + Save (PUT). "New topic" creates a file. The
// CP enforces edit permission (a 403 surfaces as an error), matching the console.

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import {
  fetchAgentMemoryFull,
  updateAgentMemory,
  listAgentMemory,
  ApiError,
  type MemoryFileEntry,
  type MemoryDreamingConfig
} from '@/lib/api'
import { useConsoleData } from '@/lib/data-context'
import { Spinner } from '@/components/marks'
import { Icon, Button } from '@/components/ui'
import { resolveMemoryMarkdownLink } from '@/components/console/memory-links'
import {
  ExternalMemoryBindingFields,
  type ExternalMemoryBindingDraft
} from '@/components/console/ExternalMemoryBindingFields'
import { MemoryProviderPicker } from '@/components/console/MemoryProviderPicker'
import {
  cloneMemorySettings,
  memoryBackendChanged,
  memoryConfigForDraft,
  memoryProviderLabel,
  memorySettingsBlocker,
  memorySettingsChanged,
  memorySettingsDraft,
  type MemoryProviderChoice,
  type MemorySettingsDraft
} from '@/components/console/memory-settings'
import {
  FileBrowserLayout,
  FileBrowserPreviewHeader,
  FileBrowserRow,
  FileBrowserShell
} from '@/components/console/FileBrowser'
import { RecordMemoryPanel } from '@/components/console/RecordMemoryPanel'
import { ConfirmationDialog } from '@/components/console/ConfirmationDialog'

const MarkdownView = dynamic(() => import('@/components/console/MarkdownView'), {
  ssr: false,
  loading: () => (
    <div className="px-[18px] py-4 font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
      Rendering…
    </div>
  )
})

const INDEX = 'MEMORY.md'
const TOPIC_RE = /^[A-Za-z0-9._-]+\.md$/ // flat file name, .md
const AGENT_SCOPE_HELP =
  'Agent scope is the only option currently. Memory is shared across all users who interact with this agent.'

function MemoryScopeField() {
  const tooltipId = useId()

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <span className="font-sans text-[13px] font-semibold leading-normal">Scope</span>
      <span className="group relative inline-flex items-center gap-1">
        <span className="pillbar">
          <button
            type="button"
            disabled
            data-memory-scope="agent"
            aria-describedby={tooltipId}
            className="pill on cursor-not-allowed px-2 py-1 text-[12px]"
          >
            Agent
          </button>
        </span>
        <button
          type="button"
          className="inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full text-(--text-tertiary) transition-colors hover:text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--brand)"
          aria-label="About agent memory scope"
          aria-describedby={tooltipId}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              event.currentTarget.blur()
            }
          }}
        >
          <Icon name="info" size={13} />
        </button>
        <span
          id={tooltipId}
          role="tooltip"
          className="pointer-events-none invisible absolute top-full left-0 z-30 mt-2 w-[280px] max-w-[calc(100vw-72px)] -translate-y-1 rounded-md border border-(--border-default) bg-(--surface-card) p-3 font-sans text-[11.5px] font-normal leading-[1.4] text-(--text-secondary) opacity-0 shadow-(--shadow-lg) transition-[opacity,transform,visibility] duration-150 group-hover:visible group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:visible group-focus-within:translate-y-0 group-focus-within:opacity-100"
        >
          {AGENT_SCOPE_HELP}
        </span>
      </span>
    </div>
  )
}

function settingsFromProps(input: {
  memoryProvider: string
  autoDistill: boolean
  memoryDreaming?: MemoryDreamingConfig
  memoryConnectionId?: string
  memoryRecall?: ExternalMemoryBindingDraft['recall']
  memoryCaptureMode?: ExternalMemoryBindingDraft['captureMode']
}): MemorySettingsDraft {
  return memorySettingsDraft({
    provider: input.memoryProvider,
    autoDistill: input.autoDistill,
    dreaming: input.memoryDreaming,
    connectionId: input.memoryConnectionId,
    recall: input.memoryRecall,
    captureMode: input.memoryCaptureMode
  })
}

export function MemoryPanel({
  agentId,
  canEdit,
  memoryProvider,
  autoDistill,
  memoryDreaming,
  memoryConnectionId,
  memoryRecall,
  memoryCaptureMode
}: {
  agentId: string
  canEdit: boolean
  memoryProvider: string
  autoDistill: boolean
  memoryDreaming?: MemoryDreamingConfig
  memoryConnectionId?: string
  memoryRecall?: ExternalMemoryBindingDraft['recall']
  memoryCaptureMode?: ExternalMemoryBindingDraft['captureMode']
}) {
  const { updateAgent } = useConsoleData()
  const [files, setFiles] = useState<MemoryFileEntry[]>([])
  const [listLoading, setListLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)
  const [selected, setSelected] = useState(INDEX)
  const [content, setContent] = useState('')
  const [loadedMtime, setLoadedMtime] = useState<string | null>(null)
  const [fileExists, setFileExists] = useState<boolean | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const loadRequest = useRef(0)
  const listRequest = useRef(0)

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  // Existing-agent memory settings are one explicit draft. The content below
  // continues to reflect `persistedSettings` until Save succeeds, so selecting a
  // different backend can never make an unsaved choice look active.
  const initialSettings = settingsFromProps({
    memoryProvider,
    autoDistill,
    memoryDreaming,
    memoryConnectionId,
    memoryRecall,
    memoryCaptureMode
  })
  const [settings, setSettings] = useState<MemorySettingsDraft>(() => cloneMemorySettings(initialSettings))
  const [persistedSettings, setPersistedSettings] = useState<MemorySettingsDraft>(() =>
    cloneMemorySettings(initialSettings)
  )
  const [savingProvider, setSavingProvider] = useState(false)
  const [providerError, setProviderError] = useState<string | null>(null)
  const [confirmingBackendChange, setConfirmingBackendChange] = useState(false)
  const [previewRequest, setPreviewRequest] = useState(0)
  // The settings form is collapsed behind a one-line summary by default so the
  // memory content itself stays the page's focus. Closing the form discards any
  // unsaved draft — a closed form always summarizes the persisted settings.
  const [settingsOpen, setSettingsOpen] = useState(false)

  useEffect(() => {
    setSettingsOpen(false)
  }, [agentId])

  // Polling replaces the agent DTO (and its recall object) even when the
  // persisted values are unchanged. Depend on the semantic fields so an
  // equivalent refresh cannot discard an in-progress draft.
  useEffect(() => {
    const next = settingsFromProps({
      memoryProvider,
      autoDistill,
      memoryConnectionId,
      memoryRecall,
      memoryCaptureMode
    })
    setSettings(cloneMemorySettings(next))
    setPersistedSettings(cloneMemorySettings(next))
    setProviderError(null)
    setConfirmingBackendChange(false)
  }, [
    agentId,
    memoryProvider,
    autoDistill,
    memoryConnectionId,
    memoryRecall?.mode,
    memoryRecall?.topK,
    memoryRecall?.maxBytes,
    memoryRecall?.timeoutMs,
    memoryCaptureMode
  ])

  const provider = settings.provider
  const persistedProvider = persistedSettings.provider
  const settingsChanged = memorySettingsChanged(persistedSettings, settings)
  const backendChanged = memoryBackendChanged(persistedSettings, settings)
  const settingsBlocker = memorySettingsBlocker(settings)
  const persistedProviderLabel = memoryProviderLabel(persistedProvider)
  const providerLabel = memoryProviderLabel(provider)

  const selectProvider = (next: MemoryProviderChoice) => {
    if (savingProvider) return
    setSettings((current) => ({ ...current, provider: next }))
    setProviderError(null)
  }

  const persistMemorySettings = async () => {
    if (savingProvider || !settingsChanged) return
    if (settingsBlocker) {
      setProviderError(settingsBlocker)
      return
    }
    setSavingProvider(true)
    setProviderError(null)
    try {
      await updateAgent(agentId, { memory: memoryConfigForDraft(settings) })
      setPersistedSettings(cloneMemorySettings(settings))
      setConfirmingBackendChange(false)
      setSettingsOpen(false)
    } catch (e) {
      setProviderError(e instanceof Error ? e.message : String(e))
    } finally {
      setSavingProvider(false)
    }
  }

  const saveMemorySettings = () => {
    if (savingProvider || !settingsChanged) return
    if (settingsBlocker) {
      setProviderError(settingsBlocker)
      return
    }
    if (backendChanged) {
      setProviderError(null)
      setConfirmingBackendChange(true)
      return
    }
    void persistMemorySettings()
  }

  const discardMemorySettings = () => {
    if (savingProvider) return
    setSettings(cloneMemorySettings(persistedSettings))
    setProviderError(null)
    setConfirmingBackendChange(false)
  }

  const closeSettings = () => {
    if (savingProvider) return
    discardMemorySettings()
    setSettingsOpen(false)
  }

  // One-line summary of the PERSISTED settings for the collapsed bar. Scope is
  // always named — memory is agent-scoped and shared across users.
  const settingsSummary = (() => {
    switch (persistedProvider) {
      case 'managed':
        return `Managed directory · Auto-distill ${persistedSettings.autoDistill ? 'on' : 'off'} · Dreaming ${persistedSettings.dreaming.enabled ? 'on' : 'off'} · Agent scope`
      case 'native':
        return 'Runtime-native memory · Agent scope'
      case 'external': {
        const { connectionId, recall, captureMode } = persistedSettings.external
        return [
          connectionId ? `Connection ${connectionId.slice(0, 8)}` : 'No connection',
          `Recall ${recall.mode === 'auto' ? 'every turn' : 'tool only'}`,
          `Capture ${captureMode === 'turn' ? 'every turn' : 'manual'}`,
          'Agent scope'
        ].join(' · ')
      }
      case 'none':
        return 'Persistent memory is off'
    }
  })()

  // Load the file list once (and refresh it after a create/save).
  const loadList = useCallback(async () => {
    const request = ++listRequest.current
    setListLoading(true)
    setListError(null)
    try {
      const { files } = await listAgentMemory(agentId)
      if (request !== listRequest.current) return
      setFiles(files)
    } catch (e) {
      if (request !== listRequest.current) return
      setListError(
        e instanceof ApiError && e.status === 503
          ? "Couldn't list memory — the owning daemon may be offline."
          : e instanceof Error
            ? e.message
            : String(e)
      )
    } finally {
      if (request === listRequest.current) setListLoading(false)
    }
  }, [agentId])

  // Load one file's content WHOLE (paging every slice) so the editor holds the full
  // file — a partial read would let Save clobber the tail. The index is fetched via
  // ?path omitted.
  const loadFile = useCallback(
    async (name: string) => {
      const request = ++loadRequest.current
      setLoading(true)
      setError(null)
      setEditing(false)
      setContent('')
      setLoadedMtime(null)
      setFileExists(null)
      try {
        const mem = await fetchAgentMemoryFull(agentId, name === INDEX ? undefined : name)
        if (request !== loadRequest.current) return
        setContent(mem.content)
        setLoadedMtime(mem.mtime)
        setFileExists(mem.exists)
      } catch (e) {
        if (request !== loadRequest.current) return
        setError(
          e instanceof ApiError && e.status === 503
            ? "Couldn't read the file — the owning daemon may be offline."
            : e instanceof Error
              ? e.message
              : String(e)
        )
      } finally {
        if (request === loadRequest.current) setLoading(false)
      }
    },
    [agentId]
  )

  useEffect(() => {
    loadRequest.current += 1
    listRequest.current += 1
    setFiles([])
    setSelected(INDEX)
    setContent('')
    setEditing(false)
    setError(null)
    if (persistedProvider === 'none' || persistedProvider === 'external') {
      setListLoading(false)
      setLoading(false)
      return
    }
    void loadList()
    void loadFile(INDEX)
    return () => {
      loadRequest.current += 1
      listRequest.current += 1
    }
  }, [loadList, loadFile, persistedProvider])

  const select = (name: string) => {
    if (name === selected) {
      if (error) void loadFile(name)
      return
    }
    setSelected(name)
    void loadFile(name)
  }

  const resolveMemoryLink = (href: string) => resolveMemoryMarkdownLink(href, select)

  const newTopic = () => {
    const name = window.prompt('New memory file name (e.g. "deploys.md"):')?.trim()
    if (!name) return
    if (!TOPIC_RE.test(name) || name === INDEX) {
      window.alert('Use a flat .md file name, e.g. "deploys.md".')
      return
    }
    loadRequest.current += 1
    setLoading(false)
    setSelected(name)
    setContent('')
    setLoadedMtime(null) // brand-new file — no precondition
    setFileExists(false)
    setError(null)
    setDraft(`# ${name.replace(/\.md$/, '')}\n\n`)
    setSaveError(null)
    setEditing(true)
    setPreviewRequest((request) => request + 1)
  }

  const save = async () => {
    setSaving(true)
    setSaveError(null)
    try {
      const res = await updateAgentMemory(agentId, draft, selected === INDEX ? undefined : selected, loadedMtime)
      setContent(draft)
      setLoadedMtime(res.mtime) // track the new mtime for the next edit
      setFileExists(true)
      setEditing(false)
      await loadList() // a brand-new topic now shows in the list
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setSaveError('This file changed since you opened it (the agent may have updated it). Reload before saving.')
      } else {
        setSaveError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      setSaving(false)
    }
  }

  const renderFileTree = (openPreview: () => void) => (
    <>
      {listLoading && (
        <div className="flex justify-center py-4">
          <Spinner size={18} />
        </div>
      )}
      {!listLoading && listError && (
        <div className="flex flex-col items-start gap-2 px-4 py-3 font-sans text-[12px] font-normal leading-normal text-(--red-600)">
          <span>{listError}</span>
          <button type="button" className="lnk text-[12px]" onClick={() => void loadList()}>
            Retry
          </button>
        </div>
      )}
      {!listLoading && !listError && files.length === 0 && (
        <div className="px-4 py-3 font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
          No memory yet.
        </div>
      )}
      {!listLoading &&
        files.map((file) => (
          <FileBrowserRow
            key={file.name}
            icon={file.name === INDEX ? 'book-marked' : 'file-text'}
            name={file.name}
            selected={selected === file.name}
            onClick={() => {
              select(file.name)
              openPreview()
            }}
          />
        ))}
      {!listLoading && !files.some((file) => file.name === selected) && (
        <FileBrowserRow
          icon={selected === INDEX ? 'book-marked' : fileExists === false ? 'file-plus' : 'file-text'}
          name={selected}
          selected
          onClick={() => {
            select(selected)
            openPreview()
          }}
        />
      )}
    </>
  )

  const renderPreview = (onBack?: () => void) => (
    <>
      <FileBrowserPreviewHeader
        icon={selected === INDEX ? 'book-marked' : fileExists === false ? 'file-plus' : 'file-text'}
        name={selected}
        onBack={onBack}
        actions={
          !editing && canEdit && !loading && !error && fileExists !== null ? (
            <Button
              variant="secondary"
              size="xs"
              onClick={() => {
                setDraft(content)
                setSaveError(null)
                setEditing(true)
              }}
            >
              <Icon name="pencil" size={14} />
              Edit
            </Button>
          ) : undefined
        }
      />

      {loading ? (
        <div className="flex items-center justify-center py-10">
          <Spinner />
        </div>
      ) : error ? (
        <div className="flex flex-col items-start gap-3 px-4 py-6 font-sans text-[13px] font-normal leading-normal text-(--red-600)">
          <span>{error}</span>
          <Button variant="secondary" size="xs" onClick={() => void loadFile(selected)}>
            Retry
          </Button>
        </div>
      ) : editing ? (
        <div className="flex flex-col gap-3 p-4">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            spellCheck={false}
            className="mono min-h-[320px] w-full resize-y rounded-md border border-(--border-subtle) bg-(--surface-sunken) p-3 text-[12.5px] leading-[1.6] text-(--text-primary) outline-none focus:border-(--brand-soft-text)"
            placeholder={
              selected === INDEX
                ? '# Agent memory index\n\nKeep it short — link to topic files and read them on demand.'
                : '# Topic\n\nDurable notes for this topic…'
            }
          />
          {saveError && (
            <div className="font-sans text-[12.5px] font-normal leading-normal text-(--red-600)">{saveError}</div>
          )}
          <div className="flex items-center gap-2">
            <Button variant="primary" size="sm" onClick={() => void (saving ? undefined : save())}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => (saving ? undefined : setEditing(false))}>
              Cancel
            </Button>
          </div>
        </div>
      ) : content.trim() ? (
        <div className="max-h-[520px] overflow-auto px-[18px] py-4">
          <MarkdownView content={content} resolveLink={resolveMemoryLink} />
        </div>
      ) : (
        <div className="px-4 py-6 font-sans text-[13px] font-normal leading-normal text-(--text-tertiary)">
          {fileExists === false
            ? canEdit
              ? 'This file does not exist. You can create it here.'
              : 'This file does not exist.'
            : `${
                selected === INDEX
                  ? 'No memory index yet. The agent maintains its memory itself as it works'
                  : 'This file is empty'
              }${canEdit ? ', or you can edit it here.' : '.'}`}
        </div>
      )}
    </>
  )

  return (
    <div className="p-4 desktop:p-0">
      {/* Memory backend — a collapsed one-line summary; expanding it edits one
          explicit draft. Closing without saving discards the draft, so the
          summary and the content below always describe the persisted backend. */}
      <section className="card mb-4 overflow-hidden max-desktop:rounded-lg">
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <div className="flex min-w-0 flex-col gap-[3px]">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-sans text-[13px] font-semibold leading-normal">Memory backend</span>
              <span className="badge bg-(--surface-active) text-(--text-secondary)">{persistedProviderLabel}</span>
              {settingsChanged ? (
                <span
                  className="font-sans text-[11px] font-semibold leading-normal text-(--amber-500)"
                  aria-live="polite"
                >
                  Unsaved changes
                </span>
              ) : null}
            </div>
            <span className="truncate font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
              {settingsSummary}
            </span>
          </div>
          <Button
            variant="secondary"
            size="xs"
            disabled={savingProvider}
            onClick={() => (settingsOpen ? closeSettings() : setSettingsOpen(true))}
          >
            {settingsOpen ? (
              settingsChanged ? (
                'Cancel'
              ) : (
                'Close'
              )
            ) : canEdit ? (
              <>
                <Icon name="pencil" size={13} />
                Edit
              </>
            ) : (
              'Details'
            )}
          </Button>
        </div>

        {settingsOpen ? (
          <div className="flex flex-col gap-4 border-t border-(--border-subtle) px-4 py-4">
            <div className="flex flex-col gap-2">
              <span className="font-sans text-[13px] font-semibold leading-normal">Backend</span>
              <MemoryProviderPicker value={provider} onChange={selectProvider} disabled={!canEdit || savingProvider} />
              <span className="font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
                {provider === 'external'
                  ? 'An owner-reviewed external plugin; configure exactly what may be recalled and captured below.'
                  : provider === 'native'
                    ? "The runtime's own memory (Claude / Codex), isolated under the agent root."
                    : provider === 'none'
                      ? 'No persistent memory is loaded or saved.'
                      : 'A memory directory we keep for the agent.'}
              </span>
            </div>

            <MemoryScopeField />

            {provider === 'managed' ? (
              <label className="flex items-center gap-2 font-sans text-[12px] font-normal leading-normal text-(--text-secondary)">
                <input
                  type="checkbox"
                  checked={settings.autoDistill}
                  disabled={!canEdit || savingProvider}
                  onChange={() => {
                    setSettings((current) => ({ ...current, autoDistill: !current.autoDistill }))
                    setProviderError(null)
                  }}
                />
                Automatically distill durable facts after each turn (uses an additional model call; currently Claude
                runtimes only).
              </label>
            ) : null}

            {provider === 'managed' ? (
              <div className="flex flex-col gap-2">
                <label className="flex items-center gap-2 font-sans text-[12px] font-normal leading-normal text-(--text-secondary)">
                  <input
                    type="checkbox"
                    checked={settings.dreaming.enabled}
                    disabled={!canEdit || savingProvider}
                    onChange={() => {
                      setSettings((current) => ({
                        ...current,
                        dreaming: { ...current.dreaming, enabled: !current.dreaming.enabled }
                      }))
                      setProviderError(null)
                    }}
                  />
                  Enable dreaming — periodically consolidate the store from recent sessions (staged for review before it
                  replaces the live store).
                </label>
                {settings.dreaming.enabled ? (
                  <div className="ml-6 flex flex-col gap-2">
                    <label className="flex flex-col gap-1 font-sans text-[11px] font-normal leading-normal text-(--text-tertiary)">
                      Schedule (cron, optional — leave blank for manual only)
                      <input
                        type="text"
                        value={settings.dreaming.schedule}
                        placeholder="0 4 * * *"
                        disabled={!canEdit || savingProvider}
                        onChange={(e) => {
                          const schedule = e.target.value
                          setSettings((current) => ({ ...current, dreaming: { ...current.dreaming, schedule } }))
                          setProviderError(null)
                        }}
                        className="rounded-sm border border-(--border-subtle) bg-(--surface-card) px-2 py-1 font-mono text-[12px] leading-normal text-(--text-primary)"
                      />
                    </label>
                    <label className="flex flex-col gap-1 font-sans text-[11px] font-normal leading-normal text-(--text-tertiary)">
                      Instructions (optional — steer what the dream focuses on)
                      <textarea
                        value={settings.dreaming.instructions}
                        rows={2}
                        maxLength={4096}
                        placeholder="Focus on coding-style preferences; ignore one-off debugging notes."
                        disabled={!canEdit || savingProvider}
                        onChange={(e) => {
                          const instructions = e.target.value
                          setSettings((current) => ({ ...current, dreaming: { ...current.dreaming, instructions } }))
                          setProviderError(null)
                        }}
                        className="resize-y rounded-sm border border-(--border-subtle) bg-(--surface-card) px-2 py-1 font-sans text-[12px] leading-[1.5] text-(--text-primary)"
                      />
                    </label>
                  </div>
                ) : null}
              </div>
            ) : null}

            {provider === 'external' ? (
              <div className="flex flex-col gap-3">
                <ExternalMemoryBindingFields
                  value={settings.external}
                  onChange={(external) => {
                    setSettings((current) => ({ ...current, external }))
                    setProviderError(null)
                  }}
                  disabled={!canEdit || savingProvider}
                  emptySelectionDisabled={
                    persistedProvider === 'external' && Boolean(persistedSettings.external.connectionId)
                  }
                />
                {settingsBlocker ? (
                  <div className="font-sans text-[12px] font-normal leading-normal text-(--red-600)" role="alert">
                    {settingsBlocker} The agent is still using {persistedProviderLabel}.
                  </div>
                ) : null}
              </div>
            ) : null}

            {providerError ? (
              <div className="font-sans text-[12px] font-normal leading-normal text-(--red-600)" role="alert">
                {providerError}
              </div>
            ) : null}

            {canEdit ? (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-(--border-subtle) pt-3">
                <Button
                  size="sm"
                  disabled={savingProvider || !settingsChanged || Boolean(settingsBlocker)}
                  onClick={() => void saveMemorySettings()}
                >
                  {savingProvider ? 'Saving…' : 'Save memory settings'}
                </Button>
                <Button variant="ghost" size="sm" disabled={savingProvider} onClick={closeSettings}>
                  Cancel
                </Button>
                {settingsChanged ? (
                  <span
                    className="font-sans text-[11.5px] font-normal leading-normal text-(--amber-500)"
                    aria-live="polite"
                  >
                    {persistedProviderLabel} stays active until you save.
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </section>

      {backendChanged ? (
        <div
          className="rounded-(--radius-lg) border border-(--border-subtle) bg-(--surface-sunken) p-5 font-sans"
          role="status"
        >
          <div className="text-[13px] font-semibold text-(--text-primary)">{providerLabel} selected</div>
          <div className="mt-1 text-[12px] leading-[1.5] text-(--text-secondary)">
            {provider === 'none'
              ? 'Save memory settings to turn persistent memory off.'
              : provider === persistedProvider
                ? 'Save memory settings to switch External connections and view the selected connection’s memory.'
                : `Save memory settings to switch to ${providerLabel} and view its memory.`}{' '}
            {persistedProviderLabel} remains active until you save.
          </div>
        </div>
      ) : persistedProvider === 'external' ? (
        <RecordMemoryPanel
          key={`${agentId}:${persistedSettings.external.connectionId}`}
          agentId={agentId}
          canEdit={canEdit}
        />
      ) : persistedProvider === 'none' ? (
        <div className="rounded-(--radius-lg) border border-(--border-subtle) p-5 text-[13px] text-(--text-secondary)">
          Persistent memory is disabled for this agent. Existing memory remains stored but is not loaded.
        </div>
      ) : (
        <FileBrowserShell
          title="Memory"
          headerEnd={
            canEdit ? (
              <button
                type="button"
                onClick={newTopic}
                className="flex cursor-pointer items-center gap-[4px] border-0 bg-transparent p-0 font-sans text-[12.5px] font-semibold leading-normal text-(--brand-soft-text)"
              >
                <Icon name="plus" size={13} />
                New
              </button>
            ) : undefined
          }
        >
          <FileBrowserLayout
            resetKey={agentId}
            openPreviewSignal={previewRequest}
            tree={renderFileTree}
            preview={renderPreview}
          />
        </FileBrowserShell>
      )}
      {confirmingBackendChange ? (
        <ConfirmationDialog
          title="Switch memory backend?"
          confirmLabel="Switch backend"
          busy={savingProvider}
          error={providerError}
          onClose={() => {
            if (!savingProvider) setConfirmingBackendChange(false)
          }}
          onConfirm={() => void persistMemorySettings()}
        >
          <p className="m-0">
            This switches the agent from <strong className="font-semibold">{persistedProviderLabel}</strong> to{' '}
            <strong className="font-semibold">{memoryProviderLabel(provider)}</strong>. Existing memory is not migrated,
            and any pending capture stays with its original connection.
          </p>
        </ConfirmationDialog>
      ) : null}
    </div>
  )
}
