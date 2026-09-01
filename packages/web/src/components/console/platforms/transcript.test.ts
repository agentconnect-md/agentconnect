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
  it('gives no platform a text renderer of its own yet', () => {
    // §10 ships the registry with the CORE Slack renderer as the default for
    // all chat platforms and lands per-platform overrides separately, each
    // with its own visual review. When one arrives this expectation changes
    // WITH it — which is the point of asserting the empty state.
    for (const module of platformRegistry.all()) {
      expect(module.textRenderer, module.platformId).toBeUndefined()
    }
    for (const id of [...platformRegistry.ids(), ...UNCLAIMED]) {
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
