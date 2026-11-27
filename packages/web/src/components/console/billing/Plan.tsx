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
import { ConfirmationDialog } from '@/components/console/ConfirmationDialog'

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

function SessionsMeter({
  usage,
  syncing,
  increase
}: {
  usage: SessionMonthUsageDto
  syncing: boolean
  increase?: IncreaseLink
}) {
  const t = useTranslations('Billing.plan')
  const { day, number } = useUtcDates()
  const tone = meterTone(usage.used, usage.limit)
  // Width is data, so it rides an inline style.
  const pct = usage.limit ? Math.min(100, (usage.used / usage.limit) * 100) : 100
  return (
    <div data-plan-sessions="true" className="flex h-[76px] flex-col px-[18px] pt-2 desktop:row-start-4">
      <div className="flex h-4 items-center justify-between gap-3">
        <span className="eyebrow">{t('sessions')}</span>
        <span className="mono text-[12.5px] text-(--text-tertiary)">
          <span className={`font-semibold ${tone === 'red' ? 'text-(--red-600)' : 'text-(--text-primary)'}`}>
            {number(usage.used)}
          </span>
          {usage.limit !== null && ' / '}
          {usage.limit !== null &&
            (syncing ? (
              // The limit shown is still the previous plan's while the new one is being applied.
              <span
                data-plan-limit-syncing="true"
                className="inline-flex items-baseline gap-1 text-(--status-info)"
                title={t('syncingHint')}
              >
                {number(usage.limit)}
                <Icon name="refresh-cw" size={11} className="animate-spin self-center" />
              </span>
            ) : (
              number(usage.limit)
            ))}
        </span>
      </div>
      {tone && (
        <div className="mt-3.5 h-[7px] overflow-hidden rounded-[4px] border border-(--border-subtle) bg-(--surface-sunken)">
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
  onCancelTrial,
  onCancelPending,
  increase
}: {
  reads: PlanReads
  role: string | null
  onChangePlan?: () => void
  onCancelScheduled?: () => Promise<void>
  onCancelTrial?: () => void
  onCancelPending?: (change: BillingPendingChange) => Promise<void>
  increase?: IncreaseLink
}) {
  const t = useTranslations('Billing.plan')
  const { day } = useUtcDates()
  const { subscription } = reads
  const sub = subscription.data
  // A failed read hides only the sessions block; nothing else on the card depends on it.
  const usage = reads.usage.error ? undefined : reads.usage.data
  const trialEndsAt = sub?.trialEndsAt ?? null
  // An unpaid pay-now blocks every other change, so its withdrawal takes Cancel trial's place.
  const trialPending = trialEndsAt && sub?.pendingChange?.kind === 'upgrade' ? sub.pendingChange : null
  const cancelTrial = role === 'owner' && onChangePlan && !(trialPending && onCancelPending) ? onCancelTrial : undefined
  const billingDate = trialEndsAt
    ? t('trialEnds', { date: day(trialEndsAt) })
    : sub && (sub.priceCents === null || sub.priceCents > 0) && sub.paidThrough
      ? t(sub.priceCents === null || sub.scheduled?.tierId === FREE_TIER_ID ? 'ends' : 'renews', {
          date: day(sub.paidThrough)
        })
      : null
  // The window in force; an older service sends only the plan's.
  const keptDays = sub ? (sub.retention ? sub.retention.days : sub.retentionDays) : null
  return (
    <div
      className="card @container/plan flex flex-col desktop:row-span-4 desktop:grid desktop:grid-rows-subgrid"
      data-plan-card="true"
    >
      <div className="cardhead h-14 justify-between gap-2 border-b-0">
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
          <span className="inline-flex items-center gap-3.5">
            {trialPending && onCancelPending ? (
              <CancelPendingButton change={trialPending} trial onCancel={onCancelPending} />
            ) : (
              trialEndsAt &&
              sub.scheduled &&
              sub.scheduled.tierId !== FREE_TIER_ID &&
              cancelTrial && (
                <button
                  type="button"
                  className="lnk text-(--text-secondary)"
                  data-plan-cancel-trial="true"
                  onClick={cancelTrial}
                >
                  {t('trial.cancel')}
                </button>
              )
            )}
            <Button size="sm" variant="secondary" onClick={onChangePlan}>
              {t('change.title')}
            </Button>
          </span>
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
        <div className="flex flex-1 flex-col px-[18px] pt-3.5 pb-3">
          <div className="flex flex-wrap items-end gap-x-3 gap-y-1">
            <span
              className="min-w-0 font-sans text-[28px] leading-9 font-semibold tracking-[-0.025em] wrap-anywhere desktop:text-[36px] desktop:leading-10"
              data-plan-name="true"
            >
              {sub.tierName}
              {sub.tierId !== FREE_TIER_ID && sub.optionName !== sub.tierName && (
                <>
                  {' '}
                  <span className="font-medium text-(--text-tertiary)">{sub.optionName}</span>
                </>
              )}
            </span>
            {trialEndsAt ? (
              <span
                data-plan-trial="true"
                className="mb-2.5 inline-flex h-[19px] shrink-0 items-center rounded-[4px] bg-(--brand-soft) px-[7px] font-mono text-[10.5px] font-semibold tracking-[0.04em] text-(--brand-soft-text) uppercase"
              >
                {t('trial.badge')}
              </span>
            ) : (
              <span
                className="ms-auto shrink-0 pb-2 font-sans text-[12.5px] leading-normal whitespace-nowrap text-(--text-tertiary)"
                data-plan-price="true"
              >
                {sub.priceCents === null ? t('contract') : t('price', { price: fmtCents(sub.priceCents) })}
              </span>
            )}
          </div>
          <div className="mt-3 flex flex-wrap content-start gap-x-[18px] gap-y-1 font-sans text-[12.5px] leading-4 text-(--text-secondary) @max-[280px]/plan:min-h-9">
            {billingDate && (
              <span className="inline-flex items-center gap-[7px]" data-plan-billing-date="true">
                <Icon name="calendar-days" size={14} color="var(--text-tertiary)" className="flex-none" />
                {billingDate}
              </span>
            )}
            <span className="inline-flex items-center gap-[7px]" data-plan-retention="true">
              <Icon name="clock" size={14} color="var(--text-tertiary)" className="flex-none" />
              {keptDays === null ? t('change.historyUnlimited') : t('change.historyDays', { days: keptDays })}
            </span>
          </div>
        </div>
      )}
      {sub && (
        <div className="min-h-13 px-[18px] pb-2 @min-[360px]/plan:min-h-9 desktop:row-start-3">
          {(trialEndsAt || sub.scheduled) && (
            <PlanChangeStatus
              key={sub.scheduled ? JSON.stringify([sub.scheduled.tierId, sub.scheduled.optionId]) : 'trial'}
              sub={sub}
              onCancelScheduled={role === 'owner' ? onCancelScheduled : undefined}
              onCancelTrial={cancelTrial}
            />
          )}
        </div>
      )}
      {usage && (
        <SessionsMeter
          usage={usage}
          syncing={sub?.entitlementSync === 'syncing'}
          increase={role === 'owner' ? increase : undefined}
        />
      )}
    </div>
  )
}

