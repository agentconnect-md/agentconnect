// Client for the billing service — a separate origin from the Control Plane, so
// it gets its own tiny client rather than a branch inside lib/api.ts. Nothing here
// computes money: every number below is rendered exactly as the service sent it.
//
// `BILLING_URL` says WHERE the service is. Whether the console offers billing at
// all is the `billing` feature flag (lib/feature-flags.ts) — one variable per
// question, so "flag on, endpoint missing" reports a broken deployment instead of
// looking like billing was never enabled.
//
// Paying for credit: the console's whole knowledge of the payment channel is
// "POST an amount, redirect to the URL the API returned, then poll the purchase
// until the service says Stripe confirmed it". The return redirect is never
// treated as proof of payment — only the polled status is.
//
// ── The wire contract is DUPLICATED, on purpose ──────────────────────────────
// The types below are a copy. The authority is the billing service's own zod
// schemas, which it serializes every response through; this is the consuming
// half, kept in step by hand.
//
// A shared npm package would make that mechanical, and it was tried: for two
// object shapes on a read-only surface it cost a published package, a release
// lane, a manual first publish, a version for two repositories to agree on, and
// an ordering constraint between their releases.
//
// Be exact about what that costs, because the honest version is uncomfortable:
// there is NO compile-time and NO cross-repository check. Keeping the two sides
// in step is review discipline, not a guarantee. What the code can do — and does,
// below — is refuse to render a response that does not match this file, so a
// mismatch surfaces as the page's error state instead of `$NaN` in a balance.
//
// Keep this surface small enough that a reviewer can diff both sides by eye. If
// it outgrows that, revisit the shared package rather than let the copy rot.

import { getIdTokenRaw, getToken, getUser } from '@/lib/auth'

/** Amounts are integer microUSD on the wire (1 USD = 1_000_000). */
export interface BillingAccount {
  orgId: string
  /** Credit posted minus usage billed. One definition, settled facts only. */
  balanceMicro: number
  /** The gateway's own call, never re-derived from `balanceMicro`. Absent or null ⇒ an older service. */
  state?: 'active' | 'suspended' | 'unknown' | null
  /** Warn below this balance. 0, absent or null ⇒ no warning configured. */
  lowBalanceMicro?: number | null
  /** The card on file, which top-ups prefill. Null ⇒ none; ABSENT ⇒ a service that predates cards. */
  card?: BillingCard | null
  /** Saving a card now would earn the one-time free credit. Absent or null ⇒ an older service: offer nothing. */
  cardPromoAvailable?: boolean | null
}

/** Display facts only — the console never holds a card number, and nothing here can charge one. */
export interface BillingCard {
  /** The payment network's own slug (`visa`, `mastercard`, …); an unfamiliar one renders as sent. */
  brand: string
  last4: string
  expMonth: number
  expYear: number
}

/** `pending` until the service confirms the card was saved; the return redirect is UX only. */
export type BillingCardSetupStatus = 'pending' | 'completed' | 'expired'
const CARD_SETUP_STATUSES: readonly string[] = ['pending', 'completed', 'expired']

export interface BillingCardSetup {
  id: string
  status: BillingCardSetupStatus
  /** Why the free credit was or was not added; null until `completed`. A string, not a union: an outcome this build has not heard of still means the card was saved. */
  promoOutcome: string | null
  card: BillingCard | null
}

export interface BillingCardSetupCreated {
  setupId: string
  /** Hosted page that verifies the card without charging it; the console full-page redirects to it. */
  url: string
}

// The history merges both ledger sides, so a row is one of two shapes and `type` says
// which. The two arms carry money in different units, and that is the service's
// decision rather than an inconsistency to smooth over here:
//
//   credit → integer microUSD, the unit money arrives in through a payment channel;
//   debit  → a decimal STRING, because a posted usage amount can carry 18 decimals and
//            a statement line is a reconciliation fact. The service rounds in exactly
//            two places and a history row is neither of them, so it hands the exact
//            value over and formatting it for a human is this side's job.
// `note` is optional for the same reason `type` is: a service that predates it omits it, and
// the console routinely runs ahead of that image. Absent or null ⇒ the row renders without it.
//
// The debit arm's `agents` is the billing service's per-agent split of a charge — the real
// per-ROW amounts, which is why it is mirrored: nothing else knows how one charge divides.
//
// It is NOT self-authorizing. The service holds no Agent visibility, so its ids and its amounts
// are both the ORG's, and rendering one as-is is the discovery
// `docs/designs/authorization-policy.md` §4 forbids. The row may put an agent's name beside one
// of these amounts only when that agent is in the viewer's own roster (`fetchAgents`) — the
// billing exception in `session-visibility.md` §5. Ids outside it fold into one id-less rollup
// per charge. The gate lives in `rowAttribution` in BillingView; nothing else may read this field.
export interface BillingCredit {
  type: 'credit'
  id: string
  kind: 'purchase' | 'adjustment' | 'promo' | 'refund' | 'subscription' | 'grant_expiry'
  amountMicro: number
  /** ISO 8601 instant. */
  at: string
  // Stripe-hosted receipt, on a `purchase` row only, and optional for the same reason
  // `type` is: a service that predates it omits it, and the console runs ahead of that
  // image. Absent or null ⇒ the row renders with no receipt link, never a broken one.
  receiptUrl?: string | null
  /** Why an operator moved this money, on an `adjustment` row only — null on every other
   *  kind. Free operator text, so it renders as TEXT: never as markup, never as a link. */
  note?: string | null
}

