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
      <div className="cardhead gap-[6px]">
        <span className="cardtitle">{t('title')}</span>
        <span className="mono text-[11.5px] text-(--text-tertiary)">
          {access.mode === 'all' ? t('all') : access.agents.length}
        </span>
      </div>
      <div className="-mt-px">
        {access.mode === 'all' ? (
          <div className="border-t border-(--border-subtle) px-4 py-[14px] font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-secondary)">
            {t('allDescription')}
            {computer.kind === 'self-hosted' && (
              <p className="m-0 mt-2 flex items-start gap-[7px] text-[12px] text-(--text-tertiary)">
                <Icon name="triangle-alert" size={13} className="mt-[2px] flex-none" />
                <span>{t('allNoIsolation')}</span>
              </p>
            )}
          </div>
        ) : access.agents.length === 0 ? (
          <div className="border-t border-(--border-subtle) px-4 py-[14px] font-sans text-[12.5px] font-normal leading-normal text-(--text-secondary)">
            {t('noneDescription')}
          </div>
        ) : (
          access.agents.map((id) => <GrantedAgent key={id} agent={byId.get(id)} id={id} computer={computer} />)
        )}
      </div>
      <p className="m-0 border-t border-(--border-subtle) bg-(--surface-sunken) px-4 py-[10px] font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
        {fixed
          ? t('ownAgentOnly')
          : t.rich('changeOnAgent', {
              agents: (chunks) => (
                <Link href={orgPath('/agents')} className="lnk text-[12px]">
                  {chunks}
                </Link>
              )
            })}
      </p>
    </div>
  )
}

function GrantedAgent({ agent, id, computer }: { agent: Agent | undefined; id: string; computer: ComputerDto }) {
  const t = useTranslations('Computers.agentAccess')
  const tp = useTranslations('Computers.policy')
  const { orgPath } = useOrgs()
  // A self-hosted desktop has no isolation from the agents of another member (§4.1).
  const shared =
    computer.kind === 'self-hosted' &&
    agent !== undefined &&
    agent.createdBy !== '' &&
    agent.createdBy !== computer.ownerUserId
  return (
    <div
      className={
        agent
          ? 'flex min-h-10 items-center gap-[10px] border-t border-(--border-subtle) py-[6px] pr-[10px] pl-4'
          : 'flex min-h-10 items-center gap-[10px] border-t border-(--border-subtle) py-[6px] pr-[10px] pl-4 opacity-60'
      }
    >
      <span className="flex h-[22px] w-[22px] flex-none items-center justify-center overflow-hidden rounded-[5px]">
        {agent ? <AgentIconView icon={agent.icon} runtime={agent.runtime} size={22} /> : <Icon name="bot" size={16} />}
      </span>
      <span
        className="mono min-w-0 flex-1 truncate text-[12.5px] text-(--text-primary)"
        title={agent ? agent.name : id}
      >
        {agent ? agentLabel(agent) : t('unknownAgent')}
      </span>
      {shared && (
        <span
          className="inline-flex flex-none items-center gap-1 rounded-full bg-(--status-paused-soft) px-2 py-[1px] font-sans text-[11px] font-semibold leading-normal text-[#9a6500]"
          title={t('noIsolationHint')}
        >
          <Icon name="triangle-alert" size={12} />
          {t('noIsolation')}
        </span>
      )}
      <span className="flex-none font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
        {computer.policy.agentMode === 'view' ? tp('modeView') : tp('modeControl')}
      </span>
      {agent && (
        <Link
          className="iconbtn h-7 w-7 flex-none"
          href={orgPath(`/agents/${encodeURIComponent(id)}?tab=tools`)}
          title={t('openAgentTools')}
          aria-label={t('openAgentTools')}
        >
          <Icon name="arrow-up-right" size={14} />
        </Link>
      )}
    </div>
  )
}
