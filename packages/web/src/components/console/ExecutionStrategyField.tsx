import { useTranslations } from 'next-intl'
import { DaemonSelect } from '@/components/console/DaemonSelect'
import {
  isKnownStrategy,
  strategyBoundary,
  strategyNameKey,
  type StrategyBoundary,
  type StrategyOption
} from '@/lib/execution-strategy'

const ICONS: Record<StrategyBoundary, string> = {
  none: 'shield-off',
  process: 'shield',
  vm: 'box',
  container: 'container'
}

/** A strategy's plain name, and the technology and boundary its tooltip spells out; an unknown slug is its own name, with no detail. */
export function useStrategyNames(): { name: (value: string) => string; detail: (value: string) => string | undefined } {
  const t = useTranslations('Common.executionStrategy')
  return {
    name: (value) => {
      const key = strategyNameKey(value)
      return key ? t(`name.${key}`) : value
    },
    detail: (value) => (isKnownStrategy(value) ? t(`detail.${value}`) : undefined)
  }
}

/** The agent's strategy picker (session-executors.md §5); an unavailable row stays listed, disabled, with its reason. */
export function ExecutionStrategyField({
  options,
  value,
  onChange,
  disabledReason
}: {
  options: readonly StrategyOption[]
  value: string
  onChange: (value: string) => void
  /** Why the choice cannot change right now; the field keeps showing the current value. */
  disabledReason?: string
}) {
  const t = useTranslations('Common.executionStrategy')
  const { name, detail } = useStrategyNames()
  return (
    <div className="fld min-w-0" title={disabledReason}>
      <span className="fldlbl">{t('label')}</span>
      <DaemonSelect
        value={value}
        ariaLabel={t('label')}
        placeholder={t('noneAvailable')}
        disabled={disabledReason !== undefined}
        options={options.map((option) => {
          const why = option.available
            ? undefined
            : (option.reason ?? (option.refusal ? t(`refusal.${option.refusal}`) : undefined))
          const title = [detail(option.value), why].filter(Boolean).join('\n') || undefined
          return {
            value: option.value,
            label: name(option.value),
            icon: ICONS[strategyBoundary(option.value) ?? 'process'],
            title,
            ...(option.available ? {} : { meta: t('unavailable'), disabled: true })
          }
        })}
        onChange={onChange}
      />
    </div>
  )
}
