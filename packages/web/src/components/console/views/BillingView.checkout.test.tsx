// @vitest-environment happy-dom
/**
 * The checkout-return state machine's two safety properties, pinned:
 *
 * 1. `expired` is NOT an authoritative no-charge answer. The mirrored contract
 *    (billing-api.ts) says a paid session may complete an intent an expiry guess
 *    had already marked `expired`, so a poll that reads `expired` must keep
 *    reconciling — and the banner it can end on must never claim nothing was
 *    charged.
 *
 * 2. A transient poll failure must not abandon confirmation. The return params
 *    are cleaned from the URL on claim, so the purchase id lives only in state;
 *    a single network blip or 5xx must retry, not become a dead end.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BillingError } from '@/lib/billing-api'

const mocks = vi.hoisted(() => ({
  fetchPurchase: vi.fn<() => Promise<unknown>>()
}))

vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ activeOrg: { id: 'org-1' }, myRole: 'owner', orgPath: (p: string) => p, loading: false })
}))
vi.mock('next/navigation', () => ({
  usePathname: () => '/acme/billing',
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams('checkout=success&purchase=pur_1')
}))
vi.mock('@/lib/billing-api', async () => {
  const real = await vi.importActual<typeof import('@/lib/billing-api')>('@/lib/billing-api')
  return {
    ...real,
    createBillingPurchase: vi.fn(),
    fetchBillingPurchase: mocks.fetchPurchase,
    fetchBillingAccount: async () => ({ orgId: 'org-1', balanceMicro: 0 }),
    fetchBillingTransactions: async () => ({ items: [], nextCursor: null })
  }
})

const BillingView = (await import('./BillingView')).default

let host: HTMLElement
let root: Root

async function render() {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root.render(<BillingView />)
  })
}

/** Let the pending poll timer fire and its fetch settle. */
async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  ;(window as unknown as { __AC_ENV?: Record<string, string> }).__AC_ENV = { FEATURE_FLAGS: 'billing' }
  mocks.fetchPurchase.mockReset()
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.useRealTimers()
  ;(window as unknown as { __AC_ENV?: Record<string, string> }).__AC_ENV = {}
})

const purchase = (status: string) => ({ id: 'pur_1', status, amountMicro: 50_000_000, receiptUrl: null })

describe('checkout return: expired is not terminal', () => {
  it('keeps polling after an expired reading and still lands on completed', async () => {
    mocks.fetchPurchase
      .mockResolvedValueOnce(purchase('expired'))
      .mockResolvedValueOnce(purchase('expired'))
      .mockResolvedValue(purchase('completed'))
    await render()
    await tick(0) // attempt 1 → expired
    expect(host.innerHTML).toContain('Confirming your payment')
    await tick(2_500) // attempt 2 → expired, still confirming
    expect(host.innerHTML).toContain('Confirming your payment')
    await tick(2_500) // attempt 3 → completed
    expect(host.innerHTML).toContain('$50.00 added')
    expect(mocks.fetchPurchase).toHaveBeenCalledTimes(3)
  })

  it('never claims "nothing was charged" for an expired purchase', async () => {
    mocks.fetchPurchase.mockResolvedValue(purchase('expired'))
    await render()
    await tick(0)
    for (let i = 0; i < 120; i++) await tick(2_500) // exhaust the poll budget
    expect(host.innerHTML).toContain('Checkout session expired')
    expect(host.innerHTML).not.toContain('Nothing was charged')
  })
})

describe('checkout return: transient poll failures', () => {
  it('retries through a network error instead of abandoning the purchase', async () => {
    mocks.fetchPurchase
      .mockRejectedValueOnce(new BillingError('billing request failed (HTTP 503)', 503))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValue(purchase('completed'))
    await render()
    await tick(0)
    expect(host.innerHTML).toContain('Confirming your payment')
    await tick(2_500)
    expect(host.innerHTML).toContain('Confirming your payment')
    await tick(2_500)
    expect(host.innerHTML).toContain('$50.00 added')
  })

  it('a permanent refusal keeps the purchase id and offers a manual retry', async () => {
    mocks.fetchPurchase
      .mockRejectedValueOnce(new BillingError('forbidden', 403))
      .mockResolvedValue(purchase('completed'))
    await render()
    await tick(0)
    expect(host.innerHTML).toContain('Could not check the payment')
    const retry = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('Check again'))
    expect(retry).toBeTruthy()
    await act(async () => retry!.click())
    await tick(0)
    expect(host.innerHTML).toContain('$50.00 added')
  })
})
