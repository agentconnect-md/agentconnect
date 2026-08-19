// @vitest-environment happy-dom
/**
 * A console without the `billing` flag must not TALK to a billing service, not
 * merely refrain from showing the page. Hooks run before any early return, so a
 * flag checked only at render time still leaves two live SWR subscriptions — a
 * deep link would call a service this deployment may not even have. The flag
 * therefore gates the SWR keys, and this is the regression test for that.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  fetchAccount: vi.fn(async () => ({ orgId: 'org-1', balanceMicro: 0 })),
  fetchTransactions: vi.fn(async () => ({ items: [], nextCursor: null }))
}))

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
  fetchBillingAccount: mocks.fetchAccount,
  fetchBillingTransactions: mocks.fetchTransactions,
  fmtMicroUsd: (micro: number) => `$${micro / 1_000_000}`
}))

const BillingView = (await import('./BillingView')).default

const setFlags = (value?: string) => {
  ;(window as unknown as { __AC_ENV?: Record<string, string> }).__AC_ENV =
    value === undefined ? {} : { FEATURE_FLAGS: value }
}

async function render(): Promise<string> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root: Root = createRoot(host)
  await act(async () => {
    root.render(<BillingView />)
  })
  const html = host.innerHTML
  await act(async () => root.unmount())
  host.remove()
  return html
}

beforeEach(() => {
  mocks.fetchAccount.mockClear()
  mocks.fetchTransactions.mockClear()
})
afterEach(() => setFlags())

describe('BillingView, flag off', () => {
  it('renders the cloud-only notice', async () => {
    setFlags()
    expect(await render()).toContain('Billing applies to AgentConnect Cloud')
  })

  it('never calls the billing service', async () => {
    setFlags()
    await render()
    expect(mocks.fetchAccount).not.toHaveBeenCalled()
    expect(mocks.fetchTransactions).not.toHaveBeenCalled()
  })
})

describe('BillingView, flag on', () => {
  it('fetches both the account and its transactions', async () => {
    setFlags('billing')
    const html = await render()
    expect(mocks.fetchAccount).toHaveBeenCalledWith('org-1')
    expect(mocks.fetchTransactions).toHaveBeenCalledWith('org-1')
    expect(html).not.toContain('Billing applies to AgentConnect Cloud')
  })
})
