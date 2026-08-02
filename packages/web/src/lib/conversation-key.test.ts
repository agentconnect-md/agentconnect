import { describe, expect, it } from 'vitest'
import { encodeConversationKey, isWebchatConversationKey } from './conversation-key'

describe('conversation key (browser port)', () => {
  it('matches the CP codec byte-for-byte', () => {
    // Vector mirrored from the CP codec unit test — a drift here means the CP
    // can no longer decode what the console links to.
    const encoded = encodeConversationKey({
      platform: 'slack',
      tenantScope: 'T024BE7LD',
      channel: 'C123',
      thread: '1754123456.000200'
    })!
    expect(encoded).toBe(
      Buffer.from(['slack', 'T024BE7LD', 'C123', '1754123456.000200'].join('\u0000'), 'utf8').toString('base64url')
    )
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('uses the bare conversation id for webchat and refuses singletons', () => {
    const id = 'c0c0c0c0-cccc-4ccc-8ccc-cccccccccccc'
    expect(encodeConversationKey({ platform: 'webchat', tenantScope: null, channel: id, thread: id })).toBe(id)
    expect(isWebchatConversationKey(id)).toBe(true)
    expect(isWebchatConversationKey('not-a-uuid')).toBe(false)
    expect(encodeConversationKey({ platform: 'slack', tenantScope: null, channel: null, thread: 'T' })).toBeNull()
    expect(encodeConversationKey({ platform: 'slack', tenantScope: null, channel: 'C', thread: null })).toBeNull()
  })
})
