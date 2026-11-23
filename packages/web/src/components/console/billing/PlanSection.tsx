'use client'

// The org's plan, plan catalog and plan invoices on the Billing page, read-only; each read fails into its own block.

import { useState, type ReactNode } from 'react'
import { useFormatter, useTranslations } from 'next-intl'
import useSWR from 'swr'
import {
  BillingError,
  FREE_TIER_ID,
  fetchBillingInvoices,
  fetchBillingPlans,
  fetchBillingSubscription,
  fmtCents,
  fmtMicroUsd,
  type BillingInvoice,
  type BillingPlanOption,
  type BillingPlanRef,
  type BillingPlans,
  type BillingSubscription
} from '@/lib/billing-api'
import { fetchSessionMonthUsage, type SessionMonthUsageDto } from '@/lib/api'
import { consoleKeys } from '@/lib/swr-keys'
import { Button, Icon } from '@/components/ui'

type PlanT = ReturnType<typeof useTranslations<'Billing.plan'>>

const planName = (ref: BillingPlanRef) => `${ref.tierName} · ${ref.optionName}`

/** The scheduled option's price when a renewal change is scheduled, else the current one's; null when nothing renews. */
export function nextCharge(
  sub: BillingSubscription,
  plans: BillingPlans | undefined
): { cents: number | null; date: string } | null {
  if (!sub.paidThrough || sub.scheduled?.tierId === FREE_TIER_ID) return null
  if (!sub.scheduled) return { cents: sub.priceCents, date: sub.paidThrough }
  const { tierId, optionId } = sub.scheduled
  const option = plans?.options.find((o) => o.tierId === tierId && o.optionId === optionId)
  return { cents: option?.priceCents ?? null, date: sub.paidThrough }
}

/** Options grouped by tier, keeping the catalog's order. */
export function plansByTier(
  options: readonly BillingPlanOption[]
): { tierId: string; tierName: string; options: BillingPlanOption[] }[] {
  const tiers = new Map<string, { tierId: string; tierName: string; options: BillingPlanOption[] }>()
  for (const o of options) {
    const tier = tiers.get(o.tierId) ?? { tierId: o.tierId, tierName: o.tierName, options: [] }
    tier.options.push(o)
    tiers.set(o.tierId, tier)
  }
  return [...tiers.values()]
}

