import { describe, expect, it } from 'vitest'
import { openConversationTrigger } from './conversation-defaults.js'

describe('openConversationTrigger', () => {
  it('opens a room on Mention and a 1:1 DM On', () => {
    expect(openConversationTrigger({})).toBe('mention')
    expect(openConversationTrigger({ kind: 'mpim', externalReason: null })).toBe('mention')
    expect(openConversationTrigger({ kind: 'im' })).toBe('any')
  })

  it('starts any place the platform marks external Off', () => {
    expect(openConversationTrigger({ kind: 'channel', externalReason: 'externallyShared' })).toBe('off')
    expect(openConversationTrigger({ kind: 'im', externalReason: 'externalMember' })).toBe('off')
  })
})
