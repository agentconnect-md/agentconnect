import { AgentModelProvider, PROVIDER_KEY_PROFILES } from '@agentconnect.md/protocol'
import { useTranslations } from 'next-intl'
import useSWR from 'swr'
import { fetchProviderKeys } from '@/lib/api'
import { useOrgs } from '@/lib/org-context'
import { consoleKeys } from '@/lib/swr-keys'
import { DaemonSelect } from './DaemonSelect'

export function ModelProviderField({
  value,
  onChange
}: {
  value: AgentModelProvider | null
  onChange: (value: AgentModelProvider | null) => void
}) {
  const t = useTranslations('Common.modelProvider')
  const { activeOrg } = useOrgs()
  const { data } = useSWR(consoleKeys.providerKeys(activeOrg?.id), ([, orgId]) => fetchProviderKeys(orgId))
  return (
    <div className="fld min-w-0">
      <span className="fldlbl">{t('label')}</span>
      <DaemonSelect
        value={value ?? ''}
        ariaLabel={t('label')}
        options={[
          { value: '', label: t('daemon') },
          ...AgentModelProvider.options.map((provider) => ({
            value: provider,
            label: `${PROVIDER_KEY_PROFILES[provider].name} API key`,
            icon: 'key',
            disabled: !data?.some((entry) => entry.provider === provider && entry.configured),
            title: t('providerHelp')
          }))
        ]}
        onChange={(provider) => onChange(provider ? AgentModelProvider.parse(provider) : null)}
      />
      <div className="mt-1.5 text-[12px] leading-normal text-(--text-tertiary)">{t('providerHelp')}</div>
    </div>
  )
}
