// Client for the billing service.
// It is a separate origin from the Control Plane and exists only where a
// deployment sets BILLING_URL, so it gets its own tiny client rather than a
// branch inside lib/api.ts. Nothing here computes money — every number below is
// rendered exactly as the service returned it.
//
// The service currently exposes reads only; paying for credit arrives with its
// payment channel, and the console's knowledge of it will stop at "redirect to
// the URL the API returned".
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
}

export interface BillingTransaction {
  id: string
  kind: 'purchase' | 'adjustment' | 'promo' | 'refund'
  amountMicro: number
  /** ISO 8601 instant. */
  at: string
}

export interface BillingTransactionsPage {
  items: BillingTransaction[]
  /** Pass back as `?cursor=` for the next page; null ⇒ this is the last one. */
  nextCursor: string | null
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

// Hand-rolled rather than zod: this is the whole surface, and pulling a schema
// library into the bundle to check two shapes is a cost the shared-package
// decision already rejected. Exported for the boundary test.
export function assertAccount(body: unknown): asserts body is BillingAccount {
  const b = body as Partial<BillingAccount> | null
  if (!b || typeof b.orgId !== 'string' || !isFiniteNumber(b.balanceMicro)) throw new BillingShapeError('account')
}

export function assertTransactionsPage(body: unknown): asserts body is BillingTransactionsPage {
  const b = body as Partial<BillingTransactionsPage> | null
  if (!b || !Array.isArray(b.items)) throw new BillingShapeError('transaction page')
  if (!(b.nextCursor === null || typeof b.nextCursor === 'string')) throw new BillingShapeError('transaction page')
  for (const t of b.items) {
    // `kind` is checked as a string, not against the known set: a ledger kind
    // this build has not heard of renders with its raw value as the label, and
    // refusing the whole page over one unknown label would be the worse failure.
    if (!t || typeof t.id !== 'string' || typeof t.at !== 'string' || !isFiniteNumber(t.amountMicro)) {
      throw new BillingShapeError('transaction')
    }
    if (typeof t.kind !== 'string') throw new BillingShapeError('transaction')
  }
}

async function request<T>(path: string): Promise<T> {
  const base = billingBase()
  if (!base) throw new BillingError('billing is not configured for this deployment', 0)

  const headers: Record<string, string> = {}
  const token = await getToken()
  if (token) headers.authorization = `Bearer ${token}`
  const email = (await getUser())?.email
  if (email) headers['x-ac-user-email'] = email
  const idToken = await getIdTokenRaw()
  if (idToken) headers['x-ac-id-token'] = idToken

  const res = await fetch(`${base}/api/v1${path}`, { cache: 'no-store', headers })
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

const MICRO_PER_USD = 1_000_000

/** Render microUSD as dollars. Display only — never a step in a calculation. */
export function fmtMicroUsd(micro: number): string {
  const sign = micro < 0 ? '-' : ''
  return `${sign}$${(Math.abs(micro) / MICRO_PER_USD).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}
