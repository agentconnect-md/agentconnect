// @vitest-environment happy-dom
/**
 * The Transactions table's ledger-side filter. Two things are worth pinning: the side
 * reaches the SERVICE (the feed is keyset-paginated over both sides at once, so filtering a
 * page already fetched would leave the cursor and the loaded count describing other rows),
 * and the rows are cut again on arrival — a billing image that predates `?type=` answers
 * with the whole ledger, and showing top-ups under a pill that says Usage is a wrong answer,
 * not a stale one.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  fetchAccount: vi.fn(async () => ({ orgId: 'org-1', balanceMicro: 5_000_000, state: 'active' })),
  // The stale-service case on purpose: the whole ledger whatever was asked for.
  fetchTransactions: vi.fn(async () => ({
    items: [
      { type: 'credit', id: 'c1', kind: 'promo', amountMicro: 5_000_000, at: '2026-08-24T15:09:00Z' },
      { type: 'debit', id: 'd1', period: '2026-08', amount: '0.42', at: '2026-08-20T04:00:00Z' }
    ],
    nextCursor: null
  })),
  fetchSince: vi.fn(async () => [])
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
  fetchBillingTransactionsSince: mocks.fetchSince,
  fmtMicroUsd: (micro: number) => `$${micro / 1_000_000}`,
  fmtDecimalUsd: (amount: string) => `$${amount}`
}))

const BillingView = (await import('./BillingView')).default

let host: HTMLDivElement
let root: Root

beforeEach(async () => {
  mocks.fetchTransactions.mockClear()
  ;(window as unknown as { __AC_ENV?: Record<string, string> }).__AC_ENV = { FEATURE_FLAGS: 'billing' }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root.render(<BillingView />)
  })
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  ;(window as unknown as { __AC_ENV?: Record<string, string> }).__AC_ENV = {}
})

// Scoped to the Transactions card's own pillbar — the Activity chart's has a "Usage" pill
// too, and it comes first in the document.
async function clickPill(label: string) {
  const bar = [...host.querySelectorAll('.pillbar')].find((b) =>
    [...b.querySelectorAll('button')].some((x) => x.textContent === 'All')
  )
  const pill = [...(bar?.querySelectorAll('button') ?? [])].find((b) => b.textContent === label) as
    HTMLButtonElement | undefined
  expect(pill, `no "${label}" pill`).toBeTruthy()
  await act(async () => {
    pill!.click()
  })
}

describe('Transactions — the ledger-side filter', () => {
  it('asks the service for one side, and for the whole ledger by default', async () => {
    // The default view shares its key with the balance card's own unfiltered read, so it must
    // be the same request — one page one, not two spellings of it.
    expect(mocks.fetchTransactions).toHaveBeenCalledWith('org-1')

    await clickPill('Usage')
    expect(mocks.fetchTransactions).toHaveBeenCalledWith('org-1', undefined, { type: 'debit' })

    await clickPill('Top-ups')
    expect(mocks.fetchTransactions).toHaveBeenCalledWith('org-1', undefined, { type: 'credit' })
  })

  it('cuts a stale service’s rows to the side that was asked for', async () => {
    // The stub answers with both sides whatever the request said, which is exactly what a
    // billing image predating `?type=` does.
    expect(host.innerHTML).toContain('Promotional credit')
    expect(host.innerHTML).toContain('Usage — 2026-08')

    await clickPill('Usage')
    expect(host.innerHTML).not.toContain('Promotional credit')
    expect(host.innerHTML).toContain('Usage — 2026-08')

    await clickPill('Top-ups')
    expect(host.innerHTML).toContain('Promotional credit')
    expect(host.innerHTML).not.toContain('Usage — 2026-08')
  })

  it('keeps “last deduction” off the table’s filter', async () => {
    // It is a fact about the ACCOUNT, not about whichever side is on screen — reading it off
    // the table's rows had it vanish the moment someone filtered to Top-ups.
    const posted = /Last deduction<\/div><div class="[^"]*">([^<]*)</
    const before = posted.exec(host.innerHTML)?.[1]
    expect(before).not.toBe('—')

    await clickPill('Top-ups')
    expect(posted.exec(host.innerHTML)?.[1]).toBe(before)
  })
})
