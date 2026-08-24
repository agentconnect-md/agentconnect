import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { activityWindowStart, bucketActivity } from '@/lib/billing-activity'
import type { BillingTransaction } from '@/lib/billing-api'

const credit = (at: string, amountMicro: number, kind: 'purchase' | 'refund' = 'purchase'): BillingTransaction => ({
  type: 'credit',
  id: `c-${at}-${amountMicro}`,
  kind,
  amountMicro,
  at
})
const debit = (at: string, amount: string): BillingTransaction => ({
  type: 'debit',
  id: `d-${at}`,
  period: at.slice(0, 7),
  amount,
  at
})

// A local-midnight instant, so the assertions below don't depend on the runner's timezone.
const dayStart = (daysAgo: number, hour = 12) => {
  const d = new Date()
  d.setHours(hour, 0, 0, 0)
  d.setDate(d.getDate() - daysAgo)
  return d.toISOString()
}
const now = Date.now()

describe('bucketActivity', () => {
  it('sums debits into their local day and leaves credits out of usage mode', () => {
    const rows = [debit(dayStart(1), '1.5'), debit(dayStart(1, 20), '0.25'), credit(dayStart(1), 50_000_000)]
    const buckets = bucketActivity(rows, 'd7', 'usage', now)
    expect(buckets).toHaveLength(7)
    expect(buckets[5]!.amount).toBeCloseTo(1.75)
    expect(buckets.reduce((a, b) => a + b.amount, 0)).toBeCloseTo(1.75)
  })

  it('counts positive credits in top-ups mode and ignores refunds', () => {
    const rows = [credit(dayStart(0), 10_000_000), credit(dayStart(0), -4_000_000, 'refund'), debit(dayStart(0), '3')]
    const buckets = bucketActivity(rows, 'd7', 'topups', now)
    expect(buckets[6]!.amount).toBeCloseTo(10)
    expect(buckets.reduce((a, b) => a + b.amount, 0)).toBeCloseTo(10)
  })

  it('drops rows older than the window and rows it cannot date', () => {
    const rows = [debit(dayStart(30), '9'), debit('not-a-date', '9'), debit(dayStart(2), '1')]
    const buckets = bucketActivity(rows, 'd7', 'usage', now)
    expect(buckets.reduce((a, b) => a + b.amount, 0)).toBeCloseTo(1)
  })

  it('spans exactly the range it will request, hourly for 24h', () => {
    const buckets = bucketActivity([], 'h24', 'usage', now)
    expect(buckets).toHaveLength(24)
    expect(buckets[0]!.start).toBe(activityWindowStart('h24', now))
    expect(buckets[23]!.start - buckets[22]!.start).toBe(3_600_000)
  })
})

// The 24-hour range is walked in elapsed hours, not wall-clock hours, so it survives a DST
// transition. Pinned in a zone that HAS one: in UTC the two implementations agree.
describe('bucketActivity across a spring-forward', () => {
  const realTz = process.env.TZ
  beforeAll(() => {
    process.env.TZ = 'America/New_York'
  })
  afterAll(() => {
    process.env.TZ = realTz
  })

  // 2026-03-08 skips local 02:00 in New York, so setting the wall-clock hour lands twice on
  // the same instant — 23 distinct buckets and a window start an hour late, which silently
  // drops an hour of the ledger from the request.
  const noon = new Date('2026-03-08T12:00:00-05:00').getTime()

  it('keeps 24 distinct, strictly ascending, one-hour-apart starts', () => {
    const buckets = bucketActivity([], 'h24', 'usage', noon)
    expect(new Set(buckets.map((b) => b.start)).size).toBe(24)
    for (let i = 1; i < buckets.length; i++) expect(buckets[i]!.start - buckets[i - 1]!.start).toBe(3_600_000)
    expect(activityWindowStart('h24', noon)).toBe(buckets[0]!.start)
  })

  it('still counts a row that posted in the skipped hour', () => {
    // 02:30 EST does not exist locally; the instant does, and it belongs to a bucket.
    const at = new Date('2026-03-08T07:30:00Z').toISOString()
    const buckets = bucketActivity([debit(at, '2.50')], 'h24', 'usage', noon)
    expect(buckets.reduce((a, b) => a + b.amount, 0)).toBeCloseTo(2.5)
  })

  it('keeps the 23-hour DST day exactly one bucket wide', () => {
    // Daily buckets stay calendar arithmetic on purpose: every start is a local midnight, and
    // the short day is still one bucket. Fixed-ms stepping would drift them off midnight here.
    const buckets = bucketActivity([], 'd7', 'usage', new Date('2026-03-09T12:00:00-04:00').getTime())
    expect(new Set(buckets.map((b) => b.start)).size).toBe(7)
    expect(buckets.every((b) => new Date(b.start).getHours() === 0)).toBe(true)
    const mar9 = buckets.findIndex((b) => new Date(b.start).getDate() === 9)
    expect(buckets[mar9]!.start - buckets[mar9 - 1]!.start).toBe(23 * 3_600_000)
  })
})
