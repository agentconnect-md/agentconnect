// The scheduling half of the integration suite's cost-balanced sharding (`test/shard-sequencer.ts`).
// What matters here is that the packing is deterministic, total, and disjoint — every shard job runs
// the same function over the same file list and keeps only its own bucket, so a split that disagreed
// between jobs would silently drop or double-run tests.
import { describe, it, expect } from 'vitest'
import { balanceShards, countTestCalls } from './shard-sequencer.js'

const pack = (weights: readonly number[], shards: number) =>
  balanceShards(
    weights.map((weight, index) => ({ weight, id: `f${index}` })),
    shards,
    (item) => item.weight,
    (item) => item.id
  )

const totals = (buckets: { weight: number }[][]) => buckets.map((b) => b.reduce((s, i) => s + i.weight, 0))

describe('countTestCalls', () => {
  it('counts plain and chained test calls', () => {
    expect(
      countTestCalls(`
        it('a', () => {})
        test('b', () => {})
        it.each([1, 2])('c %i', () => {})
        it.concurrent('d', () => {})
        test.skipIf(cond)('e', () => {})
      `)
    ).toBe(5)
  })

  it('ignores method calls that merely end in the keyword', () => {
    // `re.test(x)` and `submit(x)` are the two ways a naive \\b(it|test) regex over-counts.
    expect(countTestCalls('const ok = /x/.test(input); submit(form); await unit(1)')).toBe(1)
  })

  it('never returns zero, so an unparsed file still gets scheduled', () => {
    expect(countTestCalls('')).toBe(1)
    expect(countTestCalls('export const helper = 1')).toBe(1)
  })

  it('counts the real integration files it will be weighing', () => {
    // A sanity floor against a regex change that quietly zeroes every weight.
    expect(countTestCalls(`describe('x', () => { it('a', () => {}); it('b', () => {}) })`)).toBe(2)
  })
})

describe('balanceShards', () => {
  it('beats a count-based split on the skew that motivated it', () => {
    // Eight files, one of them dominant: a contiguous half-and-half split is 2x off, packing is even.
    const weights = [40, 20, 20, 10, 10, 10, 5, 5]
    const [a, b] = totals(pack(weights, 2))
    expect(Math.max(a!, b!) / Math.min(a!, b!)).toBeLessThan(1.1)
  })

  it('keeps every item exactly once across the shards', () => {
    const buckets = pack([9, 8, 7, 6, 5, 4, 3, 2, 1], 3)
    const ids = buckets.flat().map((i) => i.id)
    expect(ids).toHaveLength(9)
    expect(new Set(ids).size).toBe(9)
  })

  it('is deterministic regardless of the order files were discovered in', () => {
    const items = [5, 3, 9, 1, 7, 3, 8].map((weight, index) => ({ weight, id: `f${index}` }))
    const split = (list: typeof items) =>
      balanceShards(
        list,
        3,
        (i) => i.weight,
        (i) => i.id
      ).map((bucket) => bucket.map((i) => i.id).sort())

    expect(split([...items].reverse())).toEqual(split(items))
    expect(split([...items].sort((x, y) => (x.id < y.id ? 1 : -1)))).toEqual(split(items))
  })

  it('breaks weight ties by id so equal-cost files cannot drift between jobs', () => {
    const equal = Array.from({ length: 6 }, (_, index) => ({ weight: 1, id: `f${index}` }))
    const split = () =>
      balanceShards(
        equal,
        2,
        () => 1,
        (i) => i.id
      ).map((bucket) => bucket.map((i) => i.id))
    expect(split()).toEqual(split())
  })

  it('returns one empty bucket per shard when there is nothing to run', () => {
    expect(pack([], 3)).toEqual([[], [], []])
  })

  it('leaves surplus shards empty rather than failing', () => {
    const buckets = pack([1, 1], 4)
    expect(buckets).toHaveLength(4)
    expect(buckets.flat()).toHaveLength(2)
  })

  it('puts everything in one bucket for a single shard', () => {
    expect(pack([3, 1, 2], 1)[0]).toHaveLength(3)
  })
})
