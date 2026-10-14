'use client'

// Billing page. It renders what the billing service returns and nothing more —
// no prices, no entitlement rules of its own. Paying for credit is here, and the
// console's whole part in it is: pick an amount, POST it, redirect to the Stripe
// checkout URL the API hands back, and — after Stripe returns the browser — poll
// the purchase until the service says the payment settled. The return redirect
// itself is never treated as proof of payment.

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
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
  type BillingDebitAgent,
  type BillingPurchase,
  type BillingTransaction
} from '@/lib/billing-api'
import {
  ACTIVITY_RANGES,
  activityRange,
  activityWindowStart,
  bucketActivity,
  UNATTRIBUTED_MODEL,
  type ActivityMode,
  type ActivityRange
} from '@/lib/billing-activity'
import { balanceBanner, ledgerHistory } from '@/lib/billing-banner'
import { featureFlagEnabled } from '@/lib/feature-flags'
import { fetchAgents } from '@/lib/api'
import { agentLabel, type Agent } from '@/lib/data'
import { sumAmounts } from '@/lib/amount'
import { useOrgs } from '@/lib/org-context'
import { SEG_FILL, tickInterval } from '@/lib/spend-chart'
import { consoleKeys } from '@/lib/swr-keys'
import { AgentIconView, LoadingState, MarkSlot, ModelMark, modelProviderSlug } from '@/components/marks'
import { Button, Icon } from '@/components/ui'

// Fixed tracks keep each `.row` grid aligned with its header; mobile scrolls the card sideways.
// Usage columns: expand toggle · agent · models · amount · posted.
// ≤768px floors the agent/model tracks and widens each row to their sum so the card scrolls instead of clipping names.
const USAGE_MIN_W = 'max-desktop:min-w-[754px]'
const USAGE_GRID = `grid-cols-[28px_minmax(0,1fr)_minmax(0,1.3fr)_132px_190px] max-desktop:grid-cols-[28px_minmax(160px,1fr)_minmax(180px,1.3fr)_132px_190px] ${USAGE_MIN_W} gap-2`
// Top-up columns: description · amount · posted.
const TOPUP_GRID = 'grid-cols-[minmax(0,1fr)_132px_190px] gap-2'
// A usage row's agent or model entry: icon + name, no frame, flush with its column header.
const TX_TAG =
  'inline-flex h-[22px] min-w-0 max-w-full items-center gap-[6px] font-sans text-[12.5px] font-medium leading-normal text-(--text-secondary)'

// A model's provider brand, or a generic chip glyph when the model names no known provider.
function TxModelMark({ model }: { model: string }) {
  return (
    <MarkSlot size={14}>
      {modelProviderSlug(model) ? (
        <ModelMark model={model} fallbackRuntime="" fillPct={100} />
      ) : (
        <Icon name="cpu" size={12} strokeWidth={2} color="var(--text-tertiary)" />
      )}
    </MarkSlot>
  )
}

// Named agent chips a usage row shows before the tail becomes a `+N` count. The withheld
// rollup is never one of them — it is appended after, so it cannot be capped out of view.
const TX_AGENT_CHIPS = 4
// Model chips a usage row shows before the tail becomes a `+N` count.
const TX_MODEL_CHIPS = 3

/** One chip on a usage row. `agent` absent ⇒ the withheld rollup: no id, no count, no name. */
export interface TxAgentChip {
  key: string
  agent?: Agent
  /** Exact decimal string, added with `sumAmounts` — never a float. */
  amount: string
}

// What a usage row may say about who spent the money.
//
// The AMOUNTS come from the billing service's own split — the only thing that knows how one
// charge divides — and the PERMISSION to attach a name to one is Agent visibility alone: the
// viewer's own roster, the same list the Agents page shows them. The Session predicate does not
// apply here (`session-visibility.md` §5): the ledger already publishes every charge's amount to
// every member, so what naming discloses is only WHICH visible agent spent it.
//
// An id the roster cannot resolve — a restricted agent, or one since deleted — is never named,
// and everything withheld folds into ONE rollup: no id, no count, no partition.
export function rowAttribution(
  parts: BillingDebitAgent[] | null | undefined,
  agentById: Map<string, Agent>
): TxAgentChip[] {
  if (!parts?.length) return []
  const named: { chip: TxAgentChip; value: number }[] = []
  const withheld: string[] = []
  for (const part of parts) {
    const value = Number(part.amount)
    if (!Number.isFinite(value) || value === 0) continue
    // Fails CLOSED: an id the roster cannot resolve (unloaded, errored, or restricted) is withheld.
    const agent = agentById.get(part.agentId)
    // The id never enters a chip it cannot name — `key` included, so it cannot leak through a
    // prop that ends up serialized.
    if (agent) named.push({ chip: { key: part.agentId, agent, amount: part.amount }, value })
    else withheld.push(part.amount)
  }
  named.sort((a, b) => b.value - a.value)
  const chips = named.map(({ chip }) => chip)
  if (withheld.length) chips.push({ key: 'withheld', amount: sumAmounts(withheld) })
  return chips
}

