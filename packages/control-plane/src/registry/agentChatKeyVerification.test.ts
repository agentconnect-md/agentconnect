// A chat id names one conversation per key owner and agent (shared-bot-relay.md §10.4).
import { describe, expect, it } from 'vitest'
import { agentChatConversationId } from './agentChatKeyVerification.js'

const ORG = 'org-1'
const USER = 'user-1'
const AGENT = '11111111-1111-4111-8111-111111111111'

describe('agentChatConversationId', () => {
  it('is a stable UUIDv5 per org, owner, agent and chat id', () => {
    const id = agentChatConversationId(ORG, USER, AGENT, 'chat-1')
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(agentChatConversationId(ORG, USER, AGENT, 'chat-1')).toBe(id)
    const others = [
      agentChatConversationId('org-2', USER, AGENT, 'chat-1'),
      agentChatConversationId(ORG, 'user-2', AGENT, 'chat-1'),
      agentChatConversationId(ORG, USER, '22222222-2222-4222-8222-222222222222', 'chat-1'),
      agentChatConversationId(ORG, USER, AGENT, 'chat-2')
    ]
    expect(new Set([id, ...others]).size).toBe(5)
  })
})
