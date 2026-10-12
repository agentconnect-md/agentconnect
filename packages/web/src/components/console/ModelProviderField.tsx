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
    <div className="fld min-w-0">
      <span className="fldlbl">{t('label')}</span>
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
  )
}
