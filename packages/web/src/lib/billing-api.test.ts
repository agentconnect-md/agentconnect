// The billing types in this directory are a hand-kept copy of the billing
// service's schemas, so a mismatch is a real possibility rather than a
// hypothetical. These checks pin the one property that makes the copy tolerable:
// a response that does not match is REFUSED at the boundary, so the page shows
// its error card instead of rendering `$NaN` where a balance belongs.
import { describe, expect, it } from 'vitest'
import {
  assertAccount,
  assertPurchase,
  assertPurchaseCreated,
  assertTransactionsPage,
  BillingShapeError,
  fmtMicroUsd
} from './billing-api'

const tx = { id: 't1', kind: 'purchase', amountMicro: 25_000_000, at: '2026-08-17T09:25:33.751Z' }

describe('assertAccount', () => {
  it('accepts the documented shape', () => {
    expect(() => assertAccount({ orgId: 'org1', balanceMicro: 0 })).not.toThrow()
  })

  it('refuses a missing balance rather than letting undefined reach the formatter', () => {
    expect(() => assertAccount({ orgId: 'org1' })).toThrow(BillingShapeError)
    // The failure this guards against, stated outright: without it the balance
    // card renders this.
    expect(fmtMicroUsd(undefined as unknown as number)).toBe('$NaN')
  })

  it('refuses a non-finite balance', () => {
    expect(() => assertAccount({ orgId: 'org1', balanceMicro: Number.NaN })).toThrow(BillingShapeError)
    expect(() => assertAccount({ orgId: 'org1', balanceMicro: '25' })).toThrow(BillingShapeError)
  })

  it('refuses null and non-objects', () => {
    expect(() => assertAccount(null)).toThrow(BillingShapeError)
  })
})

describe('assertTransactionsPage', () => {
  it('accepts the documented shape', () => {
    expect(() => assertTransactionsPage({ items: [tx], nextCursor: null })).not.toThrow()
    expect(() => assertTransactionsPage({ items: [], nextCursor: 'r4' })).not.toThrow()
  })

  it('tolerates a ledger kind this build has not heard of', () => {
    // Deliberate: the row renders the raw value as its label. Refusing the whole
    // page because the service added a kind would be the worse failure.
    expect(() => assertTransactionsPage({ items: [{ ...tx, kind: 'chargeback' }], nextCursor: null })).not.toThrow()
  })

  it('refuses a row with an unusable amount or timestamp', () => {
    expect(() => assertTransactionsPage({ items: [{ ...tx, amountMicro: null }], nextCursor: null })).toThrow(
      BillingShapeError
    )
    expect(() => assertTransactionsPage({ items: [{ ...tx, at: 0 }], nextCursor: null })).toThrow(BillingShapeError)
  })

  it('refuses a page whose cursor is neither string nor null', () => {
    expect(() => assertTransactionsPage({ items: [], nextCursor: undefined })).toThrow(BillingShapeError)
  })

  it('refuses a body that is not a page at all', () => {
    expect(() => assertTransactionsPage({ items: 'nope', nextCursor: null })).toThrow(BillingShapeError)
  })
})

describe('assertPurchase', () => {
  const purchase = { id: 'p1', status: 'pending', amountMicro: 50_000_000, receiptUrl: null }

  it('accepts the documented shape, with and without a receipt', () => {
    expect(() => assertPurchase(purchase)).not.toThrow()
    expect(() =>
      assertPurchase({ ...purchase, status: 'completed', receiptUrl: 'https://pay.stripe.com/receipts/x' })
    ).not.toThrow()
  })

  it('refuses an unknown status — the poll branches on it, so an unknown value would spin forever', () => {
    expect(() => assertPurchase({ ...purchase, status: 'settling' })).toThrow(BillingShapeError)
  })

  it('refuses an unusable amount or receipt', () => {
    expect(() => assertPurchase({ ...purchase, amountMicro: '50' })).toThrow(BillingShapeError)
    expect(() => assertPurchase({ ...purchase, receiptUrl: undefined })).toThrow(BillingShapeError)
    expect(() => assertPurchase(null)).toThrow(BillingShapeError)
  })
})

describe('assertPurchaseCreated', () => {
  it('accepts the documented shape and refuses anything without the redirect URL', () => {
    expect(() => assertPurchaseCreated({ purchaseId: 'p1', url: 'https://checkout.stripe.com/x' })).not.toThrow()
    expect(() => assertPurchaseCreated({ purchaseId: 'p1' })).toThrow(BillingShapeError)
    expect(() => assertPurchaseCreated(null)).toThrow(BillingShapeError)
  })
})
