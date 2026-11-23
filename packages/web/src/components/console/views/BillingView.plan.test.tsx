// @vitest-environment happy-dom
// The plan layout: hidden and unfetched without `subscriptions`; with it, Balance and Plan side by side, plan credits and the plan banners.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const PRO = { tierId: 'pro', tierName: 'Pro', optionId: 'standard', optionName: 'Standard' }
const TEAM = { tierId: 'team', tierName: 'Team', optionId: 'double', optionName: '×2' }
const FREE = { tierId: 'free', tierName: 'Free', optionId: 'standard', optionName: 'Standard' }
const SUB_OLD = {
  ...PRO,
  sessionLimit: 500,
  priceCents: 2000,
  grantMicro: 10_000_000,
  retentionDays: 30,
  paidThrough: '2026-12-04T00:00:00.000Z',
  scheduled: null
}
// A service with grants by expiry but no batches yet.
const SUB_GRANTS = {
  ...SUB_OLD,
  grants: [
    { expiresAt: '2026-12-04T00:00:00.000Z', remainingMicro: 1_750_000 },
    { expiresAt: '2027-01-04T00:00:00.000Z', remainingMicro: 10_000_000 }
  ],
  pendingChange: null,
  entitlementSync: 'synced'
}
const batch = (grantedAt: string, expiresAt: string, remainingMicro: number, expired = false) => ({
  grantedAt,
  grantedMicro: 10_000_000,
  remainingMicro,
  expiresAt,
  expired
})
const SUB = {
  ...SUB_GRANTS,
  planCreditMicro: 11_750_000,
  expiredThisMonthMicro: 775_000,
  batches: [
    batch('2026-09-04T00:00:00.000Z', '2026-11-04T00:00:00.000Z', 775_000, true),
    batch('2026-10-04T00:00:00.000Z', '2026-12-04T00:00:00.000Z', 1_750_000),
    batch('2026-11-04T00:00:00.000Z', '2027-01-04T00:00:00.000Z', 10_000_000)
  ]
}
const USAGE = {
  used: 120,
  limit: 500,
  policyRevision: 3,
  monthStart: '2026-11-01T00:00:00.000Z',
  resetsAt: '2026-12-01T00:00:00.000Z',
  asOf: '2026-11-23T10:00:00.000Z'
}

const mocks = vi.hoisted(() => ({
  role: 'owner',
  subscription: vi.fn<() => Promise<unknown>>(),
  sessions: vi.fn<() => Promise<unknown>>()
}))

vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({
    activeOrg: { id: 'org_example', name: 'example', slug: 'example' },
    myRole: mocks.role,
    orgPath: (p: string) => p,
    loading: false
  })
}))
vi.mock('next/navigation', () => ({
  usePathname: () => '/example/billing',
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams()
}))
vi.mock('@/lib/api', async () => ({
  ...(await vi.importActual<typeof import('@/lib/api')>('@/lib/api')),
  fetchAgents: async () => [],
  fetchSessionMonthUsage: mocks.sessions
}))
vi.mock('@/lib/billing-api', async () => ({
  ...(await vi.importActual<typeof import('@/lib/billing-api')>('@/lib/billing-api')),
  fetchBillingAccount: async () => ({ orgId: 'org_example', balanceMicro: 14_000_000, state: 'active' }),
  fetchBillingTransactions: async () => ({ items: [], nextCursor: null }),
  fetchBillingSubscription: mocks.subscription
}))

const { BillingError } = await import('@/lib/billing-api')
const BillingView = (await import('./BillingView')).default

let host: HTMLElement
let root: Root

async function settle() {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
  }
}

async function render(flags = 'billing,subscriptions') {
  ;(window as unknown as { __AC_ENV?: Record<string, string> }).__AC_ENV = { FEATURE_FLAGS: flags }
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
  await settle()
}

const text = () => host.textContent ?? ''
const q = (selector: string) => host.querySelector(selector)
const planCard = () => q('[data-plan-card]')!
const balanceCard = () => q('[data-balance-card]')!
const buttonIn = (el: Element, label: string) => [...el.querySelectorAll('button')].find((b) => b.textContent === label)

async function openCredits() {
  await act(async () => (q('[data-plan-credits]') as HTMLButtonElement).click())
  return q('[data-plan-credits-dialog]')!
}
const creditRows = (dialog: Element) =>
  [...dialog.querySelectorAll('[data-credit-row]')].map((row) => ({
    tag: row.getAttribute('data-credit-row'),
    cells: [...row.children].map((c) => c.textContent)
  }))

beforeEach(() => {
  mocks.role = 'owner'
  mocks.subscription.mockReset().mockResolvedValue(SUB)
  mocks.sessions.mockReset().mockResolvedValue(USAGE)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  ;(window as unknown as { __AC_ENV?: Record<string, string> }).__AC_ENV = {}
})

