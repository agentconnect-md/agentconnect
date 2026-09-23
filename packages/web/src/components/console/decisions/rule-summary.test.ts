import { expect, it } from 'vitest'
import { ruleSummaries } from './rule-summary'

it('summarizes each rule as its condition and the model it picks', () => {
  expect(
    ruleSummaries(
      {
        decisionId: '44444444-4444-4444-8444-444444444444',
        rules: [
          { when: { type: 'choice', thresholds: { feature: 0.6 } }, runtime: 'claude', model: 'model-capable' },
          { when: { type: 'score', min: 2, max: 4 }, runtime: 'codex', model: '' },
          { when: { type: 'boolean', values: [true] }, runtime: 'claude', model: 'model-standard' }
        ]
      },
      { type: 'score', instructions: 'Rate it.', criteria: ['a', 'b', 'c', 'd', 'e'] }
    )
  ).toEqual([
    { when: 'feature ≥ 60%', then: 'model-capable' },
    { when: '2 ≤ score ≤ 4', then: 'codex' },
    { when: 'true', then: 'model-standard' }
  ])
})
