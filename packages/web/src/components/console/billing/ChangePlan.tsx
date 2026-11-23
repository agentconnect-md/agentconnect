'use client'

// The owner's plan actions: the Change plan dialog (choose → review → paying → done) and the catalog step Increase limit opens it on.

import { useEffect, useRef, useState, type ReactNode } from 'react'
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
  // A quote is refused while a change is scheduled or in flight, so only an immediate upgrade from a settled plan asks.
  const quotable =
    !!orgId && !!sub && !!option && !sub.scheduled && !sub.pendingChange && changePath(sub, option) === 'immediate'
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
  return {
    next,
    title: t('title'),
    sub: quotable && quote.data ? t('today', { amount: fmtMicroUsd(quote.data.amountCents * 10_000) }) : null,
    bannerLabel: sub.tierId === FREE_TIER_ID ? t('upgradeTo', { tier: nextTier?.tierName ?? next.tierId }) : t('title'),
    open: next
  }
}

/** Where the dialog starts: on a plan to choose, or on a checkout the browser just came back from. */
export type ChangePlanStart = { target: PlanTarget } | { changeId: string }

type Step = 'choose' | 'review' | 'paying' | 'done'
type Outcome = { kind: 'stalled' } | { kind: 'expired' } | { kind: 'error'; message: string }

// Cents as dollars and cents, the way the review rows print money. Display only.
const usd = (cents: number) => fmtMicroUsd(cents * 10_000)

const TIER_CARD = {
  on: 'flex cursor-pointer flex-col gap-[9px] rounded-[10px] border-[1.5px] border-(--brand) bg-(--brand-soft) p-3.5 text-left',
  off: 'flex cursor-pointer flex-col gap-[9px] rounded-[10px] border border-(--border-default) bg-(--surface-card) p-3.5 text-left transition-colors hover:border-(--border-strong)'
} as const
const OPTION_TILE = {
  on: 'flex-1 cursor-pointer rounded-[9px] border-[1.5px] border-(--brand) bg-(--brand-soft) px-[14px] py-[13px] text-left',
  off: 'flex-1 cursor-pointer rounded-[9px] border border-(--border-default) bg-(--surface-card) px-[14px] py-[13px] text-left transition-colors hover:border-(--border-strong)'
} as const
const NOTE = {
  info: 'mt-2 flex items-start gap-[9px] rounded-md border border-(--border-subtle) bg-(--surface-sunken) px-3 py-2.5 font-sans text-[12px] font-normal leading-[1.6] text-(--text-secondary)',
  warn: 'mt-2 flex items-start gap-[9px] rounded-md border border-(--amber-500) bg-(--status-paused-soft) px-3 py-2.5 font-sans text-[12px] font-normal leading-[1.6] text-(--text-primary)'
} as const

function Feature({ children }: { children: string }) {
  return (
    <span className="flex items-start gap-[7px] font-sans text-[12px] font-normal leading-[1.5] text-(--text-secondary)">
      <Icon name="check" size={12} strokeWidth={2.4} color="var(--text-tertiary)" className="mt-[3px] flex-none" />
      <span>{children}</span>
    </span>
  )
}

