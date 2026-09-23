'use client'

import { useState } from 'react'
import { AnchoredFlyout } from '@/components/ui/AnchoredFlyout'
import { useTranslations } from 'next-intl'
import { AgentMark } from '@/components/marks'
import { Icon, Toggle } from '@/components/ui'
import { acpRuntime, useAcpRegistry } from '@/lib/acp-registry'
import {
  displayedEffort,
  effortChoicesFor,
  fastModeAvailableFor,
  modelCapability,
  modelOptionsFor,
  permissionModeChoicesFor,
  permissionModeDefault,
  resolveEffortForModel,
  resolvedPermissionMode,
  runtimeLabel,
  runtimeWarning,
  selectableRuntimeIds,
  supportsModes,
  type DaemonRow
} from '@/lib/data'
import { permissionModeLabelKey } from '@/lib/permission-mode-i18n'
import type { DecisionRuntimeTarget } from '@agentconnect.md/protocol/decision'

export type RuntimeModelSource = Pick<DaemonRow, 'runtimeModels'>

// A runtime mark centred in its box; the bare <AgentMark> img otherwise sits at the box's top-left.
function RuntimeMark({ runtime, box }: { runtime: string; box: string }) {
  return (
    <span className={`flex flex-none items-center justify-center ${box}`}>
      <AgentMark model={runtime} fillPct={100} />
    </span>
  )
}

