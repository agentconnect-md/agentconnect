import { describe, expect, it } from 'vitest'
import { wireMentions } from './conversation-addressing'

const roster = [{ agentId: 'a-primary', primary: true }, { agentId: 'b-peer' }]

describe('wireMentions', () => {
  it('passes typed mentions through untouched', () => {
    expect(wireMentions(roster, ['b-peer'], 'a-primary')).toEqual(['b-peer'])
  })

  it('carries the primary participant on a bare multi-agent send', () => {
    expect(wireMentions(roster, [], 'b-peer')).toEqual(['a-primary'])
  })

  it('falls back to the composer agent when no participant is flagged primary', () => {
    const unflagged = [{ agentId: 'a' }, { agentId: 'b' }]
    expect(wireMentions(unflagged, [], 'b')).toEqual(['b'])
  })

  it('sends no auto-mention when the fallback is not a participant', () => {
    const unflagged = [{ agentId: 'a' }, { agentId: 'b' }]
    expect(wireMentions(unflagged, [], 'stranger')).toEqual([])
  })

  it('stays empty for single-agent conversations', () => {
    expect(wireMentions([{ agentId: 'solo', primary: true }], [], 'solo')).toEqual([])
  })
})
