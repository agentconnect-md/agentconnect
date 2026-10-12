import { describe, expect, it } from 'vitest'
import { AgentSpec, ChatActions } from './agent.js'

describe('AgentSpec.chatActions', () => {
  it('parses each level', () => {
    for (const level of ['talk', 'approve', 'settings'] as const) {
      expect(AgentSpec.parse({ name: 'example-agent', chatActions: level }).chatActions).toBe(level)
    }
  })

  it('stays absent when the spec leaves it out', () => {
    expect(AgentSpec.parse({ name: 'example-agent' }).chatActions).toBeUndefined()
  })

  it('rejects anything but a level', () => {
    expect(ChatActions.safeParse(true).success).toBe(false)
    expect(AgentSpec.safeParse({ name: 'example-agent', chatActions: 'everything' }).success).toBe(false)
  })

  it('no longer carries the boolean', () => {
    const parsed = AgentSpec.parse({ name: 'example-agent', allowRuntimeChangesInChat: true })
    expect(parsed).not.toHaveProperty('allowRuntimeChangesInChat')
    expect(parsed.chatActions).toBeUndefined()
  })
})
