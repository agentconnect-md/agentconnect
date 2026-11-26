'use client'

// The owner's plan actions: the Change plan dialog (choose → review → paying → done) and the catalog step Increase limit opens it on.

import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import useSWR from 'swr'
import {
  BillingError,
  BillingShapeError,
  FREE_TIER_ID,
  confirmBillingUpgrade,
  createBillingSubscriptionCheckout,
  fetchBillingPlans,
  fetchBillingSubscriptionChange,
  fmtCents,
  fmtMicroUsd,
  quoteBillingUpgrade,
  scheduleBillingChange,
  type BillingPlanOption,
  type BillingPlans,
  type BillingSubscription,
  type BillingSubscriptionChange,
  type BillingUpgradeQuote
} from '@/lib/billing-api'
import { helpSupportUrl } from '@/lib/help-links'
import { consoleKeys } from '@/lib/swr-keys'
import { Button, Icon } from '@/components/ui'
import { planLabel, useUtcDates } from './Plan'

const POLL_INTERVAL_MS = 2_500
const POLL_MAX_ATTEMPTS = 120
const DAY_MS = 86_400_000

export interface PlanTier {
  tierId: string
  tierName: string
  salesMode: BillingPlanOption['salesMode']
  options: BillingPlanOption[]
}

/** The catalog's options grouped by tier, in the service's order (tier, then session limit). */
export function planTiers(plans: BillingPlans): PlanTier[] {
  const tiers: PlanTier[] = []
  for (const o of plans.options) {
    const last = tiers.at(-1)
    if (last?.tierId === o.tierId) last.options.push(o)
    else tiers.push({ tierId: o.tierId, tierName: o.tierName, salesMode: o.salesMode, options: [o] })
  }
  return tiers
}

/** A tier, and the option of it; a contact-sales tier has none to pick. */
export interface PlanTarget {
  tierId: string
  optionId: string | null
}

export type ChangePath = 'checkout' | 'immediate' | 'scheduled'

/** Which endpoint a change goes to, mirroring the service's rule; the service still decides and refuses a wrong one. */
export function changePath(sub: BillingSubscription, to: BillingPlanOption): ChangePath {
  if (sub.tierId === FREE_TIER_ID) return 'checkout'
  if (to.tierId === FREE_TIER_ID) return 'scheduled'
  const retentionKept =
    to.retentionDays === null || (sub.retentionDays !== null && to.retentionDays >= sub.retentionDays)
  const nothingLost = to.grantMicro >= sub.grantMicro && to.sessionLimit >= sub.sessionLimit && retentionKept
  return (to.priceCents ?? 0) > (sub.priceCents ?? 0) && nothingLost ? 'immediate' : 'scheduled'
}

const isCurrent = (sub: BillingSubscription, o: BillingPlanOption) =>
  o.current || (o.tierId === sub.tierId && o.optionId === sub.optionId)

// Free is sold only by scheduling a cancellation; anything else must be on sale.
const sellable = (o: BillingPlanOption) => o.purchasable || o.tierId === FREE_TIER_ID

const paidSelfServe = (o: BillingPlanOption) => o.tierId !== FREE_TIER_ID && o.salesMode === 'self_serve'

/** The catalog carries no pause flag, so sales read as paused when no paid self-serve option is on sale; one unpriced option alone is not enough. */
export function salesPaused(plans: BillingPlans): boolean {
  const paid = plans.options.filter(paidSelfServe)
  return paid.length > 0 && paid.every((o) => !o.purchasable)
}

/** The next step up: the tier's next option by session limit, else the next tier's first option, else contact sales (null without a contract tier). */
export function nextStepUp(sub: BillingSubscription, tiers: PlanTier[]): PlanTarget | null {
  const at = tiers.findIndex((t) => t.tierId === sub.tierId)
  const same = at >= 0 ? tiers[at]!.options.find((o) => o.sessionLimit > sub.sessionLimit && o.purchasable) : undefined
  if (same) return { tierId: same.tierId, optionId: same.optionId }
  for (const tier of tiers.slice(at + 1)) {
    if (tier.salesMode === 'contact_sales') return { tierId: tier.tierId, optionId: null }
    const first = tier.options.find((o) => o.purchasable && o.sessionLimit >= sub.sessionLimit)
    if (first) return { tierId: first.tierId, optionId: first.optionId }
  }
  return null
}

/** The plan catalog, read for owners only: nothing else on the page needs it. */
export function usePlanCatalog(orgId: string | null) {
  return useSWR(orgId ? consoleKeys.billingPlans(orgId) : null, () => fetchBillingPlans(orgId!))
}
export type PlanCatalog = ReturnType<typeof usePlanCatalog>

export interface IncreaseLimit {
  /** Null at the top of the catalog: the entry is "Need more?" and leads to contact sales. */
  next: PlanTarget | null
  /** The link under the sessions meter. */
  title: string
  /** The immediate charge the service quoted, or contact sales; null when there is nothing to preview. */
  sub: string | null
  /** The limit banner's CTA; null at the top of the catalog, where the design offers none. */
  bannerLabel: string | null
  /** What the dialog opens on. */
  open: PlanTarget
}

