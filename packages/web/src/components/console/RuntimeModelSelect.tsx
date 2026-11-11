'use client'

import { useState } from 'react'
import { AnchoredFlyout } from '@/components/ui/AnchoredFlyout'
import { HoverCardRows, useHoverCard } from '@/components/ui/HoverCard'
import { useTranslations } from 'next-intl'
import { AgentMark, MarkSlot, ModelMark } from '@/components/marks'
import { Icon, Toggle } from '@/components/ui'
import { ModelOption, ProviderModelMenu } from '@/components/console/ProviderModelMenu'
import {
  DecisionModelHover,
  useModelEvaluationsLink,
  type DecisionModelSummary
} from '@/components/console/decisions/DecisionModelLabel'
import { acpRuntime, useAcpRegistry } from '@/lib/acp-registry'
import {
  displayedEffort,
  effortChoicesFor,
  fastModeAvailableFor,
  modelCapability,
  modelOptionsFor,
  permissionModeChoicesFor,
  permissionModeDefault,
  preselectedPermissionMode,
  resolveEffortForModel,
  runtimeLabel,
  runtimeWarning,
  selectableRuntimeIds,
  supportsModes,
  type DaemonRow
} from '@/lib/data'
import { localizedPermissionChoices } from '@/lib/permission-mode-i18n'
import type { AgentCoordinatorFilter, DecisionRuntimeTarget } from '@agentconnect.md/protocol/decision'
import type { DecisionProviderOption } from '@agentconnect.md/protocol/decision-api'
import { COORDINATOR_DEFAULT_EFFORT, type CoordinatorModel } from '@agentconnect.md/protocol/coordinator-model'

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

/** The coordinator's model beside the task model: a Task | Coordinator switch heads the menu (auto-session-mode.md §5.4). */
export interface CoordinatorModelChoice {
  /** What it runs on: the chosen model, or what Default resolves to. */
  value: CoordinatorModel
  onChange(value: CoordinatorModel): void
  /** The coordinator alone, for a field of its own beside a Decision-picked task model. */
  only?: boolean
  /** The coordinator is off (auto-session-mode.md §3.6): no Auto, and Auto conversations run Single session. */
  disabled?: boolean
  /** Offers Disable coordinator; choosing a model turns it back on. */
  onDisabledChange?(disabled: boolean): void
  /** The Decision model that screens messages before the coordinator (auto-session-mode.md §4.7); absent hides the FILTER group. */
  filter?: CoordinatorFilterChoice
}

/** The coordinator filter's value and the Decision providers able to answer its Boolean question. */
export interface CoordinatorFilterChoice {
  value: AgentCoordinatorFilter | null
  providers: readonly Pick<DecisionProviderOption, 'id' | 'name' | 'models' | 'readiness'>[]
  onChange(value: AgentCoordinatorFilter | null): void
}

// A filter provider's column id, apart from every runtime id.
const FILTER_PREFIX = 'filter:'

