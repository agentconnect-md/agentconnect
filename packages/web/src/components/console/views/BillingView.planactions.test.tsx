// @vitest-environment happy-dom
// The owner's plan actions: Change plan (choose → review → paying → done), Increase limit, the limit banner's CTA and revoking a scheduled change.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const option = (o: { tierId: string } & Record<string, unknown>) => ({
  optionId: 'standard',
  optionName: 'Standard',
  salesMode: 'self_serve',
  multiplier: null,
  retentionDays: null,
  purchasable: true,
  current: false,
  scheduled: false,
  ...o
})
const CATALOG = {
  options: [
    option({
      tierId: 'free',
      tierName: 'Free',
      priceCents: 0,
      grantMicro: 0,
      sessionLimit: 1000,
      retentionDays: 7,
      purchasable: false
    }),
    option({ tierId: 'pro', tierName: 'Pro', priceCents: 4000, grantMicro: 40_000_000, sessionLimit: 5000 }),
    option({
      tierId: 'pro',
      tierName: 'Pro',
      optionId: 'double',
      optionName: '×2',
      priceCents: 5000,
      grantMicro: 40_000_000,
      sessionLimit: 10000,
      multiplier: 2
    }),
    option({ tierId: 'max', tierName: 'Max', priceCents: 10000, grantMicro: 100_000_000, sessionLimit: 20000 }),
    option({
      tierId: 'business',
      tierName: 'Business',
      salesMode: 'contact_sales',
      priceCents: null,
      grantMicro: 0,
      sessionLimit: 50000,
      purchasable: false
    })
  ]
}
// The catalog as the service flags it for an org on `tierId`/`optionId`.
const catalogOn = (tierId: string, optionId = 'standard') => ({
  options: CATALOG.options.map((o) => ({ ...o, current: o.tierId === tierId && o.optionId === optionId }))
})

const PRO = {
  tierId: 'pro',
  tierName: 'Pro',
  optionId: 'standard',
  optionName: 'Standard',
  sessionLimit: 5000,
  priceCents: 4000,
  grantMicro: 40_000_000,
  retentionDays: null,
  paidThrough: '2026-12-04T00:00:00.000Z',
  scheduled: null,
  grants: [],
  pendingChange: null,
  entitlementSync: 'synced'
}
const PRO_DOUBLE = { ...PRO, optionId: 'double', optionName: '×2', sessionLimit: 10000, priceCents: 5000 }
const MAX = { ...PRO, tierId: 'max', tierName: 'Max', sessionLimit: 20000, priceCents: 10000, grantMicro: 100_000_000 }
const FREE = {
  ...PRO,
  tierId: 'free',
  tierName: 'Free',
  sessionLimit: 1000,
  priceCents: 0,
  grantMicro: 0,
  retentionDays: 7,
  paidThrough: null
}
const USAGE = {
  used: 120,
  limit: 5000,
  policyRevision: 3,
  monthStart: '2026-11-01T00:00:00.000Z',
  resetsAt: '2026-12-01T00:00:00.000Z',
  asOf: '2026-11-23T10:00:00.000Z'
}
const QUOTE = {
  quoteId: 'quote_1',
  tierId: 'pro',
  optionId: 'double',
  amountCents: 500,
  grantMicro: 0,
  expiresAt: '2999-01-01T00:00:00.000Z',
  paidThrough: '2026-12-04T00:00:00.000Z'
}
const change = (status: string, payUrl: string | null = null) => ({
  id: 'chg_1',
  status,
  tierId: 'pro',
  optionId: 'double',
  payUrl
})

