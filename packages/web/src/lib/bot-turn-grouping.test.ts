import { describe, expect, it } from 'vitest'
import { liveBotTurnKey, sameBotSpeaker } from './bot-turn-grouping'

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

describe('bot turn grouping', () => {
  it('keys interleaved live blocks by both turn and participant', () => {
    const turn = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    expect(liveBotTurnKey(turn, A)).toBe(liveBotTurnKey(turn, A))
    expect(liveBotTurnKey(turn, A)).not.toBe(liveBotTurnKey(turn, B))
    expect(liveBotTurnKey(turn, A)).not.toBe(liveBotTurnKey('dddddddd-dddd-4ddd-8ddd-dddddddddddd', A))
    expect(liveBotTurnKey(undefined, A)).toBeUndefined()
  })

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
