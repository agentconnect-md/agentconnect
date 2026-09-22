'use client'

import { UnifiedMemoryPanel } from '@/components/console/UnifiedMemoryPanel'

// Agent memory viewer/editor — the memory DIRECTORY at the agent root
// (<agent-root>/memory/): a MEMORY.md index plus topic files the agent maintains
// across sessions. Content is proxied through the CP straight from the owning
// daemon (never stored on the CP, body-locality), so a 503 here just means that
// daemon is offline / the agent is unplaced — an expected state, rendered as a
// friendly notice. A cluster agent's managed memory lives on its sandbox volume
// (#1078), so the same 503 carrying the asleep code is answered by waking the pod.
//
// Left: the file list (index + topics). Right: the selected file, viewed as
// markdown or edited through the same inline file-browser surface as Workspace.
// The CP enforces edit permission (a 403 surfaces as an error), matching the console.

import { useEffect, useId, useState } from 'react'
import { useTranslations } from 'next-intl'
import {
  fetchAgentMemoryFull,
  fetchAgentMemoryChannels,
  type ManagedMemoryHome,
  type ManagedMemoryScope,
  type MemoryChannelDto,
  type MemoryDreamingConfig
} from '@/lib/api'
import { useConsoleData } from '@/lib/data-context'
import { Spinner } from '@/components/marks'
import { Icon, Button } from '@/components/ui'
import {
  ExternalMemoryBindingFields,
  type ExternalMemoryBindingDraft
} from '@/components/console/ExternalMemoryBindingFields'
import { MemoryProviderPicker } from '@/components/console/MemoryProviderPicker'
import {
  cloneMemorySettings,
  MEMORY_HOME_OPTIONS,
  memoryBackendChanged,
  memoryConfigForDraft,
  memoryHomeLabel,
  memoryHomeMovesForward,
  memoryProviderLabel,
  memorySettingsBlocker,
  memorySettingsChanged,
  memorySettingsDraft,
  type MemoryProviderChoice,
  type MemorySettingsDraft
} from '@/components/console/memory-settings'
import { NativeMemoryFiles } from '@/components/console/NativeMemoryFiles'
import { DreamPanel } from '@/components/console/DreamPanel'
import { DreamScheduleFields } from '@/components/console/DreamScheduleFields'
import { ConfirmationDialog } from '@/components/console/ConfirmationDialog'

function MemoryScopeField({
  scope,
  canEdit,
  onChange
}: {
  scope: ManagedMemoryScope
  canEdit: boolean
  onChange: (next: ManagedMemoryScope) => void
}) {
  const t = useTranslations('Agents.detail.memory')
  const tooltipId = useId()
  const options: Array<{ value: ManagedMemoryScope; label: string }> = [
    { value: 'agent', label: t('agent') },
    { value: 'channel', label: t('channel') }
  ]

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <span className="font-sans text-[13px] font-semibold leading-normal">{t('scope')}</span>
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
          aria-label={t('aboutScope')}
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
          {t('scopeHelp')}
        </span>
      </span>
    </div>
  )
}

const HOME_SET_REASON = 'Agents on a group or the managed pool keep their memory in the Control Plane.'
const HOME_PENDING_STATUS = 'Moving memory to the Control Plane…'
const HOME_CONTROL_PLANE_FIXED =
  'Memory in the Control Plane stays there; moving it back is a separate, forced action below.'

// The home is chosen one way (memory-evolution.md §3.2.1): `daemon` is offered only while it is the current value.
function MemoryHomeField({
  home,
  persistedHome,
  canEdit,
  memberSetPlaced,
  pending,
  onChange
}: {
  home: ManagedMemoryHome
  persistedHome: ManagedMemoryHome
  canEdit: boolean
  memberSetPlaced: boolean
  pending: boolean
  onChange: (next: ManagedMemoryHome) => void
}) {
  const t = useTranslations('Agents.detail.memory')
  const options = MEMORY_HOME_OPTIONS.filter(
    (option) => option.value !== 'daemon' || (persistedHome === 'daemon' && !memberSetPlaced)
  )
  const editable = canEdit && !memberSetPlaced && !pending
  const reason = memberSetPlaced
    ? HOME_SET_REASON
    : pending
      ? HOME_PENDING_STATUS
      : persistedHome === 'control-plane'
        ? HOME_CONTROL_PLANE_FIXED
        : null
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="font-sans text-[13px] font-semibold leading-normal">{t('memoryHome')}</span>
        <span className="pillbar">
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              disabled={!editable}
              data-memory-home={option.value}
              aria-pressed={home === option.value}
              className={`pill ${home === option.value ? 'on' : ''} px-2 py-1 text-[12px] ${editable ? 'cursor-pointer' : 'cursor-not-allowed'}`}
              onClick={() => {
                if (editable) onChange(option.value)
              }}
            >
              {option.value === 'daemon' ? t('onDaemon') : t('inControlPlane')}
            </button>
          ))}
        </span>
      </div>
      <span className="font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
        {home === 'daemon' ? t('onDaemonHelp') : t('inControlPlaneHelp')}
      </span>
      {reason ? (
        <span
          data-memory-home-reason
          className="font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)"
          aria-live={pending ? 'polite' : undefined}
        >
          {reason}
        </span>
      ) : null}
    </div>
  )
}