const mocks = vi.hoisted(() => ({
  role: 'owner',
  search: '',
  subscription: vi.fn<() => Promise<unknown>>(),
  sessions: vi.fn<() => Promise<unknown>>(),
  plans: vi.fn<() => Promise<unknown>>(),
  quote: vi.fn<(orgId: string, args: unknown) => Promise<unknown>>(),
  confirm: vi.fn<(orgId: string, args: { quoteId: string; idempotencyKey: string }) => Promise<unknown>>(),
  getChange: vi.fn<() => Promise<unknown>>(),
  schedule: vi.fn<(orgId: string, args: unknown) => Promise<void>>(),
  revoke: vi.fn<() => Promise<void>>(),
  checkout: vi.fn<(orgId: string, args: Record<string, unknown>) => Promise<unknown>>(),
  assign: vi.fn()
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
  useSearchParams: () => new URLSearchParams(mocks.search)
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
  quoteBillingUpgrade: mocks.quote,
  confirmBillingUpgrade: mocks.confirm,
  fetchBillingSubscriptionChange: mocks.getChange,
  scheduleBillingChange: mocks.schedule,
  revokeBillingScheduledChange: mocks.revoke,
  createBillingSubscriptionCheckout: mocks.checkout
}))

const { BillingError } = await import('@/lib/billing-api')
const BillingView = (await import('./BillingView')).default

let host: HTMLElement
let root: Root

// Flushes renders and promises; under fake timers it also moves the clock by `ms`.
async function flush(ms = 0) {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(i === 0 ? ms : 0)
      else await new Promise((r) => setTimeout(r, 0))
    })
  }
}

async function render(flags = 'billing,subscriptions', env: Record<string, string> = {}) {
  ;(window as unknown as { __AC_ENV?: Record<string, string> }).__AC_ENV = { FEATURE_FLAGS: flags, ...env }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root.render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <BillingView />
      </SWRConfig>
    )
  })
  await flush()
}