function useDates() {
  const format = useFormatter()
  const at = (iso: string, withTime = false) => {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    return format.dateTime(d, withTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' })
  }
  return { date: (iso: string) => at(iso), dateTime: (iso: string) => at(iso, true), number: format.number }
}

function priceLabel(t: PlanT, priceCents: number | null): string {
  if (priceCents === null) return t('contactSales')
  if (priceCents === 0) return t('free')
  return t('perMonth', { price: fmtCents(priceCents) })
}

function retentionLabel(t: PlanT, days: number | null): string {
  return days === null ? t('unlimited') : t('retentionDays', { days })
}

function LoadError({ text, onRetry }: { text: string; onRetry: () => void }) {
  const t = useTranslations('Billing')
  return (
    <div role="alert" className="flex items-center gap-3 px-4 py-3">
      <Icon name="triangle-exclamation-point" size={18} color="var(--status-error)" />
      <span className="min-w-0 flex-1 font-sans text-[13px] font-normal leading-[1.55]">{text}</span>
      <Button size="sm" variant="secondary" onClick={onRetry}>
        {t('retry')}
      </Button>
    </div>
  )
}

function Fact({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="eyebrow">{label}</div>
      <div className="mono mt-[5px] text-[13px]">{value}</div>
      {sub && <div className="mt-1 font-sans text-[11.5px] leading-normal text-(--text-tertiary)">{sub}</div>}
    </div>
  )
}

// Width is data, so it rides an inline style; the hue steps at 80% and 100% of the limit.
function SessionsMeter({ used, limit }: { used: number; limit: number }) {
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 100
  const tone = pct >= 100 ? 'bg-(--status-error)' : pct >= 80 ? 'bg-(--status-paused)' : 'bg-(--brand)'
  return (
    <div className="mt-1.5 h-1 w-full max-w-[160px] overflow-hidden rounded-full bg-(--surface-sunken)">
      <div className={`h-full rounded-full ${tone}`} style={{ width: `${pct}%` }} />
    </div>
  )
}

function SessionsFact({ usage }: { usage: SessionMonthUsageDto }) {
  const t = useTranslations('Billing.plan')
  const { dateTime, number } = useDates()
  return (
    <div data-plan-sessions="true">
      <Fact
        label={t('facts.sessions')}
        value={
          usage.limit === null
            ? number(usage.used)
            : t('sessionsUsed', { used: number(usage.used), limit: number(usage.limit) })
        }
        sub={
          <>
            {usage.limit !== null && <SessionsMeter used={usage.used} limit={usage.limit} />}
            <span className="mt-1 block">{t('sessionsResets', { date: dateTime(usage.resetsAt) })}</span>
          </>
        }
      />
    </div>
  )
}

function PendingChangeNotice({ sub, plans }: { sub: BillingSubscription; plans: BillingPlans | undefined }) {
  const t = useTranslations('Billing.plan.pending')
  const change = sub.pendingChange
  if (!change) return null
  const option = plans?.options.find((o) => o.tierId === change.tierId && o.optionId === change.optionId)
  const plan = option ? planName(option) : change.tierId
  return (
    <div
      data-plan-pending="true"
      className="mx-[18px] mt-4 flex items-start gap-3 rounded-[10px] border border-(--status-paused) bg-(--status-paused-soft) px-4 py-3"
    >
      <span className="mt-[1px] flex-none text-(--status-paused)">
        <Icon name="clock" size={16} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="font-sans text-[13px] font-semibold leading-normal">
          {change.kind === 'upgrade' ? t('upgradeTitle', { plan }) : t('checkoutTitle', { plan })}
        </div>
        <div className="mt-1 font-sans text-[12.5px] font-normal leading-[1.55] text-(--text-secondary)">
          {change.payUrl ? t('body') : t('bodyNoLink')}
        </div>
        {change.payUrl && (
          <a
            className="mt-2 inline-flex items-center gap-1 font-sans text-[12.5px] font-medium text-(--text-brand) hover:underline"
            href={change.payUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            {t('pay')}
            <Icon name="arrow-up-right" size={12} />
          </a>
        )}
      </div>
    </div>
  )
}

function PlanCredit({ sub }: { sub: BillingSubscription }) {
  const t = useTranslations('Billing.plan.credit')
  const { date } = useDates()
  // Absent ⇒ an older service; empty ⇒ no unexpired credit. Neither has a breakdown to show.
  if (!sub.grants?.length) return null
  return (
    <div data-plan-credit="true" className="mt-4 border-t border-(--border-subtle) pt-4">
      <div className="eyebrow">{t('title')}</div>
      <ul className="mt-2 flex flex-col gap-1.5">
        {sub.grants.map((g) => (
          <li key={g.expiresAt} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <span className="mono text-[13px]">{fmtMicroUsd(g.remainingMicro)}</span>
            <span className="font-sans text-[12px] leading-normal text-(--text-tertiary)">
              {t('expires', { date: date(g.expiresAt) })}
            </span>
          </li>
        ))}
      </ul>
      <div className="mt-2 font-sans text-[12px] leading-normal text-(--text-tertiary)">{t('included')}</div>
    </div>
  )
}

/** The org's current plan. `actions` is where plan controls will sit in the card's header. */
export function CurrentPlanCard({
  sub,
  plans,
  usage,
  actions
}: {
  sub: BillingSubscription | null
  plans: BillingPlans | undefined
  usage: SessionMonthUsageDto | undefined
  actions?: ReactNode
}) {
  const t = useTranslations('Billing.plan')
  const { date } = useDates()
  const charge = sub ? nextCharge(sub, plans) : null
  const scheduled = sub?.scheduled ?? null
  const cancels = scheduled?.tierId === FREE_TIER_ID
  return (
    <div className="card mb-[18px]" data-plan-current="true">
      <div className="cardhead flex-wrap gap-2">
        <span className="cardtitle">{t('title')}</span>
        {sub?.entitlementSync === 'syncing' && (
          <span
            data-plan-syncing="true"
            className="badge bg-(--status-info-soft) text-(--status-info)"
            title={t('syncingHint')}
          >
            <Icon name="refresh-cw" size={11} />
            {t('syncing')}
          </span>
        )}
        {actions && <span className="ml-auto flex items-center gap-2">{actions}</span>}
      </div>
      {sub && <PendingChangeNotice sub={sub} plans={plans} />}
      <div className="px-[18px] py-4">
        {sub ? (
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <span className="flex min-w-0 flex-wrap items-baseline gap-2">
              <span className="font-sans text-[20px] font-semibold leading-normal tracking-[-0.01em]">
                {sub.tierName}
              </span>
              <span className="scope">{sub.optionName}</span>
            </span>
            <span className="mono text-[15px] font-semibold">{priceLabel(t, sub.priceCents)}</span>
          </div>
        ) : (
          <div>
            <div className="font-sans text-[14px] font-semibold leading-normal">{t('noneTitle')}</div>
            <div className="mt-1 font-sans text-[12.5px] font-normal leading-[1.55] text-(--text-secondary)">
              {t('noneBody')}
            </div>
          </div>
        )}
        {(sub || usage) && (
          <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-4 border-t border-(--border-subtle) pt-4 desktop:grid-cols-4">
            {usage && <SessionsFact usage={usage} />}
            {sub && (
              <>
                <Fact label={t('facts.credit')} value={fmtMicroUsd(sub.grantMicro)} />
                <Fact label={t('facts.retention')} value={retentionLabel(t, sub.retentionDays)} />
                <Fact
                  label={t('facts.nextCharge')}
                  value={
                    charge
                      ? charge.cents === null
                        ? date(charge.date)
                        : t('nextChargeLine', { amount: fmtCents(charge.cents), date: date(charge.date) })
                      : '—'
                  }
                />
              </>
            )}
          </div>
        )}
        {scheduled && (
          <div
            data-plan-scheduled="true"
            className="mt-4 flex items-center gap-2 font-sans text-[12.5px] leading-normal text-(--text-secondary)"
          >
            <Icon name="calendar-clock" size={14} color="var(--text-tertiary)" />
            {cancels
              ? sub?.paidThrough
                ? t('cancels', { date: date(sub.paidThrough) })
                : t('cancelsAtRenewal')
              : sub?.paidThrough
                ? t('scheduledChange', { plan: planName(scheduled), date: date(sub.paidThrough) })
                : t('scheduledChangeAtRenewal', { plan: planName(scheduled) })}
          </div>
        )}
        {sub && <PlanCredit sub={sub} />}
      </div>
    </div>
  )
}

/** One option of a tier. `action` is where a per-option control will sit. */
export function PlanOptionRow({ option, action }: { option: BillingPlanOption; action?: ReactNode }) {
  const t = useTranslations('Billing.plan')
  const { number } = useDates()
  return (
    <div
      data-plan-option={`${option.tierId}/${option.optionId}`}
      className={`flex flex-col gap-2 border-t border-(--border-subtle) px-4 py-3 first:border-t-0 ${option.current ? 'bg-(--surface-hover)' : ''}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-sans text-[13px] font-semibold leading-normal">{option.optionName}</span>
        {option.multiplier !== null && (
          <span className="mono text-[11.5px] text-(--text-tertiary)">×{option.multiplier}</span>
        )}
        {option.current && <span className="badge bg-(--brand-soft) text-(--text-brand)">{t('compare.current')}</span>}
        {option.scheduled && (
          <span className="badge bg-(--status-info-soft) text-(--status-info)">{t('compare.scheduled')}</span>
        )}
        <span className="mono ml-auto text-[13px] font-semibold">{priceLabel(t, option.priceCents)}</span>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 font-sans text-[12px] leading-normal">
        <dt className="text-(--text-tertiary)">{t('facts.sessionLimit')}</dt>
        <dd className="mono text-right">{number(option.sessionLimit)}</dd>
        <dt className="text-(--text-tertiary)">{t('facts.credit')}</dt>
        <dd className="mono text-right">
          {option.salesMode === 'contact_sales' ? t('perContract') : fmtMicroUsd(option.grantMicro)}
        </dd>
        <dt className="text-(--text-tertiary)">{t('facts.retention')}</dt>
        <dd className="mono text-right">{retentionLabel(t, option.retentionDays)}</dd>
      </dl>
      {action}
    </div>
  )
}

export function ComparePlans({
  plans,
  error,
  onRetry
}: {
  plans: BillingPlans | undefined
  error: unknown
  onRetry: () => void
}) {
  const t = useTranslations('Billing.plan.compare')
  const tiers = plans ? plansByTier(plans.options) : []
  return (
    <div className="card mb-[18px]" data-plan-compare="true">
      <div className="cardhead">
        <span className="cardtitle">{t('title')}</span>
      </div>
      {error ? (
        <LoadError text={t('loadError', { error: (error as Error).message })} onRetry={onRetry} />
      ) : !plans ? (
        <div className="h-[120px] animate-pulse" />
      ) : tiers.length === 0 ? (
        <div className="px-4 py-5 font-sans text-[13px] leading-normal text-(--text-tertiary)">{t('empty')}</div>
      ) : (
        <div className="grid grid-cols-1 gap-3 p-4 desktop:grid-cols-[repeat(auto-fit,minmax(220px,1fr))]">
          {tiers.map((tier) => (
            <div
              key={tier.tierId}
              data-plan-tier={tier.tierId}
              className={`overflow-hidden rounded-[10px] border ${tier.options.some((o) => o.current) ? 'border-(--border-strong)' : 'border-(--border-subtle)'}`}
            >
              <div className="border-b border-(--border-subtle) bg-(--surface-app) px-4 py-2.5 font-sans text-[14px] font-semibold leading-normal">
                {tier.tierName}
              </div>
              {tier.options.map((o) => (
                <PlanOptionRow key={o.optionId} option={o} />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

const INVOICE_STATUS_TONE: Record<string, string> = {
  paid: 'bg-(--status-online-soft) text-(--status-online)',
  open: 'bg-(--status-paused-soft) text-(--status-paused)',
  void: 'bg-(--surface-active) text-(--text-tertiary)',
  uncollectible: 'bg-(--status-error-soft) text-(--status-error)'
}
const KNOWN_INVOICE_STATUSES = ['paid', 'open', 'void', 'uncollectible'] as const

// Invoice · period · status · amount · link; ≤768px floors the row and the card scrolls sideways.
const INVOICE_GRID = 'grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_110px_110px_64px] max-desktop:min-w-[620px] gap-2'

function InvoiceRow({ invoice }: { invoice: BillingInvoice }) {
  const t = useTranslations('Billing.plan.invoices')
  const { date } = useDates()
  const status = invoice.status as string
  const known = (KNOWN_INVOICE_STATUSES as readonly string[]).includes(status)
  const amount = status === 'paid' ? invoice.amountPaidCents : invoice.amountDueCents
  return (
    <div data-invoice={invoice.id} className={`row ${INVOICE_GRID}`}>
      <span className="min-w-0">
        <span className="mono block truncate text-[12.5px]">{invoice.number ?? '—'}</span>
        <span className="block truncate font-sans text-[11.5px] leading-normal text-(--text-tertiary)">
          {t('issued', { date: date(invoice.createdAt) })}
        </span>
      </span>
      <span className="mono truncate text-[12px] text-(--text-secondary)">
        {date(invoice.periodStart)} – {date(invoice.periodEnd)}
      </span>
      <span>
        <span className={`badge ${INVOICE_STATUS_TONE[status] ?? 'bg-(--surface-active) text-(--text-secondary)'}`}>
          {known ? t(`status.${status as (typeof KNOWN_INVOICE_STATUSES)[number]}`) : status}
        </span>
      </span>
      <span className="mono text-right text-[12.5px]">{fmtCents(amount, invoice.currency)}</span>
      <span className="text-right">
        {invoice.hostedUrl && (
          <a
            className="inline-flex items-center gap-1 font-sans text-[12px] font-medium text-(--text-brand) hover:underline"
            href={invoice.hostedUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            {t('view')}
            <Icon name="arrow-up-right" size={12} />
          </a>
        )}
      </span>
    </div>
  )
}

export function InvoicesCard({ orgId }: { orgId: string }) {
  const t = useTranslations('Billing.plan.invoices')
  const first = useSWR(consoleKeys.billingInvoices(orgId), () => fetchBillingInvoices(orgId))
  // Pages past the first, keyed to their org so a switch drops them; SWR owns page one.
  const [tail, setTail] = useState<{ orgId: string; items: BillingInvoice[]; nextCursor: string | null } | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [tailError, setTailError] = useState<string | null>(null)
  const mine = tail?.orgId === orgId ? tail : null
  const firstIds = new Set(first.data?.items.map((i) => i.id))
  const items = first.data ? [...first.data.items, ...(mine?.items ?? []).filter((i) => !firstIds.has(i.id))] : []
  const nextCursor = mine ? mine.nextCursor : (first.data?.nextCursor ?? null)
  const loadMore = async () => {
    if (!nextCursor || loadingMore) return
    setLoadingMore(true)
    setTailError(null)
    try {
      const page = await fetchBillingInvoices(orgId, nextCursor)
      setTail({ orgId, items: [...(mine?.items ?? []), ...page.items], nextCursor: page.nextCursor })
    } catch (e) {
      setTailError((e as Error).message)
    }
    setLoadingMore(false)
  }
  const unavailable = first.error instanceof BillingError && first.error.status === 503
  return (
    <div className="card mb-[18px]" data-plan-invoices="true">
      <div className="cardhead">
        <span className="cardtitle">{t('title')}</span>
      </div>
      {unavailable ? (
        <div
          data-invoices-unavailable="true"
          className="flex items-center gap-3 px-4 py-3 font-sans text-[13px] leading-[1.55] text-(--text-secondary)"
        >
          <Icon name="clock" size={16} color="var(--text-tertiary)" />
          {t('unavailable')}
        </div>
      ) : first.error ? (
        <LoadError
          text={t('loadError', { error: (first.error as Error).message })}
          onRetry={() => void first.mutate()}
        />
      ) : !first.data ? (
        <div className="h-[96px] animate-pulse" />
      ) : items.length === 0 ? (
        <div className="px-4 py-5 font-sans text-[13px] leading-normal text-(--text-tertiary)">{t('empty')}</div>
      ) : (
        <>
          <div className="overflow-x-auto">
            <div className={`row h rounded-none ${INVOICE_GRID}`}>
              <span>{t('columns.invoice')}</span>
              <span>{t('columns.period')}</span>
              <span>{t('columns.status')}</span>
              <span className="text-right">{t('columns.amount')}</span>
              <span />
            </div>
            {items.map((invoice) => (
              <InvoiceRow key={invoice.id} invoice={invoice} />
            ))}
          </div>
          <div className="flex items-center justify-center gap-3 rounded-b-[10px] bg-(--surface-app) px-4 py-3">
            {nextCursor ? (
              <Button size="sm" variant="secondary" disabled={loadingMore} onClick={() => void loadMore()}>
                {loadingMore ? t('loadingMore') : t('loadMore')}
              </Button>
            ) : (
              <span className="mono text-[11.5px] text-(--text-tertiary)">{t('end')}</span>
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
  )
}

/** The plan block: the current plan, then the catalog. Invoices are their own card further down. */
export function PlanSection({ orgId }: { orgId: string }) {
  const t = useTranslations('Billing.plan')
  const subscription = useSWR(consoleKeys.billingSubscription(orgId), () => fetchBillingSubscription(orgId))
  const plans = useSWR(consoleKeys.billingPlans(orgId), () => fetchBillingPlans(orgId))
  // A failed read hides only the sessions line; nothing else on the card depends on it.
  const usage = useSWR(consoleKeys.sessionMonthUsage(orgId), () => fetchSessionMonthUsage(orgId))
  return (
    <>
      {subscription.data !== undefined && !subscription.error ? (
        <CurrentPlanCard sub={subscription.data} plans={plans.data} usage={usage.error ? undefined : usage.data} />
      ) : (
        <div className="card mb-[18px]" data-plan-current="true">
          <div className="cardhead">
            <span className="cardtitle">{t('title')}</span>
          </div>
          {subscription.error ? (
            <LoadError
              text={t('loadError', { error: (subscription.error as Error).message })}
              onRetry={() => void subscription.mutate()}
            />
          ) : (
            <div className="h-[120px] animate-pulse" />
          )}
        </div>
      )}
      <ComparePlans plans={plans.data} error={plans.error} onRetry={() => void plans.mutate()} />
    </>
  )
}
