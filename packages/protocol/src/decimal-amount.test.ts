import { describe, expect, it } from 'vitest'
import {
  DecimalAmount,
  ReportedCostAmount,
  canonicalizeDecimalAmount,
  decimalAmountFromNumber,
  normalizeReportedCostAmount
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
