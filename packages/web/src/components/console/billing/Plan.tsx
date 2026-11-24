'use client'

// The org's plan on the Billing page: the Plan card, the balance's plan-credit strip and its dialog, and the plan banners; owners' actions arrive as props.

import { useEffect, useState, type ReactNode } from 'react'
import { useFormatter, useTranslations } from 'next-intl'
import useSWR from 'swr'
import {
  FREE_TIER_ID,
  fetchBillingSubscription,
  fmtCents,
  fmtMicroUsd,
  type BillingPendingChange,
  type BillingPlanRef,
  type BillingSubscription
} from '@/lib/billing-api'
import { fetchSessionMonthUsage, type SessionMonthUsageDto } from '@/lib/api'
import { consoleKeys } from '@/lib/swr-keys'
import { Button, Icon } from '@/components/ui'

/** The plan reads; a null org leaves both unkeyed, so nothing is requested. */
export function usePlanReads(orgId: string | null) {
  const subscription = useSWR(orgId ? consoleKeys.billingSubscription(orgId) : null, () =>
    fetchBillingSubscription(orgId!)
  )
  const usage = useSWR(orgId ? consoleKeys.sessionMonthUsage(orgId) : null, () => fetchSessionMonthUsage(orgId!))
  return { subscription, usage }
}
export type PlanReads = ReturnType<typeof usePlanReads>

/** Free reads as its tier alone; any other plan as tier and option. */
export function planLabel(ref: BillingPlanRef): string {
  return ref.tierId === FREE_TIER_ID ? ref.tierName : `${ref.tierName} ${ref.optionName}`
}

export type PlanCreditTag = 'next' | 'active' | 'expired'

export interface PlanCreditRow {
  key: string
  /** Null from an older service, which sends only remaining credit per expiry. */
  grantedAt: string | null
  grantedMicro: number | null
  remainingMicro: number
  expiresAt: string
  tag: PlanCreditTag
}

/** The dialog's rows: live grants soonest first (the first expires next), then expired ones. */
export function planCreditRows(sub: BillingSubscription): PlanCreditRow[] {
  if (sub.batches) {
    const live = sub.batches.filter((b) => !b.expired)
    const gone = sub.batches.filter((b) => b.expired)
    return [...live, ...gone].map((b) => ({
      key: `${b.grantedAt}/${b.expiresAt}`,
      grantedAt: b.grantedAt,
      grantedMicro: b.grantedMicro,
      remainingMicro: b.remainingMicro,
      expiresAt: b.expiresAt,
      tag: b.expired ? 'expired' : b === live[0] ? 'next' : 'active'
    }))
  }
  return (sub.grants ?? []).map((g, i) => ({
    key: g.expiresAt,
    grantedAt: null,
    grantedMicro: null,
    remainingMicro: g.remainingMicro,
    expiresAt: g.expiresAt,
    tag: i === 0 ? 'next' : 'active'
  }))
}

/** The balance split into plan credit and the rest; null on Free or when the service sends no plan credit at all. */
export function planCreditSplit(
  sub: BillingSubscription,
  balanceMicro: number
): { planMicro: number; topUpMicro: number; next: PlanCreditRow | null } | null {
  if (sub.tierId === FREE_TIER_ID) return null
  if (sub.batches === undefined && sub.grants === undefined && sub.planCreditMicro === undefined) return null
  const live = planCreditRows(sub).filter((r) => r.tag !== 'expired')
  const planMicro = sub.planCreditMicro ?? live.reduce((sum, r) => sum + r.remainingMicro, 0)
  return { planMicro, topUpMicro: balanceMicro - planMicro, next: live[0] ?? null }
}

/** Expires by the end of the paid period, i.e. in the current cycle. */
export function expiresThisCycle(expiresAt: string, paidThrough: string | null): boolean {
  return paidThrough !== null && Date.parse(expiresAt) <= Date.parse(paidThrough)
}

/** Meter hue: brand, amber from 80% of the limit, red at it; null without a limit. */
export function meterTone(used: number, limit: number | null): 'brand' | 'amber' | 'red' | null {
  if (limit === null) return null
  if (used >= limit) return 'red'
  return used >= limit * 0.8 ? 'amber' : 'brand'
}

// Cycle boundaries and the session reset are UTC instants, so they render in UTC.
export function useUtcDates() {
  const format = useFormatter()
  const at = (iso: string, withTime: boolean) => {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    return withTime
      ? format.dateTime(d, {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          hourCycle: 'h23',
          timeZone: 'UTC'
        })
      : format.dateTime(d, { month: 'short', day: 'numeric', timeZone: 'UTC' })
  }
  return { day: (iso: string) => at(iso, false), dayTime: (iso: string) => at(iso, true), number: format.number }
}