export function RuntimeModelSelect({
  value,
  onChange,
  source,
  runtimes,
  ariaLabel,
  compact = false,
  dense = false,
  runSettings = false,
  decision,
  fastMode,
  fastModeAvailable = true,
  onFastModeChange,
  allowRuntimeOnly = false,
  runInSandbox = false,
  readOnly = false
}: {
  value: DecisionRuntimeTarget
  onChange(value: DecisionRuntimeTarget): void
  source?: RuntimeModelSource
  runtimes?: readonly string[]
  ariaLabel?: string
  compact?: boolean
  /** The 30px table-cell trigger used by Decision rule rows. */
  dense?: boolean
  runSettings?: boolean
  allowRuntimeOnly?: boolean
  runInSandbox?: boolean
  readOnly?: boolean
  decision?: { name: string; selected: boolean; onSelect(): void }
  fastMode?: boolean
  /** Whether the selected model offers Fast mode; the row stays visible but disabled when not. */
  fastModeAvailable?: boolean
  onFastModeChange?(value: boolean): void
}) {
  const t = useTranslations('Agents.dialog.runtimeModel')
  const permissionT = useTranslations('Common.permissionModes')
  const registry = useAcpRegistry()
  const [provider, setProvider] = useState(value.runtime)
  const [search, setSearch] = useState('')
  const label = (runtime: string) => runtimeLabel(runtime, acpRuntime(registry, runtime)?.name)
  const ids = runtimes ?? (source ? selectableRuntimeIds(source, value.runtime) : [])
  const profiles = ids
    .map((runtime) => {
      const profile = source?.runtimeModels.find((item) => item.runtime === runtime)
      const warning =
        profile &&
        runtimeWarning({
          authRequired: profile.authRequired,
          unavailableReason: runInSandbox ? profile.unavailableReason : undefined
        })
      return { runtime, profile, warning, options: modelOptionsFor(source, runtime, profile?.models ?? []) }
    })
    .sort((a, b) => Number(!!a.profile?.authRequired) - Number(!!b.profile?.authRequired))
  const current = source?.runtimeModels.find((profile) => profile.runtime === value.runtime)
  const selectedWarning = profiles.find((item) => item.runtime === value.runtime)?.warning
  const warningLabel = (warning: string) =>
    t(warning === 'image-binary-missing' ? 'imageBinaryMissing' : 'loginRequired')
  const modelName = current?.modelCatalog?.models.find((model) => model.id === value.model)?.name ?? value.model
  const matching = profiles
    .filter((item) => search || item.runtime === provider)
    .map((item) => ({
      ...item,
      options: item.options.filter((model) =>
        `${label(item.runtime)} ${model.value} ${model.name ?? ''}`.toLowerCase().includes(search.toLowerCase())
      )
    }))
  const capability = modelCapability(source, value.runtime, value.model)
  const effortChoices = effortChoicesFor(value.runtime, capability)
  const showEffort = capability?.efforts ? effortChoices.length > 0 : supportsModes(value.runtime)
  const effort = displayedEffort(value.effort ?? '', effortChoices, capability?.defaultEffort)
  const permissionChoices = permissionModeChoicesFor(value.runtime, current?.modelCatalog ?? undefined).map(
    (option) => {
      const key = permissionModeLabelKey(option.v)
      return { ...option, l: key ? permissionT(key) : option.l }
    }
  )
  const permission =
    value.permissionMode ?? current?.modelCatalog?.defaultPermissionMode ?? permissionModeDefault(value.runtime)
  const settingsSummary = runSettings
    ? [
        showEffort ? (effortChoices.find((option) => option.value === effort)?.label ?? effort) : undefined,
        permissionChoices.length
          ? (permissionChoices.find((option) => option.v === permission)?.l ?? permission)
          : undefined
      ]
        .filter(Boolean)
        .join(' · ')
    : ''
  const fastAvailable = runSettings ? fastModeAvailableFor(value.runtime, capability) : fastModeAvailable
  const fastOn = !!(runSettings ? value.fastMode : fastMode) && fastAvailable
  const selectModel = (runtime: string, model: string) => {
    if (!runSettings) return onChange({ runtime, model })
    const nextCapability = modelCapability(source, runtime, model)
    const catalog = source?.runtimeModels.find((profile) => profile.runtime === runtime)?.modelCatalog ?? undefined
    const modes = permissionModeChoicesFor(runtime, catalog)
    const mode =
      runtime === value.runtime && modes.some((option) => option.v === permission)
        ? permission
        : resolvedPermissionMode(permissionModeDefault(runtime), modes, catalog)
    onChange({
      runtime,
      model,
      effort: resolveEffortForModel(runtime, nextCapability, runtime === value.runtime ? (value.effort ?? '') : ''),
      permissionMode: mode,
      fastMode: !!value.fastMode && fastModeAvailableFor(runtime, nextCapability)
    })
  }
  const runtimeOnly = allowRuntimeOnly && !search && matching[0]?.options.length === 0 ? matching[0] : undefined
  return (
    <AnchoredFlyout
      role="dialog"
      ariaLabel={ariaLabel ?? t('title')}
      width={readOnly ? 320 : 480}
      estimatedHeight={readOnly ? 48 : runSettings ? 500 : 390}
      align={compact ? 'start' : 'end'}
      className="p-0!"
      triggerClassName="block min-w-0"
      trigger={({ open, menuId, toggle }) => (
        <button
          type="button"
          className={
            compact
              ? 'inline-flex h-7 max-w-[260px] items-center gap-[7px] rounded-full px-[10px] font-sans text-[12.5px] font-medium leading-normal hover:bg-(--surface-hover)'
              : dense
                ? `inp h-[30px] min-h-0 w-full cursor-pointer gap-2 px-[9px] py-0 text-left text-[12px] font-medium hover:border-(--border-strong) ${open ? 'border-(--border-focus) ring-[3px] ring-(--brand-ring)' : ''}`
                : `inp h-8 min-h-0 w-full cursor-pointer gap-2 px-[10px] py-0 text-left text-[12.5px] font-medium hover:border-(--border-strong) ${open ? 'border-(--border-focus) ring-[3px] ring-(--brand-ring)' : ''}`
          }
          aria-label={ariaLabel ?? t('title')}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          onClick={() => {
            setProvider(value.runtime)
            setSearch('')
            toggle()
          }}
        >
          {decision?.selected ? (
            <Icon name="git-branch" size={13} color="var(--brand)" className="flex-none" />
          ) : (
            <RuntimeMark runtime={value.runtime} box="h-[14px] w-[14px]" />
          )}
          <span className="min-w-0 flex-1 truncate text-left">
            {decision?.selected ? t('byDecision') : modelName || label(value.runtime) || t('choose')}
          </span>
          {settingsSummary && (
            <span
              className="max-w-[38%] truncate font-mono text-[10.5px] font-normal leading-normal text-(--text-tertiary)"
              title={settingsSummary}
            >
              {settingsSummary}
            </span>
          )}
          {!decision?.selected && selectedWarning && (
            <span className="flex flex-none" title={warningLabel(selectedWarning)}>
              <Icon name="triangle-alert" size={13} color="var(--status-paused)" />
            </span>
          )}
          {fastOn && (
            <span className="flex-none rounded-xs bg-(--brand-soft) px-[5px] py-px font-mono text-[10px] font-semibold leading-normal tracking-[0.04em] text-(--brand-soft-text)">
              FAST
            </span>
          )}
          <Icon
            name="chevron-down"
            size={compact ? 11 : 13}
            className={`flex-none text-(--text-tertiary) transition-transform ${open ? 'rotate-180' : ''}`}
          />
        </button>
      )}
    >
      {({ close }) =>
        readOnly ? (
          <div className="flex items-center gap-2 px-3 py-[10px] font-sans text-[12px] leading-normal text-(--text-secondary)">
            <Icon name="lock" size={13} className="flex-none text-(--text-tertiary)" />
            {t('readOnly')}
          </div>
        ) : (
          <div>
            {decision && (
              <div className="border-b border-(--border-subtle) p-1">
                <button
                  type="button"
                  className={`fopt min-h-10 ${decision.selected ? 'on' : ''}`}
                  onClick={() => {
                    decision.onSelect()
                    close(true)
                  }}
                >
                  <Icon name="git-branch" size={14} className="flex-none text-(--text-tertiary)" />
                  <span className="min-w-0 flex-1 text-left">
                    <span className="block">{t('byDecision')}</span>
                    <span className="block truncate font-sans text-[11px] font-normal leading-normal text-(--text-tertiary)">
                      {t('decisionHelp', { name: decision.name })}
                    </span>
                  </span>
                  <span className="flex-none font-mono text-[10.5px] font-normal leading-normal text-(--text-tertiary)">
                    {t('agentSetting')}
                  </span>
                </button>
              </div>
            )}
            <div className="flex">
              <div className="max-h-[320px] w-[168px] flex-none overflow-y-auto border-r border-(--border-subtle) bg-(--surface-app) p-1">
                <div className="fhdr">{t('provider')}</div>
                {profiles.map((item) => (
                  <button
                    key={item.runtime}
                    type="button"
                    aria-pressed={provider === item.runtime && !search}
                    className={`fopt min-h-8 ${provider === item.runtime && !search ? 'on' : ''}`}
                    onClick={() => {
                      setProvider(item.runtime)
                      setSearch('')
                    }}
                  >
                    <RuntimeMark runtime={item.runtime} box="h-[15px] w-[15px]" />
                    <span className="min-w-0 flex-1 truncate text-left">{label(item.runtime)}</span>
                    {item.warning && (
                      <span className="flex flex-none" title={warningLabel(item.warning)}>
                        <Icon name="triangle-alert" size={12} color="var(--status-paused)" />
                      </span>
                    )}
                    <span className="flex-none font-mono text-[11px] font-normal leading-normal text-(--text-tertiary)">
                      {item.options.length}
                    </span>
                  </button>
                ))}
              </div>
              <div className="flex min-w-0 flex-1 flex-col p-[6px]">
                <input
                  autoFocus
                  className="fsearch"
                  aria-label={t('search')}
                  placeholder={t('search')}
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
                <div className="max-h-[264px] overflow-y-auto">
                  {matching.map(
                    (item) =>
                      item.options.length > 0 && (
                        <div key={item.runtime}>
                          {search && <div className="fhdr">{label(item.runtime)}</div>}
                          {item.options.map((model) => {
                            const on =
                              !decision?.selected && value.runtime === item.runtime && value.model === model.value
                            return (
                              <button
                                type="button"
                                key={model.value}
                                title={model.description}
                                aria-label={`${label(item.runtime)} · ${model.name ?? model.value}`}
                                aria-pressed={on}
                                className={`fopt min-h-[30px] ${on ? 'on' : ''}`}
                                onClick={() => {
                                  selectModel(item.runtime, model.value)
                                  if (!runSettings) close(true)
                                }}
                              >
                                <span className="min-w-0 flex-1 truncate text-left">{model.name ?? model.value}</span>
                              </button>
                            )
                          })}
                        </div>
                      )
                  )}
                  {runtimeOnly && (
                    <button
                      type="button"
                      className={`fopt min-h-[30px] ${value.runtime === runtimeOnly.runtime && !value.model ? 'on' : ''}`}
                      onClick={() => {
                        onChange({ runtime: runtimeOnly.runtime, model: '' })
                        close(true)
                      }}
                    >
                      {label(runtimeOnly.runtime)}
                    </button>
                  )}
                  {!runtimeOnly && matching.every((item) => !item.options.length) && (
                    <div className="px-2 py-[14px] font-sans text-[12px] leading-normal text-(--text-tertiary)">
                      {t('empty')}
                    </div>
                  )}
                </div>
              </div>
            </div>
            {runSettings ? (
              <div className="flex flex-col gap-[9px] border-t border-(--border-subtle) bg-(--surface-app) px-3 py-[10px]">
                <div className="truncate font-mono text-[10.5px] font-semibold uppercase leading-normal tracking-[0.06em] text-(--text-tertiary)">
                  {t('runSettings', { model: modelName || label(value.runtime) })}
                </div>
                {showEffort && (
                  <div className="grid grid-cols-[76px_minmax(0,1fr)] items-center gap-2">
                    <span className="font-sans text-[12px] leading-normal text-(--text-secondary)">{t('effort')}</span>
                    <div className="pillbar flex-wrap justify-self-start" role="group" aria-label={t('effort')}>
                      {effortChoices.map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          className={`pill px-[10px] py-1 text-[12px] leading-normal ${effort === option.value ? 'on' : ''}`}
                          aria-pressed={effort === option.value}
                          title={option.description}
                          onClick={() => onChange({ ...value, effort: option.value })}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {permissionChoices.length > 0 && (
                  <div className="grid grid-cols-[76px_minmax(0,1fr)] items-center gap-2">
                    <span className="font-sans text-[12px] leading-normal text-(--text-secondary)">
                      {t('approval')}
                    </span>
                    <div className="pillbar flex-wrap justify-self-start" role="group" aria-label={t('approval')}>
                      {permissionChoices.map((option) => (
                        <button
                          key={option.v}
                          type="button"
                          className={`pill whitespace-nowrap px-[10px] py-1 text-[12px] leading-normal ${permission === option.v ? 'on' : ''}`}
                          aria-pressed={permission === option.v}
                          title={option.description}
                          onClick={() => onChange({ ...value, permissionMode: option.v })}
                        >
                          {option.l}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <div className="grid grid-cols-[76px_minmax(0,1fr)] items-center gap-2">
                  <span className="font-sans text-[12px] leading-normal text-(--text-secondary)">{t('fastMode')}</span>
                  <div className="flex items-center gap-[9px]">
                    <Toggle
                      checked={fastOn}
                      disabled={!fastAvailable}
                      onChange={(fastMode) => onChange({ ...value, fastMode })}
                      ariaLabel={t('fastMode')}
                    />
                    <span className="font-sans text-[11.5px] leading-normal text-(--text-tertiary)">
                      {t('lowerLatency')}
                    </span>
                  </div>
                </div>
              </div>
            ) : (
              onFastModeChange && (
                <div className="flex items-center gap-[10px] border-t border-(--border-subtle) px-[11px] pt-[7px] pb-2">
                  <Toggle
                    checked={fastOn}
                    disabled={!fastModeAvailable}
                    onChange={onFastModeChange}
                    ariaLabel={t('fastMode')}
                  />
                  <span
                    className={`flex-1 font-sans text-[13px] font-medium leading-normal ${fastModeAvailable ? 'text-(--text-primary)' : 'text-(--text-disabled)'}`}
                  >
                    {t('fastMode')}
                  </span>
                  <span className="font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
                    {t('lowerLatency')}
                  </span>
                </div>
              )
            )}
          </div>
        )
      }
    </AnchoredFlyout>
  )
}
