import { describe, expect, it } from 'vitest'
import { MEMORY_PERSON_LAYER_FEATURE, MemoryListReq, MemoryReadReq } from '../index.js'

describe("a console user's own memory layer on the memory frames", () => {
  it('names the person beside the agent, optionally, on list and read', () => {
    expect(MemoryListReq.parse({ agentId: 'agent-a', personUserId: 'user-1' })).toEqual({
      agentId: 'agent-a',
      personUserId: 'user-1'
    })
    expect(MemoryListReq.parse({ agentId: 'agent-a' })).toEqual({ agentId: 'agent-a' })
    expect(MemoryReadReq.parse({ agentId: 'agent-a', personUserId: 'user-1', path: 'prefs.md' })).toMatchObject({
      personUserId: 'user-1',
      path: 'prefs.md'
    })
    expect(MemoryListReq.safeParse({ agentId: 'agent-a', personUserId: '' }).success).toBe(false)
    expect(MEMORY_PERSON_LAYER_FEATURE).toBe('memory-person-layer-v1')
  })
})
