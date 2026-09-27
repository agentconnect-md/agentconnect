import { describe, expect, it } from 'vitest'
import type { SessionMessageDto } from '@/lib/api'
import { platformMessageIdentity, platformRegistry, platformTextRenderer, platformTranscriptOrdering } from './registry'

/**
 * The three transcript-domain module members (§10) read through the registry
 * rather than through an if-chain over platform ids. What these pin is the
 * DEFAULTS — the answers for ids no module claims — because that is where the
 * two shapes disagreed: the old chain made Slack the fall-through for
 * everything unrecognized, while the contract says an absent member means the
 * platform opts out.
 */
const UNCLAIMED = ['zulip', 'hook', 'github', 'playground', 'webchat', 'lark', 'Slack', 'constructor', '__proto__', '']

let seq = 0
function row(over: Partial<SessionMessageDto>): SessionMessageDto {
  return { seq: ++seq, sender: 'user-1', ts: '1000', kind: 'text', text: 'hi', ...over }
}

describe('transcript module members', () => {
  it('gives only Google Chat a text renderer of its own', () => {
    // Each override lands with its own visual review, so the set is named here and a new one is a visible diff.
    expect(
      platformRegistry
        .all()
        .filter((module) => module.textRenderer)
        .map((module) => module.platformId)
    ).toEqual(['googlechat'])
    for (const id of [...platformRegistry.ids().filter((id) => id !== 'googlechat'), ...UNCLAIMED]) {
      expect(platformTextRenderer(id), id).toBeUndefined()
    }
    expect(platformTextRenderer(undefined)).toBeUndefined()
  })

  it('recognizes each registered platform’s native message id', () => {
    const SNOWFLAKE = '1101111111111111111'
    expect(platformMessageIdentity('slack', row({ ts: '1754123456.000200' }))).toBe('ts:1754123456.000200')
    expect(platformMessageIdentity('discord', row({ ts: SNOWFLAKE }))).toBe(`ts:${SNOWFLAKE}`)
    expect(platformMessageIdentity('telegram', row({ ts: '4821' }))).toBe('ts:4821')
    expect(platformMessageIdentity('feishu', row({ ts: 'om_abc123' }))).toBe('ts:om_abc123')
    const ACTIVITY = 'b0f4b1a2-6c1e-4a3f-9f21-7c0d5e8a1b34'
    expect(platformMessageIdentity('linear', row({ ts: ACTIVITY }))).toBe(`ts:${ACTIVITY}`)
    // A Slack-shaped decimal ts is not an agent-activity id, so Linear declines it.
    expect(platformMessageIdentity('linear', row({ ts: '1754123456.000200' }))).toBeNull()
    // A daemon-local millisecond stamp is nobody's native id.
    for (const id of platformRegistry.ids()) {
      expect(platformMessageIdentity(id, row({ ts: '1754123457123' })), id).toBeNull()
    }
  })

  it('dedupes nothing for a platform id no module claims', () => {
    // Not even a Slack-SHAPED id: an unclaimed platform has no id rule, and
    // borrowing another platform's would risk deleting a distinct row.
    for (const id of UNCLAIMED) {
      expect(platformMessageIdentity(id, row({ ts: '1754123456.000200' })), id).toBeNull()
    }
  })

  it('orders by event time for Slack and by daemon sequence for everyone else', () => {
    expect(platformTranscriptOrdering('slack')).toBe('event-time')
    for (const id of [...platformRegistry.ids().filter((p) => p !== 'slack'), ...UNCLAIMED]) {
      expect(platformTranscriptOrdering(id), id).toBe('seq')
    }
  })
})