function settingsFromProps(input: {
  memoryProvider: string
  autoDistill: boolean
  memoryScope?: ManagedMemoryScope
  memoryHome?: ManagedMemoryHome
  memberSetPlaced?: boolean
  memoryDreaming?: MemoryDreamingConfig
  memoryConnectionId?: string
  memoryRecall?: ExternalMemoryBindingDraft['recall']
  memoryCaptureMode?: ExternalMemoryBindingDraft['captureMode']
}): MemorySettingsDraft {
  return memorySettingsDraft({
    provider: input.memoryProvider,
    autoDistill: input.autoDistill,
    scope: input.memoryScope,
    // A member set refuses `daemon`, so a set-placed agent’s draft is pinned to the only home it may carry.
    home: input.memberSetPlaced ? 'control-plane' : input.memoryHome,
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
  memoryHome,
  memoryHomeMigration,
  memoryDreaming,
  memoryConnectionId,
  memoryRecall,
  memoryCaptureMode,
  sessionBasePath,
  sandboxed = false,
  memberSetPlaced = false
}: {
  agentId: string
  canEdit: boolean
  memoryProvider: string
  autoDistill: boolean
  memoryScope?: ManagedMemoryScope
  /** Where the managed tree lives; absent reads as `daemon`. */
  memoryHome?: ManagedMemoryHome
  /** Set while the owning daemon copies the tree into the Control Plane; the home control waits for it to clear. */
  memoryHomeMigration?: 'pending'
  memoryDreaming?: MemoryDreamingConfig
  memoryConnectionId?: string
  memoryRecall?: ExternalMemoryBindingDraft['recall']
  memoryCaptureMode?: ExternalMemoryBindingDraft['captureMode']
  sessionBasePath?: string
  /** The agent runs in a cluster sandbox: its managed memory is readable only through a running pod, so opening the tab wakes it rather than waiting for the read to refuse. */
  sandboxed?: boolean
  /** Placed on a member set (a group or the pool), where the home is fixed to `control-plane` and there is no way back. */
  memberSetPlaced?: boolean
}) {
  const t = useTranslations('Agents.detail.memory')
  const { updateAgent } = useConsoleData()
  // Channel memory viewer (#653): the channels with their own folder, and which one
  // is being viewed. `undefined` = the shared agent-level base. Only meaningful when
  // the persisted scope is `channel`.
  const [channels, setChannels] = useState<MemoryChannelDto[]>([])
  const [selectedChannel, setSelectedChannel] = useState<string | undefined>(undefined)

  // Existing-agent memory settings are one explicit draft. The content below
  // continues to reflect `persistedSettings` until Save succeeds, so selecting a
  // different backend can never make an unsaved choice look active.
  const initialSettings = settingsFromProps({
    memoryProvider,
    autoDistill,
    memoryScope,
    memoryHome,
    memberSetPlaced,
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
  const [confirmingHomeMove, setConfirmingHomeMove] = useState(false)
  // The forced return (`control-plane` → `daemon`) is its own action with its own dialog, never a selector choice.
  const [confirmingHomeReturn, setConfirmingHomeReturn] = useState(false)
  const [returningHome, setReturningHome] = useState(false)
  const [homeReturnError, setHomeReturnError] = useState<string | null>(null)
  const homeMigrationPending = memoryHomeMigration === 'pending'
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
      memoryHome,
      memberSetPlaced,
      memoryDreaming,
      memoryConnectionId,
      memoryRecall,
      memoryCaptureMode
    })
    setSettings(cloneMemorySettings(next))
    setPersistedSettings(cloneMemorySettings(next))
    setProviderError(null)
    setConfirmingBackendChange(false)
    setConfirmingHomeMove(false)
  }, [
    agentId,
    memoryProvider,
    autoDistill,
    memoryScope,
    memoryHome,
    memberSetPlaced,
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
  const homeMovesForward = memoryHomeMovesForward(persistedSettings, settings)
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
      setConfirmingHomeMove(false)
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
    if (homeMovesForward) {
      setProviderError(null)
      setConfirmingHomeMove(true)
      return
    }
    void persistMemorySettings()
  }

  // Sends the persisted binding with `home: 'daemon'` and `force: true`; the CP drops every file and its history.
  const returnHomeToDaemon = async () => {
    if (returningHome) return
    setReturningHome(true)
    setHomeReturnError(null)
    try {
      const memory = memoryConfigForDraft(persistedSettings)
      if (memory.provider !== 'managed') throw new Error('memory is not managed')
      await updateAgent(agentId, { memory: { ...memory, home: 'daemon' }, force: true })
      const next = cloneMemorySettings({ ...persistedSettings, home: 'daemon' })
      setPersistedSettings(next)
      setSettings(cloneMemorySettings(next))
      setConfirmingHomeReturn(false)
      setSettingsOpen(false)
    } catch (e) {
      setHomeReturnError(e instanceof Error ? e.message : String(e))
    } finally {
      setReturningHome(false)
    }
  }

  const discardMemorySettings = () => {
    if (savingProvider) return
    setSettings(cloneMemorySettings(persistedSettings))
    setProviderError(null)
    setConfirmingBackendChange(false)
    setConfirmingHomeMove(false)
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
            t('managedDirectory'),
            memoryHomeLabel(persistedSettings.home),
            t('autoDistill', { state: persistedSettings.autoDistill ? t('on') : t('off') }),
            t('channelScope')
          ].join(' · ')
        }
        const dreaming = persistedSettings.dreaming
        const cadence = dreaming.schedule === '0 4 * * *' ? 'daily' : dreaming.schedule ? 'scheduled' : 'manual'
        return [
          t('managedDirectory'),
          memoryHomeLabel(persistedSettings.home),
          t('autoDistill', { state: persistedSettings.autoDistill ? t('on') : t('off') }),
          dreaming.enabled ? t('dreamingOn', { cadence: t(`dreamingCadence.${cadence}`) }) : t('dreamingOff'),
          ...(dreaming.enabled && dreaming.mineSkills === true ? [t('skillMiningOn')] : []),
          t('autoAccept', { state: dreaming.autoAdopt ? t('on') : t('off') }),
          t('agentScope')
        ].join(' · ')
      }
      case 'native':
        return t('nativeSummary')
      case 'external': {
        const { connectionId, recall, captureMode } = persistedSettings.external
        return [
          connectionId ? t('connectionNamed', { id: connectionId.slice(0, 8) }) : t('noConnection'),
          recall.mode === 'auto' ? t('recallEveryTurn') : t('recallToolOnly'),
          captureMode === 'turn' ? t('captureEveryTurn') : t('captureManual'),
          t('agentScope')
        ].join(' · ')
      }
      case 'none':
        return t('persistentOff')
    }
  })()

  // Only a managed tree with a `daemon` home lives on the sandbox volume; a `control-plane` home is read through the
  // daemon's connection and a native/external/off backend reads nothing from a pod, so none of those wake it.
  const sandboxedMemory = sandboxed && persistedProvider === 'managed' && persistedSettings.home !== 'control-plane'
  // A home change (the forward copy clearing, or the forced return) swaps the tree underneath, so nothing cached survives it.
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
  }, [agentId, persistedProvider, persistedSettings.scope, persistedSettings.home, homeMigrationPending])

  return (
    <div className="p-4 desktop:p-0">
      {/* Memory backend — a collapsed one-line summary; expanding it edits one
          explicit draft. Closing without saving discards the draft, so the
          summary and the content below always describe the persisted backend. */}
      <section className="card mb-4 overflow-hidden max-desktop:rounded-lg">
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <div className="flex min-w-0 flex-col gap-[3px]">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-sans text-[13px] font-semibold leading-normal">{t('backend')}</span>
              <span className="badge bg-(--surface-active) text-(--text-secondary)">{persistedProviderLabel}</span>
              {settingsChanged ? (
                <span
                  className="font-sans text-[11px] font-semibold leading-normal text-(--amber-500)"
                  aria-live="polite"
                >
                  {t('unsavedChanges')}
                </span>
              ) : null}
              {persistedProvider === 'managed' && homeMigrationPending ? (
                <span
                  data-memory-home-status
                  className="inline-flex items-center gap-1 font-sans text-[11px] font-normal leading-normal text-(--text-tertiary)"
                  aria-live="polite"
                >
                  <Spinner size={11} />
                  {t('movingToControlPlane')}
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
                t('cancel')
              ) : (
                t('close')
              )
            ) : canEdit ? (
              <>
                <Icon name="pencil" size={13} />
                {t('edit')}
              </>
            ) : (
              t('details')
            )}
          </Button>
        </div>

        {settingsOpen ? (
          <div className="flex flex-col gap-4 border-t border-(--border-subtle) px-4 py-4">
            <div className="flex flex-col gap-2">
              <span className="font-sans text-[13px] font-semibold leading-normal">{t('backend')}</span>
              <MemoryProviderPicker value={provider} onChange={selectProvider} disabled={!canEdit || savingProvider} />
              <span className="font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
                {provider === 'external'
                  ? t('externalDescription')
                  : provider === 'native'
                    ? t('nativeDescription')
                    : provider === 'none'
                      ? t('noneDescription')
                      : t('managedDescription')}
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
              <MemoryHomeField
                home={settings.home}
                persistedHome={persistedSettings.home}
                canEdit={canEdit && !savingProvider}
                memberSetPlaced={memberSetPlaced}
                pending={homeMigrationPending}
                onChange={(next) => {
                  setSettings((current) => ({ ...current, home: next }))
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
                {t('autoDistillLabel')}
              </label>
            ) : null}

            {provider === 'managed' && settings.scope === 'channel' ? (
              <span className="font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
                {t('channelScopeHint')}
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
                  {t('enableDreaming')}
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
                        {t('autoAdopt')}
                      </label>
                      {settings.dreaming.autoAdopt ? (
                        <div className="ml-6 font-sans text-[11px] font-normal leading-[1.5] text-(--amber-500)">
                          {t('autoAdoptWarning')}
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
                        {t('mineSkills')}
                      </label>
                      {settings.dreaming.mineSkills === true ? (
                        <div className="ml-6 font-sans text-[11px] font-normal leading-[1.5] text-(--text-tertiary)">
                          {t('mineSkillsHint')}
                        </div>
                      ) : null}
                    </div>
                    <label className="flex flex-col gap-1 font-sans text-[11px] font-normal leading-normal text-(--text-tertiary)">
                      {t('instructions')}
                      <textarea
                        value={settings.dreaming.instructions}
                        rows={2}
                        maxLength={4096}
                        placeholder={t('instructionsPlaceholder')}
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
                    {t('settingsBlocker', { reason: settingsBlocker, provider: persistedProviderLabel })}
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
                  {savingProvider ? t('saving') : t('saveSettings')}
                </Button>
                <Button variant="ghost" size="sm" disabled={savingProvider} onClick={closeSettings}>
                  {t('cancel')}
                </Button>
                {settingsChanged ? (
                  <span
                    className="font-sans text-[11.5px] font-normal leading-normal text-(--amber-500)"
                    aria-live="polite"
                  >
                    {t('staysActiveUntilSave', { provider: persistedProviderLabel })}
                  </span>
                ) : null}
              </div>
            ) : null}

            {canEdit &&
            persistedProvider === 'managed' &&
            persistedSettings.home === 'control-plane' &&
            !memberSetPlaced &&
            !homeMigrationPending ? (
              <div className="flex flex-col gap-2 rounded-md border border-(--status-error-soft) px-3 py-3 desktop:flex-row desktop:items-center desktop:justify-between">
                <div className="flex min-w-0 flex-col gap-[3px]">
                  <span className="font-sans text-[12.5px] font-semibold leading-normal">{t('moveBackToDaemon')}</span>
                  <span className="font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
                    {t('moveBackWarning')}
                  </span>
                </div>
                <Button
                  variant="danger"
                  size="sm"
                  disabled={savingProvider || returningHome}
                  onClick={() => {
                    setHomeReturnError(null)
                    setConfirmingHomeReturn(true)
                  }}
                >
                  {t('moveBackToDaemon')}
                </Button>
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
          <div className="text-[13px] font-semibold text-(--text-primary)">
            {t('providerSelected', { provider: providerLabel })}
          </div>
          <div className="mt-1 text-[12px] leading-[1.5] text-(--text-secondary)">
            {provider === 'none'
              ? t('saveToDisable')
              : provider === persistedProvider
                ? t('saveToViewExternal')
                : t('saveToSwitch', { provider: providerLabel })}{' '}
            {t('staysActiveUntilSave', { provider: persistedProviderLabel })}
          </div>
        </div>
      ) : persistedProvider === 'external' ? (
        <UnifiedMemoryPanel
          key={`${agentId}:${persistedSettings.external.connectionId}`}
          agentId={agentId}
          canEdit={canEdit}
        />
      ) : persistedProvider === 'native' ? (
        <NativeMemoryFiles key={agentId} agentId={agentId} canEdit={canEdit} />
      ) : persistedProvider === 'none' ? (
        <div className="rounded-(--radius-lg) border border-(--border-subtle) p-5 text-[13px] text-(--text-secondary)">
          {t('persistentDisabled')}
        </div>
      ) : (
        <>
          {persistedProvider === 'managed' && persistedSettings.scope === 'channel' ? (
            <div className="flex flex-wrap items-center gap-2 px-4 pt-3 font-sans text-[12px] leading-normal text-(--text-secondary)">
              <span className="font-semibold">{t('channel')}</span>
              <select
                value={selectedChannel ?? ''}
                onChange={(event) => setSelectedChannel(event.target.value || undefined)}
                aria-label={t('channelMemoryFolder')}
                className="rounded-sm border border-(--border-subtle) bg-(--surface-card) px-2 py-1 font-sans text-[12px] text-(--text-primary)"
              >
                <option value="">{t('agentShared')}</option>
                {channels.map((entry) => (
                  <option key={entry.channelKey} value={entry.channelKey}>
                    {entry.channel ?? entry.channelKey}
                  </option>
                ))}
              </select>
              {channels.length === 0 ? <span className="text-(--text-tertiary)">{t('noChannelMemory')}</span> : null}
            </div>
          ) : null}
          <UnifiedMemoryPanel
            key={`${agentId}:${persistedSettings.home}:${homeMigrationPending}:${selectedChannel}`}
            agentId={agentId}
            channelKey={selectedChannel}
            canEdit={canEdit}
            sandboxed={sandboxedMemory}
            overview={{
              read: () => fetchAgentMemoryFull(agentId, undefined, selectedChannel),
              readTopic: (file) => fetchAgentMemoryFull(agentId, file, selectedChannel)
            }}
          />
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
          title={t('switchBackendTitle')}
          confirmLabel={t('switchBackend')}
          busy={savingProvider}
          error={providerError}
          onClose={() => {
            if (!savingProvider) setConfirmingBackendChange(false)
          }}
          onConfirm={() => void persistMemorySettings()}
        >
          <p className="m-0">
            {t('switchBackendBody', { from: persistedProviderLabel, to: memoryProviderLabel(provider) })}
          </p>
        </ConfirmationDialog>
      ) : null}
      {confirmingHomeMove ? (
        <ConfirmationDialog
          title={t('moveToControlPlaneTitle')}
          confirmLabel={t('move')}
          busy={savingProvider}
          error={providerError}
          onClose={() => {
            if (!savingProvider) setConfirmingHomeMove(false)
          }}
          onConfirm={() => void persistMemorySettings()}
        >
          <p className="m-0">{t('moveToControlPlaneBody')}</p>
        </ConfirmationDialog>
      ) : null}
      {confirmingHomeReturn ? (
        <ConfirmationDialog
          title={t('moveBackTitle')}
          confirmLabel={t('move')}
          busyLabel={t('moving')}
          destructive
          busy={returningHome}
          error={homeReturnError}
          onClose={() => {
            if (!returningHome) setConfirmingHomeReturn(false)
          }}
          onConfirm={() => void returnHomeToDaemon()}
        >
          <p className="m-0">{t('moveBackBody')}</p>
        </ConfirmationDialog>
      ) : null}
    </div>
  )
}
