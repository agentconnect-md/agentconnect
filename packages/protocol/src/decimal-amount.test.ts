import { describe, expect, it } from 'vitest'
import {
  DecimalAmount,
  ReportedCostAmount,
  canonicalizeDecimalAmount,
  decimalAmountFromNumber,
  normalizeReportedCostAmount,
  scaleAmount,
  sumAmounts,
  unscaleAmount
} from './decimal-amount.js'

describe('canonicalizeDecimalAmount', () => {
  it.each([
    ['0', '0'],
    ['12.75', '12.75'],
    ['0.00000125', '0.00000125'],
    ['0.000000000000000001', '0.000000000000000001'], // exactly 18 fractional digits
    ['99999999999999999999', '99999999999999999999'] // exactly 20 integer digits
  ])('keeps canonical %j', (input, expected) => {
    expect(canonicalizeDecimalAmount(input)).toBe(expected)
  })

  it.each([
    ['12.50', '12.5'],
    ['12.000', '12'],
    ['0.0', '0']
  ])('canonicalizes the trailing zeros of %j', (input, expected) => {
    expect(canonicalizeDecimalAmount(input)).toBe(expected)
  })

  it.each([
    '-1', // signed
    '+1',
    '1e-7', // exponential
    '1E7',
    '01.5', // redundant leading zero
    '1.', // no fractional digits
    '.5',
    '1_000',
    '1,5',
    '',
    ' 1 ',
    'NaN',
    'Infinity',
    '0.0000000000000000001', // 19 fractional digits — past the column's scale
    '100000000000000000000' // 21 integer digits — past the column's precision
  ])('refuses %j', (input) => {
    expect(canonicalizeDecimalAmount(input)).toBeNull()
  })
})

describe('decimalAmountFromNumber', () => {
  it.each([
    [0, '0'],
    [12.75, '12.75'],
    // The number as WRITTEN, not the binary approximation: toFixed(18) would
    // expand 0.1 to 0.100000000000000006.
    [0.1, '0.1'],
    [0.41, '0.41'],
    [1e-7, '0.0000001'], // exponential notation is expanded, never passed through
    [1.25e-8, '0.0000000125']
  ])('normalizes %j', (input, expected) => {
    expect(decimalAmountFromNumber(input)).toBe(expected)
  })

  it('rounds half up, once, at the scale of the column', () => {
    // 5e-19 is exactly half of the smallest storable unit ⇒ rounds up to it.
    expect(decimalAmountFromNumber(5e-19)).toBe('0.000000000000000001')
    // 4e-19 is below the halfway point ⇒ rounds down to zero.
    expect(decimalAmountFromNumber(4e-19)).toBe('0')
  })

  it('carries the rounding increment through a run of nines', () => {
    expect(decimalAmountFromNumber(9.99e-19)).toBe('0.000000000000000001')
  })

  it.each([-1, -0.5, Number.NaN, Number.POSITIVE_INFINITY, 1e20, 1e21])('refuses %j', (input) => {
    expect(decimalAmountFromNumber(input)).toBeNull()
  })

  it('treats negative zero as zero', () => {
    expect(decimalAmountFromNumber(-0)).toBe('0')
  })
})

describe('normalizeReportedCostAmount', () => {
  it('accepts both reported shapes and yields one', () => {
    expect(normalizeReportedCostAmount(12.5)).toBe('12.5')
    expect(normalizeReportedCostAmount('12.50')).toBe('12.5')
  })
})

describe('exact arithmetic', () => {
  it('round-trips the full width of the column through the scaled form', () => {
    // 20 integer + 18 fractional digits — 38 significant, past what a
    // 20-significant-digit decimal library would keep through one operation.
    const widest = '99999999999999999999.999999999999999999'
    expect(unscaleAmount(scaleAmount(widest))).toBe(widest)
  })

  it('adds a full-scale amount without dropping a digit', () => {
    // The regression: a decimal library rounds `123.123456789012345678` to
    // `123.12345678901234568` the moment it is added to zero.
    expect(sumAmounts(['123.123456789012345678', '0'])).toBe('123.123456789012345678')
    expect(sumAmounts(['123.123456789012345678', '0.000000000000000002'])).toBe('123.12345678901234568')
  })

  it('adds without the drift a float sum would show', () => {
    expect(sumAmounts(['0.1', '0.2'])).toBe('0.3') // 0.30000000000000004 as numbers
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

  it('signs a negative result, which a subtraction can produce', () => {
    expect(unscaleAmount(-scaleAmount('0.25'))).toBe('-0.25')
  })

  it('ignores an unscalable amount instead of poisoning the total', () => {
    expect(sumAmounts(['1.5', 'oops', ''])).toBe('1.5')
  })
})

describe('schemas', () => {
  it('DecimalAmount takes the decimal string only', () => {
    expect(DecimalAmount.safeParse('0.25').success).toBe(true)
    expect(DecimalAmount.safeParse('1e-7').success).toBe(false)
    expect(DecimalAmount.safeParse(0.25).success).toBe(false)
  })

  it('ReportedCostAmount takes either reported shape', () => {
    expect(ReportedCostAmount.safeParse('0.25').success).toBe(true)
    expect(ReportedCostAmount.safeParse(0.25).success).toBe(true)
    expect(ReportedCostAmount.safeParse('abc').success).toBe(false)
  })
})