export interface BillingDebit {
  type: 'debit'
  id: string
  /** The UTC billing period the usage fell in, `YYYY-MM`. */
  period: string
  /** Decimal string, NOT a number. Parse it only to display it. */
  amount: string
  /** ISO 8601 instant. */
  at: string
  /** This charge's per-agent split. Decimal strings, same unit as `amount`. Absent or null ⇒
   *  an older service, or a charge it could not split. Ids AND amounts are the ORG's — see the
   *  note above: gate on the CP's projection before either reaches a chip. */
  agents?: BillingDebitAgent[] | null
  /** This charge's per-model split, org-wide and shown to every member. Absent or null ⇒ an older service or row. */
  models?: BillingDebitModel[] | null
}

export interface BillingDebitAgent {
  agentId: string
  /** Decimal string, NOT a number. Parse it only to display it. */
  amount: string
}

export interface BillingDebitModel {
  /** `""` ⇒ usage the control plane could not name a model for. */
  model: string
  /** Decimal string, NOT a number. Parse it only to display it. */
  amount: string
}

export type BillingTransaction = BillingCredit | BillingDebit

// `type` is optional on the CREDIT arm only, and only for reading: a service that predates
// the union sends credit rows without it. Everything this file hands onward is normalised
// to carry it, so components switch on `type` without a special case.
export type BillingTransactionWire = (Omit<BillingCredit, 'type'> & { type?: 'credit' }) | BillingDebit

export interface BillingTransactionsPage {
  items: BillingTransaction[]
  /** Pass back as `?cursor=` for the next page; null ⇒ this is the last one. */
  nextCursor: string | null
}

/** `pending` until Stripe confirms settlement; a paid session may complete an
 *  intent an expiry guess had already marked `expired`. */
export type BillingPurchaseStatus = 'pending' | 'completed' | 'failed' | 'expired'
const PURCHASE_STATUSES: readonly string[] = ['pending', 'completed', 'failed', 'expired']

export interface BillingPurchase {
  id: string
  status: BillingPurchaseStatus
  amountMicro: number
  /** Stripe-hosted receipt for a completed purchase; may lag completion. */
  receiptUrl: string | null
}

export interface BillingPurchaseCreated {
  purchaseId: string
  /** Stripe-hosted checkout page; the console full-page redirects to it. */
  url: string
}

/** Design defaults ($5–$2,000), mirrored for inline validation copy only — the
 *  service enforces its own (operator-tunable) bounds authoritatively. */
export const PURCHASE_MIN_MICRO = 5_000_000
export const PURCHASE_MAX_MICRO = 2_000_000_000

// ── Plans (read-only): prices are integer USD cents and credit is microUSD, as the service sends them ──

/** The Free tier's stable slug; a renewal scheduled to it is a cancellation. */
export const FREE_TIER_ID = 'free'

export interface BillingPlanRef {
  tierId: string
  tierName: string
  optionId: string
  optionName: string
}

/** Unexpired plan and operator credit sharing one expiry; already part of the account's `balanceMicro`. */
export interface BillingPlanGrant {
  expiresAt: string
  remainingMicro: number
}

/** One plan-credit grant, live or expired; already part of the account's `balanceMicro` while live. */
export interface BillingPlanBatch {
  grantedAt: string
  grantedMicro: number
  remainingMicro: number
  expiresAt: string
  expired: boolean
}

export interface BillingPendingChange {
  id: string
  kind: 'checkout' | 'upgrade'
  tierId: string
  optionId: string
  /** Provider page where the payment is completed; null until it exists. Only `https:` survives the boundary. */
  payUrl: string | null
}

/** A shorter history window on its way in. */
export interface BillingRetentionNext {
  /** Null ⇒ unlimited. */
  days: number | null
  /** ISO instant history older than `days` starts being deleted; null while `awaitingNotice`. */
  from: string | null
  /** The owner must be emailed first; the window starts at least 30 days after that. */
  awaitingNotice: boolean
}

/** The history window in force and any shorter one pending. */
export interface BillingRetention {
  /** In force now; null ⇒ unlimited. */
  days: number | null
  next: BillingRetentionNext | null
  /** Days between a downgrade taking effect and its shorter window applying. */
  shortenHoldDays: number
}

