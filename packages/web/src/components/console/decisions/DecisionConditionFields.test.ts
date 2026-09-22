import { describe, expect, it } from 'vitest'
import { intervalText, levelInInterval } from './DecisionConditionFields'

describe('intervalText', () => {
  // Half-open everywhere except the rubric maximum, which is the one endpoint that includes.
  it('excludes the upper bound below the rubric maximum', () => {
    expect(intervalText({ type: 'score', min: 1, max: 2.5 }, 4)).toBe('1 ≤ score < 2.5')
  })

  it('includes the rubric maximum', () => {
    expect(intervalText({ type: 'score', min: 2.5, max: 3 }, 4)).toBe('2.5 ≤ score ≤ 3')
  })
})

describe('levelInInterval', () => {
  it('marks the levels a half-open interval covers', () => {
    const interval = { type: 'score', min: 1, max: 2.5 } as const
    expect([0, 1, 2, 3].map((level) => levelInInterval(interval, level, 4))).toEqual([false, true, true, false])
  })

  // A fraction endpoint between levels still excludes the level at or past it.
  it('excludes the level at a fractional endpoint', () => {
    const interval = { type: 'score', min: 0, max: 2.5 } as const
    expect([0, 1, 2, 3].map((level) => levelInInterval(interval, level, 4))).toEqual([true, true, true, false])
  })

  it('includes the terminal level when the interval ends at the maximum', () => {
    const interval = { type: 'score', min: 2.5, max: 3 } as const
    expect([0, 1, 2, 3].map((level) => levelInInterval(interval, level, 4))).toEqual([false, false, false, true])
  })
})
