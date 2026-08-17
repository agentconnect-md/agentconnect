import { describe, expect, it } from 'vitest'
import { amountToNumber, sumAmounts } from './amount.js'

describe('sumAmounts', () => {
  it('adds without the drift a float sum would show', () => {
    // 0.1 + 0.2 as numbers is 0.30000000000000004.
    expect(sumAmounts(['0.1', '0.2'])).toBe('0.3')
    expect(sumAmounts(['0.1', '0.2', '0.05'])).toBe('0.35')
  })

  it('keeps sub-cent precision across many rows', () => {
    expect(sumAmounts(Array.from({ length: 1000 }, () => '0.000000000000000001'))).toBe('0.000000000000001')
  })

  it.each([
    [[], '0'],
    [['0'], '0'],
    [['12.50', '0.50'], '13'],
    [['1', '-0.5'], '0.5'], // a netted downward correction
    [['99999999999999999999', '1'], '100000000000000000000']
  ])('sums %j to %j', (amounts, expected) => {
    expect(sumAmounts(amounts)).toBe(expected)
  })

  it('ignores an unparseable amount instead of poisoning the total with NaN', () => {
    expect(sumAmounts(['1.5', 'oops', ''])).toBe('1.5')
  })
})

describe('amountToNumber', () => {
  it('converts for display and geometry', () => {
    expect(amountToNumber('12.5')).toBe(12.5)
    expect(amountToNumber('0')).toBe(0)
  })

  it('degrades an unusable amount to zero rather than NaN', () => {
    expect(amountToNumber('oops')).toBe(0)
  })
})
