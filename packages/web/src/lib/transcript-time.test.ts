import { describe, expect, it } from 'vitest'
import { formatTranscriptTime, parseTranscriptTime } from './transcript-time'

describe('transcript time', () => {
  it('parses a suffixed hook timestamp as epoch milliseconds', () => {
    const raw = '1783840089123|aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:retry-a'

    expect(parseTranscriptTime(raw)).toBe(1_783_840_089_123)
    expect(formatTranscriptTime(raw)).not.toBe('')
  })

  it('preserves Slack epoch-second timestamp parsing', () => {
    expect(parseTranscriptTime('1710799200.123456')).toBeCloseTo(1_710_799_200_123.456)
  })

  it('returns "" instead of throwing for an out-of-range (micro/nanosecond) timestamp', () => {
    // 1.7e18 is finite but beyond Date's ±8.64e15 ms range → Invalid Date.
    // Intl.format() would throw "Invalid time value" and crash the transcript render.
    const raw = '1710799200000000000'
    expect(parseTranscriptTime(raw)).toBe(1_710_799_200_000_000_000)
    expect(() => formatTranscriptTime(raw)).not.toThrow()
    expect(formatTranscriptTime(raw)).toBe('')
  })
})
