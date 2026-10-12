import { describe, expect, it } from 'vitest'
import { openConversationTrigger, pendingExternalConversation } from './conversation-defaults.js'

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

describe('pendingExternalConversation', () => {
  it('is an Off nobody chose on a place still marked external', () => {
    expect(pendingExternalConversation({ trigger: 'off', triggerChosen: false, externalReason: 'guestMember' })).toBe(
      true
    )
  })

  it('is not an operator Off, an enabled place, or an internal one', () => {
    expect(pendingExternalConversation({ trigger: 'off', triggerChosen: true, externalReason: 'guestMember' })).toBe(
      false
    )
    expect(
      pendingExternalConversation({ trigger: 'mention', triggerChosen: false, externalReason: 'externallyShared' })
    ).toBe(false)
    expect(pendingExternalConversation({ trigger: 'off', triggerChosen: false, externalReason: null })).toBe(false)
  })
})
