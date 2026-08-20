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
  /** What the gateway is doing to this org right now. Do NOT re-derive it from
   *  `balanceMicro`, which would claim something about the gateway from a number that may
   *  not have reached it.
   *
   *  `unknown` is a real answer and not a placeholder: a write whose outcome was lost may
   *  or may not have taken effect, so while a change of decision is unconfirmed the
   *  service cannot support either of the other two. It clears on its own. */
  state: 'active' | 'suspended' | 'unknown'
  /** Warn below this balance. 0 ⇒ no warning is configured for this deployment. */
  lowBalanceMicro: number
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
export interface BillingCredit {
  type: 'credit'
  id: string
  kind: 'purchase' | 'adjustment' | 'promo' | 'refund'
  amountMicro: number
  /** ISO 8601 instant. */
  at: string
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
}

export type BillingTransaction = BillingCredit | BillingDebit

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

// Hand-rolled rather than zod: this is the whole surface, and pulling a schema
// library into the bundle to check two shapes is a cost the shared-package
// decision already rejected. Exported for the boundary test.
export function assertAccount(body: unknown): asserts body is BillingAccount {
  const b = body as Partial<BillingAccount> | null
  if (!b || typeof b.orgId !== 'string' || !isFiniteNumber(b.balanceMicro)) throw new BillingShapeError('account')
  // A missing `state` is refused rather than defaulted to 'active': the default would be
  // silence about a stop that IS happening, and this page's whole job in that moment is
  // to say why nothing works. An unknown value is refused for the same reason — a state
  // this build cannot interpret must not render as "everything is fine".
  if (b.state !== 'active' && b.state !== 'suspended' && b.state !== 'unknown') {
    throw new BillingShapeError('account')
  }
  if (!isFiniteNumber(b.lowBalanceMicro)) throw new BillingShapeError('account')
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

export function assertTransactionsPage(body: unknown): asserts body is BillingTransactionsPage {
  const b = body as Partial<BillingTransactionsPage> | null
  if (!b || !Array.isArray(b.items)) throw new BillingShapeError('transaction page')
  if (!(b.nextCursor === null || typeof b.nextCursor === 'string')) throw new BillingShapeError('transaction page')
  for (const row of b.items) {
    // A loose record rather than a partial of the union: the two arms disagree on
    // `type`, so their intersection is uninhabited and every field below would narrow
    // to `never`.
    const t = row as unknown as Record<string, unknown> | null
    if (!t || typeof t.id !== 'string' || typeof t.at !== 'string') throw new BillingShapeError('transaction')
    // An unknown `type` is refused, unlike an unknown `kind` below: a row whose shape
    // this build cannot read has no sensible fallback rendering, where an unfamiliar
    // ledger kind is only a label.
    if (t.type === 'credit') {
      if (!isFiniteNumber(t.amountMicro)) throw new BillingShapeError('transaction')
      // Checked as a string rather than against the known set, deliberately: a kind
      // this build has not heard of renders with its raw value as the label, and
      // refusing the whole page over one unknown label would be the worse failure.
      if (typeof t.kind !== 'string') throw new BillingShapeError('transaction')
    } else if (t.type === 'debit') {
      // A string, and never coerced to a number here — the exact value is what the
      // service sent, and only the display rounds it.
      if (typeof t.amount !== 'string' || typeof t.period !== 'string') throw new BillingShapeError('transaction')
    } else {
      throw new BillingShapeError('transaction')
    }
  }
}

async function request<T>(path: string, init?: { method: 'POST'; body: unknown }): Promise<T> {
  const base = billingBase()
  if (!base) throw new BillingError('billing is not configured for this deployment', 0)

  const headers: Record<string, string> = {}
  if (init) headers['content-type'] = 'application/json'
  const token = await getToken()
  if (token) headers.authorization = `Bearer ${token}`
  const email = (await getUser())?.email
  if (email) headers['x-ac-user-email'] = email
  const idToken = await getIdTokenRaw()
  if (idToken) headers['x-ac-id-token'] = idToken

  const res = await fetch(`${base}/api/v1${path}`, {
    cache: 'no-store',
    headers,
    ...(init ? { method: init.method, body: JSON.stringify(init.body) } : {})
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

export async function fetchBillingTransactions(orgId: string, cursor?: string): Promise<BillingTransactionsPage> {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''
  const body = await request<unknown>(`${orgPath(orgId)}/transactions${query}`)
  assertTransactionsPage(body)
  return body
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

const MICRO_PER_USD = 1_000_000

/** Render microUSD as dollars. Display only — never a step in a calculation. */
/** A decimal-string amount, for display only. `Number` is fine HERE and only here: the
 *  value shown is rounded to cents anyway and the exact string stays untouched in the
 *  data. Never feed the result back to the service. */
export function fmtDecimalUsd(amount: string): string {
  const n = Number(amount)
  return Number.isFinite(n) ? fmtMicroUsd(n * MICRO_PER_USD) : `$${amount}`
}

export function fmtMicroUsd(micro: number): string {
  const sign = micro < 0 ? '-' : ''
  return `${sign}$${(Math.abs(micro) / MICRO_PER_USD).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}
