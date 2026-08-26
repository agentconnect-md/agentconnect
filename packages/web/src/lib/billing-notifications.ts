'use client'

// Billing suspension → notification center: mirrors `balanceBanner`'s red arm — spent-out orgs notify, never-funded ones don't.
import { useEffect } from 'react'
import useSWR from 'swr'
import { billingBase, fetchBillingAccount, fetchBillingTransactions, type BillingAccount } from '@/lib/billing-api'
import { ledgerHistory } from '@/lib/billing-banner'
import { featureFlagEnabled } from '@/lib/feature-flags'
import { consoleKeys } from '@/lib/swr-keys'
import { useNotifications, type NotificationSnapshotInput } from '@/lib/notifications'

export const BILLING_SUSPENDED_SOURCE_KEY = 'billing:suspended'

// The billing snapshot for `syncSourceSnapshot`; `null` = undecidable, do not sync — never resolve a real suspension mid-load only to re-add (and re-toast) it.
export function billingSuspensionNotifications(
  account: BillingAccount | undefined,
  hasHistory: boolean | null,
  orgPath: (path: string) => string
): NotificationSnapshotInput[] | null {
  if (!account) return null
  // 'unknown' is the gateway mid-decision — flapping the notification on it would duplicate history.
  if (account.state === 'unknown') return null
  if (account.state !== 'suspended') return []
  // Only an answered ledger can tell spent-out from never-funded — hold off until it does.
  if (hasHistory === null) return null
  if (!hasHistory) return []
  return [
    {
      category: 'billing',
      severity: 'error',
      sourceKey: BILLING_SUSPENDED_SOURCE_KEY,
      title: 'Agent traffic is paused — balance is empty',
      message:
        'LLM requests from this org are being rejected at the gateway because the prepaid balance is empty. Adding credits resumes service within a minute.',
      action: { label: 'Add credits', href: orgPath('/billing'), external: false }
    }
  ]
}

/** Polls the billing account and keeps one suspension notification in sync with it. */
export function useBillingSuspensionNotifier(orgId: string | null, orgPath: (path: string) => string): void {
  const { syncSourceSnapshot } = useNotifications()
  const offered = featureFlagEnabled('billing') && billingBase() !== null && orgId !== null
  const account = useSWR(offered ? consoleKeys.billingAccount(orgId) : null, () => fetchBillingAccount(orgId!), {
    refreshInterval: 60_000
  })
  const suspended = account.data?.state === 'suspended'
  // The ledger is read only to tell spent-out from never-funded, so only while suspended.
  const ledger = useSWR(offered && suspended ? consoleKeys.billingTransactions(orgId) : null, () =>
    fetchBillingTransactions(orgId!)
  )
  const accountData = account.data
  const hasHistory = ledgerHistory(ledger.data)

  useEffect(() => {
    if (!offered) return
    const items = billingSuspensionNotifications(accountData, hasHistory, orgPath)
    if (items) syncSourceSnapshot('billing', items)
  }, [offered, accountData, hasHistory, orgPath, syncSourceSnapshot])
}
