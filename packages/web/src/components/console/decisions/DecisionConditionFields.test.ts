import { describe, expect, it } from 'vitest'
import { conditionSummary, intervalText } from './DecisionConditionFields'

describe('conditionSummary', () => {
  const words = { yes: 'Yes', no: 'No', none: 'No answer' }

  it('words a yes/no condition as Yes or No even without its question', () => {
    expect(conditionSummary(undefined, { type: 'boolean', values: [true] }, words)).toBe('Yes')
    expect(conditionSummary(undefined, { type: 'boolean', values: [false, true] }, words)).toBe('No or Yes')
  })

  it('reads a score condition by its rubric, or by its bounds without the question', () => {
    const question = { type: 'score' as const, instructions: 'Rate it.', criteria: ['a', 'b', 'c', 'd', 'e'] }
    expect(conditionSummary(question, { type: 'score', min: 2, max: 4 }, words)).toBe('2 ≤ score ≤ 4')
    expect(conditionSummary(undefined, { type: 'score', min: 2, max: 4 }, words)).toBe('2–4')
  })

  it('lists choice thresholds without the question', () => {
    expect(conditionSummary(undefined, { type: 'choice', thresholds: { feature: 0.6 } }, words)).toBe('feature ≥ 60%')
  })
})

describe('intervalText', () => {
  // Half-open everywhere except the rubric maximum, which is the one endpoint that includes.
  it('excludes the upper bound below the rubric maximum', () => {
    expect(intervalText({ type: 'score', min: 1, max: 2.5 }, 4)).toBe('1 ≤ score < 2.5')
  })

  it('includes the rubric maximum', () => {
    expect(intervalText({ type: 'score', min: 2.5, max: 3 }, 4)).toBe('2.5 ≤ score ≤ 3')
  })

  it('keeps decimals as the model returned them', () => {
    expect(intervalText({ type: 'score', min: 0.5, max: 1.25 }, 4)).toBe('0.5 ≤ score < 1.25')
  })
})
