// The plan's own fields refuse a mismatch; the fields a newer service added stay optional for an older one.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { assertSubscription, BillingShapeError, fetchBillingSubscription, fmtCents } from './billing-api'

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
const BATCH = {
  grantedAt: '2026-11-01T00:00:00.000Z',
  grantedMicro: 10_000_000,
  remainingMicro: 4_000_000,
  expiresAt: '2026-12-01T00:00:00.000Z',
  expired: false
}
const SUBSCRIPTION = {
  ...SUBSCRIPTION_OLD,
  grants: [{ expiresAt: '2026-12-01T00:00:00.000Z', remainingMicro: 4_000_000 }],
  pendingChange: null,
  entitlementSync: 'synced',
  planCreditMicro: 4_000_000,
  expiredThisMonthMicro: 0,
  batches: [BATCH, { ...BATCH, grantedAt: '2026-10-01T00:00:00.000Z', remainingMicro: 0, expired: true }]
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
      entitlementSync: 'later',
      planCreditMicro: '4',
      expiredThisMonthMicro: null,
      batches: [{ ...BATCH, expired: 'no' }]
    }
    assertSubscription(body)
    for (const field of [
      'grants',
      'pendingChange',
      'entitlementSync',
      'planCreditMicro',
      'expiredThisMonthMicro',
      'batches'
    ])
      expect(body).not.toHaveProperty(field)
  })

  it('keeps well-formed plan credit batches', () => {
    const body: Record<string, unknown> = { ...SUBSCRIPTION }
    assertSubscription(body)
    expect(body.batches).toHaveLength(2)
    expect(body.planCreditMicro).toBe(4_000_000)
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
})

describe('fmtCents', () => {
  it('drops the cents of a whole-dollar price only', () => {
    expect(fmtCents(4000)).toBe('$40')
    expect(fmtCents(0)).toBe('$0')
    expect(fmtCents(1999)).toBe('$19.99')
  })
})
