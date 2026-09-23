'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { DECISION_PROVIDER_PROFILES, type DecisionQuestion } from '@agentconnect.md/protocol/decision'
import type { DecisionProviderOption } from '@agentconnect.md/protocol/decision-api'
import { ModelMark } from '@/components/marks'
import { Icon } from '@/components/ui'
import { AnchoredFlyout } from '@/components/ui/AnchoredFlyout'

export function DecisionModelSelect({
  providerId,
  model,
  questionType,
  providers,
  disabled,
  onChange
}: {
  providerId: string
  model: string
  questionType: DecisionQuestion['type']
  providers: Pick<DecisionProviderOption, 'id' | 'name' | 'models'>[]
  disabled: boolean
  onChange(value: { providerId: string; model: string }): void
}) {
  const t = useTranslations('Decisions')
  const [browsing, setBrowsing] = useState(providerId)
  const profiles = [
    ...new Map([...DECISION_PROVIDER_PROFILES, ...providers].map((entry) => [entry.id, entry])).values()
  ]
    .map((entry) => ({
      ...entry,
      models: entry.models.filter((option) => option.questionTypes.includes(questionType))
    }))
    .filter((entry) => entry.models.length > 0)
  const selected = profiles.find((entry) => entry.id === providerId)
  const options = profiles.find((entry) => entry.id === browsing)?.models ?? []
  const mark = (id: string) => (
    <span className="flex h-[15px] w-[15px] flex-none items-center justify-center">
      <ModelMark model={`${id}/`} fallbackRuntime="" fillPct={100} />
    </span>
  )

  return (
    <AnchoredFlyout
      role="dialog"
      ariaLabel={t('providerModel')}
      width={420}
      align="end"
      className="p-0!"
      triggerClassName="block min-w-0"
      trigger={({ open, menuId, toggle }) => (
        <button
          type="button"
          disabled={disabled}
          className={`inp min-h-9 w-full cursor-pointer gap-2 text-left hover:border-(--border-strong) ${open ? 'border-(--border-focus) ring-[3px] ring-(--brand-ring)' : ''}`}
          aria-label={t('providerModel')}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          onClick={() => {
            setBrowsing(providerId)
            toggle()
          }}
        >
          {mark(providerId)}
          <span className="min-w-0 flex-1 truncate">
            {selected?.name ?? providerId} · {selected?.models.find((entry) => entry.id === model)?.label ?? model}
          </span>
          <Icon
            name="chevron-down"
            size={14}
            className={`flex-none text-(--text-tertiary) transition-transform ${open ? 'rotate-180' : ''}`}
          />
        </button>
      )}
    >
      {({ close }) => (
        <div className="flex">
          <div className="max-h-[320px] w-[168px] flex-none overflow-y-auto border-r border-(--border-subtle) bg-(--surface-app) p-1">
            <div className="fhdr">{t('provider')}</div>
            {profiles.map((entry) => (
              <button
                key={entry.id}
                type="button"
                aria-pressed={browsing === entry.id}
                className={`fopt min-h-8 ${browsing === entry.id ? 'on' : ''}`}
                onClick={() => setBrowsing(entry.id)}
              >
                {mark(entry.id)}
                <span className="min-w-0 flex-1 truncate">{entry.name}</span>
              </button>
            ))}
          </div>
          <div className="max-h-[320px] min-w-0 flex-1 overflow-y-auto p-[6px]">
            {options.map((entry) => (
              <button
                key={entry.id}
                type="button"
                aria-pressed={providerId === browsing && model === entry.id}
                className={`fopt min-h-[30px] ${providerId === browsing && model === entry.id ? 'on' : ''}`}
                onClick={() => {
                  onChange({ providerId: browsing, model: entry.id })
                  close(true)
                }}
              >
                {entry.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </AnchoredFlyout>
  )
}
