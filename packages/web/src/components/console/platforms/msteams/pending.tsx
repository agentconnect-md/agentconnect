'use client'

import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import type { Agent } from '@/lib/data'
import { useOrgs } from '@/lib/org-context'
import { msTeamsApi } from './api'
import { MsTeamsMark } from './mark'

/** The agent's Teams request still waiting for an administrator (teams-integration.md §8.6.6), as an entry of its integration list. */
export function MsTeamsPendingEntry({ agent, mockMode, open }: { agent: Agent; mockMode: boolean; open(): void }) {
  const t = useTranslations('Platforms.msteams.pending')
  const { activeOrg } = useOrgs()
  const orgId = activeOrg?.id
  // A background check finishes the request, so the entry looks again now and then and gives way to the integration.
  const { data } = useSWR(
    mockMode || !orgId ? null : (['msteams-requests', orgId, agent.id] as const),
    ([, org, id]: readonly [string, string, string]) => msTeamsApi.requests(org, id),
    { refreshInterval: 30_000, shouldRetryOnError: false }
  )
  const request = data?.[0]
  if (!request) return null
  return (
    <button
      type="button"
      onClick={open}
      className="flex w-full cursor-pointer items-center gap-3 rounded-[9px] border border-(--border-subtle) bg-transparent px-[14px] py-3 text-left"
    >
      <span className="imark h-[34px] w-[34px] flex-none rounded-md">
        <MsTeamsMark />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-[2px]">
        <span className="flex items-center gap-2">
          <span className="truncate font-sans text-[13.5px] font-semibold leading-normal text-(--text-primary)">
            {t('title')}
          </span>
          <span className="badge bg-(--surface-active) text-(--text-secondary)">{t('badge')}</span>
        </span>
        <span className="font-sans text-[12.5px] leading-normal text-(--text-secondary)">{t(request.status)}</span>
      </span>
    </button>
  )
}
