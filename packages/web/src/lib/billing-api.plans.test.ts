// The plan's own fields refuse a mismatch; the three fields a newer service added stay optional for an older one.
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  assertInvoicesPage,
  assertPlans,
  assertSubscription,
  BillingError,
  BillingShapeError,
  fetchBillingInvoices,
  fetchBillingSubscription,
  fmtCents
} from './billing-api'

vi.mock('@/lib/auth', () => ({
  getToken: async () => null,
  getUser: async () => null,
  getIdTokenRaw: async () => null
}))

const SUBSCRIPTION_OLD = {
  tierId: 'pro',
  tierName: 'Pro',
  optionId: 'standard',
  optionName: 'Standard',
  sessionLimit: 500,
  priceCents: 2000,
  grantMicro: 10_000_000,
  retentionDays: 30,
  paidThrough: '2026-12-01T00:00:00.000Z',
  scheduled: null
}
const SUBSCRIPTION = {
  ...SUBSCRIPTION_OLD,
  grants: [{ expiresAt: '2026-12-01T00:00:00.000Z', remainingMicro: 4_000_000 }],
  pendingChange: null,
  entitlementSync: 'synced'
}
const OPTION = {
  tierId: 'pro',
  tierName: 'Pro',
  optionId: 'standard',
  optionName: 'Standard',
  salesMode: 'self_serve',
  priceCents: 2000,
  grantMicro: 10_000_000,
  sessionLimit: 500,
  multiplier: null,
  retentionDays: 30,
  purchasable: true,
  current: true,
  scheduled: false
}
const INVOICE = {
  id: 'in_test123',
  number: 'EX-0001',
  status: 'paid',
  amountDueCents: 2000,
  amountPaidCents: 2000,
  currency: 'usd',
  periodStart: '2026-11-01T00:00:00.000Z',
  periodEnd: '2026-12-01T00:00:00.000Z',
  createdAt: '2026-11-01T00:05:00.000Z',
  hostedUrl: 'https://billing.example.test/i/in_test123'
}

describe('assertSubscription', () => {
  it('accepts the current shape and one from a service that predates grants, pending changes and sync', () => {
    expect(() => assertSubscription({ ...SUBSCRIPTION })).not.toThrow()
    expect(() => assertSubscription({ ...SUBSCRIPTION_OLD })).not.toThrow()
  })

  it('accepts a scheduled plan, an unpaid plan and unlimited retention', () => {
    const scheduled = { tierId: 'free', tierName: 'Free', optionId: 'standard', optionName: 'Standard' }
    expect(() =>
      assertSubscription({ ...SUBSCRIPTION, scheduled, paidThrough: null, retentionDays: null })
    ).not.toThrow()
  })

  it('refuses a plan whose own fields do not match', () => {
    expect(() => assertSubscription({ ...SUBSCRIPTION, priceCents: '20' })).toThrow(BillingShapeError)
    expect(() => assertSubscription({ ...SUBSCRIPTION, tierName: undefined })).toThrow(BillingShapeError)
    expect(() => assertSubscription({ ...SUBSCRIPTION, scheduled: { tierId: 'free' } })).toThrow(BillingShapeError)
    expect(() => assertSubscription(null)).toThrow(BillingShapeError)
  })

  it('drops a malformed newer field instead of refusing the plan', () => {
    const body: Record<string, unknown> = {
      ...SUBSCRIPTION,
      grants: [{ expiresAt: 1 }],
      pendingChange: { id: 'c1', kind: 'refund' },
      entitlementSync: 'later'
    }
    assertSubscription(body)
    expect(body).not.toHaveProperty('grants')
    expect(body).not.toHaveProperty('pendingChange')
    expect(body).not.toHaveProperty('entitlementSync')
  })
})

describe('assertPlans', () => {
  it('accepts priced, free and contact-sales options', () => {
    expect(() =>
      assertPlans({
        options: [OPTION, { ...OPTION, salesMode: 'contact_sales', priceCents: null, multiplier: 2, current: false }]
      })
    ).not.toThrow()
    expect(() => assertPlans({ options: [] })).not.toThrow()
  })

  it('refuses an unknown sales mode or a missing flag', () => {
    expect(() => assertPlans({ options: [{ ...OPTION, salesMode: 'auction' }] })).toThrow(BillingShapeError)
    expect(() => assertPlans({ options: [{ ...OPTION, current: undefined }] })).toThrow(BillingShapeError)
    expect(() => assertPlans({})).toThrow(BillingShapeError)
  })
})

describe('assertInvoicesPage', () => {
  it('accepts a page, and an unfamiliar status as a label', () => {
    expect(() => assertInvoicesPage({ items: [INVOICE], nextCursor: 'c2' })).not.toThrow()
    expect(() => assertInvoicesPage({ items: [{ ...INVOICE, status: 'draft' }], nextCursor: null })).not.toThrow()
  })

  it('refuses a non-numeric amount or a missing cursor', () => {
    expect(() => assertInvoicesPage({ items: [{ ...INVOICE, amountDueCents: '20' }], nextCursor: null })).toThrow(
      BillingShapeError
    )
    expect(() => assertInvoicesPage({ items: [] })).toThrow(BillingShapeError)
  })
})

describe('plan reads', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  const stub = (status: number, body: unknown) => {
    const urls: string[] = []
    vi.stubEnv('BILLING_URL', 'https://billing.example.test')
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url)
      return { ok: status < 400, status, json: async () => body }
    })
    return urls
  }

  it('reads a 404 subscription as no plan', async () => {
    stub(404, { message: 'this organization has no subscription' })
    expect(await fetchBillingSubscription('org_example')).toBeNull()
  })

  it('keeps only an https pay link', async () => {
    const change = { id: 'c1', kind: 'upgrade', tierId: 'team', optionId: 'standard' }
    stub(200, { ...SUBSCRIPTION, pendingChange: { ...change, payUrl: 'javascript:alert(1)' } })
    expect((await fetchBillingSubscription('org_example'))?.pendingChange?.payUrl).toBeNull()
    stub(200, { ...SUBSCRIPTION, pendingChange: { ...change, payUrl: 'https://billing.example.test/pay' } })
    expect((await fetchBillingSubscription('org_example'))?.pendingChange?.payUrl).toBe(
      'https://billing.example.test/pay'
    )
  })

  it('pages invoices by cursor and keeps only https invoice links', async () => {
    const urls = stub(200, { items: [{ ...INVOICE, hostedUrl: 'http://billing.example.test/i' }], nextCursor: null })
    const page = await fetchBillingInvoices('org_example', 'c2')
    expect(urls[0]).toBe('https://billing.example.test/api/v1/orgs/org_example/billing/subscription/invoices?cursor=c2')
    expect(page.items[0]!.hostedUrl).toBeNull()
  })

  it('surfaces an unavailable provider as a 503', async () => {
    stub(503, { message: 'unavailable' })
    await expect(fetchBillingInvoices('org_example')).rejects.toMatchObject({ status: 503 })
    await expect(fetchBillingInvoices('org_example')).rejects.toBeInstanceOf(BillingError)
  })
})

describe('fmtCents', () => {
  it('renders cents in their currency', () => {
    expect(fmtCents(2000)).toBe('$20.00')
    expect(fmtCents(1999, 'eur')).toBe('€19.99')
  })
})
