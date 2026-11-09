import { describe, expect, it } from 'vitest'
import {
  formatTranscriptTime,
  parseTranscriptTime,
  formatTranscriptRowTime,
  turnTimeLabel,
  transcriptRowTimeMs
} from './transcript-time'

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
  it('prefers the stored event-time axis for rows whose ts is a native platform id', () => {
    // Telegram sequence id, Feishu om_ id, Discord snowflake: none is a
    // parseable clock time — the daemon-stored axis must drive the label and
    // duration math; legacy rows without it fall back to ts.
    const authoritative = 1_754_123_458_000_000 // µs
    expect(transcriptRowTimeMs({ ts: '4821', eventTimeUs: authoritative })).toBe(1_754_123_458_000)
    expect(transcriptRowTimeMs({ ts: 'om_abc', eventTimeUs: authoritative })).toBe(1_754_123_458_000)
    expect(transcriptRowTimeMs({ ts: '1101111111111111111', eventTimeUs: authoritative })).toBe(1_754_123_458_000)
    expect(formatTranscriptRowTime({ ts: 'om_abc', eventTimeUs: authoritative })).not.toBe('')
    // Legacy fallback: no stored axis → derive from ts exactly as before.
    expect(transcriptRowTimeMs({ ts: '1754123457123' })).toBe(1_754_123_457_123)
    expect(formatTranscriptRowTime({ ts: 'om_abc' })).toBe('')
  })
})

describe('turnTimeLabel', () => {
  const now = new Date(2026, 10, 9, 15, 0).getTime()
  it('keeps a time from today bare, and leads one from another day with its date and another year with its year', () => {
    expect(turnTimeLabel('2:17:37 PM', new Date(2026, 10, 9, 14, 17).getTime(), now)).toBe('2:17:37 PM')
    expect(turnTimeLabel('4:28:11 AM', new Date(2026, 10, 7, 4, 28).getTime(), now)).toBe('Nov 7, 4:28:11 AM')
    expect(turnTimeLabel('9:00:00 AM', new Date(2025, 0, 2, 9).getTime(), now)).toBe('Jan 2, 2025, 9:00:00 AM')
    expect(turnTimeLabel('9:00:00 AM', undefined, now)).toBe('9:00:00 AM')
  })
})