function PlanChangeStatus({
  sub,
  onCancelScheduled,
  onCancelTrial
}: {
  sub: BillingSubscription
  onCancelScheduled?: () => Promise<void>
  onCancelTrial?: () => void
}) {
  const t = useTranslations('Billing.plan')
  const { day } = useUtcDates()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const cancelScheduled = async () => {
    if (!onCancelScheduled || busy) return
    setBusy(true)
    setError(null)
    try {
      await onCancelScheduled()
    } catch (e) {
      setError(t('cancelScheduledError', { error: (e as Error).message }))
    }
    setBusy(false)
  }
  const { scheduled, trialEndsAt } = sub
  const plan = scheduled ? planLabel(scheduled) : null
  const trialCancelled = !!trialEndsAt && scheduled?.tierId === FREE_TIER_ID
  const trialAction = !!trialEndsAt && !scheduled && onCancelTrial
  const detail = trialCancelled
    ? t('trial.noCharge')
    : trialEndsAt && !scheduled && sub.priceCents !== null
      ? t('trial.monthlyPrice', { price: fmtCents(sub.priceCents) })
      : null
  const message = trialEndsAt
    ? trialCancelled
      ? t('trial.cancelled')
      : plan
        ? t('trial.switching', { plan })
        : t('trial.renews')
    : plan &&
      (sub.paidThrough ? t('switching', { plan, date: day(sub.paidThrough) }) : t('switchingAtRenewal', { plan }))
  return (
    <div
      data-plan-scheduled={scheduled ? true : undefined}
      data-plan-trial-status={trialEndsAt ? true : undefined}
      className="flex min-h-9 items-center gap-2.5 rounded-lg border border-(--border-subtle) bg-(--surface-sunken) px-3 py-1 @max-[360px]/plan:min-h-11"
    >
      <div className="min-w-0 flex-1 font-sans text-[12.5px] leading-4 wrap-anywhere">
        <strong className="font-semibold">{message}</strong>
        {detail && (
          <span className="font-normal text-(--text-secondary) @max-[360px]/plan:block">
            <span className="@max-[360px]/plan:hidden" aria-hidden="true">
              &#32;·&#32;
            </span>
            {detail}
          </span>
        )}
        {error && (
          <span role="alert" className="mt-1 block font-normal text-(--status-error)">
            {error}
          </span>
        )}
      </div>
      {trialAction && (
        <button
          type="button"
          className="lnk max-w-[41%] text-end"
          data-plan-cancel-trial="true"
          onClick={onCancelTrial}
        >
          {t('trial.cancel')}
        </button>
      )}
      {scheduled && onCancelScheduled && (
        <button
          type="button"
          className="lnk max-w-[41%] text-end"
          disabled={busy}
          onClick={() => void cancelScheduled()}
        >
          {trialCancelled ? t('trial.undo') : trialEndsAt ? t('trial.undoSwitch') : t('cancelScheduled')}
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
        <Icon name={icon} size={16} color="var(--gray-900)" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="font-sans text-[13px] font-semibold leading-normal">{title}</div>
        {children}
      </div>
      {action}
    </div>
  )
}

/** Withdraws an unpaid upgrade after a confirmation; a trial's pay-now reads as a payment, since the plan may not change. */
export function CancelPendingButton({
  change,
  trial,
  onCancel
}: {
  change: BillingPendingChange
  trial: boolean
  onCancel: (change: BillingPendingChange) => Promise<void>
}) {
  const t = useTranslations('Billing.plan.pending')
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const k = (key: 'cancel' | 'cancelTitle' | 'cancelConfirm' | 'cancelKeep' | 'cancelError') =>
    trial ? (`trial.${key}` as const) : key
  const cancel = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await onCancel(change)
      setConfirming(false)
    } catch (e) {
      setError(t(k('cancelError'), { error: (e as Error).message }))
    }
    setBusy(false)
  }
  return (
    <>
      <button
        type="button"
        className="lnk"
        data-plan-pending-cancel="true"
        aria-haspopup="dialog"
        onClick={() => setConfirming(true)}
      >
        {t(k('cancel'))}
      </button>
      {confirming && (
        <ConfirmationDialog
          title={t(k('cancelTitle'))}
          confirmLabel={t(k('cancel'))}
          cancelLabel={t(k('cancelKeep'))}
          busy={busy}
          busyLabel={t('cancelBusy')}
          error={error}
          onConfirm={() => void cancel()}
          onClose={() => {
            setConfirming(false)
            setError(null)
          }}
        >
          {t(k('cancelConfirm'))}
        </ConfirmationDialog>
      )}
    </>
  )
}

