import { describe, expect, it } from 'vitest'
import { openConversationTrigger, pendingConversation } from './conversation-defaults.js'

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

// #2979 B7: an Off nobody chose keeps the notice wherever it is, not only on a place marked external.
describe('pendingConversation', () => {
  it('is an Off nobody chose, internal or external', () => {
    expect(pendingConversation({ trigger: 'off', triggerChosen: false })).toBe(true)
  })

  it('is not an Off an editor chose, or an enabled conversation', () => {
    expect(pendingConversation({ trigger: 'off', triggerChosen: true })).toBe(false)
    expect(pendingConversation({ trigger: 'mention', triggerChosen: false })).toBe(false)
    expect(pendingConversation({ trigger: 'any', triggerChosen: true })).toBe(false)
  })
})