describe('BillingView plan, flag off', () => {
  it('shows the page as before and asks for nothing plan-related', async () => {
    await render('billing')
    expect(text()).toContain('$14.00')
    expect(text()).toContain('Last deduction')
    expect(q('#add-credits')).not.toBeNull()
    expect(q('[data-plan-card],[data-balance-card],[data-plan-credits],[data-plan-banner]')).toBeNull()
    expect(mocks.subscription).not.toHaveBeenCalled()
    expect(mocks.sessions).not.toHaveBeenCalled()
  })

  it('stays off with only `subscriptions`, since the page itself needs `billing`', async () => {
    await render('subscriptions')
    expect(text()).toContain('Billing applies to AgentConnect Cloud')
    expect(mocks.subscription).not.toHaveBeenCalled()
  })
})

describe('BillingView plan layout', () => {
  it('puts Balance and Plan side by side and drops the blocks the design does not have', async () => {
    await render()
    expect(balanceCard().parentElement).toBe(planCard().parentElement)
    expect(balanceCard().textContent).toContain('$14.00')
    expect(balanceCard().textContent).toContain('Serving')
    expect(q('#add-credits')).toBeNull()
    for (const gone of ['Last deduction', 'Alert threshold', 'Compare plans', 'Invoices'])
      expect(text()).not.toContain(gone)
    // The ledger stays below.
    expect(text()).toContain('Transactions')
  })

  it('names the plan, its price and renewal, and this month’s sessions', async () => {
    await render()
    expect(q('[data-plan-name]')!.textContent).toBe('ProStandard')
    expect(q('[data-plan-price]')!.textContent).toBe('$20 / month · renews Dec 4')
    const sessions = q('[data-plan-sessions]')!.textContent
    expect(sessions).toContain('Sessions this month')
    expect(sessions).toContain('120 / 500')
    expect(sessions).toContain('Resets Dec 1')
    expect(q('[data-plan-meter]')!.getAttribute('data-plan-meter')).toBe('brand')
    expect(q('[data-plan-scheduled]')).toBeNull()
    expect(q('[data-plan-banner]')).toBeNull()
  })

  it('gives owners Add credits as a dialog and Change plan in the Plan card', async () => {
    await render()
    expect(text()).not.toContain('Owners add credits')
    expect(text()).not.toContain('Owners change the plan')
    expect(buttonIn(planCard(), 'Change plan')).toBeDefined()
    await act(async () => buttonIn(balanceCard(), 'Add credits')!.click())
    const dialog = q('[role="dialog"]')!
    expect(dialog.getAttribute('aria-label')).toBe('Add credits')
    expect(buttonIn(dialog, '$50')).toBeDefined()
  })

  it('tells members who adds credits and who changes the plan', async () => {
    mocks.role = 'member'
    await render()
    expect(balanceCard().textContent).toContain('Owners add credits')
    expect(buttonIn(balanceCard(), 'Add credits')).toBeUndefined()
    expect(planCard().textContent).toContain('Owners change the plan')
    expect(buttonIn(planCard(), 'Change plan')).toBeUndefined()
    expect(text()).not.toContain('Ask an org owner to top up')
  })

  it('reads a renewal scheduled to Free as the plan ending', async () => {
    mocks.subscription.mockResolvedValue({ ...SUB, scheduled: FREE })
    await render()
    expect(q('[data-plan-price]')!.textContent).toBe('$20 / month · ends Dec 4')
    expect(q('[data-plan-scheduled]')!.textContent).toBe('Switching to Free on Dec 4Cancel')
  })

  it('names a scheduled change to another plan under the row, with no Cancel for a member', async () => {
    mocks.role = 'member'
    mocks.subscription.mockResolvedValue({ ...SUB, scheduled: TEAM })
    await render()
    expect(q('[data-plan-price]')!.textContent).toBe('$20 / month · renews Dec 4')
    expect(q('[data-plan-scheduled]')!.textContent).toBe('Switching to Team ×2 on Dec 4')
    expect(q('[data-plan-scheduled] button')).toBeNull()
  })

  it('shows Free at its price with no plan credits', async () => {
    mocks.subscription.mockResolvedValue({ ...SUB, ...FREE, priceCents: 0, grantMicro: 0, paidThrough: null })
    await render()
    expect(q('[data-plan-name]')!.textContent).toBe('Free')
    expect(q('[data-plan-price]')!.textContent).toBe('$0 / month')
    expect(q('[data-plan-credits]')).toBeNull()
  })

  it('shows a contract as contract pricing ending on its end date, with nothing scheduled', async () => {
    mocks.subscription.mockResolvedValue({ ...SUB, priceCents: null, scheduled: null })
    await render()
    expect(q('[data-plan-price]')!.textContent).toBe('Contract pricing · ends Dec 4')
  })

  it('says there is no plan when the org has none, and keeps the sessions', async () => {
    mocks.subscription.mockResolvedValue(null)
    await render()
    expect(q('[data-plan-none]')!.textContent).toContain('No plan yet')
    expect(q('[data-plan-sessions]')!.textContent).toContain('120 / 500')
    expect(q('[data-plan-credits]')).toBeNull()
  })

  it('shows a pending payment and its link to a member, and says when limits are updating', async () => {
    mocks.role = 'member'
    mocks.subscription.mockResolvedValue({
      ...SUB,
      pendingChange: {
        id: 'c1',
        kind: 'upgrade',
        tierId: 'team',
        optionId: 'standard',
        payUrl: 'https://billing.example.test/pay'
      },
      entitlementSync: 'syncing'
    })
    await render()
    const pending = q('[data-plan-banner="pending"]')!
    expect(pending.textContent).toContain('Your plan upgrade is waiting for payment')
    const link = pending.querySelector('a')!
    expect(link.getAttribute('href')).toBe('https://billing.example.test/pay')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toContain('noopener')
    expect(q('[data-plan-syncing]')!.textContent).toBe('Limits updating')
  })

  it('keeps the rest of the page when the plan read fails', async () => {
    mocks.subscription.mockRejectedValue(new BillingError('plan service down', 500))
    await render()
    expect(planCard().textContent).toContain("Couldn't load this organization's plan: plan service down")
    expect(q('[data-plan-sessions]')).not.toBeNull()
    expect(q('[data-plan-credits]')).toBeNull()
    expect(balanceCard().textContent).toContain('$14.00')
  })

  it('hides only the sessions block when that read fails', async () => {
    mocks.sessions.mockRejectedValue(new Error('down'))
    await render()
    expect(q('[data-plan-sessions]')).toBeNull()
    expect(q('[data-plan-price]')!.textContent).toContain('$20 / month')
  })

  it('drops the meter when the org has no limit', async () => {
    mocks.sessions.mockResolvedValue({ ...USAGE, limit: null })
    await render()
    expect(q('[data-plan-sessions]')!.textContent).toContain('Sessions this month120Resets')
    expect(q('[data-plan-meter]')).toBeNull()
  })
})

