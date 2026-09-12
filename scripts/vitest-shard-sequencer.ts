import { BaseSequencer, type TestSpecification } from 'vitest/node'

// Vitest shards by sha1 of the file path, a random partition — and a fixed one, so a bad draw stays bad.
// Greedy longest-processing-time over a weight partitions far better, and that weight has to be measured:
// file size mis-weighs `daemon-hook.test.ts` (174 KB) as 0.6 s against 67 s measured on the Windows runner,
// and the halves it drew over three runs came out 1.61, 1.67 and 2.44 to 1 against 1.01 on all three from a table.
export function weightBalancedSequencer(weights: Record<string, number>, fallback: number) {
  return class WeightBalancedSequencer extends BaseSequencer {
    async shard(specs: TestSpecification[]): Promise<TestSpecification[]> {
      const shard = this.ctx.config.shard
      if (!shard) return specs
      const weighed = specs.map((spec) => ({
        item: spec,
        weight: weigh(spec.moduleId, weights, fallback),
        key: spec.moduleId
      }))
      return balancedBuckets(weighed, shard.count)[shard.index - 1] ?? []
    }
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

// Module ids are absolute and the table's keys are package-relative, so match the suffix; a win32 id carries backslashes.
function weigh(moduleId: string, weights: Record<string, number>, fallback: number): number {
  const path = moduleId.replaceAll('\\', '/')
  for (const [file, weight] of Object.entries(weights)) if (path.endsWith(`/${file}`)) return weight
  return fallback
}