/** The Increase-limit entry: the next step up, previewing the charge when the service can quote it. */
export function useIncreaseLimit(
  orgId: string | null,
  sub: BillingSubscription | null | undefined,
  plans: BillingPlans | undefined
): IncreaseLimit | null {
  const t = useTranslations('Billing.plan.increase')
  const tiers = plans ? planTiers(plans) : []
  const next = sub && plans ? nextStepUp(sub, tiers) : null
  const option = next?.optionId
    ? plans?.options.find((o) => o.tierId === next.tierId && o.optionId === next.optionId)
    : undefined
  // A quote past a schedule moves the provider subscription and back, so this passive preview asks only with nothing scheduled or in flight.
  const quotable =
    !!orgId &&
    !!sub &&
    !!option &&
    !sub.scheduled &&
    !sub.pendingChange &&
    !sub.trialEndsAt &&
    changePath(sub, option) === 'immediate'
  const quote = useSWR(
    quotable ? consoleKeys.billingUpgradeQuote(orgId, option.tierId, option.optionId) : null,
    () => quoteBillingUpgrade(orgId!, { tierId: option!.tierId, optionId: option!.optionId }),
    { revalidateOnFocus: false, revalidateOnReconnect: false, revalidateIfStale: false, shouldRetryOnError: false }
  )
  if (!orgId || !sub || !plans) return null
  if (next && !next.optionId) return { next, title: t('more'), sub: t('contactSales'), bannerLabel: null, open: next }
  if (!next) {
    const contract = tiers.find((x) => x.salesMode === 'contact_sales')
    const open = contract ? { tierId: contract.tierId, optionId: null } : { tierId: sub.tierId, optionId: sub.optionId }
    return { next: null, title: t('more'), sub: t('contactSales'), bannerLabel: null, open }
  }
  const nextTier = tiers.find((x) => x.tierId === next.tierId)
  const trialDays = trialOffer(sub, option)
  return {
    next,
    title: trialDays ? t('tryFree', { tier: nextTier?.tierName ?? next.tierId, days: trialDays }) : t('title'),
    sub: quotable && quote.data ? t('today', { amount: fmtMicroUsd(quote.data.amountCents * 10_000) }) : null,
    bannerLabel: sub.tierId === FREE_TIER_ID ? t('upgradeTo', { tier: nextTier?.tierName ?? next.tierId }) : t('title'),
    open: next
  }
}

/** Free-trial days the service offers this org on `o` now; null ⇒ no trial entry (an older service sends none). */
export function trialOffer(sub: BillingSubscription, o: BillingPlanOption | undefined): number | null {
  return sub.tierId === FREE_TIER_ID && o?.purchasable && o.trialDays ? o.trialDays : null
}

// A trial checkout's id, kept across the hosted page so the return reads as a trial before the plan reread lands.
const TRIAL_CHECKOUT_KEY = 'ac.billing.trialCheckout'
function markTrialCheckout(id: string) {
  try {
    sessionStorage.setItem(TRIAL_CHECKOUT_KEY, id)
  } catch {}
}
function isTrialCheckout(id: string): boolean {
  try {
    return sessionStorage.getItem(TRIAL_CHECKOUT_KEY) === id
  } catch {
    return false
  }
}

/** Where the dialog starts: on a plan to choose (or straight at its review), or on a checkout the browser just came back from. */
export type ChangePlanStart = { target: PlanTarget; review?: boolean } | { changeId: string }

type Step = 'choose' | 'review' | 'paying' | 'done'
/** How a paid option is taken: a free trial from Free, or a switch at the trial's end; null is the plain path. */
type Via = 'trial' | 'switch' | null
type Outcome = { kind: 'stalled' } | { kind: 'expired' } | { kind: 'error'; message: string }

// Cents as dollars and cents, the way the review rows print money. Display only.
const usd = (cents: number) => fmtMicroUsd(cents * 10_000)

const CHOICE =
  'group min-w-0 cursor-pointer border border-(--border-default) bg-(--surface-card) text-left transition-colors hover:border-(--border-strong) focus-visible:shadow-(--focus-ring) focus-visible:outline-none aria-pressed:border-(--border-strong) aria-pressed:bg-(--surface-hover)'
const DETAIL_ROW =
  'flex items-baseline justify-between gap-3 border-b border-(--border-subtle) px-3.5 py-2.5 text-[13px] leading-5 last:border-b-0'
const NOTE = {
  info: 'mt-2 flex items-start gap-[9px] rounded-md border border-(--border-subtle) bg-(--surface-sunken) px-3 py-2.5 font-sans text-[12px] font-normal leading-[1.6] text-(--text-secondary)',
  warn: 'mt-2 flex items-start gap-[9px] rounded-md border border-(--amber-500) bg-(--status-paused-soft) px-3 py-2.5 font-sans text-[12px] font-normal leading-[1.6] text-(--text-primary)'
} as const

const TIER_BADGE = 'rounded-full px-1.5 text-[11px] leading-4 font-medium'

function ChoiceMark() {
  return (
    <span
      aria-hidden="true"
      className="flex size-4 flex-none items-center justify-center rounded-full border border-(--border-strong) text-transparent group-aria-pressed:border-(--brand) group-aria-pressed:bg-(--brand) group-aria-pressed:text-white"
    >
      <Icon name="check" size={10} strokeWidth={2.5} />
    </span>
  )
}

function Note({
  warn = false,
  icon = 'info',
  title,
  children
}: {
  warn?: boolean
  icon?: string
  title?: string
  children: string
}) {
  return (
    <div className={warn ? NOTE.warn : NOTE.info} data-plan-note={warn ? 'warn' : 'info'}>
      <Icon name={icon} size={14} className="mt-0.5 flex-none" />
      <span className="min-w-0 flex-1">
        {title && <strong className="block font-semibold">{title}</strong>}
        {children}
      </span>
    </div>
  )
}

function InlineError({ text }: { text: string }) {
  return (
    <div role="alert" className="mt-3 flex items-start gap-2 font-sans text-[12px] text-(--status-error)">
      <Icon name="triangle-exclamation-point" size={14} className="mt-0.5 flex-none" />
      <span className="min-w-0 flex-1">{text}</span>
    </div>
  )
}

