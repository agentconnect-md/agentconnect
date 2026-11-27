import { describe, expect, it } from 'vitest'
import { OPEN_RANGE_CAP, resolveByteRange } from './protocol'

describe('resolveByteRange', () => {
  const size = 1_000_000

  it.each([null, '', 'bytes=-', 'items=0-1', 'bytes=0-1,5-6', 'bytes=5-1', 'bytes=a-b'])('answers %j whole', (header) =>
    expect(resolveByteRange(header, size)).toBeNull()
  )

  it('caps an open-ended range so media streams in pieces', () => {
    expect(resolveByteRange('bytes=0-', size)).toEqual({ start: 0, end: OPEN_RANGE_CAP - 1 })
    expect(resolveByteRange('bytes=999990-', size)).toEqual({ start: 999_990, end: size - 1 })
  })

  it('keeps an explicit range, clamped to the file', () => {
    expect(resolveByteRange('bytes=10-19', size)).toEqual({ start: 10, end: 19 })
    expect(resolveByteRange('bytes=10-5000000', size)).toEqual({ start: 10, end: size - 1 })
  })

  it('answers a suffix range from the end', () => {
    expect(resolveByteRange('bytes=-100', size)).toEqual({ start: size - 100, end: size - 1 })
    expect(resolveByteRange('bytes=-5000000', size)).toEqual({ start: 0, end: size - 1 })
  })

  it.each(['bytes=1000000-', 'bytes=2000000-2000001', 'bytes=-0'])('refuses %j as unsatisfiable', (header) =>
    expect(resolveByteRange(header, size)).toBe('unsatisfiable')
  )
})
