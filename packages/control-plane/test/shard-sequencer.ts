// Cost-balanced `--shard` splitting for the integration project.
//
// Vitest's stock sequencer hashes each path, sorts by the hash, and hands each shard a contiguous
// slice — so shards get an equal FILE COUNT and nothing else, and the split is blind to the fact
// that the heaviest file runs ~30x the cheapest. Measured over the whole suite that costs ~7% of
// wall clock (109.8s/125.4s of test time by hash, 116.4s/116.6s packed), and it is also what turns
// a slow runner into a one-sided job: the shard holding the expensive half absorbs all of the loss.
//
// So weight each file and pack the shards greedily — longest-processing-time first, each file onto
// the lightest shard so far. The weight is a STATIC count of `it(` / `test(` calls, which needs no
// timing manifest anyone has to keep fresh; against observed per-file durations it correlates 0.72,
// and re-packing a recorded 1600s/652s run by it lands at 1158s/1094s.
//
// A weight is only ever a scheduling hint. Getting one wrong costs balance, never correctness.
import { readFileSync } from 'node:fs'
import { relative } from 'node:path'
import { BaseSequencer, type TestSpecification } from 'vitest/node'

// `it(`, `test(`, and their chained forms (`it.each([…])(`, `test.skipIf(x)(`, `it.concurrent(`).
// The leading guard keeps `re.test(s)` and identifiers ending in `it` out of the count.
const TEST_CALL = /(?:^|[^\w$.])(?:it|test)(?:\s*\.\s*\w+(?:\s*\([^)]*\))?)*\s*[(`]/g

/** Files we cannot weigh still have to go somewhere; one keeps them light rather than dropping them. */
const FALLBACK_WEIGHT = 1

/** Static stand-in for "how many tests does this file run" — the weight, not a count anyone asserts on. */
export function countTestCalls(source: string): number {
  return Math.max(FALLBACK_WEIGHT, [...source.matchAll(TEST_CALL)].length)
}

/**
 * Greedy longest-processing-time packing: heaviest first, each item to the lightest shard.
 * Deterministic — every shard job runs this over the same list and keeps only its own bucket.
 */
export function balanceShards<T>(
  items: readonly T[],
  shards: number,
  weightOf: (item: T) => number,
  idOf: (item: T) => string
): T[][] {
  const buckets: T[][] = Array.from({ length: shards }, () => [])
  const totals = new Array<number>(shards).fill(0)
  const ordered = [...items].sort((a, b) => weightOf(b) - weightOf(a) || (idOf(a) < idOf(b) ? -1 : 1))

  for (const item of ordered) {
    let lightest = 0
    for (let i = 1; i < shards; i += 1) if (totals[i]! < totals[lightest]!) lightest = i
    buckets[lightest]!.push(item)
    totals[lightest] = totals[lightest]! + weightOf(item)
  }
  return buckets
}

const weights = new Map<string, number>()

function weigh(spec: TestSpecification): number {
  const cached = weights.get(spec.moduleId)
  if (cached !== undefined) return cached
  let weight = FALLBACK_WEIGHT
  try {
    weight = countTestCalls(readFileSync(spec.moduleId, 'utf8'))
  } catch {
    // Unreadable here means Vitest is about to fail on it anyway; do not abort scheduling over it.
  }
  weights.set(spec.moduleId, weight)
  return weight
}

export class CostBalancedSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const shard = this.ctx.config.shard
    if (!shard) return files
    const root = this.ctx.config.root
    const buckets = balanceShards(
      files,
      shard.count,
      weigh,
      (spec) => `${spec.project.name}:${relative(root, spec.moduleId)}`
    )
    return buckets[shard.index - 1] ?? []
  }
}
