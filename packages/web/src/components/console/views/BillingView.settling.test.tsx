// @vitest-environment happy-dom
// For the hour after a UTC month ends its usage is still being posted; the page says so, and only then.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ activeOrg: { id: 'org-1' }, myRole: 'owner', orgPath: (p: string) => p, loading: false })
}))
vi.mock('next/navigation', () => ({
  usePathname: () => '/acme/billing',
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams()
}))
vi.mock('@/lib/billing-api', () => ({
  PURCHASE_MIN_MICRO: 5_000_000,
  PURCHASE_MAX_MICRO: 2_000_000_000,
  createBillingPurchase: vi.fn(),
  fetchBillingPurchase: vi.fn(),
  fetchBillingAccount: vi.fn(async () => ({ orgId: 'org-1', balanceMicro: 50_000_000, state: 'active' })),
  fetchBillingTransactions: vi.fn(async () => ({ items: [], nextCursor: null })),
  fmtMicroUsd: (micro: number) => `$${micro / 1_000_000}`
}))

const BillingView = (await import('./BillingView')).default

async function renderAt(iso: string): Promise<string> {
  vi.setSystemTime(new Date(iso))
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root: Root = createRoot(host)
  await act(async () => {
    root.render(<BillingView />)
  })
  // The account arrives on a later tick than the first paint; the note sits beside the numbers it qualifies.
  await act(async () => {
    await Promise.resolve()
  })
  const html = host.innerHTML
  await act(async () => root.unmount())
  host.remove()
  return html
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  ;(window as unknown as { __AC_ENV?: Record<string, string> }).__AC_ENV = { FEATURE_FLAGS: 'billing' }
})
afterEach(() => {
  vi.useRealTimers()
  ;(window as unknown as { __AC_ENV?: Record<string, string> }).__AC_ENV = {}
})

describe('BillingView, the month that just ended', () => {
  it('says last month is still settling during the first hour of a UTC month, naming the month', async () => {
    const html = await renderAt('2026-12-01T00:10:00Z')
    expect(html).toContain('November usage is still settling')
    expect(html).toContain('final after 01:00 UTC')
  })

  it('says nothing once the hour has passed, or mid-month', async () => {
    expect(await renderAt('2026-12-01T01:00:00Z')).not.toContain('still settling')
    expect(await renderAt('2026-12-15T00:10:00Z')).not.toContain('still settling')
  })
})
