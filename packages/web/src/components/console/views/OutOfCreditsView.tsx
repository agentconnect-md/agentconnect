'use client'

// The page a chat app's out-of-credits notice links: the fixes webchat offers, for one agent.

import { useParams, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { agentLabel } from '@/lib/data'
import { useConsoleData } from '@/lib/data-context'
import { creditRefusalCode } from '@/lib/out-of-credits'
import { OutOfCreditsNotice, useOutOfCreditsContext } from '@/components/console/billing/OutOfCreditsNotice'
import { LoadingState } from '@/components/marks'

export default function OutOfCreditsView() {
  const t = useTranslations('Billing.outOfCredits')
  const { id } = useParams<{ id: string }>()
  const code = creditRefusalCode(useSearchParams().get('code'))
  const { getAgent, agentsLoading } = useConsoleData()
  const agent = getAgent(id)
  const ctx = useOutOfCreditsContext(agent)
  if (!agent)
    return (
      <div className="wrap">
        {agentsLoading ? (
          <LoadingState fill />
        ) : (
          <p className="p-4 font-sans text-[14px] font-normal leading-normal text-(--text-secondary)">
            {t('notFound')}
          </p>
        )}
      </div>
    )
  return (
    <div className="wrap flex max-w-[640px] flex-col p-4 desktop:p-0">
      <OutOfCreditsNotice
        agent={agent}
        agentName={agentLabel(agent)}
        offer={{ code, addCredits: ctx.owner ? 'link' : 'ask-owner', moveToOwnMachine: ctx.canEdit }}
      />
    </div>
  )
}
