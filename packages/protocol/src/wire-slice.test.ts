import { describe, expect, it } from 'vitest'
import { REPLY_BUDGET } from './wire.js'
import { encodedBytes, fitToBudget, utf8Boundary } from './wire-slice.js'

const encode = (text: string) => new TextEncoder().encode(text)

describe('utf8Boundary', () => {
  it('keeps a cut that lands on a boundary and moves one that splits a character', () => {
    const buf = encode('aé€😀') // 1 + 2 + 3 + 4 bytes
    expect(utf8Boundary(buf, 1)).toBe(1)
    expect(utf8Boundary(buf, 2)).toBe(1) // inside é
    expect(utf8Boundary(buf, 3)).toBe(3)
    expect(utf8Boundary(buf, 5)).toBe(3) // inside €
    expect(utf8Boundary(buf, 6)).toBe(6)
    expect(utf8Boundary(buf, 8)).toBe(6) // inside 😀
    expect(utf8Boundary(buf, 10)).toBe(10)
    expect(utf8Boundary(buf, 99)).toBe(10)
    expect(utf8Boundary(buf, 0)).toBe(0)
  })
})

describe('fitToBudget', () => {
  it('returns the whole slice when it already fits', () => {
    const buf = encode('hello wörld')
    expect(fitToBudget(buf, buf.length)).toEqual({ end: buf.length, content: 'hello wörld' })
  })

  it('keeps a leading U+FEFF: a slice is bytes, and a BOM at a chunk boundary is mid-file', () => {
    const buf = encode('\uFEFFhello')
    expect(fitToBudget(buf, buf.length)).toEqual({ end: 8, content: '\uFEFFhello' })
    expect(fitToBudget(buf, 3)).toEqual({ end: 3, content: '\uFEFF' })
  })

  it('shrinks escape-heavy text under the budget without splitting a character', () => {
    const text = ''.repeat(REPLY_BUDGET / 4) + '😀'.repeat(REPLY_BUDGET / 8)
    const buf = encode(text)
    const { end, content } = fitToBudget(buf, buf.length)
    expect(end).toBeLessThan(buf.length)
    expect(encodedBytes(content)).toBeLessThanOrEqual(REPLY_BUDGET)
    expect(content).toBe(new TextDecoder().decode(buf.subarray(0, end)))
    expect(content).not.toContain('�')
  })
})
