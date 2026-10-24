'use client'

// Which agents may use a Computer (computer-use.md §4.1), shown here and changed on each agent's Tools tab.
import { useMemo } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import type { ComputerDto } from '@/lib/api'
import { agentAccessOf } from '@/lib/computers'
import { agentLabel, type Agent } from '@/lib/data'
import { useConsoleData } from '@/lib/data-context'
import { useOrgs } from '@/lib/org-context'
import { AttachedEmpty, AttachedRow } from '@/components/console/AttachedList'
import { AgentIconView } from '@/components/marks'
import { Icon } from '@/components/ui'

export function ComputerAgentAccessCard({ computer }: { computer: ComputerDto }) {
  const t = useTranslations('Computers.agentAccess')
  const { agents } = useConsoleData()
  const { orgPath } = useOrgs()
  const access = useMemo(() => agentAccessOf(computer), [computer])
  const fixed = computer.allocation === 'per-agent' || computer.allocation === 'ephemeral'
  const byId = new Map(agents.map((a) => [a.id, a]))

  return (
    <div className="card overflow-hidden max-desktop:rounded-lg">
      <div className="cardhead flex-wrap gap-2">
        <span className="cardtitle">{t('title')}</span>
        <span className="ml-auto font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
          {t(access.mode)}
        </span>
      </div>
      {access.mode === 'all' ? (
        <div className="px-4 py-4 font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-secondary)">
          {t('allDescription')}
          {computer.kind === 'self-hosted' && (
            <p className="m-0 mt-2 flex items-start gap-[7px] text-[12px] text-(--text-tertiary)">
              <Icon name="triangle-alert" size={13} className="mt-[2px] flex-none" />
              <span>{t('allNoIsolation')}</span>
            </p>
          )}
        </div>
      ) : access.agents.length === 0 ? (
        <AttachedEmpty title={t('none')} hint={t('noneDescription')} />
      ) : (
        access.agents.map((id) => <GrantedAgent key={id} agent={byId.get(id)} id={id} computer={computer} />)
      )}
      <p className="m-0 flex items-start gap-[7px] border-t border-(--border-subtle) px-4 py-3 font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
        <Icon name="info" size={13} className="mt-[2px] flex-none" />
        <span>
          {fixed
            ? t('ownAgentOnly')
            : t.rich('changeOnAgent', {
                agents: (chunks) => (
                  <Link href={orgPath('/agents')} className="text-(--brand) hover:underline">
                    {chunks}
                  </Link>
                )
              })}
        </span>
      </p>
    </div>
  )
}

function GrantedAgent({ agent, id, computer }: { agent: Agent | undefined; id: string; computer: ComputerDto }) {
  const t = useTranslations('Computers.agentAccess')
  const { orgPath } = useOrgs()
  // A self-hosted desktop has no isolation from the agents of another member (§4.1).
  const shared =
    computer.kind === 'self-hosted' &&
    agent !== undefined &&
    agent.createdBy !== '' &&
    agent.createdBy !== computer.ownerUserId
  return (
    <AttachedRow
      mark={
        <span className="flex h-7 w-7 flex-none overflow-hidden rounded-md">
          {agent ? (
            <AgentIconView icon={agent.icon} runtime={agent.runtime} size={28} />
          ) : (
            <Icon name="bot" size={18} />
          )}
        </span>
      }
      name={agent ? agentLabel(agent) : t('unknownAgent')}
      meta={agent ? agent.name : id}
      dimmed={!agent}
      badge={
        shared ? (
          <span
            className="inline-flex flex-none items-center gap-1 rounded-full bg-(--status-paused-soft) px-2 py-[1px] font-sans text-[11px] font-semibold leading-normal text-[#9a6500]"
            title={t('noIsolationHint')}
          >
            <Icon name="triangle-alert" size={12} />
            {t('noIsolation')}
          </span>
        ) : undefined
      }
      actions={
        agent ? (
          <Link
            className="iconbtn flex-none"
            href={orgPath(`/agents/${encodeURIComponent(id)}?tab=tools`)}
            title={t('openAgentTools')}
            aria-label={t('openAgentTools')}
          >
            <Icon name="arrow-up-right" size={15} />
          </Link>
        ) : undefined
      }
    />
  )
}
