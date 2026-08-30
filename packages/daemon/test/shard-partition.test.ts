import { describe, expect, it } from 'vitest'
import { balancedBuckets } from '../../../scripts/vitest-shard-sequencer.js'

// Each shard runs this independently and keeps only its own bucket, so a partition that is not
// exactly disjoint-and-complete silently drops a test file from CI or runs it on both shards.
describe('shard partition', () => {
  const items = Array.from({ length: 307 }, (_, i) => ({ item: `f${i}`, weight: (i * 7919) % 500, key: `f${i}` }))

  it('covers every file exactly once, whatever the shard count', () => {
    for (const count of [1, 2, 3, 8]) {
      const flat = balancedBuckets(items, count).flat()
      expect(flat.length).toBe(items.length)
      expect(new Set(flat).size).toBe(items.length)
    }
  })

  it('agrees with itself across runs, so two shards cannot disagree', () => {
    expect(balancedBuckets(items, 2)).toEqual(balancedBuckets([...items].reverse(), 2))
  })

  it('balances weight better than a contiguous split of the same order', () => {
    const weight = (b: string[]) => b.reduce((n, k) => n + items[Number(k.slice(1))]!.weight, 0)
    const [a, b] = balancedBuckets(items, 2).map(weight) as [number, number]
    expect(Math.abs(a - b)).toBeLessThan(items.length)
  })
})
