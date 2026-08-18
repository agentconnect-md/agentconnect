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
// schemas, which validate every response on the way out; this is the consuming
// half, hand-kept in step.
//
// A shared npm package would make that mechanical, and it was tried: it costs a
// published package, a release lane, a version to agree on, and a cross-repo
// release ordering — for two object shapes on a read-only surface. Copying is
// the smaller mistake, and it is honest about where the authority lives.
//
// What that buys, and what it demands:
//   - the service rejects its own malformed responses, so drift shows up here as
//     a field that is simply absent — never as silently wrong money
//   - therefore: when the service's response shape changes, this file changes in
//     the same change set. There is no compiler to remind you.
//   - keep the surface small enough that copying stays cheap. If it grows past
//     what a reviewer can diff by eye, that is the signal to revisit the package.

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

export function fetchBillingAccount(orgId: string): Promise<BillingAccount> {
  return request<BillingAccount>(`${orgPath(orgId)}/account`)
}

export function fetchBillingTransactions(orgId: string, cursor?: string): Promise<BillingTransactionsPage> {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''
  return request<BillingTransactionsPage>(`${orgPath(orgId)}/transactions${query}`)
}

// The contract's own constant would be a value import (⇒ zod in the bundle), and
// this is the only place the console divides by it.
const MICRO_PER_USD = 1_000_000

/** Render microUSD as dollars. Display only — never a step in a calculation. */
export function fmtMicroUsd(micro: number): string {
  const sign = micro < 0 ? '-' : ''
  return `${sign}$${(Math.abs(micro) / MICRO_PER_USD).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}