const q = (selector: string) => host.querySelector(selector)
const dialog = () => q('[role="dialog"][data-plan-dialog]')
const step = () => dialog()?.getAttribute('data-plan-dialog')
const buttonIn = (el: Element, label: string) =>
  [...el.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement | undefined
async function click(el: Element | null | undefined) {
  expect(el).toBeTruthy()
  await act(async () => (el as HTMLElement).click())
  await flush()
}
const rows = () =>
  [...dialog()!.querySelectorAll('[data-quote-row]')].map((r) => [...r.children].map((c) => c.textContent))
const notes = () => [...dialog()!.querySelectorAll('[data-plan-note]')].map((n) => n.textContent)
const pressed = (attr: string) =>
  [...dialog()!.querySelectorAll(`[${attr}][aria-pressed="true"]`)].map((b) => b.getAttribute(attr))

async function openChangePlan() {
  await click(buttonIn(q('[data-plan-card]')!, 'Change plan'))
  expect(step()).toBe('choose')
}

beforeEach(() => {
  mocks.role = 'owner'
  mocks.search = ''
  mocks.subscription.mockReset().mockResolvedValue(PRO)
  mocks.sessions.mockReset().mockResolvedValue(USAGE)
  mocks.plans.mockReset().mockImplementation(async () => catalogOn('pro'))
  mocks.quote.mockReset().mockResolvedValue(QUOTE)
  mocks.confirm.mockReset().mockResolvedValue(change('completed'))
  mocks.getChange.mockReset().mockResolvedValue(change('completed'))
  mocks.schedule.mockReset().mockResolvedValue(undefined)
  mocks.revoke.mockReset().mockResolvedValue(undefined)
  mocks.checkout.mockReset().mockResolvedValue({ changeId: 'chg_1', url: 'https://checkout.example.test/c/1' })
  mocks.assign.mockReset()
  vi.spyOn(window.location, 'assign').mockImplementation(mocks.assign)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.useRealTimers()
  vi.restoreAllMocks()
  ;(window as unknown as { __AC_ENV?: Record<string, string> }).__AC_ENV = {}
})

describe('plan actions: who sees them', () => {
  it('gives owners Change plan and Increase limit, priced from the service’s quote', async () => {
    await render()
    expect(buttonIn(q('[data-plan-card]')!, 'Change plan')).toBeDefined()
    expect(q('[data-plan-increase]')!.textContent).toBe('Increase limit+$5.00 today')
    expect(mocks.quote).toHaveBeenCalledWith('org_example', { tierId: 'pro', optionId: 'double' })
  })

  it('gives members neither, and reads no catalog or quote for them', async () => {
    mocks.role = 'member'
    mocks.subscription.mockResolvedValue({
      ...PRO,
      scheduled: { tierId: 'free', tierName: 'Free', optionId: 'standard', optionName: 'Standard' }
    })
    await render()
    expect(buttonIn(q('[data-plan-card]')!, 'Change plan')).toBeUndefined()
    expect(q('[data-plan-increase]')).toBeNull()
    expect(q('[data-plan-scheduled] button')).toBeNull()
    expect(mocks.plans).not.toHaveBeenCalled()
    expect(mocks.quote).not.toHaveBeenCalled()
  })

  it('leaves the page unchanged and reads nothing plan-related with `subscriptions` off', async () => {
    await render('billing')
    expect(q('[data-plan-card]')).toBeNull()
    expect(mocks.plans).not.toHaveBeenCalled()
    expect(mocks.quote).not.toHaveBeenCalled()
    expect(mocks.subscription).not.toHaveBeenCalled()
  })
})

describe('Change plan: choose', () => {
  it('lists the tiers with their terms, the picked tier’s options, and holds Review on the current plan', async () => {
    await render()
    await openChangePlan()
    const tiers = [...dialog()!.querySelectorAll('[data-plan-tier]')]
    expect(tiers.map((x) => x.getAttribute('data-plan-tier'))).toEqual(['free', 'pro', 'max', 'business'])
    expect(tiers[0]!.textContent).toBe('Free$0/ monthTop-ups only1K sessions7-day history')
    expect(tiers[1]!.textContent).toBe('ProCurrentfrom $40/ month$40 credits / mo5K–10K sessionsUnlimited history')
    expect(tiers[3]!.textContent).toBe('BusinessCustomby contractCustom creditsCustom sessionsOrg SSO')
    expect(pressed('data-plan-tier')).toEqual(['pro'])
    const options = [...dialog()!.querySelectorAll('[data-plan-option]')].map((o) => o.textContent)
    expect(options).toEqual(['5,000$40 / mo · current', '10,000$50 / mo'])
    expect(buttonIn(dialog()!, 'Review change')!.disabled).toBe(true)
    await click(dialog()!.querySelector('[data-plan-option="double"]'))
    expect(dialog()!.querySelector('.modalfoot')!.textContent).toContain('Pro ×2 · 10,000 sessions')
    expect(buttonIn(dialog()!, 'Review change')!.disabled).toBe(false)
  })

  it('turns a contract tier into Contact us, linked to the deployment’s support address', async () => {
    await render('billing,subscriptions', { HELP_SUPPORT_URL: 'https://support.example.test/sales' })
    await openChangePlan()
    await click(dialog()!.querySelector('[data-plan-tier="business"]'))
    expect(dialog()!.textContent).toContain('Priced by contract — session limit, credits, retention and org SSO.')
    expect(dialog()!.querySelector('[data-plan-option]')).toBeNull()
    const contact = [...dialog()!.querySelectorAll('a')].find((a) => a.textContent === 'Contact us')!
    expect(contact.getAttribute('href')).toBe('https://support.example.test/sales')
    expect(buttonIn(dialog()!, 'Review change')).toBeUndefined()
  })

  it('tells an org on a contract that changes go through sales, with the contract’s end date', async () => {
    mocks.subscription.mockResolvedValue({ ...PRO, tierId: 'enterprise', tierName: 'Enterprise', priceCents: null })
    await render('billing,subscriptions', { HELP_SUPPORT_URL: 'https://support.example.test/sales' })
    await openChangePlan()
    expect(dialog()!.querySelector('[data-plan-tier]')).toBeNull()
    expect(dialog()!.querySelector('[data-plan-note]')!.textContent).toBe(
      "Enterprise Standard is a contract plan ending Dec 4, so it can't be changed here. Contact us to change or renew it."
    )
    const contact = [...dialog()!.querySelectorAll('a')].find((a) => a.textContent === 'Contact us')!
    expect(contact.getAttribute('href')).toBe('https://support.example.test/sales')
    expect(buttonIn(dialog()!, 'Review change')).toBeUndefined()
  })
})

describe('Change plan: an immediate upgrade', () => {
  it('reviews the server’s quote, pays it with an idempotency key, confirms and refreshes the plan', async () => {
    await render()
    await openChangePlan()
    await click(dialog()!.querySelector('[data-plan-option="double"]'))
    await click(buttonIn(dialog()!, 'Review change'))
    expect(step()).toBe('review')
    expect(mocks.quote).toHaveBeenLastCalledWith('org_example', { tierId: 'pro', optionId: 'double' })
    expect(dialog()!.querySelector('.modalhead')!.textContent).toContain('Upgrade')
    expect(dialog()!.textContent).toContain('CurrentPro Standard · 5,000 sessions')
    expect(dialog()!.textContent).toContain('NowPro ×2 · 10,000 sessions')
    expect(rows()).toEqual([
      ['Due today', '$5.00 (prorated)'],
      ['Credits added', '$0.00'],
      ['Sessions / month', '5,000 → 10,000'],
      ['Next charge', 'Dec 4 · $50.00']
    ])
    expect(notes()).toEqual([])

    let resolve!: (v: unknown) => void
    mocks.confirm.mockImplementation(() => new Promise((r) => (resolve = r)))
    const reads = mocks.subscription.mock.calls.length
    await click(buttonIn(dialog()!, 'Pay $5.00'))
    expect(step()).toBe('paying')
    expect(dialog()!.textContent).toContain('Confirming payment…')
    const [, args] = mocks.confirm.mock.calls[0]!
    expect(args.quoteId).toBe('quote_1')
    expect(args.idempotencyKey).toMatch(/\S{8,}/)

    await act(async () => resolve(change('completed')))
    await flush()
    expect(step()).toBe('done')
    expect(dialog()!.textContent).toContain('Upgraded to Pro ×2')
    expect(dialog()!.textContent).toContain('10,000 sessions / month')
    expect(mocks.subscription.mock.calls.length).toBeGreaterThan(reads)
    await click(buttonIn(dialog()!, 'Done'))
    expect(dialog()).toBeNull()
  })

  it.each([
    [
      { tierId: 'free', tierName: 'Free', optionId: 'standard', optionName: 'Standard' },
      'This upgrade withdraws your cancellation scheduled for Dec 4; the plan keeps renewing.'
    ],
    [
      { tierId: 'lite', tierName: 'Lite', optionId: 'standard', optionName: 'Standard' },
      'This upgrade replaces your change to Lite Standard scheduled for Dec 4.'
    ]
  ])('quotes an upgrade over a scheduled change and says the upgrade replaces it', async (scheduled, note) => {
    mocks.subscription.mockResolvedValue({ ...PRO, scheduled })
    await render()
    await openChangePlan()
    await click(dialog()!.querySelector('[data-plan-option="double"]'))
    await click(buttonIn(dialog()!, 'Review change'))
    expect(mocks.quote).toHaveBeenLastCalledWith('org_example', { tierId: 'pro', optionId: 'double' })
    expect(notes()).toEqual([note])
  })

  it('offers the provider page when the card needs action, and finishes once the poll says it settled', async () => {
    vi.useFakeTimers()
    mocks.confirm.mockResolvedValue(change('pending', 'https://pay.example.test/i/1'))
    mocks.getChange
      .mockResolvedValueOnce(change('pending', 'https://pay.example.test/i/1'))
      .mockResolvedValue(change('completed'))
    await render()
    await openChangePlan()
    await click(dialog()!.querySelector('[data-plan-option="double"]'))
    await click(buttonIn(dialog()!, 'Review change'))
    await click(buttonIn(dialog()!, 'Pay $5.00'))
    expect(step()).toBe('paying')
    const pay = [...dialog()!.querySelectorAll('a')].find((a) => a.textContent === 'Complete payment')!
    expect(pay.getAttribute('href')).toBe('https://pay.example.test/i/1')
    expect(pay.getAttribute('target')).toBe('_blank')
    await flush(2_500)
    expect(step()).toBe('paying')
    await flush(2_500)
    expect(step()).toBe('done')
    expect(mocks.getChange).toHaveBeenCalledTimes(2)
  })

  it('re-previews a stale quote instead of paying it, then pays the fresh one', async () => {
    mocks.confirm
      .mockRejectedValueOnce(new BillingError('this quote has expired; preview the upgrade again', 409))
      .mockResolvedValue(change('completed'))
    await render()
    // Set after the page's own Increase-limit preview took its quote.
    mocks.quote.mockResolvedValueOnce(QUOTE).mockResolvedValue({ ...QUOTE, quoteId: 'quote_2', amountCents: 520 })
    await openChangePlan()
    await click(dialog()!.querySelector('[data-plan-option="double"]'))
    await click(buttonIn(dialog()!, 'Review change'))
    await click(buttonIn(dialog()!, 'Pay $5.00'))
    expect(step()).toBe('review')
    expect(rows()[0]).toEqual(['Due today', '$5.20 (prorated)'])
    expect(notes()[0]).toContain('That quote expired, so this is a fresh one.')
    await click(buttonIn(dialog()!, 'Pay $5.20'))
    expect(mocks.confirm.mock.calls[1]![1].quoteId).toBe('quote_2')
    expect(mocks.confirm.mock.calls[1]![1].idempotencyKey).not.toBe(mocks.confirm.mock.calls[0]![1].idempotencyKey)
    expect(step()).toBe('done')
  })

  it('shows a refused quote inline and lets the owner try again', async () => {
    await render()
    mocks.quote.mockRejectedValueOnce(new BillingError('billing is unavailable', 503))
    await openChangePlan()
    await click(dialog()!.querySelector('[data-plan-option="double"]'))
    await click(buttonIn(dialog()!, 'Review change'))
    expect(dialog()!.querySelector('[role="alert"]')!.textContent).toBe('billing is unavailable')
    await click(buttonIn(dialog()!, 'Try again'))
    expect(buttonIn(dialog()!, 'Pay $5.00')).toBeDefined()
  })
})

describe('Change plan: changes at renewal', () => {
  it('schedules a downgrade with no quote and no charge', async () => {
    mocks.subscription.mockResolvedValue(PRO_DOUBLE)
    mocks.plans.mockImplementation(async () => catalogOn('pro', 'double'))
    await render()
    await openChangePlan()
    await click(dialog()!.querySelector('[data-plan-option="standard"]'))
    await click(buttonIn(dialog()!, 'Review change'))
    expect(dialog()!.querySelector('.modalhead')!.textContent).toContain('Schedule change')
    expect(dialog()!.textContent).toContain('Dec 4Pro Standard · 5,000 sessions')
    expect(rows()).toEqual([
      ['Due today', '$0.00'],
      ['Takes effect', 'Dec 4'],
      ['Sessions / month', '10,000 → 5,000'],
      ['Then', '$40.00 / mo']
    ])
    expect(notes()).toEqual(['Cancel anytime before Dec 4.'])
    const quotes = mocks.quote.mock.calls.length
    await click(buttonIn(dialog()!, 'Schedule'))
    expect(mocks.schedule).toHaveBeenCalledWith('org_example', { tierId: 'pro', optionId: 'standard' })
    expect(mocks.quote.mock.calls.length).toBe(quotes)
    expect(step()).toBe('done')
    expect(dialog()!.textContent).toContain('Scheduled for Dec 4')
    expect(dialog()!.textContent).toContain('Pro Standard · 5,000 sessions')
  })

  it('dates the history deletion from the service’s hold after the renewal, not the new window', async () => {
    mocks.subscription.mockResolvedValue({ ...PRO, retention: { days: null, next: null, shortenHoldDays: 14 } })
    await render()
    await openChangePlan()
    await click(dialog()!.querySelector('[data-plan-tier="free"]'))
    await click(buttonIn(dialog()!, 'Review change'))
    expect(notes()).toEqual(['History older than 7 days is deleted from Dec 18.', 'Cancel anytime before Dec 4.'])
  })

  it('warns of no deletion when the window in force is already that short', async () => {
    const pro7 = { ...PRO_DOUBLE, retention: { days: 7, next: null, shortenHoldDays: 14 } }
    mocks.subscription.mockResolvedValue(pro7)
    mocks.plans.mockImplementation(async () => catalogOn('pro', 'double'))
    await render()
    await openChangePlan()
    await click(dialog()!.querySelector('[data-plan-tier="free"]'))
    await click(buttonIn(dialog()!, 'Review change'))
    expect(notes()).toEqual(['Cancel anytime before Dec 4.'])
  })

  it('opens Change plan from the retention notice', async () => {
    const next = { days: 7, from: '2026-12-18T00:00:00.000Z', awaitingNotice: false }
    mocks.subscription.mockResolvedValue({ ...PRO, retention: { days: null, next, shortenHoldDays: 14 } })
    await render()
    await click(buttonIn(q('[data-plan-retention-next]')!, 'Change plan'))
    expect(step()).toBe('choose')
  })

  it('falls back to the new window after the renewal on an older service', async () => {
    await render()
    await openChangePlan()
    await click(dialog()!.querySelector('[data-plan-tier="free"]'))
    await click(buttonIn(dialog()!, 'Review change'))
    expect(rows()).toEqual([
      ['Due today', '$0.00'],
      ['Takes effect', 'Dec 4'],
      ['Sessions / month', '5,000 → 1,000']
    ])
    expect(notes()).toEqual(['History older than 7 days is deleted from Dec 11.', 'Cancel anytime before Dec 4.'])
    expect(dialog()!.querySelector('[data-plan-note="warn"]')).not.toBeNull()
    await click(buttonIn(dialog()!, 'Schedule'))
    expect(mocks.schedule).toHaveBeenCalledWith('org_example', { tierId: 'free', optionId: 'standard' })
  })

  it('shows a refused schedule inline and stays on the review', async () => {
    mocks.schedule.mockRejectedValue(new BillingError('a plan change for this organization has not settled yet', 409))
    await render()
    await openChangePlan()
    await click(dialog()!.querySelector('[data-plan-tier="free"]'))
    await click(buttonIn(dialog()!, 'Review change'))
    await click(buttonIn(dialog()!, 'Schedule'))
    expect(step()).toBe('review')
    expect(dialog()!.querySelector('[role="alert"]')!.textContent).toContain('has not settled yet')
  })

  it('revokes a scheduled change from the strip', async () => {
    const scheduled = {
      ...PRO,
      scheduled: { tierId: 'free', tierName: 'Free', optionId: 'standard', optionName: 'Standard' }
    }
    mocks.subscription.mockResolvedValue(scheduled)
    await render()
    mocks.subscription.mockResolvedValue(PRO)
    await click(buttonIn(q('[data-plan-scheduled]')!, 'Cancel'))
    expect(mocks.revoke).toHaveBeenCalledWith('org_example')
    expect(q('[data-plan-scheduled]')).toBeNull()
  })
})

describe('Change plan: first purchase from Free', () => {
  it('reviews the catalog price and hands off to the hosted checkout', async () => {
    mocks.subscription.mockResolvedValue(FREE)
    mocks.plans.mockImplementation(async () => catalogOn('free'))
    await render()
    expect(q('[data-plan-increase]')!.textContent).toBe('Increase limit')
    expect(mocks.quote).not.toHaveBeenCalled()
    await openChangePlan()
    await click(dialog()!.querySelector('[data-plan-tier="pro"]'))
    await click(buttonIn(dialog()!, 'Review change'))
    expect(dialog()!.querySelector('.modalhead')!.textContent).toContain('Upgrade')
    expect(rows()).toEqual([
      ['Due today', '$40.00'],
      ['Credits added', '+$40.00'],
      ['Sessions / month', '1,000 → 5,000']
    ])
    await click(buttonIn(dialog()!, 'Pay $40.00'))
    const [, args] = mocks.checkout.mock.calls[0]!
    expect(args).toMatchObject({ tierId: 'pro', optionId: 'standard', returnPath: '/example/billing' })
    expect(args.idempotencyKey).toEqual(expect.any(String))
    expect(mocks.assign).toHaveBeenCalledWith('https://checkout.example.test/c/1')
    expect(mocks.quote).not.toHaveBeenCalled()
  })

  it('confirms the plan by polling the change when the checkout returns', async () => {
    vi.useFakeTimers()
    mocks.search = 'checkout=success&subscriptionChange=chg_1'
    mocks.subscription.mockResolvedValue(FREE)
    mocks.plans.mockImplementation(async () => catalogOn('free'))
    mocks.getChange
      .mockResolvedValueOnce({ ...change('pending'), optionId: 'standard' })
      .mockResolvedValue({ ...change('completed'), optionId: 'standard' })
    await render()
    expect(step()).toBe('paying')
    expect(dialog()!.textContent).toContain('Confirming payment…')
    await flush(2_500)
    expect(step()).toBe('done')
    expect(dialog()!.textContent).toContain('Upgraded to Pro Standard')
    expect(dialog()!.textContent).toContain('5,000 sessions / month · +$40.00 credits')
    expect(mocks.getChange).toHaveBeenCalledWith('org_example', 'chg_1')
  })
})

describe('Increase limit', () => {
  it('opens Change plan on the next option of the same tier', async () => {
    await render()
    await click(q('[data-plan-increase] button'))
    expect(step()).toBe('choose')
    expect(pressed('data-plan-tier')).toEqual(['pro'])
    expect(pressed('data-plan-option')).toEqual(['double'])
  })

  it('steps to the next tier from a tier’s largest option, previewing only what the service quotes', async () => {
    mocks.subscription.mockResolvedValue(PRO_DOUBLE)
    mocks.plans.mockImplementation(async () => catalogOn('pro', 'double'))
    mocks.quote.mockResolvedValue({ ...QUOTE, tierId: 'max', optionId: 'standard', amountCents: 2500 })
    await render()
    expect(q('[data-plan-increase]')!.textContent).toBe('Increase limit+$25.00 today')
    await click(q('[data-plan-increase] button'))
    expect(pressed('data-plan-tier')).toEqual(['max'])
  })

  it('leads to contact sales at the top of the catalog', async () => {
    mocks.subscription.mockResolvedValue(MAX)
    mocks.plans.mockImplementation(async () => catalogOn('max'))
    await render()
    expect(q('[data-plan-increase]')!.textContent).toBe('Need more?Contact sales')
    expect(mocks.quote).not.toHaveBeenCalled()
    await click(q('[data-plan-increase] button'))
    expect(pressed('data-plan-tier')).toEqual(['business'])
    expect([...dialog()!.querySelectorAll('a')].some((a) => a.textContent === 'Contact us')).toBe(true)
  })

  it('gives the limit banner the Increase-limit entry, never Add credits', async () => {
    mocks.sessions.mockResolvedValue({ ...USAGE, used: 5000 })
    await render()
    const banner = q('[data-plan-banner="session-limit"]')!
    expect(buttonIn(banner, 'Add credits')).toBeUndefined()
    await click(buttonIn(banner, 'Increase limit'))
    expect(pressed('data-plan-option')).toEqual(['double'])
  })

  it('names the next tier in the banner on Free, and offers nothing at the top of the catalog', async () => {
    mocks.sessions.mockResolvedValue({ ...USAGE, used: 1000, limit: 1000 })
    mocks.subscription.mockResolvedValue(FREE)
    mocks.plans.mockImplementation(async () => catalogOn('free'))
    await render()
    await click(buttonIn(q('[data-plan-banner="session-limit"]')!, 'Upgrade to Pro'))
    expect(pressed('data-plan-tier')).toEqual(['pro'])
    expect(pressed('data-plan-option')).toEqual(['standard'])
  })

  it('offers no banner CTA at the top of the catalog', async () => {
    mocks.sessions.mockResolvedValue({ ...USAGE, used: 20000, limit: 20000 })
    mocks.subscription.mockResolvedValue(MAX)
    mocks.plans.mockImplementation(async () => catalogOn('max'))
    await render()
    expect(q('[data-plan-banner="session-limit"] button')).toBeNull()
  })
})