export interface BillingSubscription extends BillingPlanRef {
  sessionLimit: number
  /** Monthly price, USD cents; null on a contract, which is priced outside the console. */
  priceCents: number | null
  /** Credit granted per paid period, microUSD. */
  grantMicro: number
  /** Null ⇒ unlimited. */
  retentionDays: number | null
  /** ISO instant the current paid period ends; null when not on a paid plan. */
  paidThrough: string | null
  /** The plan taken at `paidThrough` (Free for a cancellation); null when nothing is scheduled. */
  scheduled: BillingPlanRef | null
  /** Soonest first. Absent ⇒ an older service. */
  grants?: BillingPlanGrant[]
  /** The one unsettled checkout or upgrade. Absent ⇒ an older service. */
  pendingChange?: BillingPendingChange | null
  /** `syncing` ⇒ the previous plan's limits still apply. Absent ⇒ an older service. */
  entitlementSync?: 'synced' | 'syncing'
  /** Unexpired plan credit inside `balanceMicro`, microUSD. Absent ⇒ an older service. */
  planCreditMicro?: number
  /** Plan credit that expired unused this UTC month, microUSD. Absent ⇒ an older service. */
  expiredThisMonthMicro?: number
  /** Every grant by expiry, expired ones included. Absent ⇒ an older service. */
  batches?: BillingPlanBatch[]
  /** Absent ⇒ an older service. */
  retention?: BillingRetention
  /** ISO instant the free trial ends (equal to `paidThrough`); absent or null ⇒ not in one. */
  trialEndsAt?: string | null
  /** In a trial with trial credit: false ⇒ the card already received it on another org; absent or null ⇒ nothing to say. */
  trialCreditGranted?: boolean | null
}

export interface BillingPlanOption extends BillingPlanRef {
  salesMode: 'self_serve' | 'contact_sales'
  /** Monthly price, USD cents; null for a contact-sales tier. */
  priceCents: number | null
  /** Credit granted per paid period, microUSD. */
  grantMicro: number
  sessionLimit: number
  /** The "×N" label; null for an option shown without one. */
  multiplier: number | null
  /** Null ⇒ unlimited. */
  retentionDays: number | null
  /** Checkout, upgrade or scheduling can sell it now. */
  purchasable: boolean
  /** The org is on exactly this published option. */
  current: boolean
  /** The org has exactly this option scheduled for its renewal. */
  scheduled: boolean
  /** Free-trial days this org may start on this option now; absent or null ⇒ offer no trial. */
  trialDays?: number | null
  /** Credit granted once when that trial starts, microUSD; absent from an older service. */
  trialGrantMicro?: number
}

export interface BillingPlans {
  /** Every published tier's on-sale options, by tier then session limit. */
  options: BillingPlanOption[]
}

/** A checkout or upgrade; `pending` until its payment settles, and only the service says it did. */
export interface BillingSubscriptionChange {
  id: string
  status: 'pending' | 'completed' | 'expired'
  tierId: string
  optionId: string
  /** While pending, the provider page where the owner pays or verifies; only `https:` survives the boundary. */
  payUrl: string | null
}

export interface BillingSubscriptionCheckout {
  changeId: string
  /** Hosted checkout page; the console full-page redirects to it. */
  url: string
}

/** The server's locked price for an immediate upgrade; the console sends only the plan and renders this as sent. */
export interface BillingUpgradeQuote {
  quoteId: string
  tierId: string
  optionId: string
  /** Charged now for the rest of the current period, USD cents. */
  amountCents: number
  /** Credit added once paid, microUSD. */
  grantMicro: number
  /** After this instant the quote must be previewed again. */
  expiresAt: string
  /** The renewal, which the upgrade does not move; with `endsTrial`, the expected new renewal. */
  paidThrough: string
  /** True ⇒ paying ends the free trial: `amountCents` is a full month. Absent or null ⇒ an ordinary upgrade. */
  endsTrial?: boolean | null
  /** With `endsTrial`: unused trial credit that paying forfeits, microUSD. */
  forfeitMicro?: number | null
}

/** Billing base URL, or null when this deployment has no billing service. */
export function billingBase(): string | null {
  const runtime = typeof window !== 'undefined' ? window.__AC_ENV?.BILLING_URL : process.env.BILLING_URL
  const url = runtime || process.env.NEXT_PUBLIC_BILLING_URL
  return url ? url.replace(/\/+$/, '') : null
}

export class BillingError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
    this.name = 'BillingError'
  }
}

/** Thrown when a response does not match the shapes above — the copy has drifted
 *  from the service, or something other than billing answered. Carries status 0
 *  like the other client-side failures; the page shows its error card. */
export class BillingShapeError extends BillingError {
  constructor(what: string) {
    super(`billing sent an unexpected ${what} — the console may be out of date with the service`, 0)
    this.name = 'BillingShapeError'
  }
}

function isFiniteNumber(v: unknown): boolean {
  return typeof v === 'number' && Number.isFinite(v)
}

// Absent/null is the older contract; anything else must be a well-formed split or it is dropped.
function isAgentSplit(v: unknown): v is BillingDebitAgent[] | null | undefined {
  if (v === undefined || v === null) return true
  return (
    Array.isArray(v) &&
    v.every(
      (e) =>
        !!e &&
        typeof (e as BillingDebitAgent).agentId === 'string' &&
        typeof (e as BillingDebitAgent).amount === 'string'
    )
  )
}

