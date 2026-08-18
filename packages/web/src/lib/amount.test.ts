import { describe, expect, it } from 'vitest'
import { amountToNumber, sumAmounts } from './amount.js'

describe('sumAmounts', () => {
  it('is the protocol package’s exact addition, re-exported', () => {
    expect(sumAmounts(['0.1', '0.2', '0.05'])).toBe('0.35')
    expect(sumAmounts(['123.123456789012345678', '0'])).toBe('123.123456789012345678')
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
