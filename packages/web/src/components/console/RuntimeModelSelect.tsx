'use client'

import { useState } from 'react'
import { AnchoredFlyout } from '@/components/ui/AnchoredFlyout'
import { useTranslations } from 'next-intl'
import { AgentMark } from '@/components/marks'
import { Icon, Toggle } from '@/components/ui'
import { acpRuntime, useAcpRegistry } from '@/lib/acp-registry'
import { modelOptionsFor, runtimeLabel, runtimeWarning, selectableRuntimeIds, type DaemonRow } from '@/lib/data'
import type { DecisionRuntimeTarget } from '@agentconnect.md/protocol/decision'

export type RuntimeModelSource = Pick<DaemonRow, 'runtimeModels'>

export function RuntimeModelSelect({
  value,
  onChange,
  source,
  runtimes,
  ariaLabel,
  compact = false,
  decision,
  fastMode,
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
  allowRuntimeOnly?: boolean
  runInSandbox?: boolean
  readOnly?: boolean
  decision?: { name: string; selected: boolean; onSelect(): void }
  fastMode?: boolean
  onFastModeChange?(value: boolean): void
}) {
  const t = useTranslations('Agents.dialog.runtimeModel')
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
  return (
    <AnchoredFlyout
      role="dialog"
      ariaLabel={ariaLabel ?? t('title')}
      width={600}
      estimatedHeight={390}
      align={compact ? 'start' : 'end'}
      className="p-0!"
      triggerClassName="block min-w-0"
      trigger={({ open, menuId, toggle }) => (
        <button
          type="button"
          className={
            compact
              ? 'inline-flex h-7 max-w-[260px] items-center gap-2 rounded-full px-[10px] text-[12.5px] hover:bg-(--surface-hover)'
              : `inp flex w-full min-w-0 cursor-pointer items-center gap-2 text-left hover:border-(--border-strong) hover:bg-(--surface-hover) ${open ? 'border-(--border-focus) ring-[3px] ring-(--brand-ring)' : ''}`
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
          <span className="inline-flex h-5 w-5 flex-none">
            {decision?.selected ? (
              <Icon name="git-branch" size={18} color="var(--brand)" />
            ) : (
              <AgentMark model={value.runtime} />
            )}
          </span>
          <span className="min-w-0 flex-1 truncate">
            {decision?.selected ? t('byDecision') : modelName || label(value.runtime) || t('choose')}
          </span>
          {!decision?.selected && selectedWarning && (
            <span title={warningLabel(selectedWarning)}>
              <Icon name="triangle-alert" size={13} color="var(--status-paused)" />
            </span>
          )}
          {fastMode && (
            <span className="flex-none rounded-xs bg-(--brand-soft) px-1 text-[10px] font-semibold text-(--brand-soft-text)">
              FAST
            </span>
          )}
          <Icon
            name="chevron-down"
            size={14}
            className={`flex-none transition-transform ${open ? 'rotate-180' : ''}`}
          />
        </button>
      )}
    >
      {({ close }) => (
        <div>
          {readOnly && (
            <div className="flex items-start gap-2 border-b border-(--border-subtle) px-3 py-2 text-[12px] text-(--text-secondary)">
              <Icon name="lock" size={14} className="mt-px flex-none" />
              {t('readOnly')}
            </div>
          )}
          {decision && (
            <button
              type="button"
              disabled={readOnly}
              className={`flex w-full items-center gap-3 border-b border-(--border-subtle) p-3 text-left ${decision.selected ? 'bg-(--brand-soft)' : 'hover:bg-(--surface-hover)'}`}
              onClick={() => {
                decision.onSelect()
                close(true)
              }}
            >
              <Icon name="git-branch" size={18} />
              <span className="flex-1">
                <strong className="block text-[13px]">{t('byDecision')}</strong>
                <span className="text-[12px] text-(--text-secondary)">
                  {t('decisionHelp', { name: decision.name })}
                </span>
              </span>
              <span className="text-[11px] text-(--text-tertiary)">{t('agentSetting')}</span>
            </button>
          )}
          <div className="grid grid-cols-[minmax(105px,1fr)_minmax(0,2fr)]">
            <div className="max-h-[320px] overflow-y-auto border-r border-(--border-subtle) bg-(--surface-sunken) p-2">
              <div className="px-2 py-1 font-mono text-[11px] uppercase tracking-wider text-(--text-tertiary)">
                {t('provider')}
              </div>
              {profiles.map((item) => (
                <button
                  key={item.runtime}
                  type="button"
                  aria-pressed={provider === item.runtime && !search}
                  className={`fopt min-h-8 gap-2 rounded-md px-2 py-[6px] text-[13px] ${provider === item.runtime && !search ? 'on' : ''}`}
                  onClick={() => {
                    setProvider(item.runtime)
                    setSearch('')
                  }}
                >
                  <span className="inline-flex h-5 w-5 flex-none">
                    <AgentMark model={item.runtime} />
                  </span>
                  <span className="min-w-0 flex-1 truncate">{label(item.runtime)}</span>
                  <span className="text-[11px] text-(--text-tertiary)">{item.options.length}</span>
                  {item.warning && (
                    <span title={warningLabel(item.warning)}>
                      <Icon name="triangle-alert" size={12} color="var(--status-paused)" />
                    </span>
                  )}
                </button>
              ))}
            </div>
            <div className="min-w-0 p-2">
              <input
                autoFocus
                className="inp mb-2 min-h-8 w-full py-[6px]"
                aria-label={t('search')}
                placeholder={t('search')}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              <div className="max-h-[260px] overflow-y-auto">
                {matching.map(
                  (item) =>
                    item.options.length > 0 && (
                      <div key={item.runtime}>
                        {item.options.map((model) => (
                          <button
                            type="button"
                            disabled={readOnly}
                            key={model.value}
                            title={model.description}
                            aria-label={`${label(item.runtime)} · ${model.name ?? model.value}`}
                            aria-pressed={
                              !decision?.selected && value.runtime === item.runtime && value.model === model.value
                            }
                            className={`fopt min-h-8 gap-2 rounded-md px-2 py-[6px] text-[13px] disabled:cursor-not-allowed disabled:opacity-60 ${!decision?.selected && value.runtime === item.runtime && value.model === model.value ? 'on' : ''}`}
                            onClick={() => {
                              onChange({ runtime: item.runtime, model: model.value })
                              close(true)
                            }}
                          >
                            <span className="min-w-0 flex-1 truncate">{model.name ?? model.value}</span>
                            {search && (
                              <span className="truncate text-[11px] font-normal text-(--text-tertiary)">
                                {label(item.runtime)}
                              </span>
                            )}
                          </button>
                        ))}
                      </div>
                    )
                )}
                {allowRuntimeOnly && !search && matching[0] && matching[0].options.length === 0 && (
                  <button
                    type="button"
                    disabled={readOnly}
                    className="fopt p-3 text-[12px]"
                    onClick={() => {
                      onChange({ runtime: matching[0]!.runtime, model: '' })
                      close(true)
                    }}
                  >
                    {label(matching[0].runtime)}
                  </button>
                )}
                {matching.every((item) => !item.options.length) && (
                  <div className="p-3 text-[12px] text-(--text-tertiary)">{t('empty')}</div>
                )}
              </div>
            </div>
          </div>
          {onFastModeChange && (
            <div className="flex items-center gap-3 border-t border-(--border-subtle) px-3 py-2">
              <Toggle
                checked={fastMode ?? false}
                disabled={readOnly}
                onChange={onFastModeChange}
                ariaLabel={t('fastMode')}
              />
              <span className="text-[13px] font-medium">{t('fastMode')}</span>
              <span className="ml-auto text-[12px] text-(--text-tertiary)">{t('lowerLatency')}</span>
            </div>
          )}
        </div>
      )}
    </AnchoredFlyout>
  )
}