function isModelSplit(v: unknown): v is BillingDebitModel[] | null | undefined {
  if (v === undefined || v === null) return true
  return (
    Array.isArray(v) &&
    v.every(
      (e) =>
        !!e && typeof (e as BillingDebitModel).model === 'string' && typeof (e as BillingDebitModel).amount === 'string'
    )
  )
}

// Hand-rolled rather than zod: this is the whole surface, and pulling a schema
// library into the bundle to check two shapes is a cost the shared-package
// decision already rejected. Exported for the boundary test.
export function assertAccount(body: unknown): asserts body is BillingAccount {
  const b = body as Partial<BillingAccount> | null
  if (!b || typeof b.orgId !== 'string' || !isFiniteNumber(b.balanceMicro)) throw new BillingShapeError('account')
  // Unrecognised is refused; absent or null is an older service, and the page claims nothing.
  if (b.state != null && b.state !== 'active' && b.state !== 'suspended' && b.state !== 'unknown') {
    throw new BillingShapeError('account')
  }
  // A hint with a documented off value: throwing would drop the card AND the Add-credits form.
  if (b.lowBalanceMicro != null && !isFiniteNumber(b.lowBalanceMicro)) throw new BillingShapeError('account')
  // Absent is the older contract; a card this build cannot read must not render as "no card on file".
  if (b.card != null && !isCard(b.card)) throw new BillingShapeError('account')
  if (b.cardPromoAvailable != null && typeof b.cardPromoAvailable !== 'boolean') throw new BillingShapeError('account')
}

function isCard(v: unknown): v is BillingCard {
  const c = v as Partial<BillingCard> | null
  return (
    !!c &&
    typeof c.brand === 'string' &&
    typeof c.last4 === 'string' &&
    isFiniteNumber(c.expMonth) &&
    isFiniteNumber(c.expYear)
  )
}

export function assertCardSetup(body: unknown): asserts body is BillingCardSetup {
  const b = body as Partial<BillingCardSetup> | null
  // Status is checked against the known set for the reason a purchase's is: polling branches on it.
  if (
    !b ||
    typeof b.id !== 'string' ||
    typeof b.status !== 'string' ||
    !CARD_SETUP_STATUSES.includes(b.status) ||
    !(b.promoOutcome === null || typeof b.promoOutcome === 'string') ||
    !(b.card === null || isCard(b.card))
  ) {
    throw new BillingShapeError('card setup')
  }
}

export function assertCardSetupCreated(body: unknown): asserts body is BillingCardSetupCreated {
  const b = body as Partial<BillingCardSetupCreated> | null
  if (!b || typeof b.setupId !== 'string' || typeof b.url !== 'string') throw new BillingShapeError('card setup')
}

export function assertPurchase(body: unknown): asserts body is BillingPurchase {
  const b = body as Partial<BillingPurchase> | null
  // Status IS checked against the known set, unlike a ledger `kind`: polling
  // branches on it, and an unknown status would spin forever — the error card
  // ("console out of date with the service") is the better failure.
  if (
    !b ||
    typeof b.id !== 'string' ||
    typeof b.status !== 'string' ||
    !PURCHASE_STATUSES.includes(b.status) ||
    !isFiniteNumber(b.amountMicro) ||
    !(b.receiptUrl === null || typeof b.receiptUrl === 'string')
  ) {
    throw new BillingShapeError('purchase')
  }
}

export function assertPurchaseCreated(body: unknown): asserts body is BillingPurchaseCreated {
  const b = body as Partial<BillingPurchaseCreated> | null
  if (!b || typeof b.purchaseId !== 'string' || typeof b.url !== 'string') throw new BillingShapeError('purchase')
}

/** Guarantees the WIRE shape, which is one step looser than what components see: a credit
 *  row may arrive without `type` from a service that predates the union.
 *  `fetchBillingTransactions` fills it in. */
