// @vitest-environment happy-dom
/**
 * The saved card on the Billing page, pinned where a wrong render misleads:
 *
 * 1. A return from the hosted card page is CHECKED, and a card that earned no credit says why.
 * 2. A failed Remove leaves the card showing — the service changed nothing.
 * 3. Members see what is on file and nothing to press; a service that predates cards shows no card at all.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const CARD = { brand: 'visa', last4: '4242', expMonth: 8, expYear: 2028 }
const mocks = vi.hoisted(() => ({
  role: 'owner',
  search: '',
  account: {} as Record<string, unknown>,
  fetchCardSetup: vi.fn<() => Promise<unknown>>(),
  removeCard: vi.fn<() => Promise<void>>()
}))

vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({
    activeOrg: { id: 'org-1', name: 'acme', slug: 'acme' },
    myRole: mocks.role,
    orgPath: (p: string) => p,
    loading: false
  })
}))
vi.mock('next/navigation', () => ({
  usePathname: () => '/acme/billing',
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(mocks.search)
}))
vi.mock('@/lib/billing-api', async () => {
  const real = await vi.importActual<typeof import('@/lib/billing-api')>('@/lib/billing-api')
  return {
    ...real,
    fetchBillingAccount: async () => mocks.account,
    fetchBillingTransactions: async () => ({ items: [], nextCursor: null }),
    fetchBillingCardSetup: mocks.fetchCardSetup,
    removeBillingCard: mocks.removeCard
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
    root.render(
      <SWRConfig value={{ provider: () => new Map() }}>
        <BillingView />
      </SWRConfig>
    )
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
}

const button = (label: string) =>
  Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.trim() === label)

beforeEach(() => {
  vi.useFakeTimers()
  ;(window as unknown as { __AC_ENV?: Record<string, string> }).__AC_ENV = { FEATURE_FLAGS: 'billing' }
  mocks.role = 'owner'
  mocks.search = ''
  mocks.account = { orgId: 'org-1', balanceMicro: 0, state: 'suspended', card: null, cardPromoAvailable: true }
  mocks.fetchCardSetup.mockReset()
  mocks.removeCard.mockReset()
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.useRealTimers()
  ;(window as unknown as { __AC_ENV?: Record<string, string> }).__AC_ENV = {}
})

describe('payment method card', () => {
  it('offers free credit only while the service says the org can still get it', async () => {
    await render()
    expect(host.innerHTML).toContain('Add a card to get free credit')

    await act(async () => root.unmount())
    host.remove()
    mocks.account = { ...mocks.account, cardPromoAvailable: false }
    await render()
    expect(host.innerHTML).toContain('No card on file')
    expect(host.innerHTML).not.toContain('free credit')
  })

  it('shows nothing about cards against a service that predates them', async () => {
    mocks.account = { orgId: 'org-1', balanceMicro: 0, state: 'suspended' }
    await render()
    expect(host.innerHTML).not.toContain('Payment method')
  })

  it('keeps the card on screen and says so when Remove fails', async () => {
    mocks.account = { ...mocks.account, card: CARD, cardPromoAvailable: false }
    mocks.removeCard.mockRejectedValue(new Error('bad gateway'))
    await render()
    expect(host.innerHTML).toContain('Visa ending in 4242')
    await act(async () => button('Remove')!.click())
    expect(mocks.removeCard).toHaveBeenCalledTimes(1)
    expect(host.innerHTML).toContain('still on file')
    expect(host.innerHTML).toContain('Visa ending in 4242')
  })

  it('gives a member the card and nothing to press', async () => {
    mocks.role = 'member'
    mocks.account = { ...mocks.account, card: CARD, cardPromoAvailable: false }
    await render()
    expect(host.innerHTML).toContain('Visa ending in 4242')
    expect(host.innerHTML).toContain('Only owners can change the card')
    expect(button('Replace')).toBeUndefined()
    expect(button('Remove')).toBeUndefined()
  })
})

describe('card return', () => {
  it('checks the setup instead of trusting the redirect, then explains a wallet card', async () => {
    mocks.search = 'cardSetup=success&setup=cs_1'
    mocks.fetchCardSetup
      .mockResolvedValueOnce({ id: 'cs_1', status: 'pending', promoOutcome: null, card: null })
      .mockResolvedValue({ id: 'cs_1', status: 'completed', promoOutcome: 'wallet', card: CARD })
    await render()
    expect(host.innerHTML).toContain('Checking your card')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500)
    })
    expect(host.innerHTML).toContain('Card saved')
    expect(host.innerHTML).toContain('Type the card number in to claim it')
    expect(button('Enter card number')).toBeDefined()
    // No credit and none earned: paying for some is the other way forward.
    expect(button('Add credits')).toBeDefined()
  })

  it('reads a cancel as not saved without asking the service', async () => {
    mocks.search = 'cardSetup=cancel&setup=cs_1'
    await render()
    expect(host.innerHTML).toContain("Card wasn't saved")
    expect(mocks.fetchCardSetup).not.toHaveBeenCalled()
  })
})
