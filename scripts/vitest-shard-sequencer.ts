import { statSync } from 'node:fs'
import { BaseSequencer, type TestSpecification } from 'vitest/node'

// Vitest shards by sha1 of the file path, which is a random partition — and a fixed one, so a bad
// draw stays bad. Over this repo's daemon suite a random half lands at 1.33:1 by median and 2:1 at
// p90. Greedy longest-processing-time over file size is a weak proxy (0.61 correlation with
// measured duration) but a far better partition: 1.15:1 on the same suite.
export class SizeBalancedSequencer extends BaseSequencer {
  async shard(specs: TestSpecification[]): Promise<TestSpecification[]> {
    const shard = this.ctx.config.shard
    if (!shard) return specs
    const weighed = specs.map((spec) => ({ item: spec, weight: sizeOf(spec.moduleId), key: spec.moduleId }))
    return balancedBuckets(weighed, shard.count)[shard.index - 1] ?? []
  }
}

/**
 * Greedy longest-processing-time. Every shard computes the WHOLE partition and keeps its own
 * bucket, so the order has to be total — equal weights tie, and two shards disagreeing would
 * drop a file from the run or execute it twice.
 */
export function balancedBuckets<T>(items: { item: T; weight: number; key: string }[], count: number): T[][] {
  const buckets: T[][] = Array.from({ length: count }, () => [])
  const load = new Array<number>(count).fill(0)
  for (const { item, weight } of [...items].sort((a, b) => b.weight - a.weight || (a.key < b.key ? -1 : 1))) {
    let at = 0
    for (let i = 1; i < load.length; i++) if (load[i]! < load[at]!) at = i
    load[at] = load[at]! + weight
    buckets[at]!.push(item)
  }
  return buckets
}

/** An unreadable file weighs nothing rather than failing the run — it fails on its own in a moment. */
function sizeOf(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}
