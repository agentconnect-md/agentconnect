'use client'

// The composer's one notice for a Cloud agent whose org has no credit: say why nothing replies and
// offer the fix in place. Daemon and cluster agents never render it — they do not run on credit.

import { useState } from 'react'
import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import useSWR from 'swr'
import { fetchBillingAccount } from '@/lib/billing-api'
import { cloudCreditGate } from '@/lib/billing-banner'
import { billingPathWithReturn } from '@/lib/billing-return'
import { useConsoleData } from '@/lib/data-context'
import { isPoolPlacementKind, type Agent } from '@/lib/data'
import { featureFlagEnabled } from '@/lib/feature-flags'
import { useOrgs } from '@/lib/org-context'
import { consoleKeys } from '@/lib/swr-keys'
import { useCardSetupReturn } from '@/lib/use-card-setup-return'
import { AddCardDialog } from '@/components/console/billing/CardBinding'
import { Button, Icon } from '@/components/ui'

export function CloudCreditGate({ agent, agentName }: { agent: Agent | undefined; agentName: string }) {
  const t = useTranslations('Billing.gate')
  const { activeOrg, myRole, orgPath } = useOrgs()
  const { orgSetIds } = useConsoleData()
  const pathname = usePathname()
  const search = useSearchParams().toString()
  const orgId = activeOrg?.id ?? null
  // Only managed Cloud runs on credit: a self-hosted cluster and an org's own group are someone's machines.
  const onCloud =
    featureFlagEnabled('billing') &&
    featureFlagEnabled('managed') &&
    isPoolPlacementKind(agent?.placementKind, agent?.setId, orgSetIds)
  const account = useSWR(onCloud && orgId ? consoleKeys.billingAccount(orgId) : null, () => fetchBillingAccount(orgId!))
  // Add card returns to this page, so the return is claimed here and the account re-read once it settles.
  const cardReturn = useCardSetupReturn({ orgId, enabled: onCloud, onSaved: () => void account.mutate() })
  const [dialog, setDialog] = useState(false)
  const [copied, setCopied] = useState(false)

  const gate = account.data ? cloudCreditGate(account.data, myRole === 'owner') : null
  if (!onCloud || !orgId || !gate) return null
  const billingHref = orgPath('/billing')
  const checking = cardReturn.state?.phase === 'checking'

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
      className="mb-2 flex flex-wrap items-center gap-2.5 rounded-[11px] border border-(--border-default) bg-(--surface-card) px-3 py-2.5 font-sans text-[13px] font-normal leading-[1.45]"
    >
      <span
        className={
          gate === 'add-card'
            ? 'flex h-[26px] w-[26px] flex-none items-center justify-center rounded-[7px] bg-(--brand-soft) text-(--brand)'
            : 'flex h-[26px] w-[26px] flex-none items-center justify-center rounded-[7px] bg-(--status-error-soft) text-(--status-error)'
        }
      >
        <Icon name={checking ? 'loader-circle' : gate === 'add-card' ? 'gift' : 'wallet'} size={14} />
      </span>
      <span className="min-w-0 flex-1">
        <b className="font-semibold">{gate === 'add-card' ? t('noCreditYet') : t('outOfCredit')}</b>{' '}
        <span className="text-(--text-secondary)">
          {checking
            ? t('checkingCard')
            : gate === 'add-card'
              ? t('addCardBody')
              : gate === 'ask-owner'
                ? t('askOwnerBody')
                : t('addCreditsBody', { agent: agentName })}
        </span>
      </span>
      {gate === 'ask-owner' ? (
        <Button size="sm" variant="secondary" onClick={() => void copyLink()}>
          <Icon name={copied ? 'check' : 'copy'} size={14} />
          {copied ? t('copied') : t('copyBillingLink')}
        </Button>
      ) : (
        <>
          <Link
            className={
              gate === 'add-card' ? 'dsbtn sm dsbtn-secondary no-underline' : 'dsbtn sm dsbtn-primary no-underline'
            }
            // Billing takes the reader back to this conversation once the credits land.
            href={billingPathWithReturn(billingHref, search ? `${pathname}?${search}` : pathname)}
          >
            {t('addCredits')}
          </Link>
          {gate === 'add-card' && (
            <Button size="sm" disabled={checking} onClick={() => setDialog(true)}>
              {t('addCard')}
            </Button>
          )}
        </>
      )}
      {dialog && (
        <AddCardDialog
          orgId={orgId}
          orgName={activeOrg?.name ?? activeOrg?.slug ?? ''}
          returnPath={pathname}
          promoAvailable
          replacing={false}
          onClose={() => setDialog(false)}
        />
      )}
    </div>
  )
}
