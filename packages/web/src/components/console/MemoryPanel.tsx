'use client'

// Agent memory viewer/editor — the memory DIRECTORY at the agent root
// (<agent-root>/memory/): a MEMORY.md index plus topic files the agent maintains
// across sessions. Content is proxied through the CP straight from the owning
// daemon (never stored on the CP, body-locality), so a 503 here just means that
// daemon is offline / the agent is unplaced — an expected state, rendered as a
// friendly notice.
//
// Left: the file list (index + topics). Right: the selected file, viewed as
// markdown or edited through the same inline file-browser surface as Workspace.
// The CP enforces edit permission (a 403 surfaces as an error), matching the console.

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import {
  fetchAgentMemoryFull,
  updateAgentMemory,
  listAgentMemory,
  fetchAgentMemoryChannels,
  ApiError,
  type MemoryFileEntry,
  type ManagedMemoryScope,
  type MemoryChannelDto,
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
  FileBrowserBreadcrumb,
  FileBrowserEditor,
  FileBrowserEditorActions,
  FileBrowserHistoryButton,
  FileBrowserLayout,
  FileBrowserPreviewSummary,
  FileBrowserRow,
  FileBrowserShell,
  formatFileMtime,
  formatFileSize,
  type FileBrowserEditorDraft
} from '@/components/console/FileBrowser'
import { RecordMemoryPanel } from '@/components/console/RecordMemoryPanel'
import { DreamPanel } from '@/components/console/DreamPanel'
import { DreamScheduleFields } from '@/components/console/DreamScheduleFields'
import { ConfirmationDialog } from '@/components/console/ConfirmationDialog'
import { ManagedMemoryHistory } from '@/components/console/ManagedMemoryHistory'
import { useIsMobile } from '@/lib/use-is-mobile'

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
const SCOPE_HELP =
  'Agent scope shares one memory across everyone who talks to this agent. Channel scope gives each channel (DMs and webchat included) its own memory folder, so different channels never mix. Dreaming is turned off under channel scope.'

function MemoryScopeField({
  scope,
  canEdit,
  onChange
}: {
  scope: ManagedMemoryScope
  canEdit: boolean
  onChange: (next: ManagedMemoryScope) => void
}) {
  const tooltipId = useId()
  const options: Array<{ value: ManagedMemoryScope; label: string }> = [
    { value: 'agent', label: 'Agent' },
    { value: 'channel', label: 'Channel' }
  ]

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <span className="font-sans text-[13px] font-semibold leading-normal">Scope</span>
      <span className="group relative inline-flex items-center gap-1">
        <span className="pillbar">
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              disabled={!canEdit}
              data-memory-scope={option.value}
              aria-pressed={scope === option.value}
              aria-describedby={tooltipId}
              className={`pill ${scope === option.value ? 'on' : ''} px-2 py-1 text-[12px] ${canEdit ? 'cursor-pointer' : 'cursor-not-allowed'}`}
              onClick={() => {
                if (canEdit) onChange(option.value)
              }}
            >
              {option.label}
            </button>
          ))}
        </span>
        <button
          type="button"
          className="inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full text-(--text-tertiary) transition-colors hover:text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--brand)"
          aria-label="About memory scope"
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
          {SCOPE_HELP}
        </span>
      </span>
    </div>
  )
}

