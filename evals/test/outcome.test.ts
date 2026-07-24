import type { AssertionValueFunctionContext } from 'promptfoo'
import { describe, expect, it } from 'vitest'
import outcome from '../assertions/outcome.js'

function context(vars: Record<string, unknown>): AssertionValueFunctionContext {
  return { vars } as AssertionValueFunctionContext
}

describe('evaluation outcome assertion', () => {
  it('scores exact instruction following without failing an expected-low control cell', () => {
    expect(outcome(' CORE-OK-7319\n', context({ expected: 'CORE-OK-7319', match: 'exact' }))).toMatchObject({
      pass: true,
      score: 1
    })
    expect(outcome('Here it is: CORE-OK-7319', context({ expected: 'CORE-OK-7319', match: 'exact' }))).toMatchObject({
      pass: true,
      score: 0
    })
    expect(outcome('core-ok-7319', context({ expected: 'CORE-OK-7319', match: 'exact' }))).toMatchObject({
      pass: true,
      score: 0
    })
  })

  it('retains contains mode for future multi-signal cases', () => {
    expect(outcome('alpha then beta', context({ expected: ['alpha', 'beta'] }))).toMatchObject({
      pass: true,
      score: 1
    })
  })
})