// The Transactions filter, the same Usage / Top-ups split the Activity chart offers — plus
// `all`, which is the table's own default and the whole ledger it always showed. `type` goes
// to the service: the feed is keyset-paginated over both ledger sides at once, so narrowing
// it here rather than on a page already fetched is what keeps the cursor, the loaded count
// and "end of ledger" describing the rows actually on screen.
// Display text for `key`/`kind` lives in the `Billing` message catalog — see `TX_SIDES`
// labels, `KNOWN_KINDS` and `STATE_COLOR` below, resolved through `t` at the render site.
const TX_SIDES = [
  // { key: 'all', type: undefined },
  { key: 'debit', type: 'debit' },
  { key: 'credit', type: 'credit' }
] as const
type TxSide = (typeof TX_SIDES)[number]['key']

const KNOWN_KINDS = ['purchase', 'adjustment', 'promo', 'refund'] as const

// The gateway's own call, as the design's balance-card status pill color. No `state` ⇒ no pill.
const STATE_COLOR: Record<NonNullable<BillingAccount['state']>, string> = {
  active: 'var(--status-online)',
  suspended: 'var(--status-error)',
  unknown: 'var(--status-info)'
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
  const rawT = useTranslations('Billing.banners')
  // `banner.titleKey`/`textKey`/`ctaKey` are plain strings (the point of returning keys
  // instead of text, per `balanceBanner`'s doc comment) — narrower than the translator's
  // literal-union key type, so resolve them through an untyped call.
  const t = rawT as unknown as (key: string, values?: Record<string, unknown>) => string
  const banner = balanceBanner(acct, { hasHistory })
  if (!banner) return null
  const tone = BALANCE_TONE[banner.tone]
  return (
    <div className={`mb-[18px] flex items-start gap-3 rounded-[10px] border px-4 py-3.5 ${tone.card}`}>
      <span className={`flex h-7 w-7 flex-none items-center justify-center rounded-lg ${tone.chip}`}>
        <Icon name={banner.icon} size={16} color={tone.glyph} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="font-sans text-[13px] font-semibold leading-normal">
          {t(banner.titleKey, banner.titleValues)}
        </div>
        <div className="mt-1 font-sans text-[12.5px] font-normal leading-[1.55] text-(--text-secondary)">
          {t(banner.textKey, banner.textValues)}
        </div>
        {/* Only owners move money — the service enforces it; this just doesn't offer a refused form. */}
        {banner.ctaKey && canPay && (
          <Button size="sm" className="mt-2.5" onClick={onAddCredits}>
            {t(banner.ctaKey)}
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

type CheckoutTranslator = ReturnType<typeof useTranslations<'Billing.checkout'>>

function checkoutCopy(state: CheckoutReturn, t: CheckoutTranslator): { title: string; body: string } {
  switch (state.phase) {
    case 'confirming':
      return { title: t('confirmingTitle'), body: t('confirmingBody') }
    case 'still-pending':
      return { title: t('stillPendingTitle'), body: t('stillPendingBody') }
    case 'completed':
      return {
        title: t('completedTitle', { amount: fmtMicroUsd(state.purchase.amountMicro) }),
        body: t('completedBody')
      }
    case 'failed':
      return { title: t('failedTitle'), body: t('failedBody') }
    case 'expired':
      return { title: t('expiredTitle'), body: t('expiredBody') }
    case 'canceled':
      return { title: t('canceledTitle'), body: t('canceledBody') }
    case 'error':
      return { title: t('errorTitle'), body: t('errorBody', { message: state.message }) }
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
  const t = useTranslations('Billing.checkout')
  const tone = BANNER_TONE[state.phase]
  const copy = checkoutCopy(state, t)
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
            {t('checkingStatus', { attempt: state.phase === 'confirming' ? state.attempt : 0 })}
          </div>
        )}
        {state.phase === 'error' && (
          <div className="mt-2">
            <Button size="xs" variant="secondary" onClick={onRetry}>
              {t('checkAgain')}
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
            {t('viewReceipt')}
            <Icon name="arrow-up-right" size={12} />
          </a>
        )}
      </div>
      {!busy && (
        <Button size="xs" variant="ghost" onClick={onDismiss} ariaLabel={t('dismiss')}>
          <Icon name="x" size={14} />
        </Button>
      )}
    </div>
  )
}

// ── Add credits (owners only — the service enforces this; the UI just agrees) ─

function AddCreditsCard({ orgId, returnPath }: { orgId: string; returnPath: string }) {
  const t = useTranslations('Billing.addCredits')
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
        <span className="cardtitle">{t('title')}</span>
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
              placeholder={t('otherPlaceholder')}
              inputMode="decimal"
              aria-label={t('customAmountAriaLabel')}
              className="mono w-full min-w-0 border-0 bg-transparent text-[12.5px] outline-none"
            />
          </div>
        </div>
        <div
          className="mt-2 font-sans text-[11.5px] font-normal leading-[1.5]"
          style={{ color: invalidCustom ? 'var(--status-error)' : 'var(--text-tertiary)' }}
        >
          {invalidCustom
            ? t('rangeError', {
                min: MIN_USD.toFixed(2),
                max: MAX_USD.toLocaleString('en-US', { minimumFractionDigits: 2 })
              })
            : t('rangeHint', {
                min: MIN_USD.toFixed(2),
                max: MAX_USD.toLocaleString('en-US', { minimumFractionDigits: 2 })
              })}
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
              {submitting
                ? t('openingCheckout')
                : valid
                  ? t('addAmount', { amount: fmtMicroUsd(cents * 10_000) })
                  : t('addCreditsButton')}
            </span>
          </Button>
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
// Distinct hues before the model tail folds into "Other" — SEG_FILL's --chart-1..6.
const ACTIVITY_MODEL_HUES = 6
const ACTIVITY_OTHER = '\0other'

function ActivityCard({ orgId }: { orgId: string }) {
  const t = useTranslations('Billing.activity')
  const [range, setRange] = useState<ActivityRange>('d7')
  const [mode, setMode] = useState<ActivityMode>('usage')
  const cfg = activityRange(range)

  const rows = useSWR(consoleKeys.billingActivity(orgId, range), () =>
    fetchBillingTransactionsSince(orgId, activityWindowStart(range))
  )
  const buckets = bucketActivity(rows.data ?? [], range, mode)
  const total = buckets.reduce((sum, b) => sum + b.amount, 0)
  const usd = (n: number) => fmtMicroUsd(Math.round(n * 1_000_000))

  // Usage stacks by model: the top six by range spend get --chart-1..6, the tail folds into "Other".
  const modelTotals = new Map<string, number>()
  for (const b of buckets)
    for (const [k, v] of Object.entries(b.byModel)) modelTotals.set(k, (modelTotals.get(k) ?? 0) + v)
  const ranked = [...modelTotals].sort((a, b) => b[1] - a[1]).map(([k]) => k)
  // A ledger with no split at all (an older service) keeps the single brand bar.
  const stacked = mode === 'usage' && ranked.some((k) => k !== UNATTRIBUTED_MODEL)
  const topKeys = stacked ? ranked.slice(0, ACTIVITY_MODEL_HUES) : []
  const stackKeys = ranked.length > topKeys.length && stacked ? [...topKeys, ACTIVITY_OTHER] : topKeys
  const keyName = (k: string) =>
    k === ACTIVITY_OTHER ? t('otherModels') : k === UNATTRIBUTED_MODEL ? t('unknownModel') : k
  const keyColor = (k: string) =>
    k === ACTIVITY_OTHER ? 'var(--chart-other)' : `var(--chart-${topKeys.indexOf(k) + 1})`
  // Series are `s<i>` so a model name can never collide with `label`/`amount`.
  const chartData = buckets.map((b) => {
    const row: Record<string, number | string> = { label: b.label, amount: b.amount }
    stackKeys.forEach((k, i) => {
      row[`s${i}`] =
        k === ACTIVITY_OTHER
          ? Object.entries(b.byModel).reduce((sum, [m, v]) => (topKeys.includes(m) ? sum : sum + v), 0)
          : (b.byModel[k] ?? 0)
    })
    return row
  })

  type TipSeg = { dataKey: string; value: number; payload: Record<string, number | string> }
  const Tip = ({ active, payload }: { active?: boolean; payload?: TipSeg[] }) => {
    const row = active ? payload?.[0]?.payload : undefined
    if (!row) return null
    const segs = stacked ? [...payload!].reverse().filter((seg) => seg.value > 0) : []
    return (
      <div className="rounded-md border border-(--border-subtle) bg-(--surface-card) px-2.5 py-2 shadow-(--shadow-md)">
        {/* Stacked: the bucket total sits beside the date, with the per-model lines below. */}
        <div className="flex items-baseline justify-between gap-4">
          <span className="mono text-[11px] font-semibold">{row.label}</span>
          {stacked && (
            <span className="font-sans text-[11px] leading-normal text-(--text-secondary)">
              {t('tooltipTotal')}{' '}
              <span className="mono font-semibold text-(--text-primary)">{usd(Number(row.amount))}</span>
            </span>
          )}
        </div>
        {!stacked && (
          <div className="mt-1 flex items-center gap-1.5 font-sans text-[11px] leading-normal text-(--text-secondary)">
            <span
              className={`h-[9px] w-[9px] flex-none rounded-[2px] ${mode === 'usage' ? 'bg-(--brand)' : 'bg-(--green-500)'}`}
            />
            {mode === 'usage' ? t('tooltipUsage') : t('tooltipToppedUp')}{' '}
            <span className="mono text-(--text-primary)">{usd(Number(row.amount))}</span>
          </div>
        )}
        {segs.map((seg) => {
          const key = stackKeys[Number(seg.dataKey.slice(1))]!
          return (
            <div
              key={seg.dataKey}
              className="mt-1 flex items-center gap-1.5 font-sans text-[11px] leading-normal text-(--text-secondary)"
            >
              <span className="h-[8px] w-[8px] flex-none rounded-[2px]" style={{ backgroundColor: keyColor(key) }} />
              <span className="max-w-[200px] truncate">{keyName(key)}</span>
              {/* Sub-cent shares keep four significant digits, like the transactions table, instead of reading $0.00. */}
              <span className="mono text-(--text-primary)">{fmtDecimalUsd(String(seg.value))}</span>
            </div>
          )
        })}
      </div>
    )
  }

  return (
    // `min-w-0`: recharts measures this box, and an auto min-width would let the plot
    // widen its own container.
    <div className="card mb-[18px] min-w-0">
      <div className="cardhead flex-wrap justify-between gap-2">
        <span className="inline-flex items-baseline gap-2">
          <span className="cardtitle">{t('title')}</span>
          <span className="mono text-[11.5px] text-(--text-tertiary)">
            {t('lastPeriod', { period: t(`ranges.${cfg.key}.period`) })}
          </span>
        </span>
        <span className="flex items-center gap-2">
          <span className="pillbar">
            {ACTIVITY_RANGES.map((r) => (
              <button key={r.key} className={range === r.key ? 'pill on' : 'pill'} onClick={() => setRange(r.key)}>
                {t(`ranges.${r.key}.label`)}
              </button>
            ))}
          </span>
          <span className="pillbar">
            <button className={mode === 'usage' ? 'pill on' : 'pill'} onClick={() => setMode('usage')}>
              {t('modeUsage')}
            </button>
            <button className={mode === 'topups' ? 'pill on' : 'pill'} onClick={() => setMode('topups')}>
              {t('modeTopups')}
            </button>
          </span>
        </span>
      </div>
      {rows.error ? (
        <div className="flex items-center gap-3 px-4 py-3">
          <Icon name="triangle-alert" size={18} color="var(--status-error)" />
          <span className="flex-1 font-sans text-[13px] font-normal leading-[1.55]">
            {t('loadError', { error: (rows.error as Error).message })}
          </span>
          <Button size="sm" variant="secondary" onClick={() => void rows.mutate()}>
            {t('retry')}
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
                <BarChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: 4 }} barCategoryGap="12%">
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
                  {stacked ? (
                    // stackKeys order is bottom-up, which is also recharts' render order, so `seg-<i>` lines up
                    // with SEG_FILL (seg-6 is the gray "Other").
                    stackKeys.map((k, i) => (
                      <Bar
                        key={k}
                        dataKey={`s${i}`}
                        name={keyName(k)}
                        stackId="usage"
                        className={k === ACTIVITY_OTHER ? 'seg-6' : `seg-${i}`}
                        radius={i === stackKeys.length - 1 ? [3, 3, 0, 0] : undefined}
                        // Read by index: recharts hands a stacked bar a non-numeric value, which floored zero segments too.
                        minPointSize={(_: number | null | undefined, idx: number) =>
                          Number(chartData[idx]?.[`s${i}`] ?? 0) > 0 ? 2 : 0
                        }
                      />
                    ))
                  ) : (
                    <Bar
                      dataKey="amount"
                      name={mode === 'usage' ? t('barNameUsage') : t('barNameTopup')}
                      className={mode === 'usage' ? 'bar-usage' : 'bar-topup'}
                      radius={[3, 3, 0, 0]}
                      minPointSize={(_: number | null | undefined, i: number) =>
                        (buckets[i]?.amount ?? 0) > 0 ? 3 : 0
                      }
                    />
                  )}
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="py-8 text-center font-sans text-[12.5px] font-normal leading-[1.55] text-(--text-tertiary)">
              {mode === 'usage'
                ? t('emptyUsage', { period: t(`ranges.${cfg.key}.period`) })
                : t('emptyTopups', { period: t(`ranges.${cfg.key}.period`) })}
            </div>
          )}
          {stacked && total > 0 && (
            <div className="mt-2 flex flex-wrap justify-center gap-x-3 gap-y-1">
              {stackKeys.map((k) => (
                <span
                  key={k}
                  className="flex min-w-0 items-center gap-[5px] font-sans text-[11px] leading-normal text-(--text-secondary)"
                >
                  <span className="h-[9px] w-[9px] flex-none rounded-[3px]" style={{ backgroundColor: keyColor(k) }} />
                  <span className="max-w-[180px] truncate">{keyName(k)}</span>
                </span>
              ))}
            </div>
          )}
          <div className="mt-2 text-center font-sans text-[11px] font-normal leading-normal text-(--text-tertiary)">
            {t('footerLine', {
              mode: mode === 'usage' ? t('footerUsage') : t('footerTopups'),
              period: t(`ranges.${cfg.key}.period`)
            })}{' '}
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
  const t = useTranslations('Billing.membersDontPay')
  return (
    <div className="card flex flex-col">
      <div className="cardhead">
        <span className="cardtitle">{t('cardTitle')}</span>
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-5 text-center">
        <span className="flex h-9 w-9 items-center justify-center rounded-[9px] border border-(--border-subtle) bg-(--surface-sunken) text-(--text-tertiary)">
          <Icon name="user-round-cog" size={17} />
        </span>
        <div className="font-sans text-[13px] font-semibold">{t('title')}</div>
        <div className="max-w-[300px] font-sans text-[12px] font-normal leading-[1.6] text-(--text-tertiary)">
          {t('body')}
        </div>
      </div>
    </div>
  )
}

export default function BillingView() {
  const t = useTranslations('Billing')
  const { activeOrg, myRole, loading: orgLoading } = useOrgs()
  // The viewer's OWN roster, for the name and icon of an agent this row may name. Read on the
  // console data provider's own SWR key so it shares that cache instead of fetching twice.
  //
  // `error` is read, not just `data`: SWR keeps the last successful roster when a revalidation
  // fails, so ignoring it would keep naming agents from a roster that may since have had
  // visibility revoked. A failed refresh reads as EMPTY — fail closed, name nothing.
  const { data: agents, error: agentsError } = useSWR<Agent[]>(consoleKeys.agents(activeOrg?.id ?? null), ([, orgId]) =>
    fetchAgents(orgId as string)
  )
  const agentById = useMemo(
    () => (agentsError ? new Map<string, Agent>() : new Map((agents ?? []).map((a) => [a.id, a]))),
    [agents, agentsError]
  )
  // Unloaded is not the same as empty: a pending roster must render NO chip rather than the
  // fail-closed rollup, which would tell the reader they lack access and then take it back.
  const rosterPending = agents === undefined && !agentsError
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

  const [side, setSide] = useState<TxSide>('debit')
  // Usage rows whose per-model breakdown is open, by transaction id.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const toggleExpanded = useCallback(
    (id: string) =>
      setExpanded((prev) => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      }),
    []
  )
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
    // The unfiltered read, by ITS OWN handle. Its key is deliberately outside `TX_SIDES` — the
    // pills are the two ledger sides — so no loop over that table can reach it, and it is what
    // "last deduction", the banner's history and the Activity card's visibility all read.
    // Leaving it cached had a first top-up settle into a page still saying never funded.
    void ledger.mutate()
    // Then every side's page one, not only the visible one: a settled top-up belongs to the
    // Top-ups feed whichever pill is pressed, and leaving the others cached had a filter switch
    // show a ledger that predated the purchase.
    if (orgId) for (const s of TX_SIDES) void mutateKey(consoleKeys.billingTransactions(orgId, s.key))
    // The Activity chart reads the same ledger through its OWN key, one per range, and its
    // fetch usually landed while the purchase was still pending. Settlement has to reach
    // every range it can show — leaving the cached ones alone had the Top-ups chart disagree
    // with the table right beside it until a refocus or a reload.
    if (orgId) for (const r of ACTIVITY_RANGES) void mutateKey(consoleKeys.billingActivity(orgId, r.key))
  }, [account.mutate, ledger.mutate, mutateKey, orgId])
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

  // Page one from SWR plus the appended tail, deduped: a revalidated page one can
  // grow into rows the tail already fetched.
  const mine = tail && tail.orgId === orgId && tail.side === side ? tail : null
  const tailItems = mine ? mine.items : []
  const firstIds = new Set(transactions.data?.items.map((tx) => tx.id))
  const loaded = transactions.data
    ? [...transactions.data.items, ...tailItems.filter((tx) => !firstIds.has(tx.id))]
    : []
  // The side is a REQUEST: a billing image that predates `type` ignores it and answers with
  // the whole ledger. Cutting again here is what stops that image from rendering top-ups
  // under a pill that says Usage — a wrong answer is worse than a narrower one.
  const txItems = sideType ? loaded.filter((tx) => tx.type === sideType) : loaded
  // Each side has its own header; it sticks flush to the viewport, offsetting `.content`'s 34px top padding.
  const postedHeader = (
    <span className="truncate" title={LOCAL_TZ}>
      {t('transactions.columns.posted', { tz: LOCAL_TZ })}
    </span>
  )
  const txHeader =
    side === 'debit' ? (
      <div className={`row h sticky top-[-34px] z-10 rounded-none ${USAGE_GRID}`}>
        <span />
        <span>{t('transactions.columns.agent')}</span>
        <span>{t('transactions.columns.models')}</span>
        <span className="text-right">{t('transactions.columns.amount')}</span>
        {postedHeader}
      </div>
    ) : (
      <div className={`row h sticky top-[-34px] z-10 rounded-none ${TOPUP_GRID}`}>
        <span>{t('transactions.columns.description')}</span>
        <span className="text-right">{t('transactions.columns.amount')}</span>
        {postedHeader}
      </div>
    )
  const nextCursor = mine ? mine.nextCursor : (transactions.data?.nextCursor ?? null)

  // Deep-link landing for a console that does not offer billing: the rail hides
  // the entry, so anyone here typed the URL or followed an old bookmark. Gated on
  // the flag, not on BILLING_URL — with the flag on and no endpoint configured the
  // page must report a broken deployment, not quietly claim billing is elsewhere.
  if (!offered) return <Notice title={t('notOffered.title')} body={t('notOffered.body')} />
  if (orgLoading) return <LoadingState fill />
  // Every figure on this page belongs to an org, so without one there is nothing
  // to ask for — the fetches below stay unkeyed and would leave the page silently
  // empty. Reached when the org list came back empty or unauthorized (a stale
  // session keeps a token, so nothing redirects to sign-in).
  if (!orgId) return <Notice title={t('noOrg.title')} body={t('noOrg.body')} />
  if (!account.data && !account.error) return <LoadingState fill />

  const acct = account.data

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
  const lastDebit = ledgerItems.find((tx) => tx.type === 'debit')
  const thresholdMicro = acct?.lowBalanceMicro ?? 0
  const threshold = thresholdMicro > 0 ? fmtMicroUsd(thresholdMicro) : '—'
  // Design: still Serving below the threshold, but the pill turns amber with the banner.
  const lowBalance = acct != null && thresholdMicro > 0 && acct.balanceMicro < thresholdMicro
  const pill =
    acct?.state === 'active' && lowBalance
      ? { label: t('statePill.servingLowBalance'), color: 'var(--status-paused)' }
      : acct?.state != null
        ? { label: t(`statePill.${acct.state}`), color: STATE_COLOR[acct.state] }
        : null

  return (
    <div className="wrap">
      <div className="mb-4 flex min-h-[34px] items-center gap-4">
        <p className="psub mt-0 flex-1">{t('description')}</p>
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
            {t('accountLoadError', { error: (account.error as Error).message })}
          </span>
          <Button size="sm" variant="secondary" onClick={() => void account.mutate()}>
            {t('retry')}
          </Button>
        </div>
      )}

      {acct && (
        <>
          <BalanceBannerCard
            acct={acct}
            // The UNFILTERED read, like "last deduction" below: whether this account has ever
            // moved money is a fact about the account, and reading it off the table's current
            // side told a suspended org with usage and no top-ups that it had never been
            // funded the moment someone pressed Top-ups.
            hasHistory={ledgerHistory(ledger.data)}
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
                <span className="cardtitle">{t('balance')}</span>
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
                  <span className="mono pb-1.5 text-[12px] text-(--text-tertiary)">{t('usd')}</span>
                </div>
                <div className="mt-5 flex gap-[26px] border-t border-(--border-subtle) pt-4">
                  <div>
                    <div className="eyebrow">{t('lastDeduction')}</div>
                    <div className="mono mt-[5px] text-[13px]">{lastDebit ? fmtPostedLocal(lastDebit.at) : '—'}</div>
                  </div>
                  <div>
                    <div className="eyebrow">{t('alertThreshold')}</div>
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
              <span className="inline-flex items-center gap-2">
                <span className="cardtitle">{t('transactions.title')}</span>
                {/* `self-center`: the group stays baseline-aligned so the title and the count
                    keep sitting on one line, while the pillbar — a control with its own box,
                    taller than both — centres in the line instead of hanging off its text. */}
                <span className="pillbar self-center">
                  {TX_SIDES.map((s) => (
                    <button key={s.key} className={side === s.key ? 'pill on' : 'pill'} onClick={() => setSide(s.key)}>
                      {t(`transactions.sides.${s.key}`)}
                    </button>
                  ))}
                </span>
                {transactions.data && (
                  <span className="mono text-[11.5px] text-(--text-tertiary)">
                    {t('transactions.loadedCount', { count: txItems.length })}
                  </span>
                )}
              </span>
              <span className="font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
                {t('transactions.newestFirst')}
              </span>
            </div>
            {/* The two requests fail independently, so this card carries its own
                error: a reachable account with an unreachable history would
                otherwise render as "no transactions", which is a lie. */}
            {transactions.error ? (
              <div className="flex items-center gap-3 px-4 py-3">
                <Icon name="triangle-alert" size={18} color="var(--status-error)" />
                <span className="flex-1 font-sans text-[13px] font-normal leading-[1.55]">
                  {t('transactions.loadError', { error: (transactions.error as Error).message })}
                </span>
                <Button size="sm" variant="secondary" onClick={() => void transactions.mutate()}>
                  {t('retry')}
                </Button>
              </div>
            ) : !transactions.data ? (
              // Placeholder rows on the real column template, so the loaded table's header lines up with them.
              <div className="animate-pulse">
                {txHeader}
                {Array.from({ length: 5 }, (_, i) =>
                  side === 'debit' ? (
                    <div key={i} className={`row ${USAGE_GRID}`}>
                      <span />
                      <span className="h-[13px] w-[60%] rounded-[3px] bg-(--surface-active)" />
                      <span
                        className="h-[13px] rounded-[3px] bg-(--surface-active)"
                        style={{ width: `${44 + i * 9}%` }}
                      />
                      <span className="ml-auto h-[13px] w-[68px] rounded-[3px] bg-(--surface-active)" />
                      <span className="h-[13px] w-[112px] rounded-[3px] bg-(--surface-active)" />
                    </div>
                  ) : (
                    <div key={i} className={`row ${TOPUP_GRID}`}>
                      <span
                        className="h-[13px] rounded-[3px] bg-(--surface-active)"
                        style={{ width: `${44 + i * 9}%` }}
                      />
                      <span className="ml-auto h-[13px] w-[68px] rounded-[3px] bg-(--surface-active)" />
                      <span className="h-[13px] w-[112px] rounded-[3px] bg-(--surface-active)" />
                    </div>
                  )
                )}
              </div>
            ) : txItems.length === 0 ? (
              <div className="flex flex-col items-center px-4 py-10 text-center">
                <span className="flex h-11 w-11 items-center justify-center rounded-[11px] border border-(--border-subtle) bg-(--surface-sunken) text-(--text-tertiary)">
                  <Icon name="receipt-text" size={20} />
                </span>
                <div className="mt-3 font-sans text-[14px] font-semibold leading-normal">
                  {side === 'debit'
                    ? t('transactions.empty.usageTitle')
                    : side === 'credit'
                      ? t('transactions.empty.topupsTitle')
                      : t('transactions.empty.allTitle')}
                </div>
                {/* Under a filter this is "nothing on this side", not "nothing at all" — the
                    unfiltered ledger may be full, and saying otherwise reads as data loss. */}
                <div className="mt-1 max-w-[340px] font-sans text-[12.5px] font-normal leading-[1.6] text-(--text-tertiary)">
                  {side === 'debit'
                    ? t('transactions.empty.usageBody')
                    : side === 'credit'
                      ? t('transactions.empty.topupsBody')
                      : t('transactions.empty.allBody')}
                </div>
              </div>
            ) : (
              <>
                {txHeader}
                {txItems.map((tx) => {
                  const posted = (
                    <span className="mono text-[12px] text-(--text-secondary)">{fmtPostedLocal(tx.at)}</span>
                  )
                  if (tx.type === 'credit') {
                    const positive = tx.amountMicro > 0
                    return (
                      <div key={tx.id} className={`row ${TOPUP_GRID}`}>
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="truncate font-sans text-[13px] font-medium leading-normal">
                            {(KNOWN_KINDS as readonly string[]).includes(tx.kind)
                              ? t(`kindLabels.${tx.kind}`)
                              : tx.kind}
                          </span>
                          <span
                            className="mono inline-flex h-[19px] flex-none items-center rounded-[4px] px-[7px] text-[10.5px] font-semibold tracking-[0.04em] uppercase"
                            style={
                              positive
                                ? { background: 'var(--status-online-soft)', color: 'var(--status-online)' }
                                : { background: 'var(--surface-active)', color: 'var(--text-secondary)' }
                            }
                          >
                            {tx.kind}
                          </span>
                          {/* Free operator text, rendered as TEXT and truncated so it cannot push the amount out. */}
                          {tx.note && (
                            <span
                              className="truncate font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)"
                              title={tx.note}
                            >
                              {tx.note}
                            </span>
                          )}
                          {tx.receiptUrl && (
                            <a
                              className="inline-flex flex-none items-center gap-0.5 font-sans text-[12px] font-medium text-(--text-brand) hover:underline"
                              href={tx.receiptUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              {t('transactions.receipt')}
                              <Icon name="arrow-up-right" size={11} />
                            </a>
                          )}
                        </span>
                        <span
                          className="mono text-right text-[13px]"
                          style={positive ? { color: 'var(--status-online)' } : undefined}
                        >
                          {positive ? `+${fmtMicroUsd(tx.amountMicro)}` : fmtMicroUsd(tx.amountMicro)}
                        </span>
                        {posted}
                      </div>
                    )
                  }
                  // Agents are named only when in the viewer's roster (see `rowAttribution`); nothing while it loads.
                  const split = rosterPending ? [] : rowAttribution(tx.agents, agentById)
                  // Named chips are capped; the withheld rollup is appended after so it is never hidden behind `+N`.
                  const named = split.filter((c) => c.agent)
                  const rollup = split.find((c) => !c.agent)
                  const shownAgents = named.slice(0, TX_AGENT_CHIPS)
                  const restAgents = named.length - shownAgents.length
                  const models = (tx.models ?? [])
                    .filter((m) => Number(m.amount) > 0)
                    .sort((a, b) => Number(b.amount) - Number(a.amount))
                  const shownModels = models.slice(0, TX_MODEL_CHIPS)
                  const restModels = models.length - shownModels.length
                  const expandable = models.length > 0
                  const open = expandable && expanded.has(tx.id)
                  const chargeTotal = Number(tx.amount)
                  const modelName = (model: string) =>
                    model === UNATTRIBUTED_MODEL ? t('activity.unknownModel') : model
                  return (
                    <Fragment key={tx.id}>
                      <div
                        className={`row ${expandable ? 'click' : ''} ${USAGE_GRID}`}
                        onClick={expandable ? () => toggleExpanded(tx.id) : undefined}
                      >
                        <span className="flex items-center justify-center">
                          {expandable && (
                            // The row's click handler toggles; this button is the keyboard and screen-reader handle.
                            <button
                              type="button"
                              data-tx-toggle="true"
                              aria-expanded={open}
                              aria-label={open ? t('transactions.collapse') : t('transactions.expand')}
                              className="iconbtn flex h-[22px] w-[22px] items-center justify-center rounded-[5px] text-(--text-tertiary)"
                            >
                              <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} />
                            </button>
                          )}
                        </span>
                        {/* Per-agent amounts live in `title` on desktop (tabbable for the TooltipLayer); ≤768px shows them inline. */}
                        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                          {[...shownAgents, ...(rollup ? [rollup] : [])].map((chip) => {
                            const share = chip.agent
                              ? t('transactions.agentShare', {
                                  name: agentLabel(chip.agent),
                                  amount: fmtDecimalUsd(chip.amount)
                                })
                              : t('transactions.withheldShare', { amount: fmtDecimalUsd(chip.amount) })
                            return (
                              <span
                                key={chip.key}
                                data-tx-agent="true"
                                tabIndex={0}
                                title={share}
                                aria-label={share}
                                className={TX_TAG}
                              >
                                <span className="av h-[15px] w-[15px] flex-none rounded-[4px]">
                                  {chip.agent ? (
                                    <AgentIconView icon={chip.agent.icon} runtime={chip.agent.runtime} size={15} />
                                  ) : (
                                    // Default avatar: the viewer learns neither which agents nor how many, only the amount.
                                    <span
                                      data-tx-agent-default="true"
                                      className="flex h-full w-full items-center justify-center rounded-[inherit] bg-(--surface-sunken) text-(--text-tertiary)"
                                    >
                                      <Icon name="bot" size={10} strokeWidth={2} />
                                    </span>
                                  )}
                                </span>
                                {chip.agent && <span className="max-w-[160px] truncate">{agentLabel(chip.agent)}</span>}
                                <span className="mono flex-none text-(--text-tertiary) desktop:hidden">
                                  {fmtDecimalUsd(chip.amount)}
                                </span>
                              </span>
                            )
                          })}
                          {restAgents > 0 && (
                            <span className="mono flex-none text-[11.5px] text-(--text-tertiary)">+{restAgents}</span>
                          )}
                        </span>
                        {/* The charge's model split, org-wide and visible to every member. */}
                        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                          {shownModels.map((m) => {
                            const name = modelName(m.model)
                            const share = t('transactions.modelShare', { name, amount: fmtDecimalUsd(m.amount) })
                            return (
                              <span
                                key={m.model}
                                data-tx-model="true"
                                title={share}
                                aria-label={share}
                                className={TX_TAG}
                              >
                                <TxModelMark model={m.model} />
                                <span className="min-w-0 truncate">{name}</span>
                              </span>
                            )
                          })}
                          {restModels > 0 && (
                            <span className="mono flex-none text-[11.5px] text-(--text-tertiary)">+{restModels}</span>
                          )}
                        </span>
                        {/* A debit is a positive amount taken away, so the sign belongs here; the exact wire string is the tooltip. */}
                        <span className="mono text-right text-[13px]" title={`$${tx.amount}`}>
                          <span className="cursor-help border-b border-dotted border-(--border-strong)">
                            -{fmtDecimalUsd(tx.amount)}
                          </span>
                        </span>
                        {posted}
                      </div>
                      {open && (
                        <div
                          data-tx-models="true"
                          className={`border-b border-(--border-subtle) bg-(--surface-app) py-1.5 ${USAGE_MIN_W}`}
                        >
                          {models.map((m) => {
                            const pct = chargeTotal > 0 ? (Number(m.amount) / chargeTotal) * 100 : 0
                            return (
                              <div key={m.model} className={`grid items-center px-4 py-1.5 ${USAGE_GRID}`}>
                                <span />
                                <span />
                                <span className="flex min-w-0 items-center gap-2">
                                  <TxModelMark model={m.model} />
                                  <span className="mono min-w-0 truncate text-[12px] text-(--text-secondary)">
                                    {modelName(m.model)}
                                  </span>
                                  <span className="mono flex-none text-[11px] text-(--text-tertiary)">
                                    {pct.toFixed(1)}%
                                  </span>
                                </span>
                                <span className="mono text-right text-[12.5px]" title={`$${m.amount}`}>
                                  -{fmtDecimalUsd(m.amount)}
                                </span>
                                <span />
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </Fragment>
                  )
                })}
                <div className="flex items-center justify-center gap-3 rounded-b-[10px] border-t border-(--border-subtle) bg-(--surface-app) px-4 py-3.5">
                  {nextCursor ? (
                    <Button size="sm" variant="secondary" disabled={loadingMore} onClick={() => void loadMore()}>
                      {loadingMore ? t('transactions.loadingMore') : t('transactions.loadMore')}
                    </Button>
                  ) : (
                    <span className="mono text-[11.5px] text-(--text-tertiary)">{t('transactions.endOfLedger')}</span>
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