function settingsFromProps(input: {
  memoryProvider: string
  autoDistill: boolean
  memoryScope?: ManagedMemoryScope
  memoryDreaming?: MemoryDreamingConfig
  memoryConnectionId?: string
  memoryRecall?: ExternalMemoryBindingDraft['recall']
  memoryCaptureMode?: ExternalMemoryBindingDraft['captureMode']
}): MemorySettingsDraft {
  return memorySettingsDraft({
    provider: input.memoryProvider,
    autoDistill: input.autoDistill,
    scope: input.memoryScope,
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
  memoryScope,
  memoryDreaming,
  memoryConnectionId,
  memoryRecall,
  memoryCaptureMode,
  sessionBasePath
}: {
  agentId: string
  canEdit: boolean
  memoryProvider: string
  autoDistill: boolean
  memoryScope?: ManagedMemoryScope
  memoryDreaming?: MemoryDreamingConfig
  memoryConnectionId?: string
  memoryRecall?: ExternalMemoryBindingDraft['recall']
  memoryCaptureMode?: ExternalMemoryBindingDraft['captureMode']
  sessionBasePath?: string
}) {
  const { updateAgent } = useConsoleData()
  const isMobile = useIsMobile()
  const [files, setFiles] = useState<MemoryFileEntry[]>([])
  const [listLoading, setListLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)
  const [selected, setSelected] = useState(INDEX)
  const [content, setContent] = useState('')
  const [loadedMtime, setLoadedMtime] = useState<string | null>(null)
  const [fileExists, setFileExists] = useState<boolean | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  // Channel memory viewer (#653): the channels with their own folder, and which one
  // is being viewed. `undefined` = the shared agent-level base. Only meaningful when
  // the persisted scope is `channel`.
  const [channels, setChannels] = useState<MemoryChannelDto[]>([])
  const [selectedChannel, setSelectedChannel] = useState<string | undefined>(undefined)
  const loadRequest = useRef(0)
  const listRequest = useRef(0)

  const [editor, setEditor] = useState<FileBrowserEditorDraft | null>(null)
  const [mobileListSignal, setMobileListSignal] = useState(0)

  // Existing-agent memory settings are one explicit draft. The content below
  // continues to reflect `persistedSettings` until Save succeeds, so selecting a
  // different backend can never make an unsaved choice look active.
  const initialSettings = settingsFromProps({
    memoryProvider,
    autoDistill,
    memoryScope,
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
      memoryScope,
      memoryDreaming,
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
    memoryScope,
    memoryDreaming?.enabled,
    memoryDreaming?.sessionWindow,
    memoryDreaming?.schedule,
    memoryDreaming?.timezone,
    memoryDreaming?.instructions,
    memoryDreaming?.mineSkills,
    memoryDreaming?.autoAdopt,
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
  // always named. Channel scope has no dreaming, so those chips are dropped.
  const settingsSummary = (() => {
    switch (persistedProvider) {
      case 'managed': {
        if (persistedSettings.scope === 'channel') {
          return [
            'Managed directory',
            `Auto-distill ${persistedSettings.autoDistill ? 'on' : 'off'}`,
            'Channel scope'
          ].join(' · ')
        }
        const dreaming = persistedSettings.dreaming
        const cadence = dreaming.schedule === '0 4 * * *' ? 'daily' : dreaming.schedule ? 'scheduled' : 'manual'
        return [
          'Managed directory',
          `Auto-distill ${persistedSettings.autoDistill ? 'on' : 'off'}`,
          dreaming.enabled ? `Dreaming ${cadence}` : 'Dreaming off',
          ...(dreaming.enabled && dreaming.mineSkills === true ? ['Skill mining on'] : []),
          `Auto-accept ${dreaming.autoAdopt ? 'on' : 'off'}`,
          'Agent scope'
        ].join(' · ')
      }
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
      const { files } = await listAgentMemory(agentId, selectedChannel)
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
  }, [agentId, selectedChannel])

  // Load one file's content WHOLE (paging every slice) so the editor holds the full
  // file — a partial read would let Save clobber the tail. The index is fetched via
  // ?path omitted.
  const loadFile = useCallback(
    async (name: string) => {
      const request = ++loadRequest.current
      setLoading(true)
      setError(null)
      setEditor(null)
      setHistoryOpen(false)
      setContent('')
      setLoadedMtime(null)
      setFileExists(null)
      try {
        const mem = await fetchAgentMemoryFull(agentId, name === INDEX ? undefined : name, selectedChannel)
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
    [agentId, selectedChannel]
  )

  useEffect(() => {
    loadRequest.current += 1
    listRequest.current += 1
    setFiles([])
    setSelected(INDEX)
    setContent('')
    setEditor(null)
    setHistoryOpen(false)
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

  // Under channel scope, load the list of channels that have their own memory folder
  // so the viewer can offer a channel selector. Always reset the selection first —
  // the component instance is reused across agent navigations, so a stale channelKey
  // from another agent must never leak into this one's reads.
  useEffect(() => {
    setSelectedChannel(undefined)
    if (persistedProvider !== 'managed' || persistedSettings.scope !== 'channel') {
      setChannels([])
      return
    }
    let live = true
    void fetchAgentMemoryChannels(agentId)
      .then((r) => {
        if (live) setChannels(r.channels)
      })
      .catch(() => {
        if (live) setChannels([])
      })
    return () => {
      live = false
    }
  }, [agentId, persistedProvider, persistedSettings.scope])

  const select = (name: string) => {
    if (name === selected) {
      if (error) void loadFile(name)
      return
    }
    setSelected(name)
    void loadFile(name)
  }

  const resolveMemoryLink = (href: string) => resolveMemoryMarkdownLink(href, select)

  const startCreate = () => {
    setHistoryOpen(false)
    setEditor({
      target: '',
      directory: '',
      name: '',
      content: '',
      mtime: null,
      loading: false,
      saving: false,
      error: null
    })
  }

  const startEdit = () => {
    setHistoryOpen(false)
    setEditor({
      target: selected,
      directory: '',
      name: selected,
      content,
      mtime: loadedMtime,
      loading: false,
      saving: false,
      error: null
    })
  }

  const closeEditor = () => {
    if (!editor?.saving) setEditor(null)
  }

  const backFromEditor = () => {
    if (editor?.saving) return
    setEditor(null)
    setMobileListSignal((signal) => signal + 1)
  }

  const save = async () => {
    if (!editor || editor.saving || editor.loading) return
    const creating = editor.target === ''
    const target = creating ? editor.name.trim() : editor.target
    if (creating && (!TOPIC_RE.test(target) || target === INDEX)) {
      setEditor({ ...editor, error: 'Use a flat .md file name, e.g. "deploys.md".' })
      return
    }
    const savingEditor = { ...editor, saving: true, error: null }
    setEditor(savingEditor)
    try {
      const res = await updateAgentMemory(
        agentId,
        savingEditor.content,
        target === INDEX ? undefined : target,
        creating ? undefined : savingEditor.mtime,
        selectedChannel
      )
      setSelected(target)
      setContent(savingEditor.content)
      setLoadedMtime(res.mtime) // track the new mtime for the next edit
      setFileExists(true)
      setEditor(null)
      await loadList() // a brand-new topic now shows in the list
    } catch (e) {
      setEditor((current) =>
        current?.target === savingEditor.target
          ? {
              ...current,
              saving: false,
              error:
                e instanceof ApiError && e.status === 409
                  ? 'This file changed since you opened it (the agent may have updated it). Reload before saving.'
                  : e instanceof Error
                    ? e.message
                    : String(e)
            }
          : current
      )
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

  const selectedFile = files.find((file) => file.name === selected)
  const previewMeta = [
    formatFileSize(selectedFile?.size ?? null),
    selectedFile?.mtime ? `edited ${formatFileMtime(selectedFile.mtime)}` : ''
  ]
    .filter(Boolean)
    .join(' · ')

  const renderPreview = (onBack?: () => void) => (
    <>
      <FileBrowserPreviewSummary
        meta={previewMeta}
        onBack={onBack}
        actions={
          persistedProvider === 'managed' && !loading && !error && fileExists === true ? (
            <FileBrowserHistoryButton active={historyOpen} onClick={() => setHistoryOpen((open) => !open)} />
          ) : undefined
        }
      />

      {historyOpen && persistedProvider === 'managed' && fileExists === true ? (
        <ManagedMemoryHistory
          key={`${agentId}:${selected}:${selectedChannel ?? ''}`}
          agentId={agentId}
          path={selected}
          channelKey={selectedChannel}
        />
      ) : loading ? (
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

            {provider === 'managed' ? (
              <MemoryScopeField
                scope={settings.scope}
                canEdit={canEdit && !savingProvider}
                onChange={(next) => {
                  setSettings((current) => ({ ...current, scope: next }))
                  setProviderError(null)
                }}
              />
            ) : null}

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
                Automatically distill durable facts after each turn (uses an additional model call).
              </label>
            ) : null}

            {provider === 'managed' && settings.scope === 'channel' ? (
              <span className="font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
                Each channel (DMs and webchat included) keeps its own memory folder, so different channels never mix.
                Dreaming is unavailable under channel scope.
              </span>
            ) : null}

            {provider === 'managed' && settings.scope !== 'channel' ? (
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
                  Enable dreaming — consolidate the store from recent sessions. Runs on demand and on the schedule
                  below.
                </label>
                {settings.dreaming.enabled ? (
                  <div className="ml-6 flex flex-col gap-2">
                    <DreamScheduleFields
                      value={settings.dreaming.schedule ?? ''}
                      timezone={settings.dreaming.timezone ?? ''}
                      disabled={!canEdit || savingProvider}
                      onChange={(schedule, timezone) => {
                        setSettings((current) => ({
                          ...current,
                          dreaming: { ...current.dreaming, schedule, timezone }
                        }))
                        setProviderError(null)
                      }}
                    />
                    <div className="flex flex-col gap-1">
                      <label className="flex items-start gap-2 font-sans text-[12px] font-normal leading-normal text-(--text-secondary)">
                        <input
                          type="checkbox"
                          checked={settings.dreaming.autoAdopt}
                          disabled={!canEdit || savingProvider}
                          onChange={() => {
                            setSettings((current) => ({
                              ...current,
                              dreaming: { ...current.dreaming, autoAdopt: !current.dreaming.autoAdopt }
                            }))
                            setProviderError(null)
                          }}
                        />
                        Automatically adopt completed memory results without review (opt in).
                      </label>
                      {settings.dreaming.autoAdopt ? (
                        <div className="ml-6 font-sans text-[11px] font-normal leading-[1.5] text-(--amber-500)">
                          Warning: Dream memory results can be inaccurate. Conflicting changes to live memory while a
                          dream runs still pause the result for review.
                        </div>
                      ) : null}
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="flex items-start gap-2 font-sans text-[12px] font-normal leading-normal text-(--text-secondary)">
                        <input
                          type="checkbox"
                          checked={settings.dreaming.mineSkills === true}
                          disabled={!canEdit || savingProvider}
                          onChange={() => {
                            setSettings((current) => ({
                              ...current,
                              dreaming: { ...current.dreaming, mineSkills: current.dreaming.mineSkills !== true }
                            }))
                            setProviderError(null)
                          }}
                        />
                        Also mine reusable skills from repeated procedures.
                      </label>
                      {settings.dreaming.mineSkills === true ? (
                        <div className="ml-6 font-sans text-[11px] font-normal leading-[1.5] text-(--text-tertiary)">
                          Dreams read which commands ran, not just what was said, and recommend a procedure seen in at
                          least two sessions. Skills are never installed automatically — you review each one.
                        </div>
                      ) : null}
                    </div>
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
        <>
          {persistedProvider === 'managed' && persistedSettings.scope === 'channel' ? (
            <div className="flex flex-wrap items-center gap-2 px-4 pt-3 font-sans text-[12px] leading-normal text-(--text-secondary)">
              <span className="font-semibold">Channel</span>
              <select
                value={selectedChannel ?? ''}
                onChange={(event) => setSelectedChannel(event.target.value || undefined)}
                aria-label="Channel memory folder"
                className="rounded-sm border border-(--border-subtle) bg-(--surface-card) px-2 py-1 font-sans text-[12px] text-(--text-primary)"
              >
                <option value="">Agent (shared)</option>
                {channels.map((entry) => (
                  <option key={entry.channelKey} value={entry.channelKey}>
                    {entry.channel ?? entry.channelKey}
                  </option>
                ))}
              </select>
              {channels.length === 0 ? (
                <span className="text-(--text-tertiary)">No channel has memory yet — showing the shared base.</span>
              ) : null}
            </div>
          ) : null}
          <FileBrowserShell
            title={
              <FileBrowserBreadcrumb
                root="Memory"
                path={editor?.target ?? selected}
                creating={editor?.target === ''}
                draftName={editor?.name ?? ''}
                onDraftNameChange={(name) =>
                  setEditor((current) => (current?.target === '' ? { ...current, name, error: null } : current))
                }
                onBack={isMobile && editor ? backFromEditor : undefined}
                disabled={editor?.saving}
                nested={false}
                ariaLabel="Memory file path"
                inputAriaLabel="New memory file name"
              />
            }
            headerEnd={
              editor ? (
                <FileBrowserEditorActions
                  saving={editor.saving}
                  onCancel={closeEditor}
                  onSave={() => void save()}
                  disabled={editor.loading || (!editor.target && !editor.name.trim())}
                />
              ) : canEdit ? (
                <div className="flex flex-none items-center gap-2">
                  <Button variant="secondary" size="xs" className="flex-none" onClick={startCreate}>
                    <Icon name="file-plus" size={13} />
                    Add file
                  </Button>
                  {!loading && !error && fileExists !== null ? (
                    <Button variant="secondary" size="xs" className="flex-none" onClick={startEdit}>
                      <Icon name="pencil" size={13} />
                      Edit
                    </Button>
                  ) : null}
                </div>
              ) : undefined
            }
          >
            <FileBrowserLayout
              resetKey={`${agentId}:${mobileListSignal}`}
              previewOpen={editor !== null}
              tree={renderFileTree}
              preview={
                editor
                  ? () => (
                      <FileBrowserEditor
                        draft={editor}
                        onContentChange={(content) =>
                          setEditor((current) => (current ? { ...current, content, error: null } : current))
                        }
                        onCancel={closeEditor}
                        onSubmit={() => void save()}
                      />
                    )
                  : renderPreview
              }
            />
          </FileBrowserShell>
          {/* Dreaming is managed-only and is secondary to the live memory
              content, so it sits below the browser. Only render it when the
              persisted policy is on; otherwise its trigger would be noise. */}
          {persistedSettings.dreaming.enabled ? (
            <div className="mt-4">
              <DreamPanel
                key={agentId}
                agentId={agentId}
                canEdit={canEdit}
                autoAcceptMemory={persistedSettings.dreaming.autoAdopt}
                sessionBasePath={sessionBasePath}
              />
            </div>
          ) : null}
        </>
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
