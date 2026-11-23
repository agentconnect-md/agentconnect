// @vitest-environment happy-dom
// The read-only plan blocks: hidden and unfetched without `subscriptions`, rendered from the service's shapes, failing per block.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const PRO = { tierId: 'pro', tierName: 'Pro', optionId: 'standard', optionName: 'Standard' }
const TEAM = { tierId: 'team', tierName: 'Team', optionId: 'standard', optionName: 'Standard' }
const FREE = { tierId: 'free', tierName: 'Free', optionId: 'standard', optionName: 'Standard' }
const SUB_OLD = {
  ...PRO,
  sessionLimit: 500,
  priceCents: 2000,
  grantMicro: 10_000_000,
  retentionDays: 30,
  paidThrough: '2026-12-01T00:00:00.000Z',
  scheduled: null
}
const SUB = {
  ...SUB_OLD,
  grants: [{ expiresAt: '2026-12-01T00:00:00.000Z', remainingMicro: 4_000_000 }],
  pendingChange: null,
  entitlementSync: 'synced'
}
const option = (ref: typeof PRO, extra: Record<string, unknown>) => ({
  ...ref,
  salesMode: 'self_serve',
  priceCents: 0,
  grantMicro: 0,
  sessionLimit: 50,
  multiplier: null,
  retentionDays: 7,
  purchasable: false,
  current: false,
  scheduled: false,
  ...extra
})
const PLANS = {
  options: [
    option(FREE, {}),
    option(PRO, { priceCents: 2000, grantMicro: 10_000_000, sessionLimit: 500, retentionDays: 30, current: true }),
    option(
      { ...PRO, optionId: 'double', optionName: 'Double' },
      { priceCents: 4000, sessionLimit: 1000, multiplier: 2 }
    ),
    option(TEAM, { priceCents: 9900, sessionLimit: 5000, retentionDays: 90 }),
    option(
      { tierId: 'enterprise', tierName: 'Enterprise', optionId: 'custom', optionName: 'Custom' },
      {
        salesMode: 'contact_sales',
        priceCents: null,
        retentionDays: null
      }
    )
  ]
}
const invoice = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  number: `EX-${id}`,
  status: 'paid',
  amountDueCents: 2000,
  amountPaidCents: 2000,
  currency: 'usd',
  periodStart: '2026-11-01T00:00:00.000Z',
  periodEnd: '2026-12-01T00:00:00.000Z',
  createdAt: '2026-11-01T00:05:00.000Z',
  hostedUrl: `https://billing.example.test/i/${id}`,
  ...extra
})
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
  plans: vi.fn<() => Promise<unknown>>(),
  invoices: vi.fn<(orgId: string, cursor?: string) => Promise<unknown>>(),
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
  fetchBillingSubscription: mocks.subscription,
  fetchBillingPlans: mocks.plans,
  fetchBillingInvoices: mocks.invoices
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

async function render(flags: string) {
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
const block = (name: string) => host.querySelector(`[data-plan-${name}]`)

beforeEach(() => {
  mocks.role = 'owner'
  mocks.subscription.mockReset().mockResolvedValue(SUB)
  mocks.plans.mockReset().mockResolvedValue(PLANS)
  mocks.invoices.mockReset().mockResolvedValue({ items: [invoice('1')], nextCursor: null })
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
    expect(host.querySelector('[data-plan-current],[data-plan-compare],[data-plan-invoices]')).toBeNull()
    expect(mocks.subscription).not.toHaveBeenCalled()
    expect(mocks.plans).not.toHaveBeenCalled()
    expect(mocks.invoices).not.toHaveBeenCalled()
    expect(mocks.sessions).not.toHaveBeenCalled()
  })

  it('stays off with only `subscriptions`, since the page itself needs `billing`', async () => {
    await render('subscriptions')
    expect(text()).toContain('Billing applies to AgentConnect Cloud')
    expect(mocks.subscription).not.toHaveBeenCalled()
  })
})

