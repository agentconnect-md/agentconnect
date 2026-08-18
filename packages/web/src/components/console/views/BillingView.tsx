'use client'

// Billing page. It renders what the billing service returns and nothing more —
// no prices, no entitlement rules of its own. Paying for credit is not here yet:
// it arrives with the service's payment channel, and this page's whole part in it
// will be a redirect to the checkout URL the API hands back.

import useSWR from 'swr'
import { billingBase, fetchBillingAccount, fetchBillingTransactions, fmtMicroUsd } from '@/lib/billing-api'
import { useOrgs } from '@/lib/org-context'
import { consoleKeys } from '@/lib/swr-keys'
import { LoadingState } from '@/components/marks'
import { Button, Icon } from '@/components/ui'

// `.row` is a bare grid — the column template is the caller's, as a full literal.
const TX_GRID = 'grid-cols-[1fr_110px] gap-3'

const KIND_LABEL: Record<string, string> = {
  purchase: 'Credit purchase',
  adjustment: 'Adjustment',
  promo: 'Promotional credit',
  refund: 'Refund'
}

function fmtWhen(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

function Notice({ title, body }: { title: string; body: string }) {
  return (
    <div className="wrap">
      <div className="card flex flex-col items-center gap-3 px-6 py-[44px] text-center">
        <span className="flex h-[46px] w-[46px] items-center justify-center rounded-[11px] border border-(--border-subtle) bg-(--surface-sunken)">
          <Icon name="credit-card" size={22} color="var(--text-tertiary)" />
        </span>
        <div className="font-sans text-[15px] font-semibold leading-normal">{title}</div>
        <div className="max-w-[400px] font-sans text-[13px] font-normal leading-[1.55] text-(--text-secondary)">
          {body}
        </div>
      </div>
    </div>
  )
}

export default function BillingView() {
  const { activeOrg, loading: orgLoading } = useOrgs()
  const orgId = activeOrg?.id ?? null

  const account = useSWR(consoleKeys.billingAccount(orgId), orgId ? () => fetchBillingAccount(orgId) : null)
  const transactions = useSWR(
    consoleKeys.billingTransactions(orgId),
    orgId ? () => fetchBillingTransactions(orgId) : null
  )

  // Deep-link landing for a console without billing: the rail hides the
  // entry, so anyone here typed the URL or followed an old bookmark.
  if (!billingBase())
    return (
      <Notice
        title="Billing applies to AgentConnect Cloud"
        body="This deployment is self-hosted, so there is nothing to bill. Usage and cost of your own runtimes are on the Analytics page."
      />
    )
  if (orgLoading) return <LoadingState fill />
  // Every figure on this page belongs to an org, so without one there is nothing
  // to ask for — the fetches below stay unkeyed and would leave the page silently
  // empty. Reached when the org list came back empty or unauthorized (a stale
  // session keeps a token, so nothing redirects to sign-in).
  if (!orgId)
    return (
      <Notice
        title="No organization selected"
        body="Billing is per organization. Pick one from the switcher, or sign in again if your session has expired."
      />
    )
  if (!account.data && !account.error) return <LoadingState fill />

  const acct = account.data

  return (
    <div className="wrap">
      <div className="mb-4 flex min-h-[34px] items-center gap-4">
        <p className="psub mt-0 flex-1">Prepaid balance for this organization, and what has been credited to it.</p>
      </div>

      {account.error && (
        <div className="card mb-4 flex items-center gap-3 px-4 py-3">
          <Icon name="triangle-alert" size={18} color="var(--status-error)" />
          <span className="flex-1 font-sans text-[13px] font-normal leading-[1.55]">
            Could not reach the billing service: {(account.error as Error).message}
          </span>
          <Button size="sm" variant="secondary" onClick={() => void account.mutate()}>
            Retry
          </Button>
        </div>
      )}

      {acct && (
        <>
          {/* One figure, no in-flight caveat: v1 has no hold layer, so the balance
              is every reconciliation fact there is. A suspended/low-balance badge
              belongs here once the service can report a state at all. */}
          <div className="card stat mb-4 max-w-[320px]">
            <div className="statlbl">Balance</div>
            <div className="statval">{fmtMicroUsd(acct.balanceMicro)}</div>
          </div>

          <div className="card">
            <div className="cardhead">
              <span className="cardtitle">Transactions</span>
            </div>
            {/* The two requests fail independently, so this card carries its own
                error: a reachable account with an unreachable history would
                otherwise render as "no transactions", which is a lie. */}
            {transactions.error ? (
              <div className="flex items-center gap-3 px-4 py-3">
                <Icon name="triangle-alert" size={18} color="var(--status-error)" />
                <span className="flex-1 font-sans text-[13px] font-normal leading-[1.55]">
                  Could not load transactions: {(transactions.error as Error).message}
                </span>
                <Button size="sm" variant="secondary" onClick={() => void transactions.mutate()}>
                  Retry
                </Button>
              </div>
            ) : !transactions.data ? (
              <div className="px-4 py-8 text-center font-sans text-[13px] font-normal leading-[1.55] text-(--text-tertiary)">
                Loading…
              </div>
            ) : transactions.data.items.length === 0 ? (
              <div className="px-4 py-8 text-center font-sans text-[13px] font-normal leading-[1.55] text-(--text-secondary)">
                No transactions yet.
              </div>
            ) : (
              transactions.data.items.map((t) => (
                <div key={t.id} className={`row ${TX_GRID}`}>
                  <span className="min-w-0">
                    <span className="block truncate font-sans text-[13px] font-medium leading-normal">
                      {KIND_LABEL[t.kind] ?? t.kind}
                    </span>
                    <span className="block font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
                      {fmtWhen(t.at)}
                    </span>
                  </span>
                  <span className="mono text-right text-[13px]">{fmtMicroUsd(t.amountMicro)}</span>
                </div>
              ))
            )}
            {transactions.data?.nextCursor && (
              <div className="px-4 py-3 text-center font-sans text-[12px] font-normal leading-[1.55] text-(--text-tertiary)">
                Showing the most recent transactions.
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
