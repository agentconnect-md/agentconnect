'use client'

// A Cloud turn that failed for lack of credit, drawn as its fixes instead of the raw failure text.

import { useState } from 'react'
import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { billingPathWithReturn } from '@/lib/billing-return'
import { useConsoleData } from '@/lib/data-context'
import { isPoolPlacementKind, MOCK_PREFIX, type Agent } from '@/lib/data'
import { featureFlagEnabled } from '@/lib/feature-flags'
import { useOrgs } from '@/lib/org-context'
import { hasOwnMachine, type OutOfCreditsContext, type OutOfCreditsOffer } from '@/lib/out-of-credits'
import { useOptionalModal } from '@/components/console/ModalProvider'
import { Button, Icon } from '@/components/ui'

/** What a turn's out-of-credits failure can offer this viewer, by CloudCreditGate's Cloud test. */
export function useOutOfCreditsContext(agent: Agent | undefined): OutOfCreditsContext {
  const { myRole } = useOrgs()
  const { daemons, orgSetIds } = useConsoleData()
  return {
    onCloud:
      featureFlagEnabled('billing') &&
      featureFlagEnabled('managed') &&
      isPoolPlacementKind(agent?.placementKind, agent?.setId, orgSetIds),
    owner: myRole === 'owner',
    canEdit: !!agent?.canEdit && !agent.name.startsWith(MOCK_PREFIX),
    ownMachine: hasOwnMachine(daemons ?? [])
  }
}

export function OutOfCreditsNotice({
  agent,
  agentName,
  offer
}: {
  agent: Agent | undefined
  agentName: string
  offer: OutOfCreditsOffer
}) {
  const t = useTranslations('Billing.outOfCredits')
  const { orgPath } = useOrgs()
  const modal = useOptionalModal()
  const pathname = usePathname()
  const search = useSearchParams().toString()
  const [copied, setCopied] = useState(false)
  const billingHref = orgPath('/billing')
  const move =
    offer.moveToOwnMachine && agent && modal
      ? () => modal.openModal('editAgent', agent, { focusSection: 'basics' })
      : null
  const owner = offer.addCredits === 'link'

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(new URL(billingHref, window.location.origin).toString())
      setCopied(true)
      setTimeout(() => setCopied(false), 1700)
    } catch {
      /* clipboard unavailable */
    }
  }

  return (
    <div
      role="status"
      data-out-of-credits=""
      className="flex max-w-full flex-col gap-2.5 rounded-[11px] border border-(--border-default) bg-(--surface-card) px-3 py-2.5 font-sans text-[13px] font-normal leading-[1.45] desktop:max-w-[86%]"
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <span className="flex h-[26px] w-[26px] flex-none items-center justify-center rounded-[7px] bg-(--status-error-soft) text-(--status-error)">
          <Icon name="wallet" size={14} />
        </span>
        <span className="min-w-0 flex-1">
          <b className="font-semibold">{t('title')}</b>{' '}
          <span className="text-(--text-secondary)">
            {owner
              ? move
                ? t('bodyOwnerMove', { agent: agentName })
                : t('bodyOwner', { agent: agentName })
              : move
                ? t('bodyMemberMove', { agent: agentName })
                : t('bodyMember', { agent: agentName })}
          </span>
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2 pl-9">
        {owner ? (
          <Link
            className="dsbtn sm dsbtn-primary no-underline"
            // Billing takes the reader back to this conversation once the credits land.
            href={billingPathWithReturn(billingHref, search ? `${pathname}?${search}` : pathname)}
          >
            {t('addCredits')}
          </Link>
        ) : (
          <Button size="sm" variant="secondary" onClick={() => void copyLink()}>
            <Icon name={copied ? 'check' : 'copy'} size={14} />
            {copied ? t('copied') : t('copyBillingLink')}
          </Button>
        )}
        {move && (
          <Button size="sm" variant="secondary" onClick={move}>
            <Icon name="server" size={14} />
            {t('moveToOwnMachine')}
          </Button>
        )}
      </div>
    </div>
  )
}