/** An owner can withdraw an unpaid upgrade; a pending checkout is replaced by starting checkout again. */
function PendingPaymentBanner({
  change,
  trial,
  onCancel
}: {
  change: BillingPendingChange
  trial: boolean
  onCancel?: (change: BillingPendingChange) => Promise<void>
}) {
  const t = useTranslations('Billing.plan.pending')
  const cancelable = change.kind === 'upgrade' && onCancel
  const upgrade = change.kind === 'upgrade'
  return (
    <AmberBanner
      data="pending"
      icon="clock"
      title={upgrade && trial ? t('trial.title') : upgrade ? t('upgradeTitle') : t('checkoutTitle')}
    >
      <div className="mt-1 font-sans text-[12.5px] font-normal leading-[1.55] text-(--text-secondary)">
        {!change.payUrl ? t('bodyNoLink') : upgrade && trial ? t('trial.body') : t('body')}
      </div>
      {(change.payUrl || cancelable) && (
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
          {change.payUrl && (
            <a className="lnk flex w-fit" href={change.payUrl} target="_blank" rel="noopener noreferrer">
              {t('pay')}
              <Icon name="arrow-up-right" size={12} />
            </a>
          )}
          {cancelable && <CancelPendingButton change={change} trial={trial} onCancel={onCancel} />}
        </div>
      )}
    </AmberBanner>
  )
}