/** The agent Decision a composer can defer to, with what its hover card summarizes. */
export interface RuntimeDecisionChoice extends DecisionModelSummary {
  selected: boolean
  onSelect(): void
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
  readsImage = false,
  readOnly = false,
  readOnlyNote,
  coordinator
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
  /** Whether the agent's strategy starts the image's runtime install, so a profile's image-binary warning applies. */
  readsImage?: boolean
  readOnly?: boolean
  /** Who may change it instead, when read-only says more than that changes are disabled here. */
  readOnlyNote?: string
  decision?: RuntimeDecisionChoice
  coordinator?: CoordinatorModelChoice
}) {
  const t = useTranslations('Agents.dialog.runtimeModel')
  const permissionT = useTranslations('Common.permissionModes')
  const registry = useAcpRegistry()
  const [provider, setProvider] = useState(value.runtime)
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState<'task' | 'coordinator'>('task')
  const onCoordinator = !!coordinator && (coordinator.only || tab === 'coordinator')
  const hover = useHoverCard({
    interactive: !!decision?.selected && !!(decision.evaluations || decision.decisionHref)
  })
  const link = useModelEvaluationsLink(decision?.selected ? decision.evaluations : undefined, hover.hide)
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
          unavailableReason: readsImage ? profile.unavailableReason : undefined
        })
      return { runtime, profile, warning, options: modelOptionsFor(source, runtime, profile?.models ?? []) }
    })
    .sort((a, b) => Number(!!a.profile?.authRequired) - Number(!!b.profile?.authRequired))
  const current = source?.runtimeModels.find((profile) => profile.runtime === value.runtime)
  const selectedWarning = profiles.find((item) => item.runtime === value.runtime)?.warning
  const warningLabel = (warning: string) =>
    t(warning === 'image-binary-missing' ? 'imageBinaryMissing' : 'loginRequired')
  const nameOf = (runtime: string, model: string) =>
    source?.runtimeModels
      .find((profile) => profile.runtime === runtime)
      ?.modelCatalog?.models.find((m) => m.id === model)?.name ?? model
  const modelName = nameOf(value.runtime, value.model)
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
  // The composer pill and a rule table's row read "effort · approval"; a form names a non-default effort alone.
  const effortText = choiceLabel(controls?.effort)
  const summary = decision?.selected
    ? ''
    : compact || dense
      ? [effortText, choiceLabel(controls?.approval)].filter(Boolean).join(' · ')
      : controls?.effort && controls.effort.value !== 'default'
        ? effortText
        : ''
  const co = coordinator?.value
  const coOff = !!coordinator?.disabled
  const coCapability = co ? modelCapability(source, co.runtime, co.model) : undefined
  const coEffortChoices = co ? effortChoicesFor(co.runtime, coCapability) : []
  const coShowEffort = co && (coCapability?.efforts ? coEffortChoices.length > 0 : supportsModes(co.runtime))
  // The coordinator runs read-only (auto-session-mode.md §5.4), so it offers no approval.
  const coControls: RunSettingsControls | undefined =
    co && coordinator && !coOff
      ? {
          effort:
            coShowEffort && coEffortChoices.length
              ? {
                  value: displayedEffort(co.effort ?? '', coEffortChoices, coCapability?.defaultEffort),
                  options: coEffortChoices,
                  onChange: (next) => coordinator.onChange({ ...co, effort: next })
                }
              : undefined,
          fast: fastModeAvailableFor(co.runtime, coCapability)
            ? { value: !!co.fastMode, onChange: (next) => coordinator.onChange({ ...co, fastMode: next }) }
            : undefined
        }
      : undefined
  const selectCoordinator = (runtime: string, model: string) => {
    if (!co || !coordinator) return
    const capability = modelCapability(source, runtime, model)
    const effort = resolveEffortForModel(
      runtime,
      capability,
      runtime === co.runtime ? (co.effort ?? '') : COORDINATOR_DEFAULT_EFFORT
    )
    if (coOff) coordinator.onDisabledChange?.(false)
    coordinator.onChange({
      runtime,
      model,
      ...(effort ? { effort } : {}),
      ...(co.fastMode && fastModeAvailableFor(runtime, capability) ? { fastMode: true } : {})
    })
  }
  const filter = onCoordinator && !coOff ? coordinator?.filter : undefined
  const filterProvider =
    filter && !search && provider.startsWith(FILTER_PREFIX)
      ? filter.providers.find((option) => FILTER_PREFIX + option.id === provider)
      : undefined
  const filterName = (choice: AgentCoordinatorFilter) => {
    const option = coordinator?.filter?.providers.find((one) => one.id === choice.providerId)
    return option?.models.find((model) => model.id === choice.model)?.label ?? choice.model
  }
  // The filter adds to the coordinator model, so the coordinator's settings stay while a filter provider is browsed.
  const footer = onCoordinator ? coControls : showSettings ? controls : undefined
  const filterValue = !coOff ? coordinator?.filter?.value : undefined
  const coOnly = !!coordinator?.only && !!co
  const fastOn = coOnly ? !!co?.fastMode : !decision?.selected && !!controls?.fast?.value
  const triggerName = coOnly
    ? coOff
      ? t('coordinatorOff')
      : nameOf(co!.runtime, co!.model) || label(co!.runtime) || t('choose')
    : decision?.selected
      ? decision.name
      : modelName || label(value.runtime) || t('choose')
  const triggerSummary = coOnly
    ? coControls?.effort && coControls.effort.value !== 'default'
      ? choiceLabel(coControls.effort)
      : ''
    : summary
  // A form's trigger names the coordinator beside the task model; the composer leaves it to the hover card.
  const coordinatorNote =
    !co || coordinator?.only || compact || dense
      ? ''
      : coOff
        ? t('plusCoordinatorOff')
        : co.model
          ? filterValue
            ? t('plusCoordinatorAndFilter', { model: nameOf(co.runtime, co.model), filter: filterName(filterValue) })
            : t('plusCoordinator', { model: nameOf(co.runtime, co.model) })
          : ''
  const selectModel = (runtime: string, model: string) => {
    if (!runSettings) return onChange({ runtime, model })
    const nextCapability = modelCapability(source, runtime, model)
    const catalog = source?.runtimeModels.find((profile) => profile.runtime === runtime)?.modelCatalog ?? undefined
    const modes = permissionModeChoicesFor(runtime, catalog)
    const mode =
      runtime === value.runtime && modes.some((option) => option.v === permission)
        ? permission
        : preselectedPermissionMode(runtime, modes, catalog)
    onChange({
      runtime,
      model,
      effort: resolveEffortForModel(runtime, nextCapability, runtime === value.runtime ? (value.effort ?? '') : ''),
      permissionMode: mode,
      fastMode: !!value.fastMode && fastModeAvailableFor(runtime, nextCapability)
    })
  }
  const runtimeOnly = allowRuntimeOnly && !search && matching[0]?.options.length === 0 ? matching[0] : undefined
  const hoverContent = decision?.selected ? (
    <DecisionModelHover
      name={decision.name}
      selection={decision.selection}
      question={decision.question}
      fallback={decision.fallback}
      decisionHref={decision.decisionHref}
      onEvaluations={link.onEvaluations}
    />
  ) : (
    <HoverCardRows
      rows={[
        [t('provider'), label(value.runtime)],
        [t('model'), modelName],
        ...(controls?.effort ? [[t('effort'), choiceLabel(controls.effort)] as [string, string]] : []),
        ...(controls?.approval ? [[t('approval'), choiceLabel(controls.approval)] as [string, string]] : []),
        ...(controls?.fast ? [[t('fastMode'), controls.fast.value ? t('on') : t('off')] as [string, string]] : []),
        ...(co && !coordinator?.only
          ? [
              [t('coordinator'), coOff ? t('off') : `${label(co.runtime)} · ${nameOf(co.runtime, co.model)}`] as [
                string,
                string
              ]
            ]
          : []),
        ...(co && !coordinator?.only && !coOff && coordinator?.filter?.value
          ? [[t('filter'), filterName(coordinator.filter.value)] as [string, string]]
          : [])
      ]}
    />
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
                ? 'inline-flex h-7 w-full max-w-[400px] cursor-pointer items-center gap-[7px] rounded-full px-[10px] max-desktop:px-0 font-sans text-[12.5px] font-medium leading-normal hover:bg-(--surface-hover)'
                : dense
                  ? `inp h-[30px] min-h-0 w-full cursor-pointer gap-2 px-[9px] py-0 text-left text-[12px] font-medium hover:border-(--border-strong) ${open ? 'border-(--border-strong) shadow-(--focus-shadow)' : ''}`
                  : `inp w-full cursor-pointer gap-2 text-left hover:border-(--border-strong) ${open ? 'border-(--border-strong) shadow-(--focus-shadow)' : ''}`
            }
            aria-label={ariaLabel ?? t('title')}
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-controls={open ? menuId : undefined}
            {...hover.triggerProps}
            onClick={() => {
              hover.hide()
              const runtime = coordinator?.only && co ? co.runtime : value.runtime
              setTab('task')
              setProvider(ids.includes(runtime) ? runtime : (ids[0] ?? ''))
              setSearch('')
              toggle()
            }}
          >
            {decision?.selected && !coOnly ? (
              <Icon name="split" size={13} color="var(--brand)" className="flex-none" />
            ) : (
              <MarkSlot size={14}>
                {coOnly && coOff ? (
                  <Icon name="ban" size={14} className="text-(--text-tertiary)" />
                ) : (
                  <AgentMark model={coOnly ? co!.runtime : value.runtime} fillPct={100} />
                )}
              </MarkSlot>
            )}
            {compact ? (
              <span className="min-w-0 flex-1 truncate text-left">
                {triggerName}
                {triggerSummary && (
                  <span className="font-mono text-[11px] font-normal text-(--text-tertiary) max-desktop:hidden">
                    {' '}
                    · {triggerSummary}
                  </span>
                )}
              </span>
            ) : (
              // The name keeps most of the width; the run settings shrink first.
              <span className="flex min-w-0 flex-1 items-center gap-[7px] text-left">
                <span className={`truncate ${triggerSummary ? 'max-w-[62%] flex-none' : 'min-w-0'}`}>
                  {triggerName}
                </span>
                {triggerSummary && (
                  <span className="min-w-0 truncate font-mono text-[10.5px] font-normal text-(--text-tertiary)">
                    {triggerSummary}
                  </span>
                )}
                {coordinatorNote && (
                  <span className="min-w-0 truncate font-mono text-[10.5px] font-normal text-(--text-tertiary)">
                    {coordinatorNote}
                  </span>
                )}
              </span>
            )}
            {!decision?.selected && !coOnly && selectedWarning && (
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
          {link.drawer}
        </>
      )}
    >
      {({ close }) =>
        readOnly ? (
          <div className="flex items-center gap-2 px-3 py-[10px] font-sans text-[12px] leading-normal text-(--text-secondary)">
            <Icon name="lock" size={13} className="flex-none text-(--text-tertiary)" />
            {readOnlyNote ?? t('readOnly')}
          </div>
        ) : (
          <div>
            {decision && !onCoordinator && (
              <div className="border-b border-(--border-subtle) p-1">
                <button
                  type="button"
                  className={`fopt min-h-10 ${decision.selected ? 'on' : ''}`}
                  onClick={() => {
                    decision.onSelect()
                    close(true)
                  }}
                >
                  <Icon name="split" size={14} className="flex-none text-(--text-tertiary)" />
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
                warning: item.warning ? warningLabel(item.warning) : undefined,
                // The coordinator always runs on one model; its runtime keeps the mark while a filter is browsed.
                ...(onCoordinator && !coOff && co?.runtime === item.runtime ? { current: t('currentChoice') } : {})
              }))}
              active={search ? null : provider}
              onPick={(runtime) => {
                setProvider(runtime)
                setSearch('')
              }}
              section={
                filter
                  ? {
                      title: t('filter'),
                      hint: t('filterHint'),
                      providers: filter.providers.map((option) => ({
                        id: FILTER_PREFIX + option.id,
                        label: option.name,
                        mark: <ModelMark model={`${option.id}/`} fallbackRuntime="" fillPct={100} />,
                        count: option.models.length,
                        warning: option.readiness.status === 'ready' ? undefined : t('filterNotReady'),
                        ...(filter.value?.providerId === option.id ? { current: t('currentChoice') } : {})
                      }))
                    }
                  : undefined
              }
              search={{ value: search, placeholder: t('search'), onChange: setSearch }}
              header={
                coordinator &&
                !coordinator.only && (
                  <div className="pillbar mb-1 flex w-full" role="group" aria-label={t('target')}>
                    {(['task', 'coordinator'] as const).map((key) => (
                      <button
                        key={key}
                        type="button"
                        className={`pill flex-1 px-0 py-1 text-[12px] ${tab === key ? 'on' : ''}`}
                        aria-pressed={tab === key}
                        onClick={() => {
                          const runtime = key === 'coordinator' && co ? co.runtime : value.runtime
                          setTab(key)
                          setProvider(ids.includes(runtime) ? runtime : (ids[0] ?? ''))
                          setSearch('')
                        }}
                      >
                        {t(key)}
                      </button>
                    ))}
                  </div>
                )
              }
            >
              {filterProvider && filter && (
                <>
                  {co?.model && (
                    <div className="px-2 pb-[6px] pt-[2px] font-sans text-[11.5px] font-normal leading-[1.45] text-(--text-tertiary)">
                      {t('filterCaption', { model: nameOf(co.runtime, co.model) })}
                    </div>
                  )}
                  {filterProvider.models.map((model) => (
                    <ModelOption
                      key={model.id}
                      label={model.label}
                      ariaLabel={`${filterProvider.name} · ${model.label}`}
                      selected={filter.value?.providerId === filterProvider.id && filter.value.model === model.id}
                      onClick={() => filter.onChange({ providerId: filterProvider.id, model: model.id })}
                    />
                  ))}
                  <div className="mt-1 border-t border-(--border-subtle) pt-1">
                    <ModelOption label={t('noFilter')} selected={!filter.value} onClick={() => filter.onChange(null)} />
                  </div>
                </>
              )}
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
                            onCoordinator
                              ? !coOff && co?.runtime === item.runtime && co.model === model.value
                              : !decision?.selected && value.runtime === item.runtime && value.model === model.value
                          }
                          onClick={() => {
                            if (onCoordinator) return selectCoordinator(item.runtime, model.value)
                            selectModel(item.runtime, model.value)
                            if (!runSettings) close(true)
                          }}
                        />
                      ))}
                    </div>
                  )
              )}
              {runtimeOnly && !onCoordinator && (
                <ModelOption
                  label={label(runtimeOnly.runtime)}
                  selected={value.runtime === runtimeOnly.runtime && !value.model}
                  onClick={() => {
                    onChange({ runtime: runtimeOnly.runtime, model: '' })
                    close(true)
                  }}
                />
              )}
              {!filterProvider && (!runtimeOnly || onCoordinator) && matching.every((item) => !item.options.length) && (
                <div className="px-2 py-[14px] font-sans text-[12px] leading-normal text-(--text-tertiary)">
                  {t('empty')}
                </div>
              )}
              {onCoordinator && coordinator?.onDisabledChange && !search && !filterProvider && (
                <div className="mt-1 border-t border-(--border-subtle) pt-1">
                  <button
                    type="button"
                    className={`fopt min-h-[30px] ${coOff ? 'on' : ''}`}
                    aria-pressed={coOff}
                    title={t('disableCoordinatorHelp')}
                    onClick={() => {
                      coordinator.onDisabledChange?.(true)
                      close(true)
                    }}
                  >
                    <Icon name="ban" size={14} className="flex-none text-(--text-tertiary)" />
                    <span className="min-w-0 flex-1 truncate text-left">{t('disableCoordinator')}</span>
                  </button>
                </div>
              )}
            </ProviderModelMenu>
            {(footer?.effort || footer?.approval || footer?.fast) && (
              <div className="flex flex-wrap items-center gap-2 border-t border-(--border-subtle) bg-(--surface-app) px-[10px] py-[7px]">
                {footer.effort && <SettingSelect label={t('effort')} control={footer.effort} />}
                {footer.approval && <SettingSelect label={t('approval')} control={footer.approval} />}
                {footer.fast && (
                  <span
                    className="ml-auto inline-flex items-center gap-[6px] font-sans text-[11.5px] font-medium leading-normal text-(--text-tertiary)"
                    title={t('lowerLatency')}
                  >
                    <Toggle
                      size="sm"
                      checked={footer.fast.value}
                      onChange={footer.fast.onChange}
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