describe('BillingView history retention', () => {
  const retention = (days: number | null, next: unknown = null) => ({ days, next, shortenHoldDays: 7 })
  const DATED = { days: 7, from: '2026-12-11T00:00:00.000Z', awaitingNotice: false }
  const AWAITING = { days: 7, from: null, awaitingNotice: true }

  it('shows the window in force beside the price, with no notice when nothing is pending', async () => {
    mocks.subscription.mockResolvedValue({ ...SUB, retentionDays: null, retention: retention(null) })
    await render()
    expect(q('[data-plan-price]')!.textContent).toBe('$20 / month · renews Dec 4')
    expect(q('[data-plan-retention]')!.textContent).toBe(' · Unlimited history')
    expect(q('[data-plan-retention-next]')).toBeNull()
  })

  it('reads the window in force, not the plan’s, while a shorter one waits', async () => {
    mocks.subscription.mockResolvedValue({
      ...SUB,
      ...FREE,
      priceCents: 0,
      grantMicro: 0,
      paidThrough: null,
      retentionDays: 7,
      retention: retention(null, DATED)
    })
    await render()
    expect(q('[data-plan-retention]')!.textContent).toBe(' · Unlimited history')
  })

  it('dates the deletion in amber and points an owner at Change plan', async () => {
    mocks.subscription.mockResolvedValue({ ...SUB, scheduled: FREE, retention: retention(null, DATED) })
    await render()
    const strip = q('[data-plan-retention-next]')!
    expect(strip.getAttribute('data-plan-retention-next')).toBe('dated')
    expect(strip.className).toContain('border-(--amber-500)')
    expect(strip.textContent).toBe(
      'History older than 7 days will be deleted from Dec 11.Upgrading keeps your history.Change plan'
    )
    // The scheduled change keeps its own strip above.
    expect(q('[data-plan-scheduled]')!.textContent).toBe('Switching to Free on Dec 4Cancel')
  })

  it('tells a member the date with no plan action', async () => {
    mocks.role = 'member'
    mocks.subscription.mockResolvedValue({ ...SUB, retention: retention(null, DATED) })
    await render()
    const strip = q('[data-plan-retention-next]')!
    expect(strip.textContent).toBe('History older than 7 days will be deleted from Dec 11.')
    expect(strip.querySelector('button')).toBeNull()
  })

  it('promises an email first while the service is still to send the notice', async () => {
    mocks.subscription.mockResolvedValue({ ...SUB, retention: retention(30, AWAITING) })
    await render()
    const strip = q('[data-plan-retention-next]')!
    expect(strip.getAttribute('data-plan-retention-next')).toBe('awaiting')
    expect(strip.textContent).toContain(
      "History retention will shorten to 7 days; you'll be emailed at least 30 days before."
    )
    expect(strip.className).not.toContain('amber')
    expect(q('[data-plan-retention]')!.textContent).toBe(' · 30-day history')
  })

  it('falls back to the plan’s window on an older service and shows no notice', async () => {
    mocks.subscription.mockResolvedValue(SUB_OLD)
    await render()
    expect(q('[data-plan-retention]')!.textContent).toBe(' · 30-day history')
    expect(q('[data-plan-retention-next]')).toBeNull()
  })
})

