import type { AgentModelProvider } from '@agentconnect.md/protocol/provider-key'
import { useTranslations } from 'next-intl'
import { DaemonSelect } from './DaemonSelect'

export function ModelProviderField({
  value,
  onChange
}: {
  value: AgentModelProvider | null
  onChange: (value: AgentModelProvider | null) => void
}) {
  const t = useTranslations('Common.modelProvider')
  return (
    <div className="flex min-w-0 items-center gap-3">
      <span className="text-[12px] font-medium leading-normal text-(--text-secondary)">{t('label')}</span>
      <div className="min-w-0 flex-1">
        <DaemonSelect
          value={value ? 'auto' : ''}
          ariaLabel={t('label')}
          options={[
            { value: '', label: t('daemon'), icon: 'server' },
            { value: 'auto', label: t('saved'), icon: 'key' }
          ]}
          onChange={(source) => onChange(source ? 'auto' : null)}
        />
      </div>
    </div>
  )
}