export function assertTransactionsPage(
  body: unknown
): asserts body is { items: BillingTransactionWire[]; nextCursor: string | null } {
  const b = body as { items?: BillingTransactionWire[]; nextCursor?: string | null } | null
  if (!b || !Array.isArray(b.items)) throw new BillingShapeError('transaction page')
  if (!(b.nextCursor === null || typeof b.nextCursor === 'string')) throw new BillingShapeError('transaction page')
  for (const row of b.items) {
    // A loose record rather than a partial of the union: the two arms disagree on
    // `type`, so their intersection is uninhabited and every field below would narrow
    // to `never`.
    const t = row as unknown as Record<string, unknown> | null
    if (!t || typeof t.id !== 'string' || typeof t.at !== 'string') throw new BillingShapeError('transaction')
    // An ABSENT `type` is the shape this API had before the history merged both ledger
    // sides, and it is read as a credit — which is exactly what it was.
    //
    // That tolerance is not politeness, it is what makes this side deployable on its own.
    // Merge order is not deploy order: the console rides the application train and goes
    // out automatically, while the billing service's image is pinned and synced by hand,
    // so a console carrying a new mirror routinely runs against the previous service for
    // a while. Requiring `type` made that window a page that failed outright.
    //
    // An unknown `type` VALUE is still refused, unlike an unknown `kind` below: a shape
    // this build cannot read has no sensible fallback rendering, where an unfamiliar
    // ledger kind is only a label. "Absent" is not unknown — it is the previous contract,
    // and this file knows what it was.
    if (t.type === 'credit' || t.type === undefined) {
      if (!isFiniteNumber(t.amountMicro)) throw new BillingShapeError('transaction')
      // Checked as a string rather than against the known set, deliberately: a kind
      // this build has not heard of renders with its raw value as the label, and
      // refusing the whole page over one unknown label would be the worse failure.
      if (typeof t.kind !== 'string') throw new BillingShapeError('transaction')
      // A non-string, non-null receipt is a shape error; ABSENT is the older contract.
      if (!(t.receiptUrl === undefined || t.receiptUrl === null || typeof t.receiptUrl === 'string'))
        throw new BillingShapeError('transaction')
      // An operator's note, on `adjustment` only. ABSENT is the older contract.
      if (!(t.note === undefined || t.note === null || typeof t.note === 'string'))
        throw new BillingShapeError('transaction')
    } else if (t.type === 'debit') {
      // A string, and never coerced to a number here — the exact value is what the
      // service sent, and only the display rounds it.
      if (typeof t.amount !== 'string' || typeof t.period !== 'string') throw new BillingShapeError('transaction')
      // ABSENT is the older contract. A malformed split drops to `undefined` rather than
      // failing the page: the money on the row is the fact, the attribution is a garnish.
      if (!isAgentSplit(t.agents)) delete t.agents
      if (!isModelSplit(t.models)) delete t.models
    } else {
      throw new BillingShapeError('transaction')
    }
  }
}

function isPlanRef(v: unknown): v is BillingPlanRef {
  const r = v as Partial<BillingPlanRef> | null
  return (
    !!r &&
    typeof r.tierId === 'string' &&
    typeof r.tierName === 'string' &&
    typeof r.optionId === 'string' &&
    typeof r.optionName === 'string'
  )
}

const isNullableFinite = (v: unknown) => v === null || isFiniteNumber(v)
const isNullableString = (v: unknown) => v === null || typeof v === 'string'

// The plan fields are the fact and refuse the read; the newer fields are garnish, so absent is the older contract and malformed drops.
export function assertSubscription(body: unknown): asserts body is BillingSubscription {
  const b = body as (Partial<BillingSubscription> & Record<string, unknown>) | null
  if (
    !isPlanRef(b) ||
    !isFiniteNumber(b.sessionLimit) ||
    !isNullableFinite(b.priceCents) ||
    !isFiniteNumber(b.grantMicro) ||
    !isNullableFinite(b.retentionDays) ||
    !isNullableString(b.paidThrough) ||
    !(b.scheduled === null || isPlanRef(b.scheduled))
  ) {
    throw new BillingShapeError('subscription')
  }
  if (
    b.grants !== undefined &&
    !(
      Array.isArray(b.grants) &&
      b.grants.every((g) => !!g && typeof g.expiresAt === 'string' && isFiniteNumber(g.remainingMicro))
    )
  )
    delete b.grants
  const p = b.pendingChange
  if (
    p !== undefined &&
    p !== null &&
    !(
      typeof p.id === 'string' &&
      (p.kind === 'checkout' || p.kind === 'upgrade') &&
      typeof p.tierId === 'string' &&
      typeof p.optionId === 'string' &&
      isNullableString(p.payUrl)
    )
  )
    delete b.pendingChange
  if (b.entitlementSync !== undefined && b.entitlementSync !== 'synced' && b.entitlementSync !== 'syncing')
    delete b.entitlementSync
  if (b.planCreditMicro !== undefined && !isFiniteNumber(b.planCreditMicro)) delete b.planCreditMicro
  if (b.expiredThisMonthMicro !== undefined && !isFiniteNumber(b.expiredThisMonthMicro)) delete b.expiredThisMonthMicro
  if (
    b.batches !== undefined &&
    !(
      Array.isArray(b.batches) &&
      b.batches.every(
        (x) =>
          !!x &&
          typeof x.grantedAt === 'string' &&
          isFiniteNumber(x.grantedMicro) &&
          isFiniteNumber(x.remainingMicro) &&
          typeof x.expiresAt === 'string' &&
          typeof x.expired === 'boolean'
      )
    )
  )
    delete b.batches
  if (b.retention !== undefined && !isRetention(b.retention)) delete b.retention
  if (b.trialEndsAt != null && !(typeof b.trialEndsAt === 'string' && !Number.isNaN(Date.parse(b.trialEndsAt))))
    delete b.trialEndsAt
  if (b.trialCreditGranted != null && typeof b.trialCreditGranted !== 'boolean') delete b.trialCreditGranted
}

function isRetention(v: unknown): v is BillingRetention {
  const r = v as Partial<BillingRetention> | null
  if (!r || typeof r !== 'object' || !isNullableFinite(r.days) || !isFiniteNumber(r.shortenHoldDays)) return false
  const n = r.next as Partial<BillingRetentionNext> | null | undefined
  if (n === null) return true
  return (
    !!n &&
    typeof n === 'object' &&
    isNullableFinite(n.days) &&
    typeof n.awaitingNotice === 'boolean' &&
    (n.from === null || (typeof n.from === 'string' && !Number.isNaN(Date.parse(n.from))))
  )
}

