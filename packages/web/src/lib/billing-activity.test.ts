import { describe, expect, it } from 'vitest'
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
