import { describe, expect, it } from 'vitest'
import { decodeConversationKey, encodeConversationKey } from './conversation-key.js'

describe('conversation key codec', () => {
  it('round-trips an IM key with and without a tenant scope', () => {
    const scoped = { platform: 'slack', tenantScope: 'T024BE7LD', channel: 'C123', thread: '1754123456.000200' }
    const encoded = encodeConversationKey(scoped)!
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/) // base64url, path/query safe
    expect(decodeConversationKey(encoded)).toEqual(scoped)

    const unscoped = { platform: 'slack', tenantScope: null, channel: 'C123', thread: 'C123' }
    expect(decodeConversationKey(encodeConversationKey(unscoped)!)).toEqual(unscoped)
  })

  it('uses the bare conversation id for webchat; decode restores the prefixed thread', () => {
    const id = 'c0c0c0c0-cccc-4ccc-8ccc-cccccccccccc'
    // Rows record thread as the daemon's msgId form (`webchat:<id>`); the
    // bare-id key must round-trip onto that shape or the resolver matches
    // nothing (the exact production bug this pins).
    const key = { platform: 'webchat', tenantScope: null, channel: id, thread: `webchat:${id}` }
    expect(encodeConversationKey(key)).toBe(id)
    expect(decodeConversationKey(id)).toEqual(key)
  })

  it('never encodes singletons and rejects garbage', () => {
    expect(encodeConversationKey({ platform: 'hook', tenantScope: null, channel: null, thread: null })).toBeNull()
    expect(encodeConversationKey({ platform: 'slack', tenantScope: null, channel: 'C1', thread: null })).toBeNull()
    expect(decodeConversationKey('!!!not-a-key!!!')).toBeNull()
    expect(decodeConversationKey(Buffer.from('only two').toString('base64url'))).toBeNull()
  })
})
