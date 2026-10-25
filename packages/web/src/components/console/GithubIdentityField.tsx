import { useTranslations } from 'next-intl'
import useSWR from 'swr'
import { DaemonSelect } from '@/components/console/DaemonSelect'
import { fetchGithubApps } from '@/lib/api'
import { useOrgs } from '@/lib/org-context'
import { consoleKeys } from '@/lib/swr-keys'

/** Which GitHub App the agent acts as; '' is the deployment App. Renders nothing until the organization has registered one. */
export function GithubIdentityField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const t = useTranslations('Common.githubIdentity')
  const { activeOrg } = useOrgs()
  const { data: apps } = useSWR(
    consoleKeys.githubApps(activeOrg?.id),
    ([, orgId]) => fetchGithubApps(orgId as string),
    { revalidateOnFocus: false, shouldRetryOnError: false }
  )
  if (!apps || apps.length === 0) return null
  return (
    <div className="fld min-w-0">
      <span className="fldlbl">{t('label')}</span>
      <DaemonSelect
        value={value}
        ariaLabel={t('label')}
        options={[
          { value: '', label: t('deployment') },
          ...apps.map((app) => ({ value: app.id, label: `${app.slug}[bot]` }))
        ]}
        onChange={onChange}
      />
    </div>
  )
}
