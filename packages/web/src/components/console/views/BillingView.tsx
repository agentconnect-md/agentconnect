'use client'

// Billing page. It renders what the billing service returns and nothing more —
// no prices, no entitlement rules of its own. Paying for credit is here, and the
// console's whole part in it is: pick an amount, POST it, redirect to the Stripe
// checkout URL the API hands back, and — after Stripe returns the browser — poll
// the purchase until the service says the payment settled. The return redirect
// itself is never treated as proof of payment.

import { useCallback, useEffect, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import useSWR, { useSWRConfig } from 'swr'
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis } from 'recharts'
import {
  BillingError,
  BillingShapeError,
  PURCHASE_MAX_MICRO,
  PURCHASE_MIN_MICRO,
  createBillingPurchase,
  fetchBillingAccount,
  fetchBillingPurchase,
  fetchBillingTransactions,
  fetchBillingTransactionsSince,
  fmtDecimalUsd,
  fmtMicroUsd,
  type BillingAccount,
  type BillingPurchase,
  type BillingTransaction
} from '@/lib/billing-api'
import {
  ACTIVITY_RANGES,
  activityRange,
  activityWindowStart,
  bucketActivity,
  type ActivityMode,
  type ActivityRange
} from '@/lib/billing-activity'
import { balanceBanner, ledgerHistory } from '@/lib/billing-banner'
import { featureFlagEnabled } from '@/lib/feature-flags'
import { useOrgs } from '@/lib/org-context'
import { SEG_FILL, tickInterval } from '@/lib/spend-chart'
import { consoleKeys } from '@/lib/swr-keys'
import { LoadingState } from '@/components/marks'
import { Button, Icon } from '@/components/ui'

// `.row` is a bare grid — the column template is the caller's, as a full literal.
// Design columns: direction chip · description · amount · spacer · posted.
// Every track but the description is a fixed width: each `.row` is its own grid, so an
// `auto` track sizes per-row and pulls the header out of line with the body below it.
// Mobile scrolls the card sideways (globals' `.card:has(.row)`), so one template serves both.
const TX_GRID = 'grid-cols-[34px_minmax(0,1fr)_132px_24px_190px] gap-2'

// The Transactions filter, the same Usage / Top-ups split the Activity chart offers — plus
// `all`, which is the table's own default and the whole ledger it always showed. `type` goes
// to the service: the feed is keyset-paginated over both ledger sides at once, so narrowing
// it here rather than on a page already fetched is what keeps the cursor, the loaded count
// and "end of ledger" describing the rows actually on screen.
const TX_SIDES = [
  { key: 'all', label: 'All', type: undefined },
  { key: 'debit', label: 'Usage', type: 'debit' },
  { key: 'credit', label: 'Top-ups', type: 'credit' }
] as const
type TxSide = (typeof TX_SIDES)[number]['key']

const KIND_LABEL: Record<string, string> = {
  purchase: 'Credit purchase',
  adjustment: 'Adjustment',
  promo: 'Promotional credit',
  refund: 'Refund'
}

// The gateway's own call, as the design's balance-card status pill. No `state` ⇒ no pill.
const STATE_PILL: Record<NonNullable<BillingAccount['state']>, { label: string; color: string }> = {
  active: { label: 'Serving', color: 'var(--status-online)' },
  suspended: { label: 'Suspended', color: 'var(--status-error)' },
  unknown: { label: 'Unconfirmed', color: 'var(--status-info)' }
}

// Design's Posted column, `YYYY-MM-DD HH:mm` in the viewer's own timezone. sv-SE is the
// locale whose short form already is that shape, so no manual part assembly.
const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone
function fmtPostedLocal(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString('sv-SE', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      })
}

const PRESETS_USD = [10, 50, 100]
const MIN_USD = PURCHASE_MIN_MICRO / 1_000_000
const MAX_USD = PURCHASE_MAX_MICRO / 1_000_000
/** 2.5s cadence; ~5 minutes before the poll goes quiet ("safe to leave"). */
const POLL_INTERVAL_MS = 2_500
const POLL_MAX_ATTEMPTS = 120

