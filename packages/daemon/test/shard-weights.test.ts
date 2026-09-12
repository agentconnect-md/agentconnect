// An entry that no longer names a real file weighs nothing, silently — the file it replaced falls back to
// one second and the shards drift back toward the split that measured 2.44 to 1. The sequencer matches a
// module id by suffix, so a key that is not a package-relative POSIX path never matches either.
import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { TestSpecification } from 'vitest/node'
import { weightBalancedSequencer } from '../../../scripts/vitest-shard-sequencer.js'
import { SHARD_WEIGHTS, SHARD_WEIGHT_FALLBACK } from '../vitest.config.js'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const entries = Object.entries(SHARD_WEIGHTS)

describe('shard weights', () => {
  it('names files that exist', () => {
    expect(entries.filter(([file]) => !existsSync(join(packageRoot, file))).map(([file]) => file)).toEqual([])
  })

  it('keys them the way the sequencer matches them', () => {
    expect(entries.filter(([file]) => file.includes('\\') || file.startsWith('./') || file.startsWith('/'))).toEqual([])
  })

  it('weighs each one above the fallback, or the entry buys nothing', () => {
    expect(entries.filter(([, weight]) => weight <= SHARD_WEIGHT_FALLBACK)).toEqual([])
  })

  // The whole table reaches the partition through one suffix match against an absolute module id: get that
  // wrong and every file silently weighs the fallback, which is the imbalance this table exists to remove.
  it('splits the weight it names evenly between two shards', async () => {
    const Sequencer = weightBalancedSequencer(SHARD_WEIGHTS, SHARD_WEIGHT_FALLBACK)
    const specs = entries.map(([file]) => ({ moduleId: join(packageRoot, file) }) as TestSpecification)
    const halves = await Promise.all(
      [1, 2].map((index) => new Sequencer({ config: { shard: { index, count: 2 } } } as never).shard(specs))
    )
    const weigh = (half: TestSpecification[]) =>
      half.reduce(
        (total, spec) => total + (SHARD_WEIGHTS[spec.moduleId.slice(packageRoot.length).replaceAll('\\', '/')] ?? 0),
        0
      )
    const total = entries.reduce((sum, [, weight]) => sum + weight, 0)
    expect(halves.flat().length).toBe(specs.length)
    expect(new Set(halves.flat()).size).toBe(specs.length)
    // Equal to the table's own sum only if every module id matched an entry; a fallback everywhere balances too.
    expect(weigh(halves[0]!) + weigh(halves[1]!)).toBe(total)
    expect(Math.abs(weigh(halves[0]!) - weigh(halves[1]!)) / total).toBeLessThan(0.05)
  })
})