function Note({ warn = false, icon = 'info', children }: { warn?: boolean; icon?: string; children: string }) {
  return (
    <div className={warn ? NOTE.warn : NOTE.info} data-plan-note={warn ? 'warn' : 'info'}>
      <Icon name={icon} size={14} className="mt-0.5 flex-none" />
      <span className="min-w-0 flex-1">{children}</span>
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
  const { day, number } = useUtcDates()
  const plans = catalog.data
  const tiers = plans ? planTiers(plans) : []
  const [step, setStep] = useState<Step>('changeId' in start ? 'paying' : 'choose')
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
  const path = option ? changePath(sub, option) : null
  const same = !!option && isCurrent(sub, option)
  const combo = (label: string, sessions: number) => t('combo', { plan: label, sessions: number(sessions) })
  const fromLabel = combo(planLabel(sub), sub.sessionLimit)
  const toLabel = option ? combo(planLabel(option), option.sessionLimit) : ''
  const support = helpSupportUrl()

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
    if (x.salesMode === 'contact_sales') return setTarget({ tierId: x.tierId, optionId: null })
    const keep = x.options.find((o) => isCurrent(sub, o)) ?? x.options[0]!
    setTarget({ tierId: x.tierId, optionId: keep.optionId })
  }

  const toReview = () => {
    if (!option || same) return
    setError(null)
    setRefreshed(false)
    setStep('review')
    if (path === 'immediate') void requestQuote(false)
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
        const { url } = await createBillingSubscriptionCheckout(orgId, {
          tierId: option.tierId,
          optionId: option.optionId,
          idempotencyKey: crypto.randomUUID(),
          returnPath
        })
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
  if (step === 'choose') {
    const tierPrice = (x: PlanTier) => {
      const prices = x.options.map((o) => o.priceCents ?? 0)
      const min = Math.min(...prices)
      return prices.every((p) => p === min) ? fmtCents(min) : t('from', { price: fmtCents(min) })
    }
    const span = (values: number[], fmt: (n: number) => string) => {
      const min = Math.min(...values)
      const max = Math.max(...values)
      return min === max ? fmt(min) : `${fmt(min)}–${fmt(max)}`
    }
    const compact = (n: number) => number(n, { notation: 'compact' })
    body = (
      <>
        <div className="modalhead">
          <span className="cardtitle flex-1">{t('title')}</span>
          {close}
        </div>
        <div className="modalbody">
          {catalog.error ? (
            <InlineError text={t('loadError', { error: (catalog.error as Error).message })} />
          ) : !plans ? (
            <div className="h-[220px] animate-pulse rounded-[10px] bg-(--surface-sunken)" />
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2.5 desktop:auto-cols-fr desktop:grid-flow-col desktop:grid-cols-none">
                {tiers.map((x) => {
                  const custom = x.salesMode === 'contact_sales'
                  const grants = x.options.map((o) => o.grantMicro)
                  const days = x.options[0]!.retentionDays
                  return (
                    <button
                      key={x.tierId}
                      type="button"
                      data-plan-tier={x.tierId}
                      aria-pressed={x.tierId === target.tierId}
                      className={x.tierId === target.tierId ? TIER_CARD.on : TIER_CARD.off}
                      onClick={() => pickTier(x)}
                    >
                      <span className="flex items-center justify-between gap-1.5">
                        <span className="font-sans text-[14px] font-semibold leading-normal">{x.tierName}</span>
                        {x.options.some((o) => isCurrent(sub, o)) && (
                          <span className="mono inline-flex h-[19px] items-center rounded-xs bg-(--surface-active) px-[7px] text-[10.5px] font-semibold tracking-[0.04em] text-(--text-secondary) uppercase">
                            {t('current')}
                          </span>
                        )}
                      </span>
                      <span className="flex flex-wrap items-baseline gap-x-[5px]">
                        <span className="mono text-[21px] font-semibold tracking-[-0.02em] whitespace-nowrap">
                          {custom ? t('custom') : tierPrice(x)}
                        </span>
                        <span className="font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
                          {custom ? t('byContract') : t('perMonth')}
                        </span>
                      </span>
                      <span className="h-px bg-(--border-subtle)" />
                      <Feature>
                        {custom
                          ? t('customCredits')
                          : Math.max(...grants) === 0
                            ? t('topUpsOnly')
                            : t('credits', { amount: span(grants, (g) => fmtCents(g / 10_000)) })}
                      </Feature>
                      <Feature>
                        {custom
                          ? t('customSessions')
                          : t('sessions', {
                              sessions: span(
                                x.options.map((o) => o.sessionLimit),
                                compact
                              )
                            })}
                      </Feature>
                      <Feature>
                        {custom ? t('orgSso') : days === null ? t('historyUnlimited') : t('historyDays', { days })}
                      </Feature>
                    </button>
                  )
                })}
              </div>
              {tier && !contact && tier.options.length > 1 && (
                <div className="mt-4">
                  <div className="fldlbl">{t('sessionsPerMonth')}</div>
                  <div className="mt-2 flex gap-2.5">
                    {tier.options.map((o) => {
                      const meta = t('optionMeta', { price: fmtCents(o.priceCents ?? 0) })
                      return (
                        <button
                          key={o.optionId}
                          type="button"
                          data-plan-option={o.optionId}
                          aria-pressed={o.optionId === target.optionId}
                          className={o.optionId === target.optionId ? OPTION_TILE.on : OPTION_TILE.off}
                          onClick={() => setTarget({ tierId: o.tierId, optionId: o.optionId })}
                        >
                          <div className="mono text-[16px] font-semibold">{number(o.sessionLimit)}</div>
                          <div className="mt-[3px] font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
                            {isCurrent(sub, o) ? t('optionCurrent', { meta }) : meta}
                          </div>
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}
              {contact && <Note icon="mail">{t('contactNote')}</Note>}
            </>
          )}
        </div>
        <div className="modalfoot">
          <span className="min-w-0 flex-1 font-sans text-[12px] font-normal leading-normal text-(--text-secondary)">
            {option && !same ? toLabel : ''}
          </span>
          <Button size="sm" variant="secondary" onClick={onClose}>
            {t('cancel')}
          </Button>
          {contact ? (
            <a
              className="dsbtn sm dsbtn-primary no-underline"
              href={support}
              target={support.startsWith('https://') ? '_blank' : undefined}
              rel="noopener noreferrer"
            >
              {t('contactUs')}
            </a>
          ) : (
            <Button size="sm" disabled={!option || same || !sellable(option)} onClick={toReview}>
              {t('reviewChange')}
            </Button>
          )}
        </div>
      </>
    )
  } else if (step === 'review' && option && path) {
    const now = path !== 'scheduled'
    const paidThrough = path === 'immediate' ? (quote?.quote.paidThrough ?? sub.paidThrough) : sub.paidThrough
    const when = paidThrough ? day(paidThrough) : t('review.atRenewal')
    const sessions = { k: t('sessionsPerMonth'), v: `${number(sub.sessionLimit)} → ${number(option.sessionLimit)}` }
    const price = option.priceCents ?? 0
    let rows: { k: string; v: string }[] | null
    if (path === 'checkout')
      rows = [
        { k: t('review.dueToday'), v: usd(price) },
        { k: t('review.creditsAdded'), v: `+${fmtMicroUsd(option.grantMicro)}` },
        sessions
      ]
    else if (path === 'immediate')
      rows = quote
        ? [
            { k: t('review.dueToday'), v: t('review.prorated', { amount: usd(quote.quote.amountCents) }) },
            {
              k: t('review.creditsAdded'),
              v: quote.quote.grantMicro > 0 ? `+${fmtMicroUsd(quote.quote.grantMicro)}` : fmtMicroUsd(0)
            },
            sessions,
            { k: t('review.nextCharge'), v: t('review.nextChargeValue', { date: when, price: usd(price) }) }
          ]
        : null
    else
      rows = [
        { k: t('review.dueToday'), v: fmtMicroUsd(0) },
        { k: t('review.takesEffect'), v: when },
        sessions,
        ...(option.tierId === FREE_TIER_ID ? [] : [{ k: t('review.then'), v: t('optionMeta', { price: usd(price) }) }])
      ]
    // A shorter window starts the service's hold after the renewal; an older service sends no hold, so the new window stands in.
    const keptDays = sub.retention ? sub.retention.days : sub.retentionDays
    const shrinks =
      !now &&
      option.retentionDays !== null &&
      (keptDays === null || option.retentionDays < keptDays) &&
      sub.paidThrough !== null
    const holdDays = sub.retention?.shortenHoldDays ?? option.retentionDays
    const retry = path === 'immediate' && !quote && !!error
    const cta =
      path === 'scheduled'
        ? t('review.schedule')
        : path === 'checkout'
          ? t('review.pay', { amount: usd(price) })
          : quote
            ? t('review.pay', { amount: usd(quote.quote.amountCents) })
            : t('review.quoting')
    body = (
      <>
        <div className="modalhead">
          <button className="iconbtn" onClick={back} title={t('back')} aria-label={t('back')}>
            <Icon name="chevron-left" size={15} />
          </button>
          <span className="cardtitle flex-1">{now ? t('review.upgrade') : t('review.scheduleTitle')}</span>
          {close}
        </div>
        <div className="modalbody" data-plan-review={path}>
          <div className="mb-3 flex items-center gap-2.5">
            <span className="min-w-0 flex-1 rounded-md border border-(--border-subtle) bg-(--surface-app) px-3 py-2.5">
              <span className="eyebrow block">{t('current')}</span>
              <span className="mt-1 block font-sans text-[13px] font-semibold leading-normal">{fromLabel}</span>
            </span>
            <Icon name="arrow-right" size={16} color="var(--text-tertiary)" className="flex-none" />
            <span className="min-w-0 flex-1 rounded-md border border-(--brand) bg-(--brand-soft) px-3 py-2.5">
              <span className="eyebrow block">{now ? t('review.now') : when}</span>
              <span className="mt-1 block font-sans text-[13px] font-semibold leading-normal">{toLabel}</span>
            </span>
          </div>
          {rows ? (
            <div>
              {rows.map((r) => (
                <div
                  key={r.k}
                  data-quote-row="true"
                  className="flex items-baseline justify-between gap-3 border-b border-(--border-subtle) py-[9px] font-sans text-[12.5px] font-normal leading-normal text-(--text-secondary) last:border-b-0"
                >
                  <span>{r.k}</span>
                  <span className="mono text-right text-[12.5px] font-semibold text-(--text-primary)">{r.v}</span>
                </div>
              ))}
            </div>
          ) : (
            !error && (
              <div className="h-[150px] animate-pulse rounded-md bg-(--surface-sunken)" data-plan-quoting="true" />
            )
          )}
          {refreshed && quote && <Note warn>{t('review.refreshed')}</Note>}
          {shrinks && (
            <Note warn>
              {t('review.historyWarning', {
                days: option.retentionDays!,
                date: day(new Date(Date.parse(sub.paidThrough!) + holdDays! * DAY_MS).toISOString())
              })}
            </Note>
          )}
          {!now && <Note>{t('review.cancelBefore', { date: when })}</Note>}
          {error && <InlineError text={error} />}
        </div>
        <div className="modalfoot">
          <span className="flex-1" />
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
          <div className="mt-3.5 font-sans text-[15px] font-semibold leading-normal">{title}</div>
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
    // Done: an upgrade or checkout names what the org is on now; a scheduled change, when it lands.
    const settled = change
      ? plans?.options.find((o) => o.tierId === change.tierId && o.optionId === change.optionId)
      : option
    const scheduled = !change && path === 'scheduled'
    const credits = change && quote ? quote.quote.grantMicro : (settled?.grantMicro ?? 0)
    const title = scheduled
      ? sub.paidThrough
        ? t('done.scheduled', { date: day(sub.paidThrough) })
        : t('done.scheduledAtRenewal')
      : t('done.upgraded', { plan: settled ? planLabel(settled) : (change?.tierId ?? '') })
    const sessionsLine = settled ? t('done.sessions', { sessions: number(settled.sessionLimit) }) : ''
    const text = scheduled
      ? toLabel
      : credits > 0 && sessionsLine
        ? t('done.withCredits', { line: sessionsLine, amount: fmtMicroUsd(credits) })
        : sessionsLine
    body = (
      <>
        <div className="modalbody px-7 py-[34px] text-center" data-plan-done="true">
          <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-[11px] border border-(--green-500) bg-(--green-50) text-(--green-500)">
            <Icon name="check" size={21} />
          </span>
          <div className="mt-3.5 font-sans text-[16px] font-semibold leading-normal">{title}</div>
          {text && (
            <div className="mx-auto mt-1.5 max-w-[400px] font-sans text-[12.5px] font-normal leading-[1.65] text-(--text-secondary)">
              {text}
            </div>
          )}
        </div>
        <div className="modalfoot">
          <span className="flex-1" />
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
        className={step === 'choose' ? 'modal max-w-[900px]' : 'modal max-w-[540px]'}
        role="dialog"
        aria-modal="true"
        aria-label={t('title')}
        data-plan-dialog={step}
      >
        {body}
      </div>
    </div>
  )
}
