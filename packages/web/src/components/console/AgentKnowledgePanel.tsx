'use client'

// An agent's Knowledge tab (assistant-mode.md §5.16): the Handbook's three entries with whether this agent reads each, and the Library entries it reads.

import Link from 'next/link'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { getOrganizationRecord, listOrganizationKnowledge, type OrganizationKnowledgeDto } from '@/lib/api'
import { consoleKeys } from '@/lib/swr-keys'
import { useOrgs } from '@/lib/org-context'
import { HANDBOOK_ICONS, RECORD_KINDS, useRecordName, useRecordSummary } from '@/components/console/handbook'
import { LoadingState } from '@/components/marks'
import { Icon } from '@/components/ui'

/** Every agent reads an `all` entry; a `selected` one only the agents it lists. */
export function agentReads(entry: Pick<OrganizationKnowledgeDto, 'visibility' | 'readers'>, agentId: string): boolean {
  return entry.visibility === 'all' || entry.readers.includes(agentId)
}

export function AgentKnowledgePanel({ agentId }: { agentId: string }) {
  const t = useTranslations('Agents.detail.knowledge')
  const { activeOrg, orgPath } = useOrgs()
  const name = useRecordName()
  const summary = useRecordSummary()
  const record = useSWR(consoleKeys.organizationRecord(activeOrg?.id), () => getOrganizationRecord())
  const library = useSWR(consoleKeys.organizationKnowledge(activeOrg?.id, false), () =>
    listOrganizationKnowledge(false)
  )
  const readable = library.data?.filter((entry) => entry.kind === 'entry' && agentReads(entry, agentId))

  return (
    <div className="flex flex-col gap-4 p-4 desktop:max-w-[760px] desktop:gap-[18px] desktop:p-0">
      <div className="card overflow-hidden max-desktop:rounded-lg">
        <div className="cardhead justify-between">
          <span className="cardtitle">{t('handbook')}</span>
          <Link className="lnk text-[12px]" href={orgPath('/knowledge')}>
            {t('openKnowledge')}
          </Link>
        </div>
        {record.isLoading && !record.data ? (
          <LoadingState size={20} padding={16} />
        ) : !record.data?.entries.length ? (
          <div className="px-4 py-4 font-sans text-[13px] font-normal leading-normal text-(--text-tertiary)">
            {t('noRecord')}
          </div>
        ) : (
          RECORD_KINDS.map((kind) => {
            const entry = record.data!.entries.find((candidate) => candidate.kind === kind)
            if (!entry) return null
            const reads = agentReads(entry, agentId)
            return (
              <Link
                key={kind}
                href={orgPath(`/knowledge/${entry.id}`)}
                className="row click grid-cols-[auto_minmax(0,1fr)_auto] gap-3"
              >
                <Icon name={HANDBOOK_ICONS[kind]} size={15} color="var(--text-secondary)" />
                <span className="min-w-0">
                  <span className="block font-sans text-[13px] font-semibold leading-normal text-(--text-primary)">
                    {name(kind)}
                  </span>
                  <span className="block truncate font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
                    {summary(kind, entry.content)}
                  </span>
                </span>
                <span
                  className={
                    reads
                      ? 'inline-flex items-center gap-[5px] font-sans text-[12px] font-medium leading-normal text-(--status-online)'
                      : 'inline-flex items-center gap-[5px] font-sans text-[12px] font-medium leading-normal text-(--text-tertiary)'
                  }
                >
                  <Icon name={reads ? 'check' : 'minus'} size={13} />
                  {reads ? t('reads') : t('doesNotRead')}
                </span>
              </Link>
            )
          })
        )}
      </div>
      <div className="card overflow-hidden max-desktop:rounded-lg">
        <div className="cardhead">
          <span className="cardtitle">{t('library')}</span>
        </div>
        {library.isLoading && !library.data ? (
          <LoadingState size={20} padding={16} />
        ) : !readable?.length ? (
          <div className="px-4 py-4 font-sans text-[13px] font-normal leading-normal text-(--text-tertiary)">
            {t('emptyLibrary')}
          </div>
        ) : (
          readable.map((entry) => (
            <Link key={entry.id} href={orgPath(`/knowledge/${entry.id}`)} className="row click grid-cols-1 gap-1">
              <span className="truncate font-sans text-[13px] font-semibold leading-normal text-(--text-primary)">
                {entry.title}
              </span>
              {entry.summary && (
                <span className="truncate font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
                  {entry.summary}
                </span>
              )}
            </Link>
          ))
        )}
      </div>
    </div>
  )
}