describe('BillingView session meter and limit', () => {
  it.each([
    [399, 'brand'],
    [400, 'amber'],
    [499, 'amber'],
    [500, 'red'],
    [520, 'red']
  ])('colours %i of 500 sessions %s', async (used, tone) => {
    mocks.sessions.mockResolvedValue({ ...USAGE, used })
    await render()
    expect(q('[data-plan-meter]')!.getAttribute('data-plan-meter')).toBe(tone)
  })

  it('raises the limit-reached banner at the limit, with no action for a member', async () => {
    mocks.role = 'member'
    mocks.sessions.mockResolvedValue({ ...USAGE, used: 500 })
    await render()
    const banner = q('[data-plan-banner="session-limit"]')!
    expect(banner.textContent).toContain('Session limit reached')
    expect(banner.textContent).toContain(
      'New sessions resume Dec 1. Existing sessions continue and still need balance.'
    )
    expect(banner.querySelector('button,a')).toBeNull()
  })

  it('keeps the banner away below the limit', async () => {
    mocks.sessions.mockResolvedValue({ ...USAGE, used: 499 })
    await render()
    expect(q('[data-plan-banner="session-limit"]')).toBeNull()
  })
})

describe('BillingView plan credits', () => {
  it('splits the balance and flags credit expiring this cycle', async () => {
    await render()
    const strip = q('[data-plan-credits]')!
    expect(strip.textContent).toContain('Plan credits$11.75')
    expect(strip.textContent).toContain('Top-ups$2.25')
    expect(strip.textContent).toContain('Expiring Dec 4$1.75')
    expect(strip.querySelector('[data-soon]')).not.toBeNull()
  })

  it('does not flag credit that outlives the current cycle', async () => {
    mocks.subscription.mockResolvedValue({ ...SUB, batches: SUB.batches.filter((b) => b.expiresAt > '2026-12-05') })
    await render()
    expect(q('[data-plan-credits]')!.textContent).toContain('Expiring Jan 4$10.00')
    expect(q('[data-plan-credits] [data-soon]')).toBeNull()
  })

  it('lists every cycle with its tag, live first and the expired one struck through', async () => {
    await render()
    const dialog = await openCredits()
    expect(dialog.textContent).toContain('Plan credits')
    expect(dialog.textContent).toContain('Expires (UTC)')
    expect(creditRows(dialog)).toEqual([
      { tag: 'next', cells: ['Oct 4 cycleexpires next', '$10.00', '$1.75', 'Dec 4, 00:00'] },
      { tag: 'active', cells: ['Nov 4 cycleactive', '$10.00', '$10.00', 'Jan 4, 00:00'] },
      { tag: 'expired', cells: ['Sep 4 cycleexpired', '$10.00', '$0.78', 'Nov 4, 00:00'] }
    ])
    expect(dialog.querySelector('[data-credit-row="expired"] .line-through')!.textContent).toBe('$0.78')
    expect(dialog.textContent).toContain('Earliest-expiring credits are used first, then top-ups.')
    await act(async () => (dialog.querySelector('button[aria-label="Close"]') as HTMLButtonElement).click())
    expect(q('[data-plan-credits-dialog]')).toBeNull()
  })

  it('falls back to grants on an older service: no cycle, no granted amount, no expired row', async () => {
    mocks.subscription.mockResolvedValue(SUB_GRANTS)
    await render()
    expect(q('[data-plan-credits]')!.textContent).toContain('Plan credits$11.75')
    expect(q('[data-plan-credits]')!.textContent).toContain('Expiring Dec 4$1.75')
    const dialog = await openCredits()
    expect(creditRows(dialog)).toEqual([
      { tag: 'next', cells: ['—expires next', '—', '$1.75', 'Dec 4, 00:00'] },
      { tag: 'active', cells: ['—active', '—', '$10.00', 'Jan 4, 00:00'] }
    ])
  })

  it('shows no strip when the service sends no plan credit at all', async () => {
    mocks.subscription.mockResolvedValue(SUB_OLD)
    await render()
    expect(q('[data-plan-credits]')).toBeNull()
    expect(q('[data-plan-price]')!.textContent).toBe('$20 / month · renews Dec 4')
  })
})
