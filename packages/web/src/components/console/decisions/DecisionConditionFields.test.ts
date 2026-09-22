import { describe, expect, it } from 'vitest'
import { intervalText } from './DecisionConditionFields'

describe('intervalText', () => {
  // Half-open everywhere except the rubric maximum, which is the one endpoint that includes.
  it('excludes the upper bound below the rubric maximum', () => {
    expect(intervalText({ type: 'score', min: 1, max: 2.5 }, 4)).toBe('1 ≤ score < 2.5')
  })

  it('includes the rubric maximum', () => {
    expect(intervalText({ type: 'score', min: 2.5, max: 3 }, 4)).toBe('2.5 ≤ score ≤ 3')
  })

  // The design prints the inequalities rather than relying on a rounded value.
  it('keeps decimals as the model returned them', () => {
    expect(intervalText({ type: 'score', min: 0.5, max: 1.25 }, 4)).toBe('0.5 ≤ score < 1.25')
  })
})
