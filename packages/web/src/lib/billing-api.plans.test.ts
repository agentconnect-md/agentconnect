// The plan's own fields refuse a mismatch; the fields a newer service added stay optional for an older one.
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  assertPlans,
  assertSubscription,
  BillingError,
  BillingShapeError,
  cancelBillingSubscriptionChange,
  confirmBillingUpgrade,
  createBillingSubscriptionCheckout,
  fetchBillingPlans,
  fetchBillingSubscription,
  fetchBillingSubscriptionChange,
  fmtCents,
  quoteBillingUpgrade,
  revokeBillingScheduledChange,
  scheduleBillingChange
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

  it('accepts a contract, which has no console price', () => {
    expect(() => assertSubscription({ ...SUBSCRIPTION, priceCents: null })).not.toThrow()
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

  it('keeps a well-formed retention: none pending, a dated window, and one awaiting its notice', () => {
    const shapes = [
      { days: null, next: null, shortenHoldDays: 7 },
      { days: null, next: { days: 7, from: '2026-12-08T00:00:00.000Z', awaitingNotice: false }, shortenHoldDays: 7 },
      { days: 30, next: { days: 7, from: null, awaitingNotice: true }, shortenHoldDays: 0 }
    ]
    for (const retention of shapes) {
      const body: Record<string, unknown> = { ...SUBSCRIPTION, retention }
      assertSubscription(body)
      expect(body.retention).toEqual(retention)
    }
  })

  it('keeps a trial end and credit flag, and reads null as not in a trial', () => {
    const trial = { trialEndsAt: '2026-12-10T08:00:00.000Z', trialCreditGranted: false }
    const body: Record<string, unknown> = { ...SUBSCRIPTION, ...trial }
    assertSubscription(body)
    expect(body).toMatchObject(trial)
    expect(() => assertSubscription({ ...SUBSCRIPTION, trialEndsAt: null, trialCreditGranted: null })).not.toThrow()
  })

  it('drops a malformed trial field and keeps the plan', () => {
    for (const trial of [{ trialEndsAt: 'soon' }, { trialEndsAt: 1 }, { trialCreditGranted: 'no' }]) {
      const body: Record<string, unknown> = { ...SUBSCRIPTION, ...trial }
      expect(() => assertSubscription(body)).not.toThrow()
      for (const field of Object.keys(trial)) expect(body).not.toHaveProperty(field)
    }
  })

  it('drops a malformed retention and keeps the plan', () => {
    const next = { days: 7, from: '2026-12-08T00:00:00.000Z', awaitingNotice: false }
    for (const retention of [
      null,
      'unlimited',
      { days: '30', next: null, shortenHoldDays: 7 },
      { days: null, next: null },
      { days: null, shortenHoldDays: 7 },
      { days: null, next: { ...next, from: 'soon' }, shortenHoldDays: 7 },
      { days: null, next: { ...next, from: 1 }, shortenHoldDays: 7 },
      { days: null, next: { ...next, awaitingNotice: 'yes' }, shortenHoldDays: 7 },
      { days: null, next: { from: null, awaitingNotice: true }, shortenHoldDays: 7 }
    ]) {
      const body: Record<string, unknown> = { ...SUBSCRIPTION, retention }
      expect(() => assertSubscription(body)).not.toThrow()
      expect(body).not.toHaveProperty('retention')
      expect(body.retentionDays).toBe(30)
    }
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

const OPTION = {
  tierId: 'pro',
  tierName: 'Pro',
  optionId: 'standard',
  optionName: 'Standard',
  salesMode: 'self_serve',
  priceCents: 4000,
  grantMicro: 40_000_000,
  sessionLimit: 5000,
  multiplier: null,
  retentionDays: null,
  purchasable: true,
  current: true,
  scheduled: false
}

describe('assertPlans', () => {
  it('accepts priced, free and contact-sales options', () => {
    expect(() =>
      assertPlans({ options: [OPTION, { ...OPTION, salesMode: 'contact_sales', priceCents: null, current: false }] })
    ).not.toThrow()
  })

  it('keeps a trial offer, reads absent or null as none, and drops a malformed one', () => {
    const body: unknown = { options: [{ ...OPTION, trialDays: 14 }, { ...OPTION, trialDays: null }, { ...OPTION }] }
    assertPlans(body)
    expect(body.options.map((o) => o.trialDays)).toEqual([14, null, undefined])
    for (const trialDays of ['14', 0, -1, Number.NaN]) {
      const malformed: { options: Record<string, unknown>[] } = { options: [{ ...OPTION, trialDays }] }
      expect(() => assertPlans(malformed)).not.toThrow()
      expect(malformed.options[0]).not.toHaveProperty('trialDays')
    }
  })

  it('refuses an unknown sales mode or a missing flag', () => {
    expect(() => assertPlans({ options: [{ ...OPTION, salesMode: 'auction' }] })).toThrow(BillingShapeError)
    expect(() => assertPlans({ options: [{ ...OPTION, current: undefined }] })).toThrow(BillingShapeError)
    expect(() => assertPlans({})).toThrow(BillingShapeError)
  })
})

describe('plan writes', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  const calls: { url: string; method: string; body: unknown }[] = []
  const stub = (status: number, body: unknown) => {
    calls.length = 0
    vi.stubEnv('BILLING_URL', 'https://billing.example.test')
    vi.stubGlobal('fetch', async (url: string, init?: { method?: string; body?: string }) => {
      calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : undefined })
      return { ok: status < 400, status, json: async () => body }
    })
  }
  const base = 'https://billing.example.test/api/v1/orgs/org_example/billing'

  it('reads the catalog', async () => {
    stub(200, { options: [OPTION] })
    expect((await fetchBillingPlans('org_example')).options).toHaveLength(1)
    expect(calls[0]!.url).toBe(`${base}/plans`)
  })

  it('sends only the plan ids for a quote, and refuses a quote without an amount', async () => {
    const quote = {
      quoteId: 'q1',
      tierId: 'pro',
      optionId: 'double',
      amountCents: 500,
      grantMicro: 0,
      expiresAt: '2026-11-23T10:15:00.000Z',
      paidThrough: '2026-12-04T00:00:00.000Z'
    }
    stub(200, quote)
    expect(await quoteBillingUpgrade('org_example', { tierId: 'pro', optionId: 'double' })).toEqual(quote)
    expect(calls[0]).toEqual({
      url: `${base}/subscription/quote`,
      method: 'POST',
      body: { tierId: 'pro', optionId: 'double' }
    })
    stub(200, { ...quote, amountCents: '5' })
    await expect(quoteBillingUpgrade('org_example', { tierId: 'pro', optionId: 'double' })).rejects.toBeInstanceOf(
      BillingShapeError
    )
  })

  it('reads a trial-ending quote, tolerates null trial fields, and refuses malformed ones', async () => {
    const quote = {
      quoteId: 'q2',
      tierId: 'pro',
      optionId: 'standard',
      amountCents: 4000,
      grantMicro: 40_000_000,
      expiresAt: '2026-11-23T10:15:00.000Z',
      paidThrough: '2026-12-23T10:00:00.000Z'
    }
    const args = { tierId: 'pro', optionId: 'standard' }
    stub(200, { ...quote, endsTrial: true, forfeitMicro: 3_000_000 })
    expect(await quoteBillingUpgrade('org_example', args)).toMatchObject({ endsTrial: true, forfeitMicro: 3_000_000 })
    stub(200, { ...quote, endsTrial: null, forfeitMicro: null })
    expect((await quoteBillingUpgrade('org_example', args)).endsTrial).toBeNull()
    for (const bad of [{ endsTrial: 'yes' }, { endsTrial: true, forfeitMicro: '3' }]) {
      stub(200, { ...quote, ...bad })
      await expect(quoteBillingUpgrade('org_example', args)).rejects.toBeInstanceOf(BillingShapeError)
    }
  })

  it('sends trial on a checkout only when asked for', async () => {
    const args = { tierId: 'pro', optionId: 'standard', idempotencyKey: 'k1', returnPath: '/billing' }
    stub(200, { changeId: 'c1', url: 'https://checkout.example.test/c1' })
    await createBillingSubscriptionCheckout('org_example', args)
    await createBillingSubscriptionCheckout('org_example', { ...args, trial: false })
    await createBillingSubscriptionCheckout('org_example', { ...args, trial: true })
    expect(calls.map((c) => c.body)).toEqual([args, args, { ...args, trial: true }])
    expect(calls[0]!.url).toBe(`${base}/subscription/checkout`)
  })

  it('keeps only an https pay link on a change, and refuses an unknown status', async () => {
    const change = { id: 'c1', status: 'pending', tierId: 'pro', optionId: 'double', payUrl: 'http://pay.example.test' }
    stub(200, change)
    expect((await confirmBillingUpgrade('org_example', { quoteId: 'q1', idempotencyKey: 'k1' })).payUrl).toBeNull()
    expect(calls[0]!.body).toEqual({ quoteId: 'q1', idempotencyKey: 'k1' })
    stub(200, { ...change, status: 'paid' })
    await expect(fetchBillingSubscriptionChange('org_example', 'c1')).rejects.toBeInstanceOf(BillingShapeError)
  })

  it('schedules with PUT, revokes and cancels with DELETE, surfacing a refusal’s status', async () => {
    stub(200, {})
    await scheduleBillingChange('org_example', { tierId: 'free', optionId: 'standard' })
    expect(calls[0]).toMatchObject({ url: `${base}/subscription/scheduled`, method: 'PUT' })
    await revokeBillingScheduledChange('org_example')
    expect(calls[1]).toMatchObject({ url: `${base}/subscription/scheduled`, method: 'DELETE' })
    await cancelBillingSubscriptionChange('org_example', 'chg/1')
    expect(calls[2]).toMatchObject({ url: `${base}/subscription/changes/chg%2F1`, method: 'DELETE' })
    stub(409, { message: 'a plan change for this organization has not settled yet' })
    await expect(scheduleBillingChange('org_example', { tierId: 'free', optionId: 'standard' })).rejects.toEqual(
      new BillingError('a plan change for this organization has not settled yet', 409)
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
