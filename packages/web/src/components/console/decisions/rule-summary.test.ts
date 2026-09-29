import { expect, it } from 'vitest'
import { conditionText } from './rule-summary'

it('words each kind of condition in one line', () => {
  expect(conditionText({ type: 'choice', thresholds: { feature: 0.6 } })).toBe('feature ≥ 60%')
  expect(
    conditionText(
      { type: 'score', min: 2, max: 4 },
      { type: 'score', instructions: 'Rate it.', criteria: ['a', 'b', 'c', 'd', 'e'] }
    )
  ).toBe('2 ≤ score ≤ 4')
  expect(conditionText({ type: 'boolean', values: [true] })).toBe('true')
})
