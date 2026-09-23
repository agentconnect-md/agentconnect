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

export interface RunSettingChoice {
  value: string
  label: string
  description?: string
}

export interface RunSettingControl {
  value: string
  options: readonly RunSettingChoice[]
  onChange(value: string): void
}

/** Run settings a caller owns (the chat composers); form pickers derive them from `value`. */
export interface RunSettingsControls {
  effort?: RunSettingControl
  approval?: RunSettingControl
  /** Present only when the selected model offers Fast mode. */
  fast?: { value: boolean; onChange(value: boolean): void }
}

// A runtime mark centred in its box; the bare <AgentMark> img otherwise sits at the box's top-left.
function RuntimeMark({ runtime, box }: { runtime: string; box: string }) {
  return (
    <span className={`flex flex-none items-center justify-center ${box}`}>
      <AgentMark model={runtime} fillPct={100} />
    </span>
  )
}

function SettingSelect({ label, control }: { label: string; control: RunSettingControl }) {
  const offered = control.options.some((option) => option.value === control.value)
  return (
    <span className="inline-flex items-center gap-[5px] font-sans text-[11.5px] font-medium leading-normal text-(--text-tertiary)">
      {label}
      <select
        aria-label={label}
        value={control.value}
        onChange={(event) => control.onChange(event.target.value)}
        className="h-[26px] cursor-pointer rounded-sm border border-(--border-default) bg-(--surface-card) pr-1 pl-[6px] font-sans text-[12px] font-medium leading-normal text-(--text-primary) outline-none focus-visible:border-(--border-focus)"
      >
        {!offered && (
          <option value={control.value} disabled>
            {control.value || '—'}
          </option>
        )}
        {control.options.map((option) => (
          <option key={option.value} value={option.value} title={option.description}>
            {option.label}
          </option>
        ))}
      </select>
    </span>
  )
}

const choiceLabel = (control: RunSettingControl | undefined) =>
  control ? (control.options.find((option) => option.value === control.value)?.label ?? control.value) : ''

export function RuntimeModelSelect({
  value,
  onChange,
  source,
  runtimes,
  ariaLabel,
  compact = false,
  dense = false,
  runSettings = false,
  settings,
  pending = false,
  decision,
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
  /** Edit the target's own effort, approval and Fast mode (Agent and Decision forms). */
  runSettings?: boolean
  /** Caller-owned run settings, shown in the same footer when `runSettings` is off. */
  settings?: RunSettingsControls
  pending?: boolean
  allowRuntimeOnly?: boolean
  runInSandbox?: boolean
  readOnly?: boolean
  decision?: { name: string; selected: boolean; onSelect(): void }
}) {
  const t = useTranslations('Agents.dialog.runtimeModel')
  const permissionT = useTranslations('Common.permissionModes')
  const registry = useAcpRegistry()
  const [provider, setProvider] = useState(value.runtime)
  const [search, setSearch] = useState('')
  if (pending) {
    return (
      <span
        role="status"
        aria-label={ariaLabel ?? t('title')}
        className={
          compact
            ? 'inline-flex h-7 items-center gap-2 rounded-full px-[10px] text-[12.5px] text-(--text-tertiary)'
            : 'inp flex items-center gap-2 text-(--text-tertiary)'
        }
      >
        <Icon name="clock" size={16} />
        {t('pending')}
      </span>
    )
  }
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
      return { value: option.v, label: key ? permissionT(key) : option.l, description: option.description }
    }
  )
  const permission =
    value.permissionMode ?? current?.modelCatalog?.defaultPermissionMode ?? permissionModeDefault(value.runtime)
  const controls: RunSettingsControls | undefined = runSettings
    ? {
        effort:
          showEffort && effortChoices.length
            ? { value: effort, options: effortChoices, onChange: (next) => onChange({ ...value, effort: next }) }
            : undefined,
        approval: permissionChoices.length
          ? {
              value: permission,
              options: permissionChoices,
              onChange: (next) => onChange({ ...value, permissionMode: next })
            }
          : undefined,
        fast: fastModeAvailableFor(value.runtime, capability)
          ? { value: !!value.fastMode, onChange: (next) => onChange({ ...value, fastMode: next }) }
          : undefined
      }
    : settings
  const showSettings = !decision?.selected && !!(controls?.effort || controls?.approval || controls?.fast)
  // The composer pill reads "model · effort · approval"; a form names the effort alone, and not the default.
  const effortText = choiceLabel(controls?.effort)
  const summary = decision?.selected
    ? ''
    : compact
      ? [effortText, choiceLabel(controls?.approval)].filter(Boolean).join(' · ')
      : controls?.effort && controls.effort.value !== 'default'
        ? effortText
        : ''
  const fastOn = !decision?.selected && !!controls?.fast?.value
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
      estimatedHeight={readOnly ? 48 : 430}
      align={compact ? 'start' : 'end'}
      className="p-0!"
      triggerClassName="block min-w-0"
      trigger={({ open, menuId, toggle }) => (
        <button
          type="button"
          className={
            compact
              ? 'inline-flex h-7 max-w-[400px] items-center gap-[7px] rounded-full px-[10px] font-sans text-[12.5px] font-medium leading-normal hover:bg-(--surface-hover)'
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
            {summary &&
              (compact ? (
                <span className="font-mono text-[11px] font-normal text-(--text-tertiary)"> · {summary}</span>
              ) : (
                <span className="font-normal text-(--text-tertiary)"> ({summary})</span>
              ))}
          </span>
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
            {showSettings && (
              <div className="flex flex-wrap items-center gap-2 border-t border-(--border-subtle) bg-(--surface-app) px-[10px] py-[7px]">
                {controls?.effort && <SettingSelect label={t('effort')} control={controls.effort} />}
                {controls?.approval && <SettingSelect label={t('approval')} control={controls.approval} />}
                {controls?.fast && (
                  <span
                    className="ml-auto inline-flex items-center gap-[6px] font-sans text-[11.5px] font-medium leading-normal text-(--text-tertiary)"
                    title={t('lowerLatency')}
                  >
                    <Toggle
                      size="sm"
                      checked={controls.fast.value}
                      onChange={controls.fast.onChange}
                      ariaLabel={t('fastMode')}
                    />
                    {t('fast')}
                  </span>
                )}
              </div>
            )}
          </div>
        )
      }
    </AnchoredFlyout>
  )
}