export function assertPlans(body: unknown): asserts body is BillingPlans {
  const b = body as { options?: unknown } | null
  if (!b || !Array.isArray(b.options)) throw new BillingShapeError('plan catalog')
  for (const raw of b.options as unknown[]) {
    const o = raw as Partial<BillingPlanOption> | null
    if (
      !o ||
      !isPlanRef(raw) ||
      (o.salesMode !== 'self_serve' && o.salesMode !== 'contact_sales') ||
      !isNullableFinite(o.priceCents) ||
      !isFiniteNumber(o.grantMicro) ||
      !isFiniteNumber(o.sessionLimit) ||
      !isNullableFinite(o.multiplier) ||
      !isNullableFinite(o.retentionDays) ||
      typeof o.purchasable !== 'boolean' ||
      typeof o.current !== 'boolean' ||
      typeof o.scheduled !== 'boolean'
    ) {
      throw new BillingShapeError('plan catalog')
    }
    // A malformed trial offer drops to no offer: the plain subscribe path is always safe.
    if (o.trialDays != null && !(isFiniteNumber(o.trialDays) && o.trialDays > 0)) delete o.trialDays
    if (o.trialGrantMicro !== undefined && !(isFiniteNumber(o.trialGrantMicro) && o.trialGrantMicro >= 0))
      delete o.trialGrantMicro
  }
}

// Polling branches on the status, so an unknown one is refused like a purchase's.
export function assertSubscriptionChange(body: unknown): asserts body is BillingSubscriptionChange {
  const b = body as Partial<BillingSubscriptionChange> | null
  if (
    !b ||
    typeof b.id !== 'string' ||
    (b.status !== 'pending' && b.status !== 'completed' && b.status !== 'expired') ||
    typeof b.tierId !== 'string' ||
    typeof b.optionId !== 'string' ||
    !isNullableString(b.payUrl)
  ) {
    throw new BillingShapeError('plan change')
  }
}

export function assertUpgradeQuote(body: unknown): asserts body is BillingUpgradeQuote {
  const b = body as Partial<BillingUpgradeQuote> | null
  if (
    !b ||
    typeof b.quoteId !== 'string' ||
    typeof b.tierId !== 'string' ||
    typeof b.optionId !== 'string' ||
    !isFiniteNumber(b.amountCents) ||
    !isFiniteNumber(b.grantMicro) ||
    typeof b.expiresAt !== 'string' ||
    typeof b.paidThrough !== 'string' ||
    // Refused rather than dropped: a trial-ending payment must not render as an ordinary upgrade.
    !(b.endsTrial == null || typeof b.endsTrial === 'boolean') ||
    !(b.forfeitMicro == null || isFiniteNumber(b.forfeitMicro))
  ) {
    throw new BillingShapeError('upgrade quote')
  }
}

// Remote input becomes an `href` only as `https:`.
const httpsOnly = (url: string | null | undefined): string | null => (url?.startsWith('https://') ? url : null)

async function request<T>(
  path: string,
  init?: { method: 'POST' | 'PUT'; body: unknown } | { method: 'DELETE' }
): Promise<T> {
  const base = billingBase()
  if (!base) throw new BillingError('billing is not configured for this deployment', 0)

  const headers: Record<string, string> = {}
  if (init && 'body' in init) headers['content-type'] = 'application/json'
  const token = await getToken()
  if (token) headers.authorization = `Bearer ${token}`
  const email = (await getUser())?.email
  if (email) headers['x-ac-user-email'] = email
  const idToken = await getIdTokenRaw()
  if (idToken) headers['x-ac-id-token'] = idToken

  const res = await fetch(`${base}/api/v1${path}`, {
    cache: 'no-store',
    headers,
    ...(init ? { method: init.method, ...('body' in init ? { body: JSON.stringify(init.body) } : {}) } : {})
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string }
    throw new BillingError(body.message ?? `billing request failed (HTTP ${res.status})`, res.status)
  }
  return (await res.json()) as T
}

const orgPath = (orgId: string) => `/orgs/${encodeURIComponent(orgId)}/billing`

export async function fetchBillingAccount(orgId: string): Promise<BillingAccount> {
  const body = await request<unknown>(`${orgPath(orgId)}/account`)
  assertAccount(body)
  return body
}

/** `filter` narrows the feed. `from`/`to` are a half-open `[from, to)` on the row's own
 *  instant, the same shape the CP's usage query takes; both ends are optional and an omitted
 *  one is open. `type` narrows it to one ledger side, and an omitted one is both.
 *
 *  Every part is a REQUEST, not a guarantee: a billing image that predates a parameter
 *  ignores it and answers with the whole ledger, and this console routinely runs ahead of
 *  that image. A caller that needs a narrowing to hold must check the rows it keeps — `at`
 *  for the window, `type` for the side. */
