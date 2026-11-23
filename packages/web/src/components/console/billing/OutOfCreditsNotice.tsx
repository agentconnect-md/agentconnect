'use client'

// A Cloud turn that failed for lack of credit, drawn as its fixes instead of the raw failure text.

import { useState } from 'react'
import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import useSWR from 'swr'
import { fetchDaemons } from '@/lib/api'
import { billingPathWithReturn } from '@/lib/billing-return'
import { useConsoleData } from '@/lib/data-context'
import { isPoolPlacementKind, MOCK_PREFIX, type Agent } from '@/lib/data'
import { featureFlagEnabled } from '@/lib/feature-flags'
import { useOrgs } from '@/lib/org-context'
import { hasOwnMachine, type OutOfCreditsContext, type OutOfCreditsOffer } from '@/lib/out-of-credits'
import { consoleKeys } from '@/lib/swr-keys'
import { useOptionalModal } from '@/components/console/ModalProvider'
import { Button, Icon } from '@/components/ui'

/** What a turn's out-of-credits failure can offer this viewer, by CloudCreditGate's Cloud test. */
export function useOutOfCreditsContext(agent: Agent | undefined): OutOfCreditsContext {
  const { myRole } = useOrgs()
  const { orgSetIds } = useConsoleData()
  return {
    onCloud:
      featureFlagEnabled('billing') &&
      featureFlagEnabled('managed') &&
      isPoolPlacementKind(agent?.placementKind, agent?.setId, orgSetIds),
    owner: myRole === 'owner',
    canEdit: !!agent?.canEdit && !agent.name.startsWith(MOCK_PREFIX)
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
  const { orgPath, activeOrg } = useOrgs()
  const modal = useOptionalModal()
  const orgId = activeOrg?.id ?? null
  // The card asks for the fleet itself: Move stays greyed out until the org shows a machine of its own.
  const fleet = useSWR(offer.moveToOwnMachine ? consoleKeys.daemons(orgId) : null, ([, id]) => fetchDaemons(id))
  const machineReady = !!fleet.data && hasOwnMachine(fleet.data)
  const pathname = usePathname()
  const search = useSearchParams().toString()
  const [copied, setCopied] = useState(false)
  const billingHref = orgPath('/billing')
  const move = offer.moveToOwnMachine && agent && modal
  const openMove = () => {
    if (agent) modal?.openModal('editAgent', agent, { focusSection: 'basics' })
  }
  const owner = offer.addCredits === 'link'
  const neverFunded = offer.code === 'never_funded'

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
          <b className="font-semibold">{t(neverFunded ? 'neverFundedTitle' : 'title')}</b>{' '}
          <span className="text-(--text-secondary)">
            {t(neverFunded ? 'neverFundedLead' : 'lead', { agent: agentName })}{' '}
            {owner ? (move ? t('nextOwnerMove') : t('nextOwner')) : move ? t('nextMemberMove') : t('nextMember')}
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
          <Button size="sm" variant="secondary" disabled={!machineReady} onClick={openMove}>
            <Icon name="server" size={14} />
            {t('moveToOwnMachine')}
          </Button>
        )}
      </div>
      {move && !machineReady && (fleet.data || fleet.error) && (
        <span className="pl-9 text-[12px] text-(--text-tertiary)">
          {t(fleet.data ? 'noOwnMachine' : 'machinesUnreadable')}
        </span>
      )}
    </div>
  )
}
