'use client'

// An agent's open capability requests on its page, so they are found without the link (capability-requests.md §4.5).
import Link from 'next/link'
import useSWR from 'swr'
import { useFormatter, useTranslations } from 'next-intl'
import { fetchCapabilityRequests } from '@/lib/api'
import { featureFlagEnabled } from '@/lib/feature-flags'
import { formatDateTime } from '@/i18n/format'
import { useOrgs } from '@/lib/org-context'
import { consoleKeys } from '@/lib/swr-keys'

const REFRESH_MS = 30_000

export function AgentCapabilityRequestsCard({
  agentId,
  className = 'mb-4'
}: {
  agentId: string
  /** Spacing where it is placed: below it in a stack (the default), none inside a grid that spaces its cells. */
  className?: string
}) {
  const enabled = featureFlagEnabled('capability-requests')
  const { activeOrg, orgPath } = useOrgs()
  const t = useTranslations('CapabilityRequests')
  const format = useFormatter()
  const key = enabled ? consoleKeys.agentCapabilityRequests(activeOrg?.id, agentId) : null
  const { data } = useSWR(key, ([, orgId, , id]) => fetchCapabilityRequests({ agentId: id, status: 'open' }, orgId), {
    refreshInterval: REFRESH_MS
  })
  // Nothing to find means nothing to show; a failed read is not worth a card of its own here.
  if (!enabled || !data || data.length === 0) return null
  return (
    <div className={`card overflow-hidden max-desktop:rounded-lg ${className}`} data-capability-requests>
      <div className="cardhead flex-wrap gap-2">
        <span className="cardtitle">{t('agentCard.title')}</span>
        <span className="mono ml-auto text-[11px] text-(--text-tertiary)">
          {t('agentCard.count', { count: data.length })}
        </span>
      </div>
      {data.map((request) => (
        <Link
          key={request.id}
          href={orgPath(`/requests/${request.id}`)}
          className="row click flex flex-col items-start gap-1 border-t border-(--border-subtle) px-4 py-3 desktop:flex-row desktop:items-center desktop:gap-4"
        >
          <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-(--text-primary)">
            {request.summary}
          </span>
          <span className="font-mono text-[12px] text-(--text-tertiary)">
            {t('page.askedAt', {
              time: formatDateTime(format, new Date(request.createdAt), { dateStyle: 'medium', timeStyle: 'short' })
            })}
          </span>
        </Link>
      ))}
    </div>
  )
}