function LoadError({ text, onRetry }: { text: string; onRetry: () => void }) {
  const t = useTranslations('Billing')
  return (
    <div role="alert" className="flex flex-1 items-center gap-3 px-4 py-3">
      <Icon name="triangle-exclamation-point" size={18} color="var(--status-error)" />
      <span className="min-w-0 flex-1 font-sans text-[13px] font-normal leading-[1.55]">{text}</span>
      <Button size="sm" variant="secondary" onClick={onRetry}>
        {t('retry')}
      </Button>
    </div>
  )
}

const METER_FILL = { brand: 'bg-(--brand)', amber: 'bg-(--amber-500)', red: 'bg-(--red-500)' } as const

/** The owner's Increase-limit link under the meter, with its preview line. */
export interface IncreaseLink {
  title: string
  sub: string | null
  onClick: () => void
}

function SessionsMeter({ usage, increase }: { usage: SessionMonthUsageDto; increase?: IncreaseLink }) {
  const t = useTranslations('Billing.plan')
  const { day, number } = useUtcDates()
  const tone = meterTone(usage.used, usage.limit)
  // Width is data, so it rides an inline style.
  const pct = usage.limit ? Math.min(100, (usage.used / usage.limit) * 100) : 100
  return (
    <div data-plan-sessions="true" className="flex h-[76px] flex-col justify-center px-[18px] desktop:row-start-4">
      <div className="flex items-baseline justify-between gap-3">
        <span className="eyebrow">{t('sessions')}</span>
        <span className="mono text-[12.5px] text-(--text-tertiary)">
          <span className={`font-semibold ${tone === 'red' ? 'text-(--red-600)' : 'text-(--text-primary)'}`}>
            {number(usage.used)}
          </span>
          {usage.limit !== null && ` / ${number(usage.limit)}`}
        </span>
      </div>
      {tone && (
        <div className="mt-[9px] h-[7px] overflow-hidden rounded-[4px] border border-(--border-subtle) bg-(--surface-sunken)">
          <span
            data-plan-meter={tone}
            className={`block h-full rounded-[4px] ${METER_FILL[tone]}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
      <div className="mt-2 flex items-center justify-between gap-3 font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
        <span>{t('resets', { date: day(usage.resetsAt) })}</span>
        {increase && (
          <span className="inline-flex min-w-0 items-center gap-2" data-plan-increase="true">
            <button type="button" className="lnk text-[12px]" onClick={increase.onClick}>
              {increase.title}
              <Icon name="chevron-right" size={12} />
            </button>
            {increase.sub && <span className="truncate">{increase.sub}</span>}
          </span>
        )}
      </div>
    </div>
  )
}

/** The Plan card beside the balance. Owners get Change plan in its header, Cancel on a scheduled change and Increase limit under the meter; members are told who can. */
export function PlanCard({
  reads,
  role,
  onChangePlan,
  onCancelScheduled,
  increase
}: {
  reads: PlanReads
  role: string | null
  onChangePlan?: () => void
  onCancelScheduled?: () => Promise<void>
  increase?: IncreaseLink
}) {
  const t = useTranslations('Billing.plan')
  const { day } = useUtcDates()
  const { subscription } = reads
  const sub = subscription.data
  // A failed read hides only the sessions block; nothing else on the card depends on it.
  const usage = reads.usage.error ? undefined : reads.usage.data
  const billingDate =
    sub && (sub.priceCents === null || sub.priceCents > 0) && sub.paidThrough
      ? t(sub.priceCents === null || sub.scheduled?.tierId === FREE_TIER_ID ? 'ends' : 'renews', {
          date: day(sub.paidThrough)
        })
      : null
  // The window in force; an older service sends only the plan's.
  const keptDays = sub ? (sub.retention ? sub.retention.days : sub.retentionDays) : null
  return (
    <div className="card flex flex-col desktop:row-span-4 desktop:grid desktop:grid-rows-subgrid" data-plan-card="true">
      <div className="cardhead h-[60px] justify-between gap-2 border-b-0">
        <span className="inline-flex min-w-0 items-center gap-2">
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
        </span>
        {role && role !== 'owner' && (
          <span className="font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
            {t('ownersChange')}
          </span>
        )}
        {role === 'owner' && sub && onChangePlan && (
          <Button size="sm" variant="secondary" onClick={onChangePlan}>
            {t('change.title')}
          </Button>
        )}
      </div>
      {subscription.error ? (
        <LoadError
          text={t('loadError', { error: (subscription.error as Error).message })}
          onRetry={() => void subscription.mutate()}
        />
      ) : sub === undefined ? (
        <div className="min-h-[92px] flex-1 animate-pulse" />
      ) : sub === null ? (
        <div className="flex flex-1 flex-col justify-end px-[18px] py-6" data-plan-none="true">
          <div className="font-sans text-[20px] font-semibold leading-normal">{t('noneTitle')}</div>
          <div className="mt-1 font-sans text-[12.5px] font-normal leading-[1.55] text-(--text-secondary)">
            {t('noneBody')}
          </div>
        </div>
      ) : (
        <div className="flex flex-1 flex-col justify-end gap-1 px-[18px] pt-3 pb-1">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span
              className="min-w-0 font-sans text-[32px] font-semibold leading-none tracking-[-0.03em] wrap-anywhere desktop:text-[44px]"
              data-plan-name="true"
            >
              {sub.tierName}
              {sub.tierId !== FREE_TIER_ID && sub.optionName !== sub.tierName && (
                <span className="ml-2.5 text-[16px] tracking-[-0.01em] text-(--text-secondary) desktop:text-[20px]">
                  {sub.optionName}
                </span>
              )}
            </span>
            <span
              className="ms-auto font-sans text-[12px] leading-normal whitespace-nowrap text-(--text-tertiary)"
              data-plan-price="true"
            >
              {sub.priceCents === null
                ? t('contract')
                : t.rich('price', {
                    price: fmtCents(sub.priceCents),
                    amount: (value) => (
                      <strong className="text-[21px] font-semibold tracking-[-0.02em] text-(--text-primary) tabular-nums">
                        {value}
                      </strong>
                    )
                  })}
            </span>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 font-sans text-[12px] leading-4 text-(--text-secondary)">
            {billingDate && (
              <span className="inline-flex items-center gap-1.5" data-plan-billing-date="true">
                <Icon name="calendar-days" size={13} className="flex-none" />
                {billingDate}
              </span>
            )}
            <span className="inline-flex items-center gap-1.5" data-plan-retention="true">
              <Icon name="clock" size={13} className="flex-none" />
              {keptDays === null ? t('change.historyUnlimited') : t('change.historyDays', { days: keptDays })}
            </span>
          </div>
        </div>
      )}
      {sub && (
        <div className="min-h-[52px] px-[18px] py-1 max-desktop:@min-[382px]:min-h-9 desktop:row-start-3 desktop:@min-[782px]:min-h-9">
          {sub.scheduled && (
            <ScheduledChange
              sub={sub}
              scheduled={sub.scheduled}
              onCancel={role === 'owner' ? onCancelScheduled : undefined}
            />
          )}
        </div>
      )}
      {usage && <SessionsMeter usage={usage} increase={role === 'owner' ? increase : undefined} />}
    </div>
  )
}

/** A scheduled renewal change, inside the Plan card under the plan's name; owners can revoke it. */
function ScheduledChange({
  sub,
  scheduled,
  onCancel
}: {
  sub: BillingSubscription
  scheduled: BillingPlanRef
  onCancel?: () => Promise<void>
}) {
  const t = useTranslations('Billing.plan')
  const { day } = useUtcDates()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const cancel = async () => {
    if (!onCancel || busy) return
    setBusy(true)
    setError(null)
    try {
      await onCancel()
    } catch (e) {
      setError(t('cancelScheduledError', { error: (e as Error).message }))
    }
    setBusy(false)
  }
  const plan = planLabel(scheduled)
  return (
    <div
      data-plan-scheduled="true"
      className="flex items-center gap-2.5 rounded-lg bg-(--status-info-soft) px-3 py-1.5 desktop:@max-[540px]:gap-1.5 desktop:@max-[540px]:px-2"
    >
      <Icon
        name="calendar-clock"
        size={14}
        color="var(--status-info)"
        className="flex-none desktop:@max-[540px]:hidden"
      />
      <span className="min-w-0 flex-1 font-sans text-[12.5px] font-medium leading-4 wrap-anywhere">
        {sub.paidThrough ? t('switching', { plan, date: day(sub.paidThrough) }) : t('switchingAtRenewal', { plan })}
        {error && (
          <span role="alert" className="mt-1 block font-normal text-(--status-error)">
            {error}
          </span>
        )}
      </span>
      {onCancel && (
        <button type="button" className="lnk" disabled={busy} onClick={() => void cancel()}>
          {t('cancelScheduled')}
        </button>
      )}
    </div>
  )
}

const RETENTION_STRIP = {
  dated:
    'mb-[18px] flex items-center gap-2.5 rounded-[10px] border border-(--amber-500) bg-(--status-paused-soft) px-[18px] py-2.5',
  awaiting:
    'mb-[18px] flex items-center gap-2.5 rounded-[10px] border border-(--border-subtle) bg-(--surface-sunken) px-[18px] py-2.5'
} as const

/** A shorter history window on its way in, dated once the service has set the day; owners are pointed at Change plan. */
export function RetentionStrip({
  sub,
  onChangePlan
}: {
  sub: BillingSubscription | null | undefined
  onChangePlan?: () => void
}) {
  const t = useTranslations('Billing.plan')
  const { day } = useUtcDates()
  const next = sub?.retention?.next
  if (!next || next.days === null || (!next.from && !next.awaitingNotice)) return null
  const kind = next.from ? 'dated' : 'awaiting'
  return (
    <div data-plan-retention-next={kind} className={RETENTION_STRIP[kind]}>
      <span className="min-w-0 flex-1 font-sans text-[12.5px] font-medium leading-normal">
        {next.from
          ? t('retention.deletes', { days: next.days, date: day(next.from) })
          : t('retention.awaiting', { days: next.days })}
        {onChangePlan && (
          <span className="ml-[0.3em] font-normal text-(--text-secondary)">{t('retention.upgradeKeeps')}</span>
        )}
      </span>
      {onChangePlan && (
        <button type="button" className="lnk" onClick={onChangePlan}>
          {t('change.title')}
        </button>
      )}
    </div>
  )
}

// The page's amber banner, as the balance banners draw it.
function AmberBanner({
  data,
  icon,
  title,
  action,
  children
}: {
  data: string
  icon: string
  title: string
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <div
      data-plan-banner={data}
      className="mb-[18px] flex items-start gap-3 rounded-[10px] border border-(--status-paused) bg-(--status-paused-soft) px-4 py-3.5"
    >
      <span className="flex h-7 w-7 flex-none items-center justify-center rounded-lg bg-(--status-paused)">
        <Icon name={icon} size={16} color="#fff" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="font-sans text-[13px] font-semibold leading-normal">{title}</div>
        {children}
      </div>
      {action}
    </div>
  )
}

function PendingPaymentBanner({ change }: { change: BillingPendingChange }) {
  const t = useTranslations('Billing.plan.pending')
  return (
    <AmberBanner data="pending" icon="clock" title={change.kind === 'upgrade' ? t('upgradeTitle') : t('checkoutTitle')}>
      <div className="mt-1 font-sans text-[12.5px] font-normal leading-[1.55] text-(--text-secondary)">
        {change.payUrl ? t('body') : t('bodyNoLink')}
      </div>
      {change.payUrl && (
        <a className="lnk mt-2 flex w-fit" href={change.payUrl} target="_blank" rel="noopener noreferrer">
          {t('pay')}
          <Icon name="arrow-up-right" size={12} />
        </a>
      )}
    </AmberBanner>
  )
}

/** The plan's page banners: a payment still owed for a plan change, and a spent session limit whose CTA is the Increase-limit entry. */
export function PlanBanners({
  reads,
  limitAction
}: {
  reads: PlanReads
  limitAction?: { label: string; onClick: () => void }
}) {
  const t = useTranslations('Billing.plan.limitReached')
  const { day } = useUtcDates()
  const change = reads.subscription.data?.pendingChange
  const usage = reads.usage.error ? undefined : reads.usage.data
  const atLimit = usage !== undefined && usage.limit !== null && usage.used >= usage.limit
  return (
    <>
      {change && <PendingPaymentBanner change={change} />}
      {atLimit && (
        <AmberBanner
          data="session-limit"
          icon="triangle-exclamation-point"
          title={t('title')}
          action={
            limitAction && (
              <Button size="sm" className="flex-none self-center" onClick={limitAction.onClick}>
                {limitAction.label}
              </Button>
            )
          }
        >
          <div className="mt-1 font-sans text-[12.5px] font-normal leading-[1.55] text-(--text-secondary)">
            {t('text', { date: day(usage.resetsAt) })}
          </div>
        </AmberBanner>
      )}
    </>
  )
}

const CREDIT_GRID = 'grid-cols-[minmax(0,1fr)_90px_100px_150px] max-desktop:min-w-[560px] gap-2'
const CREDIT_TAG = {
  next: 'bg-(--amber-50) text-(--amber-500)',
  active: 'bg-(--green-50) text-(--green-500)',
  expired: 'bg-(--surface-active) text-(--text-tertiary)'
} as const

function PlanCreditsDialog({ rows, onClose }: { rows: PlanCreditRow[]; onClose: () => void }) {
  const t = useTranslations('Billing.plan.credits')
  const { day, dayTime } = useUtcDates()
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="modal max-w-[600px]"
        role="dialog"
        aria-modal="true"
        aria-label={t('title')}
        data-plan-credits-dialog="true"
      >
        <div className="modalhead">
          <span className="cardtitle flex-1">{t('title')}</span>
          <button className="iconbtn border-0" onClick={onClose} aria-label={t('close')}>
            <Icon name="x" size={16} />
          </button>
        </div>
        {rows.length === 0 ? (
          <div className="px-5 py-5 font-sans text-[13px] font-normal leading-normal text-(--text-tertiary)">
            {t('empty')}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <div className={`row h rounded-none ${CREDIT_GRID}`}>
              <span>{t('columns.cycle')}</span>
              <span className="text-right">{t('columns.granted')}</span>
              <span className="text-right">{t('columns.remaining')}</span>
              <span className="text-right">{t('columns.expires')}</span>
            </div>
            {rows.map((r) => {
              const expired = r.tag === 'expired'
              return (
                <div key={r.key} data-credit-row={r.tag} className={`row ${CREDIT_GRID}`}>
                  <span className="flex min-w-0 items-center gap-2">
                    <span
                      className={`truncate font-sans text-[13px] font-medium leading-normal ${expired ? 'text-(--text-tertiary)' : ''}`}
                    >
                      {r.grantedAt ? t('cycle', { date: day(r.grantedAt) }) : '—'}
                    </span>
                    <span
                      className={`mono inline-flex h-[19px] flex-none items-center rounded-[4px] px-[7px] text-[10.5px] font-semibold tracking-[0.04em] uppercase ${CREDIT_TAG[r.tag]}`}
                    >
                      {t(`tags.${r.tag}`)}
                    </span>
                  </span>
                  <span className="mono text-right text-[12.5px] text-(--text-secondary)">
                    {r.grantedMicro === null ? '—' : fmtMicroUsd(r.grantedMicro)}
                  </span>
                  <span
                    className={`mono text-right text-[12.5px] ${expired ? 'text-(--text-tertiary) line-through' : ''}`}
                  >
                    {fmtMicroUsd(r.remainingMicro)}
                  </span>
                  <span className="mono text-right text-[12px] text-(--text-secondary)">{dayTime(r.expiresAt)}</span>
                </div>
              )
            })}
          </div>
        )}
        <div className="modalbody px-5 py-3.5 font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
          {t('footer')}
        </div>
      </div>
    </div>
  )
}

function Stat({ label, value, soon = false }: { label: string; value: string; soon?: boolean }) {
  return (
    <span className="min-w-0">
      <span className="eyebrow block truncate text-[10px]">{label}</span>
      <span
        data-soon={soon ? 'true' : undefined}
        className={`mono mt-1.5 block truncate text-[13.5px] font-semibold ${soon ? 'text-(--amber-500)' : 'text-(--text-primary)'}`}
      >
        {value}
      </span>
    </span>
  )
}

/** The balance card's foot: plan credit, the rest, and what expires next; opens the per-cycle table. */
export function PlanCreditStrip({ sub, balanceMicro }: { sub: BillingSubscription; balanceMicro: number }) {
  const t = useTranslations('Billing.plan.credits')
  const { day } = useUtcDates()
  const [open, setOpen] = useState(false)
  const split = planCreditSplit(sub, balanceMicro)
  if (!split) return null
  const { next } = split
  return (
    <>
      <button
        type="button"
        data-plan-credits="true"
        title={t('open')}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        className="grid h-[76px] w-full cursor-pointer grid-cols-[1fr_1fr_1fr_14px] items-center desktop:row-start-4 gap-3 rounded-b-[10px] border-0 bg-transparent px-[18px] text-left transition-colors hover:bg-(--surface-hover)"
      >
        <Stat label={t('planCredits')} value={fmtMicroUsd(split.planMicro)} />
        <Stat label={t('topUps')} value={fmtMicroUsd(split.topUpMicro)} />
        <Stat
          label={next ? t('expiringOn', { date: day(next.expiresAt) }) : t('expiring')}
          value={fmtMicroUsd(next?.remainingMicro ?? 0)}
          soon={next !== null && expiresThisCycle(next.expiresAt, sub.paidThrough)}
        />
        <Icon name="chevron-right" size={14} color="var(--text-tertiary)" />
      </button>
      {open && <PlanCreditsDialog rows={planCreditRows(sub)} onClose={() => setOpen(false)} />}
    </>
  )
}
