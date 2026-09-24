import { useTranslations } from 'next-intl'
import { DaemonSelect } from '@/components/console/DaemonSelect'
import { LEGACY_SANDBOX, strategyBoundary, type StrategyBoundary, type StrategyOption } from '@/lib/execution-strategy'

const ICONS: Record<StrategyBoundary, string> = {
  none: 'shield-off',
  process: 'shield',
  vm: 'box',
  container: 'container'
}

/** A strategy as the console names it: its slug and the boundary it puts around a session. */
export function useStrategyLabel(): (value: string) => string {
  const t = useTranslations('Common.executionStrategy')
  return (value) => {
    if (value === LEGACY_SANDBOX) return t('sandbox')
    const boundary = strategyBoundary(value)
    return boundary ? t('option', { strategy: value, boundary: t(`boundary.${boundary}`) }) : value
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
  const label = useStrategyLabel()
  return (
    <div className="fld min-w-0" title={disabledReason}>
      <span className="fldlbl">{t('label')}</span>
      <DaemonSelect
        value={value}
        ariaLabel={t('label')}
        placeholder={t('noneAvailable')}
        disabled={disabledReason !== undefined}
        options={options.map((option) => ({
          value: option.value,
          label: label(option.value),
          icon: ICONS[strategyBoundary(option.value) ?? 'process'],
          ...(option.available
            ? {}
            : {
                meta: t('unavailable'),
                title: option.reason ?? (option.refusal ? t(`refusal.${option.refusal}`) : undefined),
                disabled: true
              })
        }))}
        onChange={onChange}
      />
    </div>
  )
}
