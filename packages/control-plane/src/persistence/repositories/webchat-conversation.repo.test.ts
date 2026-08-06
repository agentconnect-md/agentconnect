import { describe, expect, it, vi } from 'vitest'
import { AgentId, OrgId } from '../../domain/ids.js'
import { PgWebchatConversationRepo } from './webchat-conversation.repo.js'

describe('PgWebchatConversationRepo synthetic coordinates', () => {
  it('treats an A2A channel as absent instead of querying UUID-backed tables', async () => {
    const findMany = vi.fn()
    const findFirst = vi.fn()
    const repo = new PgWebchatConversationRepo({
      webchatConversationAgent: { findMany },
      webchatConversation: { findFirst }
    } as never)
    const channel = 'a2a:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

    await expect(repo.participants(OrgId('org-1'), channel)).resolves.toEqual([])
    await expect(repo.findOwner(channel, AgentId('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'))).resolves.toBeNull()
    expect(findMany).not.toHaveBeenCalled()
    expect(findFirst).not.toHaveBeenCalled()
  })
})