// Complete literal class strings, never assembled from fragments: Tailwind's scanner only
// sees whole literals, and `tone` is a closed union of four compile-time constants, so
// nothing here is the data-derived value rule 8's inline carve-out is for.
// Glyph colour is per-tone because the chips do not all carry white. The chips stay mid-tone
// in both themes while `--text-primary` flips to near-white in dark, which would make the fix
// worse than the bug (amber would go 1.78:1). Contrast against the chip, light / dark, against
// the 3:1 non-text threshold:
//
//   brand  white 5.25 / 5.25      ✓ white
//   red    white 4.08 / 3.01      ✓ white, but dark mode is at the line — if the red
//                                 palette is ever nudged lighter, this needs `--gray-900` too
//   amber  white 2.52 / 2.05  ✗   → --gray-900: 6.44 / 7.90
//   blue   white 4.55 / 2.85      ✓ white — the design canvas carries white here, and the
//                                 dark glyph read WORSE in practice (near-invisible on the
//                                 mid blue) than the numeric dark-mode shortfall it fixed
//
// `--gray-900`, not the hex it resolves to, and not `--text-primary`: the palette entry is
// theme-stable (the dark block remaps only the semantic layer above it), which is exactly the
// property the amber chip needs.
const BALANCE_TONE = {
  brand: { card: 'bg-(--brand-soft) border-(--brand)', chip: 'bg-(--brand)', glyph: '#fff' },
  red: { card: 'bg-(--status-error-soft) border-(--status-error)', chip: 'bg-(--status-error)', glyph: '#fff' },
  amber: {
    card: 'bg-(--status-paused-soft) border-(--status-paused)',
    chip: 'bg-(--status-paused)',
    glyph: 'var(--gray-900)'
  },
  blue: { card: 'bg-(--status-info-soft) border-(--status-info)', chip: 'bg-(--status-info)', glyph: '#fff' }
} as const

function BalanceBannerCard({
  acct,
  hasHistory,
  canPay,
  onAddCredits
}: {
  acct: BillingAccount
  hasHistory: boolean | null
  canPay: boolean
  onAddCredits: () => void
}) {
  const banner = balanceBanner(acct, { hasHistory })
  if (!banner) return null
  const tone = BALANCE_TONE[banner.tone]
  return (
    <div className={`mb-[18px] flex items-start gap-3 rounded-[10px] border px-4 py-3.5 ${tone.card}`}>
      <span className={`flex h-7 w-7 flex-none items-center justify-center rounded-lg ${tone.chip}`}>
        <Icon name={banner.icon} size={16} color={tone.glyph} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="font-sans text-[13px] font-semibold leading-normal">{banner.title}</div>
        <div className="mt-1 font-sans text-[12.5px] font-normal leading-[1.55] text-(--text-secondary)">
          {banner.text}
        </div>
        {/* Only owners move money — the service enforces it; this just doesn't offer a refused form. */}
        {banner.cta && canPay && (
          <Button size="sm" className="mt-2.5" onClick={onAddCredits}>
            {banner.cta}
          </Button>
        )}
      </div>
    </div>
  )
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
//
// `failed` is the only polled status this page treats as an authoritative
// no-charge answer. `expired` is NOT one: the mirrored contract says a paid
// session may complete an intent an expiry guess had already marked `expired`,
// so an expired reading keeps reconciling for the full poll budget and the
// banner it ends on never claims nothing was charged. Transient poll failures
// don't abandon the confirmation either — the purchase id is kept, retried
// within the same budget, and surfaced with a manual retry if it runs out.

type CheckoutReturn =
  | { phase: 'confirming'; purchaseId: string; attempt: number }
  | { phase: 'still-pending'; purchaseId: string }
  | { phase: 'completed'; purchase: BillingPurchase }
  | { phase: 'failed' }
  | { phase: 'expired'; purchaseId: string }
  | { phase: 'canceled' }
  | { phase: 'error'; purchaseId: string; message: string }

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
        body: 'The Stripe session timed out and no payment confirmation has arrived. If you left without paying, nothing was charged. If you paid just as the session closed, the credits still post automatically once Stripe confirms — they will show in the transactions below.'
      }
    case 'canceled':
      return { title: 'Checkout canceled', body: 'You left the Stripe page before paying. Nothing was charged.' }
    case 'error':
      return {
        title: 'Could not check the payment',
        body: `${state.message} — if the payment went through, the credits still post automatically; you can also check again now.`
      }
  }
}