describe('BillingView plan, both flags on', () => {
  it('renders the current plan, its credit and the session count', async () => {
    await render('billing,subscriptions')
    const plan = block('current')!.textContent!
    expect(plan).toContain('Pro')
    expect(plan).toContain('Standard')
    expect(plan).toContain('$20.00 / month')
    expect(plan).toContain('30 days')
    expect(plan).toContain('$10.00')
    expect(plan).toContain('120 / 500')
    expect(plan).toContain('Resets Dec 1, 2026')
    expect(plan).toContain('$20.00 on Dec 1, 2026')
    expect(block('credit')!.textContent).toContain('$4.00')
    expect(block('credit')!.textContent).toContain('Expires Dec 1, 2026')
    expect(block('credit')!.textContent).toContain('Included in your available balance.')
    expect(block('scheduled')).toBeNull()
    expect(block('pending')).toBeNull()
    expect(block('syncing')).toBeNull()
    // The balance and ledger render beside it.
    expect(text()).toContain('$14.00')
    expect(text()).toContain('Transactions')
  })

  it('compares every tier with its prices, limits and badges', async () => {
    await render('billing,subscriptions')
    const tiers = [...host.querySelectorAll('[data-plan-tier]')].map((el) => el.getAttribute('data-plan-tier'))
    expect(tiers).toEqual(['free', 'pro', 'team', 'enterprise'])
    const pro = host.querySelector('[data-plan-option="pro/standard"]')!.textContent!
    expect(pro).toContain('Current')
    expect(pro).toContain('$20.00 / month')
    const double = host.querySelector('[data-plan-option="pro/double"]')!.textContent!
    expect(double).toContain('×2')
    expect(double).toContain('1,000')
    expect(host.querySelector('[data-plan-option="free/standard"]')!.textContent).toContain('Free')
    const enterprise = host.querySelector('[data-plan-option="enterprise/custom"]')!.textContent!
    expect(enterprise).toContain('Contact sales')
    expect(enterprise).toContain('Per contract')
    expect(enterprise).not.toContain('$0.00')
    expect(enterprise).toContain('Unlimited')
    expect(block('compare')!.querySelector('button')).toBeNull()
  })

  it('names a scheduled change and charges its price at renewal', async () => {
    mocks.subscription.mockResolvedValue({ ...SUB, scheduled: TEAM })
    mocks.plans.mockResolvedValue({
      options: PLANS.options.map((o) => (o.tierId === 'team' ? { ...o, scheduled: true } : o))
    })
    await render('billing,subscriptions')
    expect(block('scheduled')!.textContent).toBe('Changes to Team · Standard on Dec 1, 2026')
    expect(block('current')!.textContent).toContain('$99.00 on Dec 1, 2026')
    expect(host.querySelector('[data-plan-option="team/standard"]')!.textContent).toContain('Scheduled')
  })

  it('reads a renewal scheduled to Free as a cancellation, with no next charge', async () => {
    mocks.subscription.mockResolvedValue({ ...SUB, scheduled: FREE })
    await render('billing,subscriptions')
    expect(block('scheduled')!.textContent).toBe('Cancels on Dec 1, 2026')
    expect(block('current')!.textContent).not.toContain('$20.00 on')
  })

  it('shows a pending change and its pay link to a member, and says when limits are updating', async () => {
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
    await render('billing,subscriptions')
    const pending = block('pending')!
    expect(pending.textContent).toContain('Upgrade to Team · Standard is waiting for payment')
    const link = pending.querySelector('a')!
    expect(link.getAttribute('href')).toBe('https://billing.example.test/pay')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toContain('noopener')
    expect(block('syncing')!.textContent).toBe('Limits updating')
  })

  it('renders an older service plan without grants, pending changes or sync', async () => {
    mocks.subscription.mockResolvedValue(SUB_OLD)
    await render('billing,subscriptions')
    expect(block('current')!.textContent).toContain('$20.00 / month')
    expect(block('credit')).toBeNull()
    expect(block('pending')).toBeNull()
    expect(block('syncing')).toBeNull()
  })

  it('says there is no plan when the org has none', async () => {
    mocks.subscription.mockResolvedValue(null)
    await render('billing,subscriptions')
    expect(block('current')!.textContent).toContain('No plan yet')
    expect(block('current')!.textContent).toContain('120 / 500')
  })

  it('hides only the session line when that read fails', async () => {
    mocks.sessions.mockRejectedValue(new Error('down'))
    await render('billing,subscriptions')
    expect(block('sessions')).toBeNull()
    expect(block('current')!.textContent).toContain('$20.00 / month')
  })

  it('drops the limit when the org has none', async () => {
    mocks.sessions.mockResolvedValue({ ...USAGE, limit: null })
    await render('billing,subscriptions')
    expect(block('sessions')!.textContent).toContain('Sessions this month120Resets')
  })

  it('keeps the rest of the page when the plan read fails', async () => {
    mocks.subscription.mockRejectedValue(new BillingError('plan service down', 500))
    await render('billing,subscriptions')
    expect(block('current')!.textContent).toContain("Couldn't load this organization's plan: plan service down")
    expect(block('compare')!.querySelectorAll('[data-plan-tier]')).toHaveLength(4)
    expect(text()).toContain('$14.00')
  })

  it('reports a failed catalog read in the catalog alone', async () => {
    mocks.plans.mockRejectedValue(new BillingError('catalog down', 500))
    await render('billing,subscriptions')
    expect(block('compare')!.textContent).toContain("Couldn't load plans: catalog down")
    expect(block('current')!.textContent).toContain('$20.00 on Dec 1, 2026')
  })
})

