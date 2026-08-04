import { describe, it, expect } from 'vitest'
import { hasNativeMessageOrder, messageOrderingFor } from '../src/platforms/message-ordering.js'

describe('message-ordering strategy (cursorOrdering)', () => {
  const slack = messageOrderingFor('slack')!

  it('registers a native order for Slack only', () => {
    expect(hasNativeMessageOrder('slack')).toBe(true)
    for (const platform of ['telegram', 'discord', 'feishu', 'webchat', 'hook', 'github']) {
      expect(hasNativeMessageOrder(platform)).toBe(false)
      expect(messageOrderingFor(platform)).toBeUndefined()
    }
  })

  it('is fail-closed for an unknown platform and for prototype keys', () => {
    // The absence IS the default: no neutral comparator that could silently
    // answer "equal" for ids it cannot order.
    expect(messageOrderingFor('some-future-platform')).toBeUndefined()
    expect(messageOrderingFor('constructor')).toBeUndefined()
    expect(hasNativeMessageOrder('constructor')).toBe(false)
    expect(hasNativeMessageOrder('toString')).toBe(false)
  })

  it('reads a Slack coordinate only from a canonical decimal ts', () => {
    expect(slack.coordinate('1784098696.100000')).toBe(1784098696100000n)
    // Short fractional parts are right-padded to microseconds, so '100.1' and
    // '100.100000' are the SAME instant — both spellings appear on the wire.
    expect(slack.coordinate('100.1')).toBe(slack.coordinate('100.100000'))
    // Everything the platform never issued has no coordinate: anchored cron/hook
    // UUIDs, bare epoch millis, and over-precise or malformed decimals.
    for (const id of ['trace-1', 'cron:daily:trace-1', '1784098696', '100.1234567', '', '.5', '100.']) {
      expect(slack.coordinate(id)).toBeNull()
    }
  })

  it('orders Slack ids by microsecond, not lexically', () => {
    // A plain string compare gets this backwards: lexically '1000.1' < '999.9',
    // but 1000.1 is the LATER instant. Same divergence at the second boundary.
    expect(slack.compare('1000.1', '999.9')).toBeGreaterThan(0)
    expect(slack.compare('999.9', '1000.1')).toBeLessThan(0)
    expect(slack.compare('99.999999', '100.000000')).toBeLessThan(0)
    // Padding makes the two spellings of one instant compare equal.
    expect(slack.compare('100.100000', '100.1')).toBe(0)
    expect(slack.compare('100.10', '100.9')).toBeLessThan(0)
    // BigInt, because microseconds at today's epoch exceed float precision.
    expect(slack.compare('1784098696.100000', '1784098696.100001')).toBeLessThan(0)
  })

  it('sorts coordinate-less ids before every real one, and stays total', () => {
    // A real follow-up must never look older than the synthetic cursor that
    // created its thread (legacy anchored cron/hook turns persisted UUIDs).
    expect(slack.compare('trace-1', '100.1')).toBeLessThan(0)
    expect(slack.compare('100.1', 'trace-1')).toBeGreaterThan(0)
    // Two synthetic ids still compare deterministically, so a sort is stable.
    expect(slack.compare('trace-a', 'trace-b')).toBe('trace-a'.localeCompare('trace-b'))
    expect(slack.compare('trace-a', 'trace-a')).toBe(0)
    expect(['1000.1', 'trace-1', '100.10', '999.9'].sort(slack.compare)).toEqual([
      'trace-1',
      '100.10',
      '999.9',
      '1000.1'
    ])
  })

  it('keeps coordinate-less ids inside any wall-clock cutoff', () => {
    expect(slack.withinCutoff('100.1', '100.5')).toBe(true)
    expect(slack.withinCutoff('100.5', '100.5')).toBe(true)
    expect(slack.withinCutoff('100.6', '100.5')).toBe(false)
    // A synthetic id cannot be compared with a wall-clock marker at all, so a
    // snapshot keeps it rather than silently dropping it.
    expect(slack.withinCutoff('trace-1', '100.5')).toBe(true)
  })
})