function CheckoutBanner({
  state,
  onDismiss,
  onRetry
}: {
  state: CheckoutReturn
  onDismiss: () => void
  onRetry: () => void
}) {
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
        {state.phase === 'error' && (
          <div className="mt-2">
            <Button size="xs" variant="secondary" onClick={onRetry}>
              Check again
            </Button>
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
    <div id="add-credits" className="card flex flex-col">
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
          {/* Focus lands on the inner input, so the wrapper carries the console's
              input focus look via focus-within; invalid keeps the red border either way. */}
          <div
            className={`flex h-[38px] items-center gap-1.5 rounded-[6px] border px-2.5 ${
              invalidCustom
                ? 'border-(--status-error)'
                : 'border-(--border-default) focus-within:border-(--border-focus) focus-within:shadow-[0_0_0_3px_var(--brand-ring)]'
            }`}
          >
            <span className="mono text-[12.5px] text-(--text-tertiary)">$</span>
            <input
              value={custom}
              // Digits and one dot only — anything else never enters the state.
              onChange={(e) => setCustom(e.target.value.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1'))}
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

// ── Activity: the ledger, bucketed ──────────────────────────────────────────
// Both series come out of the SAME feed the transactions table reads — this page has no
// other source, and the service exposes no time series of its own. So the chart states
// what the ledger says and nothing more: no burn rate, no projection, no "days left".
//
// SVG `fill` can't take a `var()` presentation attribute, so the hues are descendant rules
// on the wrapper — the trick `SEG_FILL` uses. Usage is the brand hue (money leaving),
// top-ups green (money arriving), the same pairing as the Cluster page's credits chart.
const ACTIVITY_FILL = '[&_.bar-usage_path]:fill-(--brand) [&_.bar-topup_path]:fill-(--green-500)'

function ActivityCard({ orgId }: { orgId: string }) {
  const [range, setRange] = useState<ActivityRange>('d7')
  const [mode, setMode] = useState<ActivityMode>('usage')
  const cfg = activityRange(range)

  const rows = useSWR(consoleKeys.billingActivity(orgId, range), () =>
    fetchBillingTransactionsSince(orgId, activityWindowStart(range))
  )
  const buckets = bucketActivity(rows.data ?? [], range, mode)
  const total = buckets.reduce((sum, b) => sum + b.amount, 0)

  const Tip = ({ active, payload }: { active?: boolean; payload?: { payload: (typeof buckets)[number] }[] }) => {
    const row = active ? payload?.[0]?.payload : undefined
    if (!row) return null
    return (
      <div className="rounded-md border border-(--border-subtle) bg-(--surface-card) px-2.5 py-2 shadow-(--shadow-md)">
        <div className="mono text-[11px] font-semibold">{row.label}</div>
        <div className="mt-1 flex items-center gap-1.5 font-sans text-[11px] leading-normal text-(--text-secondary)">
          <span
            className={`h-[9px] w-[9px] flex-none rounded-[2px] ${mode === 'usage' ? 'bg-(--brand)' : 'bg-(--green-500)'}`}
          />
          {mode === 'usage' ? 'usage' : 'topped up'}{' '}
          <span className="mono text-(--text-primary)">{fmtMicroUsd(Math.round(row.amount * 1_000_000))}</span>
        </div>
      </div>
    )
  }

  return (
    // `min-w-0`: recharts measures this box, and an auto min-width would let the plot
    // widen its own container.
    <div className="card mb-[18px] min-w-0">
      <div className="cardhead flex-wrap justify-between gap-2">
        <span className="inline-flex items-baseline gap-2">
          <span className="cardtitle">Activity</span>
          <span className="mono text-[11.5px] text-(--text-tertiary)">{cfg.note}</span>
        </span>
        <span className="flex items-center gap-2">
          <span className="pillbar">
            {ACTIVITY_RANGES.map((r) => (
              <button key={r.key} className={range === r.key ? 'pill on' : 'pill'} onClick={() => setRange(r.key)}>
                {r.label}
              </button>
            ))}
          </span>
          <span className="pillbar">
            <button className={mode === 'usage' ? 'pill on' : 'pill'} onClick={() => setMode('usage')}>
              Usage
            </button>
            <button className={mode === 'topups' ? 'pill on' : 'pill'} onClick={() => setMode('topups')}>
              Top-ups
            </button>
          </span>
        </span>
      </div>
      {rows.error ? (
        <div className="flex items-center gap-3 px-4 py-3">
          <Icon name="triangle-alert" size={18} color="var(--status-error)" />
          <span className="flex-1 font-sans text-[13px] font-normal leading-[1.55]">
            Could not load activity: {(rows.error as Error).message}
          </span>
          <Button size="sm" variant="secondary" onClick={() => void rows.mutate()}>
            Retry
          </Button>
        </div>
      ) : !rows.data ? (
        // Bar count is the range's real bucket count, so the placeholder has the plot's own
        // rhythm and switching range doesn't reflow the card's height. Each bar is an equal
        // flex SLOT with the bar 88% wide inside it, which is `barCategoryGap="12%"` below —
        // a fixed px gap would leave 7 wide bars glued together and 90 narrow ones as gap.
        <div className="p-4">
          <div className="flex h-[124px] animate-pulse items-end pb-[22px]">
            {Array.from({ length: cfg.buckets }, (_, i) => (
              <span
                key={i}
                className="flex min-w-0 flex-1 justify-center"
                style={{ height: `${24 + ((i * 23 + 13) % 60)}%` }}
              >
                <span className="w-[88%] rounded-t-[3px] bg-(--surface-active)" />
              </span>
            ))}
          </div>
          <div className="mt-2 flex justify-center">
            <span className="h-[11px] w-[160px] animate-pulse rounded-[3px] bg-(--surface-active)" />
          </div>
        </div>
      ) : (
        <div className="p-4">
          {/* An all-zero plot reads as broken rather than as empty, so an empty range says so
              in words and keeps the chart out of it. */}
          {total > 0 ? (
            <div className={`h-[124px] text-(--text-tertiary) ${SEG_FILL} ${ACTIVITY_FILL}`}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={buckets} margin={{ top: 4, right: 4, bottom: 0, left: 4 }} barCategoryGap="12%">
                  <XAxis
                    dataKey="label"
                    interval={tickInterval(buckets.length)}
                    tickLine={false}
                    axisLine={false}
                    tickMargin={6}
                    tick={{ fill: 'currentColor', fontSize: 10.5 }}
                    className="mono"
                  />
                  <Tooltip content={<Tip />} cursor={{ fill: 'var(--surface-hover)' }} />
                  {/* A pixel floor under any nonzero bucket, so a cent beside a $50 top-up is
                      still visible — and 0 for a bucket with nothing, so an idle day draws
                      nothing at all. */}
                  <Bar
                    dataKey="amount"
                    name={mode === 'usage' ? 'usage' : 'top-up'}
                    className={mode === 'usage' ? 'bar-usage' : 'bar-topup'}
                    radius={[3, 3, 0, 0]}
                    minPointSize={(_: number | null | undefined, i: number) => ((buckets[i]?.amount ?? 0) > 0 ? 3 : 0)}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="py-8 text-center font-sans text-[12.5px] font-normal leading-[1.55] text-(--text-tertiary)">
              {mode === 'usage'
                ? `Nothing was deducted in the ${cfg.note.replace('last ', '')}.`
                : `No credits were added in the ${cfg.note.replace('last ', '')}.`}
            </div>
          )}
          <div className="mt-2 text-center font-sans text-[11px] font-normal leading-normal text-(--text-tertiary)">
            {mode === 'usage' ? 'usage' : 'top-ups'} · {cfg.note.replace('last ', '')}{' '}
            <span className="mono text-[11px] text-(--text-secondary)">
              {fmtMicroUsd(Math.round(total * 1_000_000))}
            </span>
          </div>
        </div>
      )}
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

  const [side, setSide] = useState<TxSide>('all')
  const sideType = TX_SIDES.find((s) => s.key === side)!.type
  // The table's own feed, one page one per side. `all` is the same key the unfiltered ledger
  // below uses, so the default view still costs ONE request — SWR dedupes them.
  const transactions = useSWR(fetching ? consoleKeys.billingTransactions(orgId, side) : null, () =>
    // The unfiltered call on `all`, not `{ type: undefined }`: it shares its key with the
    // ledger read below, and SWR runs ONE of the two fetchers for a shared key — so they
    // have to be the same request, not two spellings of it.
    sideType ? fetchBillingTransactions(orgId!, undefined, { type: sideType }) : fetchBillingTransactions(orgId!)
  )
  // The balance card's own read, deliberately NOT the table's: "last deduction" is a fact
  // about the account, and reading it off whatever the table happens to have loaded made it
  // vanish the moment someone filtered to Top-ups.
  const ledger = useSWR(fetching ? consoleKeys.billingTransactions(orgId) : null, () =>
    fetchBillingTransactions(orgId!)
  )

  // Pages past the first, keyed to their org AND side so a switch of either drops them
  // without an effect — a cursor belongs to the feed it came from and means nothing in
  // another. SWR owns page one (and revalidates it); this only ever appends behind it.
  const [tail, setTail] = useState<{
    orgId: string
    side: TxSide
    items: BillingTransaction[]
    nextCursor: string | null
  } | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [tailError, setTailError] = useState<string | null>(null)

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
  const { mutate: mutateKey } = useSWRConfig()
  const refreshMoney = useCallback(() => {
    void account.mutate()
    // Every side's page one, not only the visible one: a settled top-up belongs to the All
    // and Top-ups feeds alike, and leaving the others cached had a filter switch show a
    // ledger that predated the purchase.
    if (orgId) for (const s of TX_SIDES) void mutateKey(consoleKeys.billingTransactions(orgId, s.key))
    // The Activity chart reads the same ledger through its OWN key, one per range, and its
    // fetch usually landed while the purchase was still pending. Settlement has to reach
    // every range it can show — leaving the cached ones alone had the Top-ups chart disagree
    // with the table right beside it until a refocus or a reload.
    if (orgId) for (const r of ACTIVITY_RANGES) void mutateKey(consoleKeys.billingActivity(orgId, r.key))
  }, [account.mutate, mutateKey, orgId])
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
          // `expired` is not authoritative (see the contract note above): keep
          // reconciling like `pending`; only which banner ends the budget differs.
          else if (attempt >= POLL_MAX_ATTEMPTS)
            setCheckout(
              purchase.status === 'expired' ? { phase: 'expired', purchaseId } : { phase: 'still-pending', purchaseId }
            )
          else setCheckout({ phase: 'confirming', purchaseId, attempt: attempt + 1 })
        } catch (e) {
          if (cancelled) return
          // The URL was already cleaned, so giving up here would lose the
          // purchase id for good. Retry transient failures (network, 5xx) inside
          // the same budget; only a client-side refusal — shape drift or a 4xx —
          // or an exhausted budget lands on the error banner, which keeps the id
          // and offers a manual "Check again".
          const permanent =
            e instanceof BillingShapeError || (e instanceof BillingError && e.status >= 400 && e.status < 500)
          if (!permanent && attempt < POLL_MAX_ATTEMPTS)
            setCheckout({ phase: 'confirming', purchaseId, attempt: attempt + 1 })
          else setCheckout({ phase: 'error', purchaseId, message: (e as Error).message })
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

  // Page one from SWR plus the appended tail, deduped: a revalidated page one can
  // grow into rows the tail already fetched.
  const mine = tail && tail.orgId === orgId && tail.side === side ? tail : null
  const tailItems = mine ? mine.items : []
  const firstIds = new Set(transactions.data?.items.map((t) => t.id))
  const loaded = transactions.data ? [...transactions.data.items, ...tailItems.filter((t) => !firstIds.has(t.id))] : []
  // The side is a REQUEST: a billing image that predates `type` ignores it and answers with
  // the whole ledger. Cutting again here is what stops that image from rendering top-ups
  // under a pill that says Usage — a wrong answer is worse than a narrower one.
  const txItems = sideType ? loaded.filter((t) => t.type === sideType) : loaded
  const nextCursor = mine ? mine.nextCursor : (transactions.data?.nextCursor ?? null)

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return
    setLoadingMore(true)
    setTailError(null)
    try {
      const page = await fetchBillingTransactions(orgId, nextCursor, { type: sideType })
      setTail({ orgId, side, items: [...tailItems, ...page.items], nextCursor: page.nextCursor })
    } catch (e) {
      setTailError((e as Error).message)
    }
    setLoadingMore(false)
  }

  // Design's balance-card stats, from what the wire actually carries: the latest debit
  // comes off the loaded ledger, the threshold off the account. The design's
  // "Billed this period" needs a service field that does not exist — still out.
  const ledgerItems = ledger.data?.items ?? []
  const lastDebit = ledgerItems.find((t) => t.type === 'debit')
  const thresholdMicro = acct?.lowBalanceMicro ?? 0
  const threshold = thresholdMicro > 0 ? fmtMicroUsd(thresholdMicro) : '—'
  // Design: still Serving below the threshold, but the pill turns amber with the banner.
  const lowBalance = acct != null && thresholdMicro > 0 && acct.balanceMicro < thresholdMicro
  const pill =
    acct?.state === 'active' && lowBalance
      ? { label: 'Serving', color: 'var(--status-paused)' }
      : acct?.state != null
        ? STATE_PILL[acct.state]
        : null

  return (
    <div className="wrap">
      <div className="mb-4 flex min-h-[34px] items-center gap-4">
        <p className="psub mt-0 flex-1">Prepaid balance for this organization, and what has been credited to it.</p>
      </div>

      {checkout && (
        <CheckoutBanner
          state={checkout}
          onDismiss={() => setCheckout(null)}
          onRetry={() =>
            setCheckout((c) =>
              c && c.phase === 'error' ? { phase: 'confirming', purchaseId: c.purchaseId, attempt: 1 } : c
            )
          }
        />
      )}

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
          <BalanceBannerCard
            acct={acct}
            hasHistory={ledgerHistory(transactions.data)}
            canPay={myRole === 'owner'}
            // The banner's CTA leads INTO the inline form (the design's modal equivalent):
            // scroll to it, blink the card, and land focus in the amount field.
            onAddCredits={() => {
              const card = document.getElementById('add-credits')
              if (!card) return
              // A scripted scroll dodges the CSS reduced-motion block, so honor it here.
              // 'instant', not 'auto': auto defers to CSS scroll-behavior, instant never animates.
              const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
              card.scrollIntoView({ behavior: reduced ? 'instant' : 'smooth', block: 'center' })
              card.querySelector('input')?.focus({ preventScroll: true })
              card.classList.remove('card-flash')
              void card.offsetWidth // restart the animation on repeat clicks
              card.classList.add('card-flash')
            }}
          />
          <div className="mb-[18px] grid items-stretch gap-[18px] desktop:grid-cols-2">
            {/* One figure, no in-flight caveat: v1 has no hold layer, so the balance
                is every reconciliation fact there is. */}
            <div className="card">
              <div className="cardhead justify-between">
                <span className="cardtitle">Balance</span>
                {pill && (
                  <span className="inline-flex items-center gap-[7px]">
                    <span className="h-[7px] w-[7px] rounded-full" style={{ background: pill.color }} />
                    <span className="font-sans text-[12px] font-medium leading-normal" style={{ color: pill.color }}>
                      {pill.label}
                    </span>
                  </span>
                )}
              </div>
              <div className="px-[18px] pt-[22px] pb-5">
                <div className="flex items-end gap-3.5">
                  <span className="mono text-[44px] leading-none font-semibold tracking-[-0.02em]">
                    {fmtMicroUsd(acct.balanceMicro)}
                  </span>
                  <span className="mono pb-1.5 text-[12px] text-(--text-tertiary)">USD</span>
                </div>
                <div className="mt-5 flex gap-[26px] border-t border-(--border-subtle) pt-4">
                  <div>
                    <div className="eyebrow">Last deduction</div>
                    <div className="mono mt-[5px] text-[13px]">{lastDebit ? fmtPostedLocal(lastDebit.at) : '—'}</div>
                  </div>
                  <div>
                    <div className="eyebrow">Alert threshold</div>
                    <div className="mono mt-[5px] text-[13px]">{threshold}</div>
                  </div>
                </div>
              </div>
            </div>
            {/* Only owners move money — the service enforces it (403); the page
                just doesn't offer members a form that would be refused. */}
            {myRole === 'owner' ? (
              <AddCreditsCard orgId={orgId} returnPath={pathname} />
            ) : myRole ? (
              <MembersDontPayCard />
            ) : null}
          </div>

          {/* Design: the chart only appears once the ledger has something to draw — an
              unfunded org gets the banner and the empty table, not an empty plot. */}
          {ledgerItems.length > 0 && <ActivityCard orgId={orgId} />}

          <div className="card">
            <div className="cardhead flex-wrap justify-between gap-2">
              <span className="inline-flex items-baseline gap-2">
                <span className="cardtitle">Transactions</span>
                {transactions.data && (
                  <span className="mono text-[11.5px] text-(--text-tertiary)">{txItems.length} loaded</span>
                )}
              </span>
              <span className="flex items-center gap-2">
                <span className="font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
                  Newest first · amounts in USD
                </span>
                <span className="pillbar">
                  {TX_SIDES.map((s) => (
                    <button key={s.key} className={side === s.key ? 'pill on' : 'pill'} onClick={() => setSide(s.key)}>
                      {s.label}
                    </button>
                  ))}
                </span>
              </span>
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
              // Placeholder rows on the real column template, so the header the loaded table
              // will carry lines up with them instead of arriving over a centred word.
              <div className="animate-pulse">
                <div className={`row h rounded-none ${TX_GRID}`}>
                  <span />
                  <span>Description</span>
                  <span className="text-right">Amount</span>
                  <span />
                  <span className="truncate">Posted ({LOCAL_TZ})</span>
                </div>
                {Array.from({ length: 5 }, (_, i) => (
                  <div key={i} className={`row ${TX_GRID}`}>
                    <span className="h-[26px] w-[26px] rounded-[7px] bg-(--surface-active)" />
                    <span
                      className="h-[13px] rounded-[3px] bg-(--surface-active)"
                      style={{ width: `${44 + i * 9}%` }}
                    />
                    <span className="ml-auto h-[13px] w-[68px] rounded-[3px] bg-(--surface-active)" />
                    <span />
                    <span className="h-[13px] w-[112px] rounded-[3px] bg-(--surface-active)" />
                  </div>
                ))}
              </div>
            ) : txItems.length === 0 ? (
              <div className="flex flex-col items-center px-4 py-10 text-center">
                <span className="flex h-11 w-11 items-center justify-center rounded-[11px] border border-(--border-subtle) bg-(--surface-sunken) text-(--text-tertiary)">
                  <Icon name="receipt-text" size={20} />
                </span>
                <div className="mt-3 font-sans text-[14px] font-semibold leading-normal">
                  {side === 'debit' ? 'No usage yet' : side === 'credit' ? 'No top-ups yet' : 'No transactions yet'}
                </div>
                {/* Under a filter this is "nothing on this side", not "nothing at all" — the
                    unfiltered ledger may be full, and saying otherwise reads as data loss. */}
                <div className="mt-1 max-w-[340px] font-sans text-[12.5px] font-normal leading-[1.6] text-(--text-tertiary)">
                  {side === 'debit'
                    ? 'Usage deductions will appear here once your agents start spending.'
                    : side === 'credit'
                      ? 'Purchases and operator credits will appear here.'
                      : 'Purchases and usage deductions will appear here once your org is funded.'}
                </div>
              </div>
            ) : (
              <>
                <div className={`row h rounded-none ${TX_GRID}`}>
                  <span />
                  <span>Description</span>
                  <span className="text-right">Amount</span>
                  <span />
                  <span className="truncate" title={LOCAL_TZ}>
                    Posted ({LOCAL_TZ})
                  </span>
                </div>
                {txItems.map((t) => {
                  const credit = t.type === 'credit'
                  const positive = credit && t.amountMicro > 0
                  return (
                    <div key={t.id} className={`row ${TX_GRID}`}>
                      <span
                        className="flex h-[26px] w-[26px] items-center justify-center rounded-[7px]"
                        style={
                          positive
                            ? { background: 'var(--status-online-soft)', color: 'var(--status-online)' }
                            : { background: 'var(--surface-sunken)', color: 'var(--text-tertiary)' }
                        }
                      >
                        <Icon name={credit ? 'arrow-down-left' : 'arrow-up-right'} size={14} strokeWidth={2} />
                      </span>
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate font-sans text-[13px] font-medium leading-normal">
                          {credit ? (KIND_LABEL[t.kind] ?? t.kind) : `Usage — ${t.period}`}
                        </span>
                        <span
                          className="mono inline-flex h-[19px] flex-none items-center rounded-[4px] px-[7px] text-[10.5px] font-semibold tracking-[0.04em] uppercase"
                          style={
                            positive
                              ? { background: 'var(--status-online-soft)', color: 'var(--status-online)' }
                              : { background: 'var(--surface-active)', color: 'var(--text-secondary)' }
                          }
                        >
                          {credit ? t.kind : 'usage'}
                        </span>
                        {/* No agent attribution here, deliberately: this feed is authorized on
                            org membership alone, so naming the agent behind a charge would
                            hand every member a resource-existence oracle. See billing-api.ts. */}
                        {/* Free operator text, rendered as TEXT — truncated, with the whole
                            note on hover, so a long one cannot push the amount column out. */}
                        {credit && t.note && (
                          <span
                            className="truncate font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)"
                            title={t.note}
                          >
                            {t.note}
                          </span>
                        )}
                        {credit && t.receiptUrl && (
                          <a
                            className="inline-flex flex-none items-center gap-0.5 font-sans text-[12px] font-medium text-(--text-brand) hover:underline"
                            href={t.receiptUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            Receipt
                            <Icon name="arrow-up-right" size={11} />
                          </a>
                        )}
                      </span>
                      {/* A debit is recorded as a positive amount that was taken away, so the
                          sign belongs here. The rounded figure carries the exact wire string
                          as its tooltip, dotted per the design. */}
                      {credit ? (
                        <span
                          className="mono text-right text-[13px]"
                          style={positive ? { color: 'var(--status-online)' } : undefined}
                        >
                          {positive ? `+${fmtMicroUsd(t.amountMicro)}` : fmtMicroUsd(t.amountMicro)}
                        </span>
                      ) : (
                        <span className="mono text-right text-[13px]" title={`$${t.amount}`}>
                          <span className="cursor-help border-b border-dotted border-(--border-strong)">
                            -{fmtDecimalUsd(t.amount)}
                          </span>
                        </span>
                      )}
                      <span />
                      <span className="mono text-[12px] text-(--text-secondary)">{fmtPostedLocal(t.at)}</span>
                    </div>
                  )
                })}
                <div className="flex items-center justify-center gap-3 rounded-b-[10px] border-t border-(--border-subtle) bg-(--surface-app) px-4 py-3.5">
                  {nextCursor ? (
                    <Button size="sm" variant="secondary" disabled={loadingMore} onClick={() => void loadMore()}>
                      {loadingMore ? 'Loading…' : 'Load more'}
                    </Button>
                  ) : (
                    <span className="mono text-[11.5px] text-(--text-tertiary)">end of ledger</span>
                  )}
                  {tailError && (
                    <span className="font-sans text-[12px] font-normal leading-normal text-(--status-error)">
                      {tailError}
                    </span>
                  )}
                </div>
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}
