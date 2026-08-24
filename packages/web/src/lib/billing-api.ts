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
// `note` and `agents` are each on ONE arm, and each is optional for the same reason `type`
// is: a service that predates it omits it, and the console routinely runs ahead of that
// image. Absent or null ⇒ the row renders without that detail.
export interface BillingCredit {
  type: 'credit'
  id: string
  kind: 'purchase' | 'adjustment' | 'promo' | 'refund'
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
  /** Which agents the charge came from, descending by amount. ATTRIBUTION, not a second
   *  amount: it is the control plane's split of the same observation `amount` was
   *  differenced from, so this side must not present it as a proof of the total.
   *
   *  Absent or null ⇒ the row carries no attribution. `[]` is the different claim that a
   *  breakdown arrived and named nobody; both render as no agents, and neither is an error.
   *  A credit has no agent at all, which is why the field is on this arm only. */
  agents?: BillingDebitAgent[] | null
}

/** One agent's share of a debit. `amount` is a decimal STRING, same reason as the debit's. */
export interface BillingDebitAgent {
  agentId: string
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
  // Unrecognised is refused; absent or null is an older service, and the page claims nothing.
  if (b.state != null && b.state !== 'active' && b.state !== 'suspended' && b.state !== 'unknown') {
    throw new BillingShapeError('account')
  }
  // A hint with a documented off value: throwing would drop the card AND the Add-credits form.
  if (b.lowBalanceMicro != null && !isFiniteNumber(b.lowBalanceMicro)) throw new BillingShapeError('account')
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
      // Attribution. ABSENT is the older contract and `null` is "no breakdown"; a present
      // list must be entirely readable, since a half-rendered split is worse than none.
      if (!(t.agents === undefined || t.agents === null)) {
        if (!Array.isArray(t.agents)) throw new BillingShapeError('transaction')
        for (const a of t.agents as unknown[]) {
          const agent = a as Record<string, unknown> | null
          if (!agent || typeof agent.agentId !== 'string' || typeof agent.amount !== 'string')
            throw new BillingShapeError('transaction')
        }
      }
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
