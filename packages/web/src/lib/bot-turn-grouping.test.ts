import { describe, expect, it } from 'vitest'
import { sameBotSpeaker } from './bot-turn-grouping'

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

describe('bot turn grouping', () => {
  it('splits two participants that share a display name', () => {
    // The regression: two distinct agents labeled identically must not merge
    // into one block (whose avatar/runtime would belong to the first).
    expect(sameBotSpeaker({ agentId: A, agentName: 'review' }, { agentId: B, agentName: 'review' })).toBe(false)
  })

  it('continues the block for the same tagged participant', () => {
    expect(sameBotSpeaker({ agentId: A, agentName: 'review' }, { agentId: A, agentName: 'review' })).toBe(true)
  })

  it('groups legacy untagged steps by display name', () => {
    expect(sameBotSpeaker({ agentName: 'a' }, { agentName: 'a' })).toBe(true)
    expect(sameBotSpeaker({ agentName: 'a' }, { agentName: 'b' })).toBe(false)
  })

  it('lets a one-sided tag fall back to the name', () => {
    // An untagged warning step pushed while a tagged block is open, and the
    // tagged step that follows an untagged block, both group by name.
    expect(sameBotSpeaker({ agentId: A, agentName: 'a' }, { agentName: 'a' })).toBe(true)
    expect(sameBotSpeaker({ agentName: 'a' }, { agentId: A, agentName: 'a' })).toBe(true)
  })
})
