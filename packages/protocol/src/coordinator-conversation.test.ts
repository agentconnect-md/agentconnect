import { describe, expect, it } from 'vitest'
import { coordinatorConversationId, uuidV5 } from './coordinator-conversation.js'

describe('coordinatorConversationId', () => {
  it('derives a version 5 UUID as RFC 9562 specifies', () => {
    expect(uuidV5('6ba7b810-9dad-11d1-80b4-00c04fd430c8', 'www.example.com')).toBe(
      '2ed6657d-e927-568b-95e1-2665a8aea6a2'
    )
  })

  it('gives each organization, member and agent one stable conversation', () => {
    const id = coordinatorConversationId('org-1', 'user-1', 'agent-1')
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(coordinatorConversationId('org-1', 'user-1', 'agent-1')).toBe(id)
    expect(coordinatorConversationId('org-1', 'user-2', 'agent-1')).not.toBe(id)
    expect(coordinatorConversationId('org-1', 'user-1', 'agent-2')).not.toBe(id)
    expect(coordinatorConversationId('org-2', 'user-1', 'agent-1')).not.toBe(id)
  })
})
