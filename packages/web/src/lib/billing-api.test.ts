// The billing types in this directory are a hand-kept copy of the billing
// service's schemas, so a mismatch is a real possibility rather than a
// hypothetical. These checks pin the one property that makes the copy tolerable:
// a response that does not match is REFUSED at the boundary, so the page shows
// its error card instead of rendering `$NaN` where a balance belongs.
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  assertAccount,
  assertPurchase,
  assertPurchaseCreated,
  assertTransactionsPage,
  fetchBillingTransactions,
  fmtDecimalUsd,
  BillingShapeError,
  fmtMicroUsd,
  type BillingDebit
} from './billing-api'

const tx = { type: 'credit', id: 't1', kind: 'purchase', amountMicro: 25_000_000, at: '2026-08-17T09:25:33.751Z' }
const debit = {
  type: 'debit',
  id: 'd1',
  period: '2026-08',
  amount: '0.450000000000000001',
  at: '2026-08-20T10:00:00.000Z'
}

const ACCOUNT = { orgId: 'org1', balanceMicro: 0, state: 'active', lowBalanceMicro: 0 }

describe('assertAccount', () => {
  it('accepts the documented shape', () => {
    expect(() => assertAccount({ orgId: 'org1', balanceMicro: 0, state: 'active', lowBalanceMicro: 0 })).not.toThrow()
  })

  it('refuses a missing balance rather than letting undefined reach the formatter', () => {
    expect(() => assertAccount({ orgId: 'org1' })).toThrow(BillingShapeError)
    // The failure this guards against, stated outright: without it the balance
    // card renders this.
    expect(fmtMicroUsd(undefined as unknown as number)).toBe('$NaN')
  })

  it('refuses a non-finite balance', () => {
    expect(() => assertAccount({ ...ACCOUNT, balanceMicro: Number.NaN })).toThrow(BillingShapeError)
    expect(() => assertAccount({ ...ACCOUNT, balanceMicro: '25' })).toThrow(BillingShapeError)
  })

  it('accepts the unknown state, which the service reports while a change is unconfirmed', () => {
    expect(() => assertAccount({ ...ACCOUNT, state: 'unknown' })).not.toThrow()
  })

  it('tolerates a null state the same way it tolerates an absent one', () => {
    // The two checks in this function must read the same way; `null` is the natural
    // serialization if the service ever models "no gateway configured" explicitly.
    expect(() => assertAccount({ ...ACCOUNT, state: null })).not.toThrow()
  })

  it('accepts an account from a service that predates `state`, and claims nothing', () => {
    // This side deploys ahead of the service routinely, and throwing would cost the balance
    // figure AND the Add-credits card — the one control a suspended org needs.
    expect(() => assertAccount({ orgId: 'org1', balanceMicro: 0 })).not.toThrow()
  })

  it('refuses an UNRECOGNISED state — it must not render as “everything is fine”', () => {
    expect(() => assertAccount({ ...ACCOUNT, state: 'closed' })).toThrow(BillingShapeError)
  })

  it('reads an absent or null threshold as “no warning”, never as a broken account', () => {
    // `null` is the natural serialization of a nullable "no threshold configured" value, and
    // a presentation hint must not be able to take the whole card down.
    expect(() => assertAccount({ orgId: 'org1', balanceMicro: 0, state: 'active' })).not.toThrow()
    expect(() => assertAccount({ ...ACCOUNT, lowBalanceMicro: null })).not.toThrow()
    // A threshold that is present but unusable is still refused.
    expect(() => assertAccount({ ...ACCOUNT, lowBalanceMicro: 'ten' })).toThrow(BillingShapeError)
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

  it('accepts a debit row', () => {
    expect(() => assertTransactionsPage({ items: [tx, debit], nextCursor: null })).not.toThrow()
  })

  it('accepts a credit row from a service that predates the union, and fills in its type', async () => {
    // Merge order is not deploy order: this app rides the train and goes out
    // automatically, while the billing service's image is synced by hand — so a console
    // carrying a new mirror routinely runs against the previous service. Requiring `type`
    // turned that window into a page that failed outright, which is what happened on test.
    const legacy = { id: 't0', kind: 'purchase', amountMicro: 1_000_000, at: tx.at }
    expect(() => assertTransactionsPage({ items: [legacy], nextCursor: null })).not.toThrow()
  })

  it("accepts an operator's note on a credit, and refuses one it cannot read", () => {
    // Absent is the older contract; null is the service's "no note on this kind".
    expect(() =>
      assertTransactionsPage({
        items: [
          { ...tx, kind: 'adjustment', note: 'goodwill credit' },
          { ...tx, note: null }
        ],
        nextCursor: null
      })
    ).not.toThrow()
    expect(() => assertTransactionsPage({ items: [{ ...tx, note: 7 }], nextCursor: null })).toThrow(BillingShapeError)
  })

  it('mirrors a debit’s agent split, and drops a malformed one instead of failing the page', () => {
    // The ids are the ORG's, not the viewer's — this boundary only carries them; the row
    // resolves them against the viewer's roster before naming one (BillingView `agentSplit`).
    const page = { items: [{ ...debit, agents: [{ agentId: 'agt_1', amount: '0.4' }] }], nextCursor: null }
    expect(() => assertTransactionsPage(page)).not.toThrow()
    expect((page.items[0] as unknown as BillingDebit).agents).toEqual([{ agentId: 'agt_1', amount: '0.4' }])

    // The money on the row is the fact; the attribution is a garnish, so a bad split is
    // dropped rather than taking a statement line down with it. ABSENT stays valid.
    for (const agents of [[{ agentId: 'agt_1', amount: 0.4 }], [{ amount: '0.4' }], 'nope', 7]) {
      const bad = { items: [{ ...debit, agents }], nextCursor: null }
      expect(() => assertTransactionsPage(bad)).not.toThrow()
      expect((bad.items[0] as unknown as BillingDebit).agents).toBeUndefined()
    }
    expect(() => assertTransactionsPage({ items: [debit], nextCursor: null })).not.toThrow()
  })

  it('refuses a row whose type this build cannot read', () => {
    // Unlike an unknown `kind`, an unknown `type` has no sensible fallback rendering.
    expect(() => assertTransactionsPage({ items: [{ ...tx, type: 'hold' }], nextCursor: null })).toThrow(
      BillingShapeError
    )
    // A row with no `type` AND no credit fields is still refused — tolerating the
    // previous shape means reading it as a credit, not waving anything through.
    expect(() => assertTransactionsPage({ items: [{ id: 'x', at: tx.at }], nextCursor: null })).toThrow(
      BillingShapeError
    )
  })

  it('refuses a debit whose amount arrived as a number', () => {
    // The service sends a decimal string precisely so 18 decimals survive the wire;
    // accepting a number here would hide the day that stops being true.
    expect(() => assertTransactionsPage({ items: [{ ...debit, amount: 0.45 }], nextCursor: null })).toThrow(
      BillingShapeError
    )
    expect(() => assertTransactionsPage({ items: [{ ...debit, period: 8 }], nextCursor: null })).toThrow(
      BillingShapeError
    )
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

describe('fmtDecimalUsd', () => {
  it('rounds an exact decimal to cents for display', () => {
    expect(fmtDecimalUsd('0.450000000000000001')).toBe('$0.45')
    expect(fmtDecimalUsd('1234.5')).toBe('$1,234.50')
  })

  it('shows the raw string rather than $NaN when it is not a number', () => {
    expect(fmtDecimalUsd('twelve')).toBe('$twelve')
  })

  it('keeps four significant digits under a dollar — a nonzero charge is never a bare $0.00', () => {
    expect(fmtDecimalUsd('0.001234567890123456')).toBe('$0.001235')
    expect(fmtDecimalUsd('0.4821')).toBe('$0.4821')
    expect(fmtDecimalUsd('0.000098')).toBe('$0.000098')
  })

  it('pads back to cents so $0.10 lines up with fmtMicroUsd amounts in the same column', () => {
    expect(fmtDecimalUsd('0.10')).toBe('$0.10')
    expect(fmtDecimalUsd('0.5')).toBe('$0.50')
    expect(fmtDecimalUsd('0.2')).toBe('$0.20')
  })

  it('keeps the sign outside the symbol, matching fmtMicroUsd', () => {
    expect(fmtDecimalUsd('-0.5')).toBe('-$0.50')
    expect(fmtDecimalUsd('-0.001234')).toBe('-$0.001234')
  })
})

// Auth is not what these check; stub it so `request` builds a URL instead of a token.
vi.mock('@/lib/auth', () => ({
  getToken: async () => null,
  getUser: async () => null,
  getIdTokenRaw: async () => null
}))

describe('fetchBillingTransactions', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  const urls: string[] = []
  const stub = () => {
    urls.length = 0
    vi.stubEnv('BILLING_URL', 'https://billing.test')
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url)
      return { ok: true, json: async () => ({ items: [], nextCursor: null }) }
    })
  }

  it('sends the window as the service names it, so the filter runs in SQL', async () => {
    // A misspelled parameter is invisible from the console: the service ignores what it does
    // not know, the caller's own cut still trims the rows, and the page stays correct while
    // paging the whole ledger to get there.
    stub()

    await fetchBillingTransactions('org1', undefined, { from: '2026-07-21T00:00:00.000Z' })

    expect(urls[0]).toBe('https://billing.test/api/v1/orgs/org1/billing/transactions?from=2026-07-21T00%3A00%3A00.000Z')
  })

  it('carries the cursor and both ends together', async () => {
    stub()

    await fetchBillingTransactions('org1', 'c1', { from: '2026-07-21T00:00:00.000Z', to: '2026-08-20T00:00:00.000Z' })

    expect(urls[0]).toContain('cursor=c1')
    expect(urls[0]).toContain('from=2026-07-21')
    expect(urls[0]).toContain('to=2026-08-20')
  })

  it('asks for no window at all when it has none, rather than an empty one', async () => {
    stub()

    await fetchBillingTransactions('org1')

    expect(urls[0]).toBe('https://billing.test/api/v1/orgs/org1/billing/transactions')
  })

  it('keeps an https receipt and drops anything else, so no row can render a hostile href', async () => {
    vi.stubEnv('BILLING_URL', 'https://billing.test')
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => ({
        items: [
          {
            id: 'c1',
            kind: 'purchase',
            amountMicro: 50_000_000,
            at: tx.at,
            receiptUrl: 'https://pay.stripe.com/receipts/x'
          },
          { id: 'c2', kind: 'purchase', amountMicro: 50_000_000, at: tx.at, receiptUrl: 'javascript:alert(1)' },
          { id: 'c3', kind: 'purchase', amountMicro: 50_000_000, at: tx.at }
        ],
        nextCursor: null
      })
    }))

    const page = await fetchBillingTransactions('org1')

    expect(page.items.map((t) => (t.type === 'credit' ? t.receiptUrl : undefined))).toEqual([
      'https://pay.stripe.com/receipts/x',
      null,
      null
    ])
  })
})
