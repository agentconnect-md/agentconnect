'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { DECISION_PROVIDER_PROFILES, type DecisionQuestion } from '@agentconnect.md/protocol/decision'
import type { DecisionProviderOption } from '@agentconnect.md/protocol/decision-api'
import { MarkSlot, ModelMark } from '@/components/marks'
import { Icon } from '@/components/ui'
import { AnchoredFlyout } from '@/components/ui/AnchoredFlyout'
import { HoverCardRows, useHoverCard } from '@/components/ui/HoverCard'
import { ModelOption, ProviderModelMenu } from '@/components/console/ProviderModelMenu'

const providerMark = (id: string) => <ModelMark model={`${id}/`} fallbackRuntime="" fillPct={100} />

export function DecisionModelSelect({
  providerId,
  model,
  questionType,
  providers,
  disabled,
  placeholder,
  ariaLabel,
  onChange
}: {
  providerId: string
  model: string
  questionType: DecisionQuestion['type']
  providers: Pick<DecisionProviderOption, 'id' | 'name' | 'models'>[]
  disabled: boolean
  /** Shown while no provider is chosen yet. */
  placeholder?: string
  ariaLabel?: string
  onChange(value: { providerId: string; model: string }): void
}) {
  const t = useTranslations('Decisions')
  const labels = useTranslations('Agents.dialog.runtimeModel')
  const [browsing, setBrowsing] = useState(providerId)
  const hover = useHoverCard()
  const profiles = [
    ...new Map([...DECISION_PROVIDER_PROFILES, ...providers].map((entry) => [entry.id, entry])).values()
  ]
    .map((entry) => ({
      ...entry,
      models: entry.models.filter((option) => option.questionTypes.includes(questionType))
    }))
    .filter((entry) => entry.models.length > 0)
  const selected = profiles.find((entry) => entry.id === providerId)
  const providerName = selected?.name ?? providerId
  const modelLabel = selected?.models.find((entry) => entry.id === model)?.label ?? model
  const options = profiles.find((entry) => entry.id === browsing)?.models ?? []
  const empty = !providerId && placeholder !== undefined

  return (
    <AnchoredFlyout
      role="dialog"
      ariaLabel={t('providerModel')}
      width={420}
      align="end"
      className="p-0!"
      triggerClassName="block min-w-0"
      trigger={({ open, menuId, toggle }) => (
        <>
          <button
            type="button"
            disabled={disabled}
            className={`inp min-h-9 w-full cursor-pointer gap-2 text-left hover:border-(--border-strong) ${open ? 'border-(--border-focus) ring-[3px] ring-(--brand-ring)' : ''}`}
            aria-label={ariaLabel ?? t('providerModel')}
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-controls={open ? menuId : undefined}
            {...hover.triggerProps}
            onClick={() => {
              hover.hide()
              setBrowsing(providerId || profiles[0]?.id || '')
              toggle()
            }}
          >
            {empty ? (
              <span className="min-w-0 flex-1 truncate text-(--text-tertiary)">{placeholder}</span>
            ) : (
              <>
                <MarkSlot>{providerMark(providerId)}</MarkSlot>
                <span className="min-w-0 flex-1 truncate">
                  {providerName} · {modelLabel}
                </span>
              </>
            )}
            <Icon
              name="chevron-down"
              size={14}
              className={`flex-none text-(--text-tertiary) transition-transform ${open ? 'rotate-180' : ''}`}
            />
          </button>
          {!open &&
            !empty &&
            hover.card(
              <HoverCardRows
                rows={[
                  [labels('provider'), providerName],
                  [labels('model'), modelLabel]
                ]}
              />
            )}
        </>
      )}
    >
      {({ close }) => (
        <ProviderModelMenu
          title={t('provider')}
          providers={profiles.map((entry) => ({ id: entry.id, label: entry.name, mark: providerMark(entry.id) }))}
          active={browsing}
          onPick={setBrowsing}
        >
          {options.map((entry) => (
            <ModelOption
              key={entry.id}
              label={entry.label}
              selected={providerId === browsing && model === entry.id}
              onClick={() => {
                onChange({ providerId: browsing, model: entry.id })
                close(true)
              }}
            />
          ))}
        </ProviderModelMenu>
      )}
    </AnchoredFlyout>
  )
}