export async function fetchBillingTransactions(
  orgId: string,
  cursor?: string,
  filter?: { from?: string; to?: string; type?: 'credit' | 'debit' }
): Promise<BillingTransactionsPage> {
  const params = new URLSearchParams()
  if (cursor) params.set('cursor', cursor)
  if (filter?.from) params.set('from', filter.from)
  if (filter?.to) params.set('to', filter.to)
  if (filter?.type) params.set('type', filter.type)
  const query = params.size > 0 ? `?${params}` : ''
  const body = await request<unknown>(`${orgPath(orgId)}/transactions${query}`)
  assertTransactionsPage(body)
  // Normalised here so the tolerance stops at this boundary: a service that predates the
  // union omits `type` on its credit rows, and every component past this line gets to
  // switch on it without knowing that history.
  // Keyed on `debit` rather than on the absence of `type`, so the credit arm is stamped
  // the same way whether the service sent it or not.
  // The receipt is dropped unless it is `https:` — it becomes an `href`, and a payload
  // that reached this line is remote input, so nothing else may become a link.
  const items: BillingTransaction[] = body.items.map((row) =>
    row.type === 'debit'
      ? row
      : { ...row, type: 'credit' as const, receiptUrl: row.receiptUrl?.startsWith('https://') ? row.receiptUrl : null }
  )
  return { items, nextCursor: body.nextCursor }
}

/** Start a purchase: the service persists the intent, mints a Stripe Checkout
 *  Session, and hands back the hosted URL. `idempotencyKey` makes the request
 *  replay-safe (same key + same amount returns the same purchase; a different
 *  amount under the same key is refused). `returnPath` is a console path — the
 *  service pins the origin — that Stripe sends the browser back to with
 *  `?checkout=success|cancel&purchase=<id>`. */
export async function createBillingPurchase(
  orgId: string,
  args: { amountMicro: number; idempotencyKey: string; returnPath: string }
): Promise<BillingPurchaseCreated> {
  const body = await request<unknown>(`${orgPath(orgId)}/purchases`, { method: 'POST', body: args })
  assertPurchaseCreated(body)
  return body
}

export async function fetchBillingPurchase(orgId: string, id: string): Promise<BillingPurchase> {
  const body = await request<unknown>(`${orgPath(orgId)}/purchases/${encodeURIComponent(id)}`)
  assertPurchase(body)
  return body
}

/** Start saving a card: the service persists the setup and hands back a hosted page that
 *  verifies the card without charging it. With a card already on file this replaces it once
 *  the new one is confirmed. The browser returns to `returnPath` with
 *  `?cardSetup=success|cancel&setup=<id>` — which, like a checkout return, proves nothing. */
export async function createBillingCardSetup(
  orgId: string,
  args: { idempotencyKey: string; returnPath: string }
): Promise<BillingCardSetupCreated> {
  const body = await request<unknown>(`${orgPath(orgId)}/card-setup`, { method: 'POST', body: args })
  assertCardSetupCreated(body)
  return body
}

export async function fetchBillingCardSetup(orgId: string, id: string): Promise<BillingCardSetup> {
  const body = await request<unknown>(`${orgPath(orgId)}/card-setup/${encodeURIComponent(id)}`)
  assertCardSetup(body)
  return body
}

/** Remove the card on file. Idempotent; a failure leaves the card exactly as it was. Credit it earned stays. */
export async function removeBillingCard(orgId: string): Promise<void> {
  await request<unknown>(`${orgPath(orgId)}/card`, { method: 'DELETE' })
}

/** The org's plan, or null when it has none (404). */
export async function fetchBillingSubscription(orgId: string): Promise<BillingSubscription | null> {
  let body: unknown
  try {
    body = await request<unknown>(`${orgPath(orgId)}/subscription`)
  } catch (e) {
    if (e instanceof BillingError && e.status === 404) return null
    throw e
  }
  assertSubscription(body)
  const pending = body.pendingChange
  return pending ? { ...body, pendingChange: { ...pending, payUrl: httpsOnly(pending.payUrl) } } : body
}

/** The published plan catalog, with the org's current and scheduled options flagged. */
export async function fetchBillingPlans(orgId: string): Promise<BillingPlans> {
  const body = await request<unknown>(`${orgPath(orgId)}/plans`)
  assertPlans(body)
  return body
}

const changeView = (body: unknown): BillingSubscriptionChange => {
  assertSubscriptionChange(body)
  return { ...body, payUrl: httpsOnly(body.payUrl) }
}

/** First purchase from Free: a hosted checkout the browser is redirected to; it returns to `returnPath` with `?checkout=success|cancel&subscriptionChange=<id>`, which proves nothing. */
export async function createBillingSubscriptionCheckout(
  orgId: string,
  args: { tierId: string; optionId: string; idempotencyKey: string; returnPath: string; trial?: boolean }
): Promise<BillingSubscriptionCheckout> {
  // `trial` goes on the wire only when true, so a plain subscribe reads exactly as before.
  const { trial, ...rest } = args
  const payload = trial ? { ...rest, trial: true } : rest
  const body = await request<unknown>(`${orgPath(orgId)}/subscription/checkout`, { method: 'POST', body: payload })
  const b = body as Partial<BillingSubscriptionCheckout> | null
  if (!b || typeof b.changeId !== 'string' || typeof b.url !== 'string') throw new BillingShapeError('plan checkout')
  return { changeId: b.changeId, url: b.url }
}

