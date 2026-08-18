'use client'

// Billing page. It renders what the billing service returns and nothing more —
// no prices, no entitlement rules of its own. Paying for credit is here, and the
// console's whole part in it is: pick an amount, POST it, redirect to the Stripe
// checkout URL the API hands back, and — after Stripe returns the browser — poll
// the purchase until the service says the payment settled. The return redirect
// itself is never treated as proof of payment.

import { useCallback, useEffect, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import useSWR from 'swr'
import {
  PURCHASE_MAX_MICRO,
  PURCHASE_MIN_MICRO,
  createBillingPurchase,
  fetchBillingAccount,
  fetchBillingPurchase,
  fetchBillingTransactions,
  fmtMicroUsd,
  type BillingPurchase
} from '@/lib/billing-api'
import { featureFlagEnabled } from '@/lib/feature-flags'
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

const PRESETS_USD = [10, 50, 100]
const MIN_USD = PURCHASE_MIN_MICRO / 1_000_000
const MAX_USD = PURCHASE_MAX_MICRO / 1_000_000
/** 2.5s cadence; ~5 minutes before the poll goes quiet ("safe to leave"). */
const POLL_INTERVAL_MS = 2_500
const POLL_MAX_ATTEMPTS = 120

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

// ── The checkout return, as a state machine ──────────────────────────────────
// `?checkout=success&purchase=<id>` only means "the browser came back"; the
// purchase settles when the service — fed by its webhook and its own Stripe
// reconcile — reports `completed`. `cancel` means the user backed out of the
// hosted page: nothing was charged and there is nothing to poll.

type CheckoutReturn =
  | { phase: 'confirming'; purchaseId: string; attempt: number }
  | { phase: 'still-pending'; purchaseId: string }
  | { phase: 'completed'; purchase: BillingPurchase }
  | { phase: 'failed' }
  | { phase: 'expired' }
  | { phase: 'canceled' }
  | { phase: 'error'; message: string }

const BANNER_TONE: Record<CheckoutReturn['phase'], { border: string; bg: string; icon: string }> = {
  confirming: { border: 'var(--status-info)', bg: 'var(--status-info-soft)', icon: 'clock' },
  'still-pending': { border: 'var(--status-info)', bg: 'var(--status-info-soft)', icon: 'clock' },
  completed: { border: 'var(--status-online)', bg: 'var(--status-online-soft)', icon: 'check' },
  failed: { border: 'var(--status-error)', bg: 'var(--status-error-soft)', icon: 'x' },
  expired: { border: 'var(--status-paused)', bg: 'var(--status-paused-soft)', icon: 'timer-off' },
  canceled: { border: 'var(--border-strong)', bg: 'var(--surface-sunken)', icon: 'undo-2' },
  error: { border: 'var(--status-error)', bg: 'var(--status-error-soft)', icon: 'triangle-alert' }
}

function checkoutCopy(state: CheckoutReturn): { title: string; body: string } {
  switch (state.phase) {
    case 'confirming':
      return {
        title: 'Confirming your payment',
        body: 'You came back from Stripe, but the payment counts only once Stripe tells us it settled. Credits post as soon as that lands — usually seconds. Safe to leave this page; the balance updates on its own.'
      }
    case 'still-pending':
      return {
        title: 'Payment still settling',
        body: 'Stripe has not confirmed the payment yet. Some payment methods settle over several minutes — credits post automatically once it lands, and it is safe to leave this page.'
      }
    case 'completed':
      return {
        title: `${fmtMicroUsd(state.purchase.amountMicro)} added`,
        body: 'The payment settled and the credits are on your balance.'
      }
    case 'failed':
      return {
        title: "Payment didn't go through",
        body: 'Stripe declined the payment, so nothing was charged and your balance is unchanged. You can try again with the same or a different method.'
      }
    case 'expired':
      return {
        title: 'Checkout session expired',
        body: "The Stripe session timed out before payment completed. Nothing was charged — start a new one when you're ready."
      }
    case 'canceled':
      return { title: 'Checkout canceled', body: 'You left the Stripe page before paying. Nothing was charged.' }
    case 'error':
      return { title: 'Could not check the payment', body: state.message }
  }
}

function CheckoutBanner({ state, onDismiss }: { state: CheckoutReturn; onDismiss: () => void }) {
  const tone = BANNER_TONE[state.phase]
  const copy = checkoutCopy(state)
  const busy = state.phase === 'confirming'
  return (
    <div
      className="mb-4 flex items-start gap-3 rounded-[10px] border px-4 py-3.5"
      style={{ borderColor: tone.border, background: tone.bg }}
    >
      <span className="mt-[1px] flex-none" style={{ color: tone.border }}>
        <Icon name={tone.icon} size={17} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="font-sans text-[13.5px] font-semibold leading-normal">{copy.title}</div>
        <div className="mt-[3px] max-w-[720px] font-sans text-[12.5px] font-normal leading-[1.6] text-(--text-secondary)">
          {copy.body}
        </div>
        {busy && (
          <div className="mono mt-2 text-[11.5px] text-(--text-tertiary)">
            checking payment status · attempt {state.phase === 'confirming' ? state.attempt : 0}
          </div>
        )}
        {state.phase === 'completed' && state.purchase.receiptUrl && (
          <a
            className="mt-2 inline-flex items-center gap-1 font-sans text-[12px] font-medium text-(--text-brand) hover:underline"
            href={state.purchase.receiptUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            View receipt
            <Icon name="arrow-up-right" size={12} />
          </a>
        )}
      </div>
      {!busy && (
        <Button size="xs" variant="ghost" onClick={onDismiss} ariaLabel="Dismiss">
          <Icon name="x" size={14} />
        </Button>
      )}
    </div>
  )
}

// ── Add credits (owners only — the service enforces this; the UI just agrees) ─

function AddCreditsCard({ orgId, returnPath }: { orgId: string; returnPath: string }) {
  const [preset, setPreset] = useState<number>(50)
  const [custom, setCustom] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const usd = custom !== '' ? Number.parseFloat(custom) : preset
  const cents = Number.isFinite(usd) ? Math.round(usd * 100) : Number.NaN
  const valid = Number.isFinite(cents) && cents >= MIN_USD * 100 && cents <= MAX_USD * 100
  const invalidCustom = custom !== '' && !valid

  const submit = async () => {
    if (!valid || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const { url } = await createBillingPurchase(orgId, {
        amountMicro: cents * 10_000,
        // Replay protection for THIS click; the service's crash-window and
        // webhook idempotency are what actually guard the money.
        idempotencyKey: crypto.randomUUID(),
        returnPath
      })
      window.location.assign(url)
      // `submitting` stays true — the page is navigating away.
    } catch (e) {
      setError((e as Error).message)
      setSubmitting(false)
    }
  }

  return (
    <div className="card flex flex-col">
      <div className="cardhead">
        <span className="cardtitle">Add credits</span>
      </div>
      <div className="flex flex-1 flex-col p-4">
        <div className="grid grid-cols-4 gap-2">
          {PRESETS_USD.map((v) => {
            const on = custom === '' && preset === v
            return (
              <button
                key={v}
                type="button"
                className="mono flex h-[38px] cursor-pointer items-center justify-center rounded-[9px] text-[14px] font-semibold"
                style={
                  on
                    ? { border: '1.5px solid var(--brand)', background: 'var(--brand-soft)' }
                    : { border: '1px solid var(--border-default)', background: 'var(--surface-card)' }
                }
                onClick={() => {
                  setPreset(v)
                  setCustom('')
                }}
              >
                ${v}
              </button>
            )
          })}
          <div
            className="flex h-[38px] items-center gap-1.5 rounded-[6px] border px-2.5"
            style={{ borderColor: invalidCustom ? 'var(--status-error)' : 'var(--border-default)' }}
          >
            <span className="mono text-[12.5px] text-(--text-tertiary)">$</span>
            <input
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              placeholder="Other"
              inputMode="decimal"
              aria-label="Custom amount in USD"
              className="mono w-full min-w-0 border-0 bg-transparent text-[12.5px] outline-none"
            />
          </div>
        </div>
        <div
          className="mt-2 font-sans text-[11.5px] font-normal leading-[1.5]"
          style={{ color: invalidCustom ? 'var(--status-error)' : 'var(--text-tertiary)' }}
        >
          {invalidCustom
            ? `Enter an amount between $${MIN_USD.toFixed(2)} and $${MAX_USD.toLocaleString('en-US', { minimumFractionDigits: 2 })}.`
            : `Minimum $${MIN_USD.toFixed(2)}, maximum $${MAX_USD.toLocaleString('en-US', { minimumFractionDigits: 2 })} per purchase.`}
        </div>
        {error && (
          <div className="mt-2 flex items-center gap-2 font-sans text-[12px] text-(--status-error)">
            <Icon name="triangle-alert" size={14} />
            <span className="min-w-0 flex-1">{error}</span>
          </div>
        )}
        <div className="mt-3">
          <Button size="md" disabled={!valid || submitting} onClick={() => void submit()} className="w-full">
            <span className="inline-flex items-center gap-2">
              <Icon name={submitting ? 'loader-circle' : 'plus'} size={15} />
              {submitting ? 'Opening Stripe checkout…' : `Add ${valid ? fmtMicroUsd(cents * 10_000) : 'credits'}`}
            </span>
          </Button>
        </div>
        <div className="mt-auto flex items-start gap-2 pt-3.5">
          <span className="mt-[2px] flex-none text-(--text-tertiary)">
            <Icon name="lock" size={13} />
          </span>
          <span className="font-sans text-[11.5px] font-normal leading-[1.55] text-(--text-tertiary)">
            Payment is handled on Stripe's hosted page. Card details never touch AgentConnect.
          </span>
        </div>
      </div>
    </div>
  )
}

function MembersDontPayCard() {
  return (
    <div className="card flex flex-col">
      <div className="cardhead">
        <span className="cardtitle">Add credits</span>
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-5 text-center">
        <span className="flex h-9 w-9 items-center justify-center rounded-[9px] border border-(--border-subtle) bg-(--surface-sunken) text-(--text-tertiary)">
          <Icon name="user-round-cog" size={17} />
        </span>
        <div className="font-sans text-[13px] font-semibold">Owners add credits</div>
        <div className="max-w-[300px] font-sans text-[12px] font-normal leading-[1.6] text-(--text-tertiary)">
          You can see the balance and every transaction. Ask an org owner to top up.
        </div>
      </div>
    </div>
  )
}

export default function BillingView() {
  const { activeOrg, myRole, loading: orgLoading } = useOrgs()
  const orgId = activeOrg?.id ?? null
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  // Hooks run before any early return, so the flag has to gate the KEYS, not just
  // the render: a null key is what stops SWR from fetching. Checking it only below
  // would let a deep link on a console without billing still call the service —
  // twice — before rendering the notice that says billing is elsewhere.
  const offered = featureFlagEnabled('billing')
  const fetching = offered && orgId !== null

  const account = useSWR(fetching ? consoleKeys.billingAccount(orgId) : null, () => fetchBillingAccount(orgId!))
  const transactions = useSWR(fetching ? consoleKeys.billingTransactions(orgId) : null, () =>
    fetchBillingTransactions(orgId!)
  )

  // The return from Stripe. Claimed once from the URL, which is then cleaned so
  // a refresh or a shared link does not replay the banner.
  const [checkout, setCheckout] = useState<CheckoutReturn | null>(null)
  const claimed = useRef(false)
  useEffect(() => {
    if (claimed.current || !offered) return
    const result = searchParams.get('checkout')
    const purchaseId = searchParams.get('purchase')
    if (!result) return
    claimed.current = true
    if (result === 'success' && purchaseId) setCheckout({ phase: 'confirming', purchaseId, attempt: 1 })
    else if (result === 'cancel') setCheckout({ phase: 'canceled' })
    router.replace(pathname)
  }, [offered, searchParams, router, pathname])

  // Poll until the service reports a terminal status. Each poll also makes the
  // service reconcile against Stripe directly, so a lost webhook delays nothing.
  const refreshMoney = useCallback(() => {
    void account.mutate()
    void transactions.mutate()
  }, [account.mutate, transactions.mutate])
  useEffect(() => {
    if (!orgId || checkout?.phase !== 'confirming') return
    const { purchaseId, attempt } = checkout
    let cancelled = false
    const timer = setTimeout(
      async () => {
        try {
          const purchase = await fetchBillingPurchase(orgId, purchaseId)
          if (cancelled) return
          if (purchase.status === 'completed') {
            setCheckout({ phase: 'completed', purchase })
            refreshMoney()
          } else if (purchase.status === 'failed') setCheckout({ phase: 'failed' })
          else if (purchase.status === 'expired') setCheckout({ phase: 'expired' })
          else if (attempt >= POLL_MAX_ATTEMPTS) setCheckout({ phase: 'still-pending', purchaseId })
          else setCheckout({ phase: 'confirming', purchaseId, attempt: attempt + 1 })
        } catch (e) {
          if (!cancelled) setCheckout({ phase: 'error', message: (e as Error).message })
        }
      },
      attempt === 1 ? 0 : POLL_INTERVAL_MS
    )
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [orgId, checkout, refreshMoney])

  // Deep-link landing for a console that does not offer billing: the rail hides
  // the entry, so anyone here typed the URL or followed an old bookmark. Gated on
  // the flag, not on BILLING_URL — with the flag on and no endpoint configured the
  // page must report a broken deployment, not quietly claim billing is elsewhere.
  if (!offered)
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

      {checkout && <CheckoutBanner state={checkout} onDismiss={() => setCheckout(null)} />}

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
          <div className="mb-4 grid items-stretch gap-4 md:grid-cols-2">
            {/* One figure, no in-flight caveat: v1 has no hold layer, so the balance
                is every reconciliation fact there is. A suspended/low-balance badge
                belongs here once the service can report a state at all. */}
            <div className="card stat">
              <div className="statlbl">Balance</div>
              <div className="statval">{fmtMicroUsd(acct.balanceMicro)}</div>
            </div>
            {/* Only owners move money — the service enforces it (403); the page
                just doesn't offer members a form that would be refused. */}
            {myRole === 'owner' ? (
              <AddCreditsCard orgId={orgId} returnPath={pathname} />
            ) : myRole ? (
              <MembersDontPayCard />
            ) : null}
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