describe('BillingView invoices', () => {
  it('lists invoices with status, amount, period and a hosted link', async () => {
    mocks.invoices.mockResolvedValue({
      items: [invoice('2', { status: 'open', amountPaidCents: 0, amountDueCents: 9900 }), invoice('1')],
      nextCursor: null
    })
    await render('billing,subscriptions')
    const open = host.querySelector('[data-invoice="2"]')!
    expect(open.textContent).toContain('EX-2')
    expect(open.textContent).toContain('Open')
    expect(open.textContent).toContain('$99.00')
    expect(open.textContent).toContain('Nov 1, 2026 – Dec 1, 2026')
    expect(open.querySelector('a')!.getAttribute('target')).toBe('_blank')
    expect(host.querySelector('[data-invoice="1"]')!.textContent).toContain('Paid')
    expect(block('invoices')!.textContent).toContain('end of invoices')
  })

  it('pages with the cursor the service returned', async () => {
    mocks.invoices.mockImplementation(async (_org, cursor) =>
      cursor === 'c2' ? { items: [invoice('1')], nextCursor: null } : { items: [invoice('2')], nextCursor: 'c2' }
    )
    await render('billing,subscriptions')
    expect(host.querySelectorAll('[data-invoice]')).toHaveLength(1)
    const more = [...block('invoices')!.querySelectorAll('button')].find((b) => b.textContent === 'Load more')!
    await act(async () => more.click())
    await settle()
    expect(mocks.invoices).toHaveBeenLastCalledWith('org_example', 'c2')
    expect([...host.querySelectorAll('[data-invoice]')].map((el) => el.getAttribute('data-invoice'))).toEqual([
      '2',
      '1'
    ])
    expect(block('invoices')!.textContent).toContain('end of invoices')
  })

  it('says invoices are unavailable on a 503, and keeps the plan', async () => {
    mocks.invoices.mockRejectedValue(new BillingError('provider unavailable', 503))
    await render('billing,subscriptions')
    expect(host.querySelector('[data-invoices-unavailable]')!.textContent).toContain(
      'Invoices are unavailable right now.'
    )
    expect(block('current')!.textContent).toContain('$20.00 / month')
  })

  it('shows any other failure as a retryable error', async () => {
    mocks.invoices.mockRejectedValue(new BillingError('boom', 500))
    await render('billing,subscriptions')
    expect(block('invoices')!.textContent).toContain("Couldn't load invoices: boom")
    expect(host.querySelector('[data-invoices-unavailable]')).toBeNull()
  })
})