/** Price an immediate upgrade; the quote is locked for a while and a 409 means preview it again. */
export async function quoteBillingUpgrade(
  orgId: string,
  args: { tierId: string; optionId: string }
): Promise<BillingUpgradeQuote> {
  const body = await request<unknown>(`${orgPath(orgId)}/subscription/quote`, { method: 'POST', body: args })
  assertUpgradeQuote(body)
  return body
}

/** Pay a quote. Same key + same quote replays; a pending result with a `payUrl` needs the owner to act on the provider page. */
export async function confirmBillingUpgrade(
  orgId: string,
  args: { quoteId: string; idempotencyKey: string }
): Promise<BillingSubscriptionChange> {
  return changeView(await request<unknown>(`${orgPath(orgId)}/subscription/upgrade`, { method: 'POST', body: args }))
}

export async function fetchBillingSubscriptionChange(orgId: string, id: string): Promise<BillingSubscriptionChange> {
  return changeView(await request<unknown>(`${orgPath(orgId)}/subscription/changes/${encodeURIComponent(id)}`))
}

/** Withdraw an unpaid upgrade and void its invoice; the caller rereads the plan rather than parsing the reply. */
export async function cancelBillingSubscriptionChange(orgId: string, id: string): Promise<void> {
  await request<unknown>(`${orgPath(orgId)}/subscription/changes/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

/** Move to the plan at the next renewal; Free's option cancels the renewal. */
export async function scheduleBillingChange(orgId: string, args: { tierId: string; optionId: string }): Promise<void> {
  await request<unknown>(`${orgPath(orgId)}/subscription/scheduled`, { method: 'PUT', body: args })
}

/** Renew at the current plan again. */
export async function revokeBillingScheduledChange(orgId: string): Promise<void> {
  await request<unknown>(`${orgPath(orgId)}/subscription/scheduled`, { method: 'DELETE' })
}

const MICRO_PER_USD = 1_000_000

/** A decimal-string amount, for display only. `Number` is fine HERE and only here: the
 *  shown value is a rounding of the exact string, which stays untouched in the data.
 *  Never feed the result back to the service. Cents above $1; below it, four significant
 *  digits (design: a nonzero charge must never render as a bare $0.00). */
export function fmtDecimalUsd(amount: string): string {
  const n = Number(amount)
  if (!Number.isFinite(n)) return `$${amount}`
  if (Math.abs(n) >= 1) return fmtMicroUsd(n * MICRO_PER_USD)
  const zeros = /^-?0\.(0*)[1-9]/.exec(amount)
  if (!zeros) return fmtMicroUsd(n * MICRO_PER_USD)
  // Fraction padded back to at least cents so $0.10 lines up with fmtMicroUsd's
  // $0.50 in the same column; the sign stays outside the symbol for the same reason.
  const out = Math.abs(n)
    .toFixed(Math.min(zeros[1]!.length + 4, 18))
    .replace(/0+$/, '')
  const [int, frac = ''] = out.split('.')
  return `${n < 0 ? '-' : ''}$${int}.${frac.padEnd(2, '0')}`
}

/** Render microUSD as dollars. Display only — never a step in a calculation. */
export function fmtMicroUsd(micro: number): string {
  const sign = micro < 0 ? '-' : ''
  return `${sign}$${(Math.abs(micro) / MICRO_PER_USD).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/** A plan price in USD cents, whole dollars without decimals (`$40`, `$19.99`). Display only. */
export function fmtCents(cents: number): string {
  const digits = cents % 100 === 0 ? 0 : 2
  return (cents / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  })
}

/** Every transaction posted at or after `sinceMs`, newest first. The window goes to the
 *  service as `from`, so a long ledger costs one page instead of however many it takes to
 *  walk back; the client-side cut stays because a billing image that predates the parameter
 *  ignores it and answers with everything, and this console deploys ahead of that image.
 *
 *  `maxPages` is a runaway guard, not a policy: a ledger busier than that under-reports
 *  rather than paging all of it for one total. */
export async function fetchBillingTransactionsSince(
  orgId: string,
  sinceMs: number,
  maxPages = 10
): Promise<BillingTransaction[]> {
  const from = new Date(sinceMs).toISOString()
  const out: BillingTransaction[] = []
  let cursor: string | undefined
  for (let page = 0; page < maxPages; page++) {
    const { items, nextCursor } = await fetchBillingTransactions(orgId, cursor, { from })
    // Rows are newest-first, so the window ends at the first row older than it. An unparseable
    // `at` compares false and stays — a row this side cannot date must not silently truncate
    // the ones behind it.
    const older = items.findIndex((t) => Date.parse(t.at) < sinceMs)
    out.push(...(older < 0 ? items : items.slice(0, older)))
    if (older >= 0 || !nextCursor) break
    cursor = nextCursor
  }
  return out
}
