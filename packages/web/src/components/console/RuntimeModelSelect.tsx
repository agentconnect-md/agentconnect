'use client'

import { useState } from 'react'
import { AnchoredFlyout } from '@/components/ui/AnchoredFlyout'
import { HoverCardRows, useHoverCard } from '@/components/ui/HoverCard'
import { useTranslations } from 'next-intl'
import { AgentMark, MarkSlot } from '@/components/marks'
import { Icon, Toggle } from '@/components/ui'
import { ModelOption, ProviderModelMenu } from '@/components/console/ProviderModelMenu'
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
import { localizedPermissionChoices } from '@/lib/permission-mode-i18n'
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

/** The agent Decision a composer can defer to, with its rules summarized for the hover card. */
export interface RuntimeDecisionChoice {
  name: string
  selected: boolean
  onSelect(): void
  rules?: readonly { when: string; then: string }[]
  fallback?: string
}

const HOVER_RULE = 'grid grid-cols-[16px_auto_12px_minmax(0,1fr)] items-center gap-[6px]'
const HOVER_NUM =
  'flex h-4 w-4 items-center justify-center rounded-xs font-mono text-[9.5px] font-semibold leading-normal text-(--text-secondary)'

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
  decision?: RuntimeDecisionChoice
}) {
  const t = useTranslations('Agents.dialog.runtimeModel')
  const permissionT = useTranslations('Common.permissionModes')
  const registry = useAcpRegistry()
  const [provider, setProvider] = useState(value.runtime)
  const [search, setSearch] = useState('')
  const hover = useHoverCard()
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
  const permissionChoices = localizedPermissionChoices(
    permissionModeChoicesFor(value.runtime, current?.modelCatalog ?? undefined),
    permissionT
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
  const hoverRows: [string, string][] = decision?.selected
    ? [
        [t('model'), t('byDecision')],
        [t('decision'), decision.name]
      ]
    : [
        [t('provider'), label(value.runtime)],
        [t('model'), modelName],
        ...(controls?.effort ? [[t('effort'), choiceLabel(controls.effort)] as [string, string]] : []),
        ...(controls?.approval ? [[t('approval'), choiceLabel(controls.approval)] as [string, string]] : []),
        ...(controls?.fast ? [[t('fastMode'), controls.fast.value ? t('on') : t('off')] as [string, string]] : [])
      ]
  const hoverContent = (
    <>
      <HoverCardRows rows={hoverRows} />
      {decision?.selected && (!!decision.rules?.length || !!decision.fallback) && (
        <span className="mt-2 flex flex-col gap-1 border-t border-(--border-subtle) pt-2">
          {decision.rules?.map((rule, index) => (
            <span key={index} className={HOVER_RULE}>
              <span className={`${HOVER_NUM} bg-(--surface-active)`}>{index + 1}</span>
              <span className="whitespace-nowrap font-mono text-[11px] leading-normal text-(--text-primary)">
                {rule.when}
              </span>
              <Icon name="arrow-right" size={11} className="text-(--text-tertiary)" />
              <span className="truncate font-mono text-[11px] leading-normal text-(--text-secondary)">{rule.then}</span>
            </span>
          ))}
          {decision.fallback && (
            <span className={HOVER_RULE}>
              <span className={`${HOVER_NUM} bg-(--surface-sunken)`}>—</span>
              <span className="font-sans text-[11px] leading-normal text-(--text-tertiary)">{t('fallback')}</span>
              <Icon name="arrow-right" size={11} className="text-(--text-tertiary)" />
              <span className="truncate font-mono text-[11px] leading-normal text-(--text-secondary)">
                {decision.fallback}
              </span>
            </span>
          )}
        </span>
      )}
    </>
  )
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
        <>
          <button
            type="button"
            className={
              compact
                ? 'inline-flex h-7 max-w-[400px] cursor-pointer items-center gap-[7px] rounded-full px-[10px] font-sans text-[12.5px] font-medium leading-normal hover:bg-(--surface-hover)'
                : dense
                  ? `inp h-[30px] min-h-0 w-full cursor-pointer gap-2 px-[9px] py-0 text-left text-[12px] font-medium hover:border-(--border-strong) ${open ? 'border-(--border-focus) ring-[3px] ring-(--brand-ring)' : ''}`
                  : `inp h-8 min-h-0 w-full cursor-pointer gap-2 px-[10px] py-0 text-left text-[12.5px] font-medium hover:border-(--border-strong) ${open ? 'border-(--border-focus) ring-[3px] ring-(--brand-ring)' : ''}`
            }
            aria-label={ariaLabel ?? t('title')}
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-controls={open ? menuId : undefined}
            {...hover.triggerProps}
            onClick={() => {
              hover.hide()
              setProvider(value.runtime)
              setSearch('')
              toggle()
            }}
          >
            {decision?.selected ? (
              <Icon name="git-branch" size={13} color="var(--brand)" className="flex-none" />
            ) : (
              <MarkSlot size={14}>
                <AgentMark model={value.runtime} fillPct={100} />
              </MarkSlot>
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
          {!open && hover.card(hoverContent)}
        </>
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
            <ProviderModelMenu
              title={t('provider')}
              providers={profiles.map((item) => ({
                id: item.runtime,
                label: label(item.runtime),
                mark: <AgentMark model={item.runtime} fillPct={100} />,
                count: item.options.length,
                warning: item.warning ? warningLabel(item.warning) : undefined
              }))}
              active={search ? null : provider}
              onPick={(runtime) => {
                setProvider(runtime)
                setSearch('')
              }}
              search={{ value: search, placeholder: t('search'), onChange: setSearch }}
            >
              {matching.map(
                (item) =>
                  item.options.length > 0 && (
                    <div key={item.runtime}>
                      {search && <div className="fhdr">{label(item.runtime)}</div>}
                      {item.options.map((model) => (
                        <ModelOption
                          key={model.value}
                          label={model.name ?? model.value}
                          description={model.description}
                          ariaLabel={`${label(item.runtime)} · ${model.name ?? model.value}`}
                          selected={
                            !decision?.selected && value.runtime === item.runtime && value.model === model.value
                          }
                          onClick={() => {
                            selectModel(item.runtime, model.value)
                            if (!runSettings) close(true)
                          }}
                        />
                      ))}
                    </div>
                  )
              )}
              {runtimeOnly && (
                <ModelOption
                  label={label(runtimeOnly.runtime)}
                  selected={value.runtime === runtimeOnly.runtime && !value.model}
                  onClick={() => {
                    onChange({ runtime: runtimeOnly.runtime, model: '' })
                    close(true)
                  }}
                />
              )}
              {!runtimeOnly && matching.every((item) => !item.options.length) && (
                <div className="px-2 py-[14px] font-sans text-[12px] leading-normal text-(--text-tertiary)">
                  {t('empty')}
                </div>
              )}
            </ProviderModelMenu>
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