/** The Change plan dialog. The client sends only tier and option ids; every amount and date it shows is the service's. */
export function ChangePlanDialog({
  orgId,
  sub,
  catalog,
  start,
  returnPath,
  onClose,
  onChanged
}: {
  orgId: string
  sub: BillingSubscription
  catalog: PlanCatalog
  start: ChangePlanStart
  returnPath: string
  onClose: () => void
  onChanged: () => void
}) {
  const t = useTranslations('Billing.plan.change')
  const titleId = useId()
  const { day, number } = useUtcDates()
  const plans = catalog.data
  const tiers = plans ? planTiers(plans) : []
  const [step, setStep] = useState<Step>('changeId' in start ? 'paying' : start.review ? 'review' : 'choose')
  const [via, setVia] = useState<Via>(null)
  const [trialCheckout] = useState(() => 'changeId' in start && isTrialCheckout(start.changeId))
  const [target, setTarget] = useState<PlanTarget>(
    'target' in start ? start.target : { tierId: sub.tierId, optionId: sub.optionId }
  )
  const [quote, setQuote] = useState<{ quote: BillingUpgradeQuote; key: string } | null>(null)
  const [refreshed, setRefreshed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [change, setChange] = useState<BillingSubscriptionChange | null>(null)
  const [poll, setPoll] = useState<{ id: string; attempt: number; now: boolean } | null>(
    'changeId' in start ? { id: start.changeId, attempt: 1, now: true } : null
  )
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const quoteSeq = useRef(0)
  const selectedTierCard = useRef<HTMLButtonElement>(null)
  const changed = useRef(onChanged)
  changed.current = onChanged

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const settle = (c: BillingSubscriptionChange, attempt: number) => {
    setChange(c)
    if (c.status === 'completed') {
      setPoll(null)
      changed.current()
      setStep('done')
    } else if (c.status === 'expired') {
      setPoll(null)
      setOutcome({ kind: 'expired' })
    } else if (attempt >= POLL_MAX_ATTEMPTS) {
      setPoll(null)
      setOutcome({ kind: 'stalled' })
    } else setPoll({ id: c.id, attempt: attempt + 1, now: false })
  }
  const settleRef = useRef(settle)
  settleRef.current = settle

  // Polls the change until the service says it settled; the return redirect and the confirm response are not proof.
  useEffect(() => {
    if (!poll) return
    let live = true
    const timer = setTimeout(
      async () => {
        try {
          const c = await fetchBillingSubscriptionChange(orgId, poll.id)
          if (live) settleRef.current(c, poll.attempt)
        } catch (e) {
          if (!live) return
          const permanent =
            e instanceof BillingShapeError || (e instanceof BillingError && e.status >= 400 && e.status < 500)
          if (!permanent && poll.attempt < POLL_MAX_ATTEMPTS)
            setPoll({ id: poll.id, attempt: poll.attempt + 1, now: false })
          else {
            setPoll(null)
            setOutcome({ kind: 'error', message: (e as Error).message })
          }
        }
      },
      poll.now ? 0 : POLL_INTERVAL_MS
    )
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [orgId, poll])

  const tier = tiers.find((x) => x.tierId === target.tierId)
  const option = target.optionId
    ? plans?.options.find((o) => o.tierId === target.tierId && o.optionId === target.optionId)
    : undefined
  const contact = tier?.salesMode === 'contact_sales'
  const visibleTier = plans && !catalog.error ? tier?.tierId : undefined
  useEffect(() => {
    if (step === 'choose' && visibleTier) selectedTierCard.current?.scrollIntoView({ block: 'nearest' })
  }, [step, visibleTier])

  // In a trial every paid option is paid now or switched to at its end, the current one included; Free cancels it.
  const trialEndsAt = sub.trialEndsAt ?? null
  const trialCancelled = !!trialEndsAt && sub.scheduled?.tierId === FREE_TIER_ID
  const pathFor = (v: Via): ChangePath | null =>
    !option
      ? null
      : trialEndsAt
        ? option.tierId === FREE_TIER_ID || v === 'switch'
          ? 'scheduled'
          : 'immediate'
        : changePath(sub, option)
  const path = pathFor(via)
  const same = !!option && isCurrent(sub, option)
  const trialDays = trialOffer(sub, option)
  const trialEnd = trialEndsAt ? day(trialEndsAt) : ''
  const retentionWarning = (target: BillingPlanOption, effectiveAt: string | null) => {
    const days = target.retentionDays
    const keptDays = sub.retention ? sub.retention.days : sub.retentionDays
    if (effectiveAt === null || days === null || (keptDays !== null && days >= keptDays)) return null
    // Older services omit the hold, so fall back to the new retention window.
    const holdDays = sub.retention?.shortenHoldDays ?? days
    return {
      days,
      date: day(new Date(Date.parse(effectiveAt) + holdDays * DAY_MS).toISOString())
    }
  }
  const combo = (label: string, sessions: number) => t('combo', { plan: label, sessions: number(sessions) })
  const toLabel = option ? combo(planLabel(option), option.sessionLimit) : ''
  const support = helpSupportUrl()
  // A contract is priced outside the console and its tier is not in the catalog, so changes go through sales.
  const onContract = sub.priceCents === null
  const contactLink = (
    <a
      className="dsbtn sm dsbtn-primary no-underline"
      href={support}
      target={support.startsWith('https://') ? '_blank' : undefined}
      rel="noopener noreferrer"
    >
      {t('contactUs')}
    </a>
  )

  const requestQuote = async (again: boolean) => {
    if (!option) return
    const seq = ++quoteSeq.current
    setQuote(null)
    setError(null)
    setRefreshed(again)
    try {
      const q = await quoteBillingUpgrade(orgId, { tierId: option.tierId, optionId: option.optionId })
      if (seq === quoteSeq.current) setQuote({ quote: q, key: crypto.randomUUID() })
    } catch (e) {
      if (seq === quoteSeq.current) setError((e as Error).message)
    }
  }

  const pickTier = (x: PlanTier) => {
    if (x.tierId === target.tierId && (option || contact)) return
    if (x.salesMode === 'contact_sales') return setTarget({ tierId: x.tierId, optionId: null })
    const keep = x.options.find((o) => isCurrent(sub, o)) ?? x.options[0]!
    setTarget({ tierId: x.tierId, optionId: keep.optionId })
  }

  const toReview = (v: Via = null) => {
    if (!option || (same && !trialEndsAt)) return
    setVia(v)
    setError(null)
    setRefreshed(false)
    setStep('review')
    if (pathFor(v) === 'immediate') void requestQuote(false)
  }

  const back = () => {
    quoteSeq.current++
    setError(null)
    setStep('choose')
  }

  const confirm = async () => {
    if (!option || busy) return
    setError(null)
    if (path === 'checkout') {
      setBusy(true)
      try {
        const trial = via === 'trial'
        const { changeId, url } = await createBillingSubscriptionCheckout(orgId, {
          tierId: option.tierId,
          optionId: option.optionId,
          idempotencyKey: crypto.randomUUID(),
          returnPath,
          trial
        })
        if (trial) markTrialCheckout(changeId)
        window.location.assign(url)
        // `busy` stays: the page is navigating away.
      } catch (e) {
        setError((e as Error).message)
        setBusy(false)
      }
      return
    }
    if (path === 'scheduled') {
      setBusy(true)
      try {
        await scheduleBillingChange(orgId, { tierId: option.tierId, optionId: option.optionId })
        changed.current()
        // Cancelling a trial needs no result step: the Plan card's strip says what happens next.
        if (trialEndsAt && option.tierId === FREE_TIER_ID) return onClose()
        setStep('done')
      } catch (e) {
        setError((e as Error).message)
      }
      setBusy(false)
      return
    }
    if (!quote) return
    // A lapsed quote is previewed again rather than sent to be refused.
    if (Date.parse(quote.quote.expiresAt) <= Date.now()) return void requestQuote(true)
    setStep('paying')
    setOutcome(null)
    try {
      settle(await confirmBillingUpgrade(orgId, { quoteId: quote.quote.quoteId, idempotencyKey: quote.key }), 0)
    } catch (e) {
      setStep('review')
      // A stale quote or plan revision: re-preview, and the owner pays the fresh amount.
      if (e instanceof BillingError && (e.status === 409 || e.status === 404)) void requestQuote(true)
      else setError((e as Error).message)
    }
  }

  const close = (
    <button className="iconbtn border-0" onClick={onClose} aria-label={t('close')}>
      <Icon name="x" size={16} />
    </button>
  )

  let body: ReactNode = null
  if (step === 'choose' && onContract) {
    const rows = [
      { k: t('sessionsPerMonth'), v: number(sub.sessionLimit) },
      ...(sub.paidThrough ? [{ k: t('contract.ends'), v: day(sub.paidThrough) }] : [])
    ]
    body = (
      <>
        <div className="modalhead">
          <h2 id={titleId} className="cardtitle flex-1">
            {t('title')}
          </h2>
          {close}
        </div>
        <div className="modalbody" data-plan-contract="true">
          <div className="rounded-md border border-(--border-subtle) bg-(--surface-app) px-4 pt-3 pb-1">
            <span className="eyebrow block">{t('current')}</span>
            <span className="mt-1 flex items-center gap-2">
              <span className="font-sans text-[15px] font-semibold leading-normal">{planLabel(sub)}</span>
              <span className="badge bg-(--surface-active) text-(--text-secondary)">{t('contract.badge')}</span>
            </span>
            <div className="mt-2">
              {rows.map((r) => (
                <div
                  key={r.k}
                  className="flex items-baseline justify-between gap-3 border-t border-(--border-subtle) py-[9px] font-sans text-[12.5px] font-normal leading-normal text-(--text-secondary)"
                >
                  <span>{r.k}</span>
                  <span className="mono text-right text-[12.5px] font-semibold text-(--text-primary)">{r.v}</span>
                </div>
              ))}
            </div>
          </div>
          <p className="mt-3 font-sans text-[12.5px] font-normal leading-[1.6] text-(--text-secondary)">
            {t('contract.body')}
          </p>
        </div>
        <div className="modalfoot">
          <span className="flex-1" />
          <Button size="sm" variant="secondary" onClick={onClose}>
            {t('cancel')}
          </Button>
          {contactLink}
        </div>
      </>
    )
  } else if (step === 'choose') {
    const range = (values: number[], fmt: (n: number) => string) => {
      const min = Math.min(...values)
      const max = Math.max(...values)
      return min === max ? fmt(min) : `${fmt(min)}–${fmt(max)}`
    }
    const compact = (n: number) => number(n, { notation: 'compact' })
    const creditText = (grants: number[]) =>
      Math.max(...grants) === 0 ? t('topUpsOnly') : t('credits', { amount: range(grants, (g) => fmtCents(g / 10_000)) })
    const historyText = (days: number | null) => (days === null ? t('historyUnlimited') : t('historyDays', { days }))
    const catalogReady = !!plans && !catalog.error
    const paused = catalogReady && salesPaused(plans)

    body = (
      <>
        <div className="modalhead shrink-0">
          <h2 id={titleId} className="flex-1 text-[17px] leading-normal font-semibold">
            {t('title')}
          </h2>
          {close}
        </div>
        <div className="modalbody min-h-0 overscroll-contain max-desktop:p-4">
          {paused && (
            <div className="mb-3" data-plan-sales-paused="true">
              <Note icon="circle-pause">{t(sub.tierId === FREE_TIER_ID ? 'salesPausedFree' : 'salesPaused')}</Note>
            </div>
          )}
          {catalog.error ? (
            <InlineError text={t('loadError', { error: (catalog.error as Error).message })} />
          ) : !catalogReady ? (
            <div className="h-[220px] animate-pulse rounded-lg bg-(--surface-sunken)" />
          ) : (
            <div role="group" aria-label={t('title')} className="grid grid-cols-2 gap-3 desktop:grid-cols-4">
              {tiers.map((x) => {
                const custom = x.salesMode === 'contact_sales'
                const current = x.options.some((o) => isCurrent(sub, o))
                const offer = x.options.map((o) => trialOffer(sub, o)).find((d) => d !== null)
                const prices = x.options.map((o) => o.priceCents ?? 0)
                const minimum = Math.min(...prices)
                const price = fmtCents(minimum)
                const amount = (value: ReactNode) => (
                  <b className="text-[24px] leading-none font-semibold tracking-tight text-(--text-primary) tabular-nums">
                    {value}
                  </b>
                )
                return (
                  <button
                    key={x.tierId}
                    type="button"
                    data-plan-tier={x.tierId}
                    aria-pressed={x.tierId === target.tierId}
                    ref={x.tierId === target.tierId ? selectedTierCard : undefined}
                    className={`${CHOICE} flex flex-col gap-3 rounded-lg p-3 desktop:p-4`}
                    onClick={() => pickTier(x)}
                  >
                    <span className="flex w-full items-start justify-between gap-2">
                      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="text-[14px] leading-4 font-semibold [overflow-wrap:anywhere]">
                          {x.tierName}
                        </span>
                        {current && trialEndsAt ? (
                          <span className={`${TIER_BADGE} bg-(--brand-soft) text-(--brand-soft-text)`}>
                            {t('trial.badge')}
                          </span>
                        ) : current ? (
                          <span className={`${TIER_BADGE} bg-(--surface-active) text-(--text-secondary)`}>
                            {t('current')}
                          </span>
                        ) : null}
                        {offer && (
                          <span
                            data-plan-trial-offer={offer}
                            className={`${TIER_BADGE} bg-(--brand-soft) text-(--brand-soft-text)`}
                          >
                            {t('trial.offer', { days: offer })}
                          </span>
                        )}
                        {paused && x.options.some(paidSelfServe) && (
                          <span className="rounded-full bg-(--status-paused-soft) px-1.5 text-[11px] leading-4 font-medium text-(--text-secondary)">
                            {t('paused')}
                          </span>
                        )}
                      </span>
                      <ChoiceMark />
                    </span>
                    <span className="flex flex-wrap items-baseline gap-x-1.5 gap-y-1 text-[11px] leading-normal text-(--text-secondary)">
                      {custom ? (
                        <b className="text-[19px] leading-none font-semibold text-(--text-primary)">{t('custom')}</b>
                      ) : prices.every((p) => p === minimum) ? (
                        amount(price)
                      ) : (
                        <span className="whitespace-nowrap">{t.rich('from', { price, amount })}</span>
                      )}
                      <span className="whitespace-nowrap">{custom ? t('byContract') : t('perMonth')}</span>
                    </span>
                    <span className="mt-auto text-[12px] leading-4 font-medium text-(--text-secondary)">
                      {custom
                        ? t('customSessions')
                        : t('sessions', {
                            sessions: range(
                              x.options.map((o) => o.sessionLimit),
                              compact
                            )
                          })}
                    </span>
                    <span className="grid w-full gap-1 border-t border-(--border-subtle) pt-2 text-[11px] leading-4 text-(--text-secondary)">
                      <span>{custom ? t('customCredits') : creditText(x.options.map((o) => o.grantMicro))}</span>
                      <span>{custom ? t('orgSso') : historyText(x.options[0]!.retentionDays)}</span>
                    </span>
                  </button>
                )
              })}
            </div>
          )}
        </div>
        {catalogReady && contact && (
          <div className="px-4 pb-4 desktop:px-5">
            <Note icon="mail">{t('contactNote')}</Note>
          </div>
        )}
        {catalogReady && tier && option && (
          <div className="max-h-[30dvh] shrink-0 overflow-y-auto overscroll-contain border-t border-(--border-subtle) bg-(--surface-app) px-4 py-3 desktop:px-5">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <h3 className="text-[13px] leading-4 font-semibold">{t('details', { plan: tier.tierName })}</h3>
              <span className="text-[12px] leading-4 text-(--text-secondary)">
                {t('detailSummary', {
                  credits: creditText([option.grantMicro]),
                  history: historyText(option.retentionDays)
                })}
              </span>
            </div>
            {tier.options.length > 1 && (
              <div
                role="group"
                aria-label={t('sessionsPerMonth')}
                className="-mx-1 mt-1 grid grid-cols-1 gap-2 p-1 desktop:grid-cols-[repeat(auto-fit,minmax(min(100%,164px),1fr))]"
              >
                {tier.options.map((o) => {
                  const meta = t('optionMeta', { price: fmtCents(o.priceCents ?? 0) })
                  return (
                    <button
                      key={o.optionId}
                      type="button"
                      data-plan-option={o.optionId}
                      aria-pressed={o.optionId === target.optionId}
                      className={`${CHOICE} flex min-h-11 flex-wrap items-center gap-x-2 gap-y-1 rounded-md px-3 py-2`}
                      onClick={() => setTarget({ tierId: o.tierId, optionId: o.optionId })}
                    >
                      <ChoiceMark />
                      <span className="text-[13px] leading-4 font-semibold tabular-nums">
                        {t('sessions', { sessions: number(o.sessionLimit) })}
                      </span>
                      <span className="ml-auto text-[12px] leading-4 text-(--text-secondary)">
                        {isCurrent(sub, o) ? t('optionCurrent', { meta }) : meta}
                      </span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )}
        <div className="modalfoot shrink-0 flex-wrap justify-end gap-y-2 max-desktop:px-4 max-desktop:py-3">
          {catalogReady && (option || contact) && (
            <div role="status" className="min-w-0 flex-1 max-desktop:basis-full">
              <span className="block text-[11px] leading-4 text-(--text-secondary)">
                {trialDays && option
                  ? t('trial.terms', { days: trialDays, price: fmtCents(option.priceCents ?? 0) })
                  : t(same ? 'currentPlan' : 'selectedPlan')}
              </span>
              <span className="block text-[13px] leading-5 font-medium [overflow-wrap:anywhere]">
                {contact ? tier?.tierName : toLabel}
              </span>
            </div>
          )}
          <Button size="sm" variant="secondary" onClick={onClose}>
            {t('cancel')}
          </Button>
          {contact ? (
            contactLink
          ) : trialEndsAt && option?.tierId === FREE_TIER_ID ? (
            <Button size="sm" disabled={trialCancelled} onClick={() => toReview()}>
              {t('trial.cancel')}
            </Button>
          ) : trialEndsAt ? (
            <>
              {option && !same && !trialCancelled && sellable(option) && (
                <Button size="sm" variant="secondary" onClick={() => toReview('switch')}>
                  {t('trial.switchOn', { date: trialEnd })}
                </Button>
              )}
              <Button size="sm" disabled={!option || !sellable(option)} onClick={() => toReview()}>
                {t('trial.payNow')}
              </Button>
            </>
          ) : trialDays ? (
            <>
              <Button size="sm" variant="secondary" onClick={() => toReview()}>
                {t('trial.subscribeNow')}
              </Button>
              <Button size="sm" onClick={() => toReview('trial')}>
                {t('trial.start')}
              </Button>
            </>
          ) : (
            <Button size="sm" disabled={!option || same || !sellable(option)} onClick={() => toReview()}>
              {t('reviewChange')}
              <Icon name="arrow-right" size={14} />
            </Button>
          )}
        </div>
      </>
    )
  } else if (step === 'review' && option && path === 'scheduled' && trialEndsAt && option.tierId === FREE_TIER_ID) {
    const history = retentionWarning(option, trialEndsAt)
    body = (
      <>
        <div className="modalhead shrink-0">
          <h2 id={titleId} className="flex-1 text-[17px] leading-normal font-semibold">
            {t('trial.cancelTitle')}
          </h2>
          {close}
        </div>
        <div className="modalbody grid min-h-0 gap-3.5 overscroll-contain max-desktop:p-4" data-plan-review={path}>
          <p className="text-[14px] leading-5">
            {t.rich('trial.cancelSummary', {
              plan: planLabel(sub),
              date: trialEnd,
              free: planLabel(option),
              strong: (value) => <strong className="font-semibold">{value}</strong>
            })}
          </p>
          <dl className="border-y border-(--border-subtle)">
            <div
              data-quote-row="true"
              className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 py-2.5 text-[13px] leading-5"
            >
              <dt className="text-(--text-secondary)">{t('trial.monthlyLimit')}</dt>
              <dd className="font-medium whitespace-nowrap tabular-nums">
                {sub.sessionLimit !== option.sessionLimit && (
                  <span className="text-(--text-secondary)">{number(sub.sessionLimit)} → </span>
                )}
                <strong className="font-semibold">{number(option.sessionLimit)}</strong>
              </dd>
            </div>
          </dl>
          {history && (
            <Note warn icon="triangle-exclamation-point" title={t('trial.historyRetention')}>
              {t('trial.historyWarning', history)}
            </Note>
          )}
          <p className="text-[13px] leading-5 text-(--text-secondary)">{t('trial.cancelNote', { date: trialEnd })}</p>
          {error && <InlineError text={error} />}
        </div>
        <div className="modalfoot flex-wrap shrink-0 justify-end max-desktop:px-4">
          <Button size="sm" variant="secondary" disabled={busy} onClick={onClose}>
            {t('trial.keep')}
          </Button>
          <Button size="sm" disabled={busy} onClick={() => void confirm()}>
            {t('trial.confirmCancel')}
          </Button>
        </div>
      </>
    )
  } else if (step === 'review' && option && path) {
    const now = path !== 'scheduled'
    const paidThrough = path === 'immediate' ? (quote?.quote.paidThrough ?? sub.paidThrough) : sub.paidThrough
    const when = paidThrough ? day(paidThrough) : t('review.atRenewal')
    const sessions = {
      k: t('sessionsPerMonth'),
      v:
        sub.sessionLimit === option.sessionLimit
          ? number(option.sessionLimit)
          : `${number(sub.sessionLimit)} → ${number(option.sessionLimit)}`
    }
    const price = option.priceCents ?? 0
    const startTrial = path === 'checkout' && via === 'trial' && !!trialDays
    const payNow = path === 'immediate' && !!quote?.quote.endsTrial
    const switchAtEnd = !!trialEndsAt && path === 'scheduled'
    const due = startTrial ? 0 : path === 'checkout' ? price : path === 'scheduled' ? 0 : quote?.quote.amountCents
    const creditsAdded = (grant: number) => (grant > 0 ? `+${fmtMicroUsd(grant)}` : fmtMicroUsd(0))
    const monthlyPrice = t('optionMeta', { price: usd(price) })
    const forfeit = quote?.quote.forfeitMicro
    let rows: { k: string; v: string }[] | null
    // The trial's length is the service's; it ends that many days after the card is saved, so today's count is an estimate.
    if (startTrial)
      rows = [
        { k: t('trial.ends'), v: day(new Date(Date.now() + trialDays * DAY_MS).toISOString()) },
        ...(option.trialGrantMicro ? [{ k: t('trial.credits'), v: creditsAdded(option.trialGrantMicro) }] : []),
        { k: t('trial.then'), v: monthlyPrice }
      ]
    else if (payNow)
      rows = [
        { k: t('trial.label'), v: t('trial.endsNow') },
        ...(forfeit != null ? [{ k: t('trial.forfeit'), v: `−${fmtMicroUsd(forfeit)}` }] : []),
        { k: t('review.nextCharge'), v: t('review.nextChargeValue', { date: when, price: usd(price) }) }
      ]
    else if (switchAtEnd)
      rows = [
        { k: t('review.takesEffect'), v: t('trial.atEnd', { date: trialEnd }) },
        { k: t('trial.firstCharge'), v: t('review.nextChargeValue', { date: trialEnd, price: usd(price) }) },
        sessions
      ]
    else if (path === 'checkout')
      rows = [
        { k: t('review.monthlyRenewal'), v: monthlyPrice },
        sessions,
        { k: t('review.creditsAdded'), v: creditsAdded(option.grantMicro) }
      ]
    else if (path === 'immediate')
      rows = quote
        ? [
            { k: t('review.nextCharge'), v: t('review.nextChargeValue', { date: when, price: usd(price) }) },
            sessions,
            { k: t('review.creditsAdded'), v: creditsAdded(quote.quote.grantMicro) }
          ]
        : null
    else
      rows = [
        { k: t('review.takesEffect'), v: when },
        sessions,
        ...(option.tierId === FREE_TIER_ID ? [] : [{ k: t('review.monthlyRenewal'), v: monthlyPrice }])
      ]
    const history = now ? null : retentionWarning(option, sub.paidThrough)
    const retry = path === 'immediate' && !quote && !!error
    const cta = startTrial
      ? t('trial.addCard')
      : path === 'scheduled'
        ? t('review.schedule')
        : path === 'checkout'
          ? t('review.pay', { amount: usd(price) })
          : quote
            ? t('review.pay', { amount: usd(quote.quote.amountCents) })
            : t('review.quoting')
    body = (
      <>
        <div className="modalhead shrink-0">
          <h2 id={titleId} className="flex-1 text-[17px] leading-normal font-semibold">
            {startTrial
              ? t('trial.start')
              : payNow
                ? t('trial.payNow')
                : switchAtEnd
                  ? t('trial.switchTitle')
                  : now
                    ? t('review.upgrade')
                    : t('review.scheduleTitle')}
          </h2>
          {close}
        </div>
        <div className="modalbody min-h-0 overscroll-contain max-desktop:p-4" data-plan-review={path}>
          <div className="mb-4 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] gap-2 rounded-lg border border-(--border-subtle) p-2">
            <dl className="px-2 py-1.5">
              <dt className="text-[12px] leading-4 text-(--text-secondary)">{t('currentPlan')}</dt>
              <dd className="mt-1 text-[14px] leading-5 font-medium [overflow-wrap:anywhere]">
                {trialEndsAt ? t('trial.current', { plan: planLabel(sub) }) : planLabel(sub)}
              </dd>
            </dl>
            <Icon name="arrow-right" size={16} color="var(--text-tertiary)" className="self-center" />
            <dl className="rounded-sm bg-(--surface-app) px-2 py-1.5">
              <dt className="text-[12px] leading-4 text-(--text-secondary)">{t('review.newPlan')}</dt>
              <dd className="mt-1 text-[14px] leading-5 font-semibold [overflow-wrap:anywhere]">{planLabel(option)}</dd>
            </dl>
          </div>
          {rows && due !== undefined ? (
            <dl className="overflow-hidden rounded-lg border border-(--border-subtle)">
              <div
                data-quote-row="true"
                className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-(--border-subtle) bg-(--surface-app) px-3.5 py-3"
              >
                <dt className="text-[13px] leading-5 font-semibold">{t('review.dueToday')}</dt>
                <dd className="ml-auto text-right">
                  <span className="text-[26px] leading-none font-semibold tracking-tight tabular-nums">{usd(due)}</span>
                  {path === 'immediate' && !payNow && (
                    <span className="block text-[11px] leading-4 text-(--text-secondary)">{t('review.prorated')}</span>
                  )}
                </dd>
              </div>
              {rows.map((r) => (
                <div key={r.k} data-quote-row="true" className={DETAIL_ROW}>
                  <dt className="text-(--text-secondary)">{r.k}</dt>
                  <dd className="min-w-0 text-right font-medium tabular-nums [overflow-wrap:anywhere]">{r.v}</dd>
                </div>
              ))}
            </dl>
          ) : (
            !error && (
              <div className="h-[150px] animate-pulse rounded-md bg-(--surface-sunken)" data-plan-quoting="true" />
            )
          )}
          {refreshed && quote && <Note warn>{t('review.refreshed')}</Note>}
          {history && <Note warn>{t('review.historyWarning', history)}</Note>}
          {payNow && quote.quote.grantMicro > 0 && (
            <Note>{t('trial.includes', { amount: fmtMicroUsd(quote.quote.grantMicro) })}</Note>
          )}
          {path === 'immediate' && sub.scheduled && (
            <Note warn>
              {trialEndsAt
                ? sub.scheduled.tierId === FREE_TIER_ID
                  ? t('trial.replacesCancel')
                  : t('trial.replacesScheduled', { plan: planLabel(sub.scheduled) })
                : sub.scheduled.tierId === FREE_TIER_ID
                  ? t('review.replacesCancel', { date: when })
                  : t('review.replacesScheduled', { plan: planLabel(sub.scheduled), date: when })}
            </Note>
          )}
          {startTrial && <Note>{t('trial.cardNote', { date: rows![0]!.v })}</Note>}
          {!now && <Note>{t('review.cancelBefore', { date: when })}</Note>}
          {error && <InlineError text={error} />}
        </div>
        <div className="modalfoot shrink-0 justify-end max-desktop:px-4">
          <Button size="sm" variant="secondary" onClick={back}>
            {t('back')}
          </Button>
          {retry ? (
            <Button size="sm" onClick={() => void requestQuote(false)}>
              {t('review.retry')}
            </Button>
          ) : (
            <Button size="sm" disabled={busy || (path === 'immediate' && !quote)} onClick={() => void confirm()}>
              {cta}
            </Button>
          )}
        </div>
      </>
    )
  } else if (step === 'paying') {
    const title =
      outcome?.kind === 'stalled'
        ? t('paying.stalledTitle')
        : outcome?.kind === 'expired'
          ? t('paying.expiredTitle')
          : outcome?.kind === 'error'
            ? t('paying.errorTitle')
            : trialCheckout
              ? t('trial.confirmingCard')
              : t('paying.title')
    const text =
      outcome?.kind === 'stalled'
        ? t('paying.stalledText')
        : outcome?.kind === 'expired'
          ? t('paying.expiredText')
          : outcome?.kind === 'error'
            ? outcome.message
            : null
    const payUrl = !outcome && change?.status === 'pending' ? change.payUrl : null
    body = (
      <>
        <div className="modalbody px-7 py-10 text-center" data-plan-paying={outcome?.kind ?? 'confirming'}>
          {outcome ? (
            <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-[11px] border border-(--amber-500) bg-(--status-paused-soft) text-(--amber-500)">
              <Icon name={outcome.kind === 'stalled' ? 'clock' : 'triangle-exclamation-point'} size={21} />
            </span>
          ) : (
            <Icon name="loader-circle" size={26} color="var(--brand)" className="mx-auto animate-spin" />
          )}
          <h2 id={titleId} className="mt-3.5 font-sans text-[15px] leading-normal font-semibold">
            {title}
          </h2>
          {text && (
            <div className="mx-auto mt-1.5 max-w-[400px] font-sans text-[12.5px] font-normal leading-[1.65] text-(--text-secondary)">
              {text}
            </div>
          )}
          {payUrl && (
            <>
              <div className="mx-auto mt-1.5 max-w-[400px] font-sans text-[12.5px] font-normal leading-[1.65] text-(--text-secondary)">
                {t('paying.action')}
              </div>
              <a className="lnk mx-auto mt-3 flex w-fit" href={payUrl} target="_blank" rel="noopener noreferrer">
                {t('paying.pay')}
                <Icon name="arrow-up-right" size={12} />
              </a>
            </>
          )}
        </div>
        {outcome && (
          <div className="modalfoot">
            <span className="flex-1" />
            <Button size="sm" variant="secondary" onClick={onClose}>
              {t('close')}
            </Button>
          </div>
        )}
      </>
    )
  } else if (step === 'done') {
    // A completed purchase names the active plan, while a scheduled change names its effective date.
    const settled = change
      ? plans?.options.find((o) => o.tierId === change.tierId && o.optionId === change.optionId)
      : option
    const scheduled = !change && path === 'scheduled'
    // A trial grants its own credit, not the plan's; the reread tells whether the card earned it.
    const trialStarted = !!change && !quote && (trialCheckout || !!sub.trialEndsAt)
    const credits = trialStarted ? 0 : change && quote ? quote.quote.grantMicro : (settled?.grantMicro ?? 0)
    const active = settled ? planLabel(settled) : change?.tierId
    const title = scheduled
      ? sub.paidThrough
        ? t('done.scheduled', { date: day(sub.paidThrough) })
        : t('done.scheduledAtRenewal')
      : trialStarted
        ? t('trial.started')
        : quote?.quote.endsTrial
          ? t('trial.subscribed', { plan: active ?? '' })
          : t('done.upgraded')
    const details = [
      ...(settled && scheduled ? [{ k: t('review.newPlan'), v: planLabel(settled) }] : []),
      ...(settled ? [{ k: t('sessionsPerMonth'), v: number(settled.sessionLimit) }] : []),
      ...(!scheduled && credits > 0 ? [{ k: t('review.creditsAdded'), v: `+${fmtMicroUsd(credits)}` }] : [])
    ]
    body = (
      <>
        <div className="modalbody min-h-0 overscroll-contain max-desktop:p-4" data-plan-done="true">
          <div className="flex items-center gap-3">
            <span
              className={`flex size-10 flex-none items-center justify-center rounded-full ${scheduled ? 'bg-(--surface-active) text-(--text-primary)' : 'bg-(--green-50) text-(--green-500)'}`}
            >
              <Icon name={scheduled ? 'calendar-clock' : 'check'} size={19} strokeWidth={2} />
            </span>
            <div className="min-w-0">
              <h2 id={titleId} className="text-[17px] leading-6 font-semibold">
                {title}
              </h2>
              {!scheduled && active && (
                <p className="text-[12px] leading-4 text-(--text-secondary) [overflow-wrap:anywhere]">
                  {trialStarted && sub.trialEndsAt
                    ? t('trial.until', { plan: active, date: day(sub.trialEndsAt) })
                    : t('done.active', { plan: active })}
                </p>
              )}
            </div>
          </div>
          {details.length > 0 && (
            <dl className="mt-4 overflow-hidden rounded-lg border border-(--border-subtle)">
              {details.map(({ k, v }) => (
                <div key={k} className={DETAIL_ROW}>
                  <dt className="text-(--text-secondary)">{k}</dt>
                  <dd className="min-w-0 text-right font-medium tabular-nums [overflow-wrap:anywhere]">{v}</dd>
                </div>
              ))}
            </dl>
          )}
          {trialStarted && sub.trialCreditGranted === false && <Note warn>{t('trial.noCredit')}</Note>}
        </div>
        <div className="modalfoot shrink-0 justify-end max-desktop:px-4">
          <Button size="sm" onClick={onClose}>
            {t('done.done')}
          </Button>
        </div>
      </>
    )
  }

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className={
          step === 'choose' && !onContract
            ? 'modal max-w-[900px]'
            : step === 'done'
              ? 'modal max-w-[420px]'
              : 'modal max-w-[540px]'
        }
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-plan-dialog={step}
      >
        {body}
      </div>
    </div>
  )
}
