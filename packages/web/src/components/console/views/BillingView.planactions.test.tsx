// @vitest-environment happy-dom
// The owner's plan actions: Change plan (choose → review → paying → done), Increase limit, the limit banner's CTA, revoking a scheduled change and cancelling an unpaid upgrade.
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
  cancelChange: vi.fn<(orgId: string, id: string) => Promise<void>>(),
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
  cancelBillingSubscriptionChange: mocks.cancelChange,
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
  [...dialog()!.querySelectorAll('[data-quote-row]')].map((r) =>
    [...r.children].map((c) =>
      c.childElementCount ? [...c.children].map((child) => child.textContent).join(' ') : c.textContent
    )
  )
const resultRows = () =>
  [...dialog()!.querySelectorAll('[data-plan-done] dl > div')].map((r) => [...r.children].map((c) => c.textContent))
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
  mocks.cancelChange.mockReset().mockResolvedValue(undefined)
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
  it('shows every tier’s terms and the selected plan’s details without a comparison toggle', async () => {
    await render()
    await openChangePlan()
    const tiers = [...dialog()!.querySelectorAll('[data-plan-tier]')]
    expect(tiers.map((x) => x.getAttribute('data-plan-tier'))).toEqual(['free', 'pro', 'max', 'business'])
    expect(tiers[0]!.textContent).toBe('Free$0/ mo1K sessionsTop-ups only7-day history')
    expect(tiers[1]!.textContent).toBe('ProCurrentFrom $40/ mo5K–10K sessions$40 credits / moUnlimited history')
    expect(tiers[3]!.textContent).toBe('BusinessCustomby contractCustom sessionsCustom creditsOrg SSO')
    expect(buttonIn(dialog()!, 'Compare details')).toBeUndefined()
    expect(pressed('data-plan-tier')).toEqual(['pro'])
    expect(dialog()!.textContent).toContain('Pro details$40 credits / mo · Unlimited history')
    const options = [...dialog()!.querySelectorAll('[data-plan-option]')].map((o) => o.textContent)
    expect(options).toEqual(['5,000 sessions$40 / mo · current', '10,000 sessions$50 / mo'])
    expect(buttonIn(dialog()!, 'Review change')!.disabled).toBe(true)
    await click(dialog()!.querySelector('[data-plan-option="double"]'))
    await click(tiers[1])
    expect(pressed('data-plan-option')).toEqual(['double'])
    expect(dialog()!.querySelector('.modalfoot')!.textContent).toContain('Pro ×2 · 10,000 sessions')
    expect(buttonIn(dialog()!, 'Review change')!.disabled).toBe(false)
    await click(tiers[0])
    expect(dialog()!.textContent).toContain('Free detailsTop-ups only · 7-day history')
    expect(dialog()!.querySelector('[data-plan-option]')).toBeNull()
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
    expect(dialog()!.querySelector('[data-plan-contract]')!.textContent).toBe(
      "CurrentEnterprise StandardContractSessions / month5,000EndsDec 4Contract plans are managed by our sales team and can't be changed here. Contact us to change the plan or renew it."
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
    expect(dialog()!.querySelector('.modalhead')!.textContent).toContain('Review upgrade')
    expect(dialog()!.textContent).toContain('Current planPro Standard')
    expect(dialog()!.textContent).toContain('New planPro ×2')
    expect(rows()).toEqual([
      ['Due today', '$5.00 Prorated'],
      ['Next charge', 'Dec 4 · $50.00'],
      ['Sessions / month', '5,000 → 10,000'],
      ['Credits added', '$0.00']
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
    expect(dialog()!.textContent).toContain('Your Pro ×2 plan is active.')
    expect(resultRows()).toEqual([['Sessions / month', '10,000']])
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
    expect(rows()[0]).toEqual(['Due today', '$5.20 Prorated'])
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
    expect(dialog()!.querySelector('.modalhead')!.textContent).toContain('Review scheduled change')
    expect(dialog()!.textContent).toContain('New planPro Standard')
    expect(rows()).toEqual([
      ['Due today', '$0.00'],
      ['Takes effect', 'Dec 4'],
      ['Sessions / month', '10,000 → 5,000'],
      ['Monthly renewal', '$40.00 / mo']
    ])
    expect(notes()).toEqual(['Cancel anytime before Dec 4.'])
    const quotes = mocks.quote.mock.calls.length
    await click(buttonIn(dialog()!, 'Schedule'))
    expect(mocks.schedule).toHaveBeenCalledWith('org_example', { tierId: 'pro', optionId: 'standard' })
    expect(mocks.quote.mock.calls.length).toBe(quotes)
    expect(step()).toBe('done')
    expect(dialog()!.textContent).toContain('Scheduled for Dec 4')
    expect(resultRows()).toEqual([
      ['New plan', 'Pro Standard'],
      ['Sessions / month', '5,000']
    ])
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

describe('a pending upgrade', () => {
  const pending = (kind: 'upgrade' | 'checkout') => ({
    ...PRO,
    pendingChange: { id: 'chg_1', kind, tierId: 'pro', optionId: 'double', payUrl: 'https://pay.example.test/i/1' }
  })
  const banner = () => q('[data-plan-banner="pending"]')
  const cancelButton = () => banner()?.querySelector<HTMLButtonElement>('[data-plan-pending-cancel]') ?? null

  const confirmDialog = () => banner()?.querySelector('[role="dialog"]') ?? null

  it('lets the owner cancel it after confirming in a dialog, and drops the banner on the reread', async () => {
    mocks.subscription.mockResolvedValue(pending('upgrade'))
    await render()
    expect(cancelButton()!.textContent).toBe('Cancel upgrade')
    await click(cancelButton())
    expect(confirmDialog()!.textContent).toContain('Its invoice is voided and your plan stays as it is.')
    await click(buttonIn(confirmDialog()!, 'Keep upgrade'))
    expect(confirmDialog()).toBeNull()
    expect(mocks.cancelChange).not.toHaveBeenCalled()
    mocks.subscription.mockResolvedValue(PRO)
    await click(cancelButton())
    await click(buttonIn(confirmDialog()!, 'Cancel upgrade'))
    expect(mocks.cancelChange).toHaveBeenCalledWith('org_example', 'chg_1')
    expect(banner()).toBeNull()
  })

  it('just rereads when the upgrade already settled', async () => {
    mocks.subscription.mockResolvedValue(pending('upgrade'))
    mocks.cancelChange.mockRejectedValue(new BillingError('the change is no longer pending', 409))
    await render()
    mocks.subscription.mockResolvedValue(PRO_DOUBLE)
    await click(cancelButton())
    await click(buttonIn(confirmDialog()!, 'Cancel upgrade'))
    expect(banner()).toBeNull()
    expect(q('[data-plan-name]')!.textContent).toContain('×2')
  })

  it('shows a refusal in the dialog and lets the owner try again', async () => {
    mocks.subscription.mockResolvedValue(pending('upgrade'))
    mocks.cancelChange.mockRejectedValue(new BillingError('billing is unavailable', 503))
    await render()
    await click(cancelButton())
    await click(buttonIn(confirmDialog()!, 'Cancel upgrade'))
    expect(confirmDialog()!.querySelector('[role="alert"]')!.textContent).toBe(
      "Couldn't cancel the upgrade: billing is unavailable"
    )
    expect(buttonIn(confirmDialog()!, 'Cancel upgrade')!.disabled).toBe(false)
  })

  it('offers no cancel on a pending checkout or to a member', async () => {
    mocks.subscription.mockResolvedValue(pending('checkout'))
    await render()
    expect(banner()).not.toBeNull()
    expect(cancelButton()).toBeNull()
    await act(async () => root.unmount())
    host.remove()
    mocks.role = 'member'
    mocks.subscription.mockResolvedValue(pending('upgrade'))
    await render()
    expect(banner()!.querySelector('a')).not.toBeNull()
    expect(cancelButton()).toBeNull()
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
    expect(dialog()!.querySelector('.modalhead')!.textContent).toContain('Review upgrade')
    expect(rows()).toEqual([
      ['Due today', '$40.00'],
      ['Monthly renewal', '$40.00 / mo'],
      ['Sessions / month', '1,000 → 5,000'],
      ['Credits added', '+$40.00']
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
    expect(dialog()!.textContent).toContain('Your Pro Standard plan is active.')
    expect(resultRows()).toEqual([
      ['Sessions / month', '5,000'],
      ['Credits added', '+$40.00']
    ])
    expect(mocks.getChange).toHaveBeenCalledWith('org_example', 'chg_1')
  })
})

// The catalog as the service serves it with plan sales paused: no paid self-serve option on sale.
const pausedOn = (tierId: string, keep?: string) => ({
  options: catalogOn(tierId).options.map((o) => ({
    ...o,
    purchasable: o.purchasable && `${o.tierId}/${o.optionId}` === keep
  }))
})
const pausedNote = () => dialog()!.querySelector('[data-plan-sales-paused]')?.textContent

describe('Change plan: plan sales paused', () => {
  it('says why nothing paid can be picked, marks the paid tiers and still schedules Free', async () => {
    mocks.plans.mockImplementation(async () => pausedOn('pro'))
    await render()
    await openChangePlan()
    expect(pausedNote()).toBe(
      'Plan purchases and upgrades are paused for now. You can still switch to Free at renewal, cancel a scheduled change and buy top-ups.'
    )
    const badged = [...dialog()!.querySelectorAll('[data-plan-tier]')]
      .filter((x) => x.textContent!.includes('Paused'))
      .map((x) => x.getAttribute('data-plan-tier'))
    expect(badged).toEqual(['pro', 'max'])
    await click(dialog()!.querySelector('[data-plan-option="double"]'))
    expect(buttonIn(dialog()!, 'Review change')!.disabled).toBe(true)
    await click(dialog()!.querySelector('[data-plan-tier="free"]'))
    await click(buttonIn(dialog()!, 'Review change'))
    await click(buttonIn(dialog()!, 'Schedule'))
    expect(mocks.schedule).toHaveBeenCalledWith('org_example', { tierId: 'free', optionId: 'standard' })
  })

  it('names only top-ups to an org on Free', async () => {
    mocks.subscription.mockResolvedValue(FREE)
    mocks.plans.mockImplementation(async () => pausedOn('free'))
    await render()
    await openChangePlan()
    expect(pausedNote()).toBe('Paid plans are paused for now. You can still buy top-ups.')
  })

  it('says nothing while one paid option is still on sale', async () => {
    mocks.plans.mockImplementation(async () => pausedOn('pro', 'max/standard'))
    await render()
    await openChangePlan()
    expect(pausedNote()).toBeUndefined()
    expect(dialog()!.textContent).not.toContain('Paused')
  })

  it('explains the pause behind Increase limit too', async () => {
    mocks.plans.mockImplementation(async () => pausedOn('pro'))
    await render()
    expect(mocks.quote).not.toHaveBeenCalled()
    await click(q('[data-plan-increase] button'))
    expect(step()).toBe('choose')
    expect(pausedNote()).toContain('paused for now')
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

describe('plan trial', () => {
  const TRIAL_END = '2026-12-10T10:00:00.000Z'
  // The catalog for an org the service finds eligible: only the Pro options carry trial days.
  const trialCatalog = () => ({
    options: catalogOn('free').options.map((o) => ({ ...o, trialDays: o.tierId === 'pro' ? 14 : null }))
  })
  const TRIAL = {
    ...PRO,
    paidThrough: TRIAL_END,
    trialEndsAt: TRIAL_END,
    trialCreditGranted: true,
    planCreditMicro: 6_000_000,
    batches: [
      {
        grantedAt: '2026-11-26T10:00:00.000Z',
        grantedMicro: 10_000_000,
        remainingMicro: 6_000_000,
        expiresAt: TRIAL_END,
        expired: false
      }
    ]
  }
  const FREE_REF = { tierId: 'free', tierName: 'Free', optionId: 'standard', optionName: 'Standard' }
  const footButtons = () => [...dialog()!.querySelectorAll('.modalfoot button')].map((b) => b.textContent)
  const card = () => q('[data-plan-card]')!

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-26T10:00:00.000Z'))
    sessionStorage.clear()
  })

  it('renders an older service, which sends no trial fields, exactly as it renders explicit nulls', async () => {
    const html: string[] = []
    for (const trial of [false, true]) {
      mocks.subscription.mockResolvedValue(trial ? { ...FREE, trialEndsAt: null, trialCreditGranted: null } : FREE)
      mocks.plans.mockImplementation(async () =>
        trial ? { options: catalogOn('free').options.map((o) => ({ ...o, trialDays: null })) } : catalogOn('free')
      )
      await render()
      await openChangePlan()
      await click(dialog()!.querySelector('[data-plan-tier="pro"]'))
      expect(footButtons()).toEqual(['Cancel', 'Review change'])
      expect(host.textContent).not.toMatch(/trial/i)
      // useId differs between mounts; everything else must match.
      html.push(host.innerHTML.replace(/_r_\w+_/g, '_r_'))
      await act(async () => root.unmount())
      host.remove()
    }
    expect(html[1]).toBe(html[0])
    host = document.createElement('div')
    root = createRoot(host)
  })

  it('offers a trial only on the options the service gives trial days, beside a plain subscribe', async () => {
    mocks.subscription.mockResolvedValue(FREE)
    mocks.plans.mockImplementation(async () => trialCatalog())
    await render()
    expect(q('[data-plan-increase]')!.textContent).toBe('Try Pro free for 14 days')
    await openChangePlan()
    const offers = [...dialog()!.querySelectorAll('[data-plan-trial-offer]')]
    expect(offers.map((o) => o.closest('[data-plan-tier]')!.getAttribute('data-plan-tier'))).toEqual(['pro'])
    expect(offers[0]!.textContent).toBe('14-day free trial')
    expect(footButtons()).toEqual(['Cancel', 'Review change'])
    await click(dialog()!.querySelector('[data-plan-tier="pro"]'))
    expect(dialog()!.querySelector('.modalfoot [role="status"]')!.textContent).toBe(
      '14 days free, then $40 / moPro Standard · 5,000 sessions'
    )
    expect(footButtons()).toEqual(['Cancel', 'Subscribe now', 'Start free trial'])
    await click(dialog()!.querySelector('[data-plan-tier="max"]'))
    expect(footButtons()).toEqual(['Cancel', 'Review change'])
  })

  it('starts a trial at $0 with the card note and sends trial on the checkout', async () => {
    mocks.subscription.mockResolvedValue(FREE)
    mocks.plans.mockImplementation(async () => trialCatalog())
    await render()
    await openChangePlan()
    await click(dialog()!.querySelector('[data-plan-tier="pro"]'))
    await click(buttonIn(dialog()!, 'Start free trial'))
    expect(dialog()!.querySelector('.modalhead')!.textContent).toContain('Start free trial')
    expect(rows()).toEqual([
      ['Due today', '$0.00'],
      ['Trial ends', 'Dec 10'],
      ['Then', '$40.00 / mo']
    ])
    expect(notes()).toEqual(['Card required — not charged today. Cancel anytime before Dec 10.'])
    await click(buttonIn(dialog()!, 'Add card'))
    expect(mocks.checkout.mock.calls[0]![1]).toMatchObject({ tierId: 'pro', optionId: 'standard', trial: true })
    expect(mocks.assign).toHaveBeenCalledWith('https://checkout.example.test/c/1')
  })

  it('keeps Subscribe now a plain paid checkout', async () => {
    mocks.subscription.mockResolvedValue(FREE)
    mocks.plans.mockImplementation(async () => trialCatalog())
    await render()
    await openChangePlan()
    await click(dialog()!.querySelector('[data-plan-tier="pro"]'))
    await click(buttonIn(dialog()!, 'Subscribe now'))
    expect(rows()[0]).toEqual(['Due today', '$40.00'])
    await click(buttonIn(dialog()!, 'Pay $40.00'))
    expect(mocks.checkout.mock.calls[0]![1].trial).toBe(false)
  })

  it('confirms a returning trial checkout as a trial, and says why a reused card got no trial credit', async () => {
    sessionStorage.setItem('ac.billing.trialCheckout', 'chg_1')
    mocks.search = 'checkout=success&subscriptionChange=chg_1'
    mocks.subscription.mockResolvedValue(FREE)
    mocks.plans.mockImplementation(async () => trialCatalog())
    let settle!: (v: unknown) => void
    mocks.getChange.mockImplementation(() => new Promise((r) => (settle = r)))
    await render()
    expect(dialog()!.textContent).toContain('Confirming card…')
    mocks.subscription.mockResolvedValue({ ...TRIAL, trialCreditGranted: false, batches: [], planCreditMicro: 0 })
    await act(async () => settle({ ...change('completed'), optionId: 'standard' }))
    await flush()
    expect(step()).toBe('done')
    expect(dialog()!.textContent).toContain('Trial started')
    expect(dialog()!.textContent).toContain('Pro Standard until Dec 10.')
    expect(resultRows()).toEqual([['Sessions / month', '5,000']])
    expect(notes()).toEqual([
      'This card already received trial credits on another organization, so none were added here. Add credits to pay for usage during the trial.'
    ])
  })

  it('shows the trial on the Plan card and its credit in the balance strip', async () => {
    mocks.subscription.mockResolvedValue(TRIAL)
    await render()
    expect(q('[data-plan-name]')!.textContent).toBe('ProStandard')
    expect(q('[data-plan-trial]')!.textContent).toBe('Trial')
    expect(q('[data-plan-price]')!.textContent).toBe('Free · then $40 / month')
    expect(q('[data-plan-billing-date]')!.textContent).toBe('Trial ends Dec 10')
    expect(card().querySelector('[data-plan-cancel-trial]')!.textContent).toBe('Cancel trial')
    expect(q('[data-plan-credits]')!.textContent).toContain('Trial credits$6.00')
    expect(q('[data-plan-increase]')!.textContent).toBe('Increase limit')
    expect(mocks.quote).not.toHaveBeenCalled()
  })

  it('shows a member the trial but no way to cancel it', async () => {
    mocks.role = 'member'
    mocks.subscription.mockResolvedValue(TRIAL)
    await render()
    expect(q('[data-plan-trial]')).not.toBeNull()
    expect(q('[data-plan-cancel-trial]')).toBeNull()
  })

  it('cancels a trial after a review that dates the end and the history deletion', async () => {
    mocks.subscription.mockResolvedValue(TRIAL)
    mocks.plans.mockImplementation(async () => catalogOn('pro'))
    await render()
    await click(card().querySelector('[data-plan-cancel-trial]'))
    expect(step()).toBe('review')
    expect(dialog()!.querySelector('.modalhead')!.textContent).toContain('Cancel trial')
    expect(dialog()!.textContent).toContain('Current planPro Standard · Trial')
    expect(rows()).toEqual([
      ['Due today', '$0.00'],
      ['Trial ends', 'Dec 10'],
      ['Sessions / month', '5,000 → 1,000']
    ])
    expect(notes()).toEqual([
      'History older than 7 days is deleted from Dec 17.',
      "You won't be charged. Undo anytime before Dec 10."
    ])
    mocks.subscription.mockResolvedValue({ ...TRIAL, scheduled: FREE_REF })
    await click(buttonIn(dialog()!, 'Cancel trial'))
    expect(mocks.schedule).toHaveBeenCalledWith('org_example', { tierId: 'free', optionId: 'standard' })
    expect(dialog()).toBeNull()
    expect(q('[data-plan-scheduled]')!.textContent).toBe('Trial ends Dec 10 · back to Free, no chargeUndo')
  })

  it('undoes a cancelled trial from the strip and drops Cancel trial while cancelled', async () => {
    mocks.subscription.mockResolvedValue({ ...TRIAL, scheduled: FREE_REF })
    await render()
    expect(q('[data-plan-price]')!.textContent).toBe('Free trial')
    expect(q('[data-plan-cancel-trial]')).toBeNull()
    mocks.subscription.mockResolvedValue(TRIAL)
    await click(buttonIn(q('[data-plan-scheduled]')!, 'Undo'))
    expect(mocks.revoke).toHaveBeenCalledWith('org_example')
    expect(q('[data-plan-cancel-trial]')).not.toBeNull()
  })

  it('offers Pay now on every paid option and a switch at the trial’s end on the others', async () => {
    mocks.subscription.mockResolvedValue(TRIAL)
    await render()
    await openChangePlan()
    const pro = dialog()!.querySelector('[data-plan-tier="pro"]')!
    expect(pro.textContent).toContain('Trial')
    expect(pro.textContent).not.toContain('Current')
    expect(footButtons()).toEqual(['Cancel', 'Pay now'])
    await click(dialog()!.querySelector('[data-plan-option="double"]'))
    expect(footButtons()).toEqual(['Cancel', 'Switch on Dec 10', 'Pay now'])
    await click(dialog()!.querySelector('[data-plan-tier="free"]'))
    expect(footButtons()).toEqual(['Cancel', 'Cancel trial'])
  })

  it('hides the switch and disables Cancel trial once the trial is cancelled, keeping Pay now', async () => {
    mocks.subscription.mockResolvedValue({ ...TRIAL, scheduled: FREE_REF })
    await render()
    await openChangePlan()
    await click(dialog()!.querySelector('[data-plan-option="double"]'))
    expect(footButtons()).toEqual(['Cancel', 'Pay now'])
    await click(dialog()!.querySelector('[data-plan-tier="free"]'))
    expect(buttonIn(dialog()!, 'Cancel trial')!.disabled).toBe(true)
  })

  it('reviews Pay now with the four facts from the trial-ending quote and subscribes', async () => {
    mocks.subscription.mockResolvedValue({ ...TRIAL, scheduled: FREE_REF })
    mocks.quote.mockResolvedValue({
      ...QUOTE,
      optionId: 'standard',
      amountCents: 4000,
      grantMicro: 40_000_000,
      paidThrough: '2026-12-26T10:00:00.000Z',
      endsTrial: true,
      forfeitMicro: 6_000_000
    })
    mocks.confirm.mockResolvedValue({ ...change('completed'), optionId: 'standard' })
    await render()
    await openChangePlan()
    await click(buttonIn(dialog()!, 'Pay now'))
    expect(mocks.quote).toHaveBeenCalledWith('org_example', { tierId: 'pro', optionId: 'standard' })
    expect(dialog()!.querySelector('.modalhead')!.textContent).toContain('Pay now')
    expect(rows()).toEqual([
      ['Due today', '$40.00'],
      ['Trial', 'Ends now'],
      ['Unused trial credits', '−$6.00'],
      ['Next charge', 'Dec 26 · $40.00']
    ])
    expect(notes()).toEqual([
      'Includes $40.00 plan credits for this cycle.',
      'Paying now also withdraws your trial cancellation.'
    ])
    await click(buttonIn(dialog()!, 'Pay $40.00'))
    expect(step()).toBe('done')
    expect(dialog()!.textContent).toContain('Subscribed to Pro Standard')
    expect(resultRows()).toEqual([
      ['Sessions / month', '5,000'],
      ['Credits added', '+$40.00']
    ])
  })

  it('schedules a switch at the trial’s end with no charge today', async () => {
    mocks.subscription.mockResolvedValue(TRIAL)
    await render()
    await openChangePlan()
    await click(dialog()!.querySelector('[data-plan-option="double"]'))
    await click(buttonIn(dialog()!, 'Switch on Dec 10'))
    expect(mocks.quote).not.toHaveBeenCalled()
    expect(dialog()!.querySelector('.modalhead')!.textContent).toContain('Switch at trial end')
    expect(rows()).toEqual([
      ['Due today', '$0.00'],
      ['Takes effect', 'Dec 10 (trial end)'],
      ['First charge', 'Dec 10 · $50.00'],
      ['Sessions / month', '5,000 → 10,000']
    ])
    expect(notes()).toEqual(['Cancel anytime before Dec 10.'])
    await click(buttonIn(dialog()!, 'Schedule'))
    expect(mocks.schedule).toHaveBeenCalledWith('org_example', { tierId: 'pro', optionId: 'double' })
    expect(step()).toBe('done')
  })

  it('names the strip after the trial’s end for a scheduled switch', async () => {
    mocks.subscription.mockResolvedValue({
      ...TRIAL,
      scheduled: { tierId: 'pro', tierName: 'Pro', optionId: 'double', optionName: '×2' }
    })
    await render()
    expect(q('[data-plan-scheduled]')!.textContent).toBe('Switching to Pro ×2 when the trial ends Dec 10Cancel')
    expect(q('[data-plan-cancel-trial]')).not.toBeNull()
  })

  it('puts withdrawing an unpaid Pay now where Cancel trial was', async () => {
    mocks.subscription.mockResolvedValue({
      ...TRIAL,
      pendingChange: {
        id: 'chg_1',
        kind: 'upgrade',
        tierId: 'pro',
        optionId: 'standard',
        payUrl: 'https://pay.example.test/i/1'
      }
    })
    await render()
    const banner = q('[data-plan-banner="pending"]')!
    expect(banner.textContent).toContain('Your plan payment is waiting')
    expect(banner.textContent).toContain('Your trial continues unchanged until the payment completes.')
    expect(q('[data-plan-cancel-trial]')).toBeNull()
    const withdraw = card().querySelector('[data-plan-pending-cancel]')!
    expect(withdraw.textContent).toBe('Cancel payment')
    mocks.subscription.mockResolvedValue(TRIAL)
    await click(withdraw)
    const confirm = card().querySelector('[role="dialog"]')!
    expect(confirm.textContent).toContain('Its invoice is voided and your trial continues as it is.')
    await click(buttonIn(confirm, 'Cancel payment'))
    expect(mocks.cancelChange).toHaveBeenCalledWith('org_example', 'chg_1')
    expect(q('[data-plan-banner="pending"]')).toBeNull()
    expect(q('[data-plan-cancel-trial]')).not.toBeNull()
  })
})
