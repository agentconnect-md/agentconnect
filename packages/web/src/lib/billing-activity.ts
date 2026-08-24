// Bucketing for the Billing page's Activity chart. Pure — the fetch is
// `fetchBillingTransactionsSince` and the drawing is recharts; this only decides which
// bucket a ledger row lands in and how much it adds.
//
// Buckets are LOCAL calendar hours/days, matching the transactions table below the chart
// (which posts in the viewer's own timezone) and `bucketLabel`, which reads a bucket start
// as local time. Walking the boundaries with setHours/setDate rather than adding a fixed
// 3_600_000/86_400_000 is what keeps a DST day one day wide.

import type { BillingTransaction } from '@/lib/billing-api'
import { bucketLabel } from '@/lib/spend-chart'

export type ActivityRange = 'h24' | 'd7' | 'd30' | 'd90'
export type ActivityMode = 'usage' | 'topups'

export const ACTIVITY_RANGES = [
  { key: 'h24', label: '24h', note: 'last 24 hours', buckets: 24, unit: 'hour' },
  { key: 'd7', label: '7d', note: 'last 7 days', buckets: 7, unit: 'day' },
  { key: 'd30', label: '30d', note: 'last 30 days', buckets: 30, unit: 'day' },
  { key: 'd90', label: '90d', note: 'last 90 days', buckets: 90, unit: 'day' }
] as const satisfies readonly {
  key: ActivityRange
  label: string
  note: string
  buckets: number
  unit: 'hour' | 'day'
}[]

export const activityRange = (key: ActivityRange) => ACTIVITY_RANGES.find((r) => r.key === key)!

/** UTC ms of every bucket start in the range, oldest first, the last one holding `nowMs`. */
function bucketStarts(range: ActivityRange, nowMs: number): number[] {
  const { buckets, unit } = activityRange(range)
  const last = new Date(nowMs)
  if (unit === 'hour') last.setMinutes(0, 0, 0)
  else last.setHours(0, 0, 0, 0)
  const starts: number[] = []
  for (let back = buckets - 1; back >= 0; back--) {
    const d = new Date(last)
    if (unit === 'hour') d.setHours(d.getHours() - back)
    else d.setDate(d.getDate() - back)
    starts.push(d.getTime())
  }
  return starts
}

/** Start of the window a range covers — what goes to the service as `from`. */
export function activityWindowStart(range: ActivityRange, nowMs: number = Date.now()): number {
  return bucketStarts(range, nowMs)[0]!
}

export interface ActivityBucket {
  start: number
  label: string
  amount: number
}

/** One row per bucket, oldest first. `amount` is USD as a NUMBER because it is chart
 *  geometry and a total under it — the exact decimal string a debit carries stays in the
 *  transactions table, which is the reconciliation surface. Rows outside the window, and
 *  rows the other mode owns, add nothing. */
export function bucketActivity(
  rows: readonly BillingTransaction[],
  range: ActivityRange,
  mode: ActivityMode,
  nowMs: number = Date.now()
): ActivityBucket[] {
  const starts = bucketStarts(range, nowMs)
  const { unit } = activityRange(range)
  const amounts = new Array<number>(starts.length).fill(0)
  for (const row of rows) {
    const at = Date.parse(row.at)
    if (!Number.isFinite(at) || at < starts[0]!) continue
    const amount =
      mode === 'usage'
        ? row.type === 'debit'
          ? Number(row.amount)
          : 0
        : // Positive credits only: a refund is a negative credit, and a bar that eats into
          // the day beside it reads as usage rather than as money coming back.
          row.type === 'credit' && row.amountMicro > 0
          ? row.amountMicro / 1_000_000
          : 0
    if (!Number.isFinite(amount) || amount <= 0) continue
    // Last bucket that had already started when the row posted.
    let i = starts.length - 1
    while (i > 0 && starts[i]! > at) i--
    amounts[i] = amounts[i]! + amount
  }
  return starts.map((start, i) => ({
    start,
    label: bucketLabel(new Date(start).toISOString(), unit),
    amount: amounts[i]!
  }))
}