/** The plan's page banners: a payment still owed for a plan change (owners may withdraw an upgrade), and a spent session limit whose CTA is the Increase-limit entry. */
export function PlanBanners({
  reads,
  limitAction,
  onCancelPending
}: {
  reads: PlanReads
  limitAction?: { label: string; onClick: () => void }
  onCancelPending?: (change: BillingPendingChange) => Promise<void>
}) {
  const t = useTranslations('Billing.plan.limitReached')
  const { day } = useUtcDates()
  const change = reads.subscription.data?.pendingChange
  const usage = reads.usage.error ? undefined : reads.usage.data
  const atLimit = usage !== undefined && usage.limit !== null && usage.used >= usage.limit
  return (
    <>
      {change && (
        <PendingPaymentBanner
          change={change}
          trial={!!reads.subscription.data?.trialEndsAt}
          onCancel={onCancelPending}
        />
      )}
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
      <span className="eyebrow block truncate leading-4">{label}</span>
      <span
        data-soon={soon ? 'true' : undefined}
        className={`mono mt-2 block truncate text-[14px] leading-5 font-semibold ${soon ? 'text-(--amber-500)' : 'text-(--text-primary)'}`}
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
        className="grid h-[76px] w-full cursor-pointer grid-cols-[1fr_1fr_1fr_14px] items-start desktop:row-start-4 gap-3 rounded-b-[10px] border-0 bg-transparent px-[18px] pt-2 text-left transition-colors hover:bg-(--surface-hover)"
      >
        <Stat label={t(sub.trialEndsAt ? 'trialCredits' : 'planCredits')} value={fmtMicroUsd(split.planMicro)} />
        <Stat label={t('topUps')} value={fmtMicroUsd(split.topUpMicro)} />
        <Stat
          label={next ? t('expiringOn', { date: day(next.expiresAt) }) : t('expiring')}
          value={fmtMicroUsd(next?.remainingMicro ?? 0)}
          soon={next !== null && expiresThisCycle(next.expiresAt, sub.paidThrough)}
        />
        <Icon name="chevron-right" size={14} color="var(--text-tertiary)" className="self-center" />
      </button>
      {open && <PlanCreditsDialog rows={planCreditRows(sub)} onClose={() => setOpen(false)} />}
    </>
  )
}
