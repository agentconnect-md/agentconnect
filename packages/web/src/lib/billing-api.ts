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
// The DTOs come from `@agentconnect.md/billing-contract`, the one declaration the
// service validates against. Imported as TYPES ONLY: the schemas are zod, and a
// value import would pull zod into the browser bundle to re-check a response the
// service already validated on the way out. Parse at this boundary when a real
// version-skew bug asks for it, not before.

import type { BillingAccount, BillingTransactionsPage } from '@agentconnect.md/billing-contract'
import { getIdTokenRaw, getToken, getUser } from '@/lib/auth'

export type { BillingAccount, BillingTransaction, BillingTransactionsPage } from '@agentconnect.md/billing-contract'

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
