import { describe, expect, it } from 'vitest'
import { wireMentions } from './conversation-addressing'

const roster = [{ agentId: 'a-primary', primary: true }, { agentId: 'b-peer' }]

describe('wireMentions', () => {
  it('passes typed mentions through untouched', () => {
    expect(wireMentions(roster, ['b-peer'])).toEqual(['b-peer'])
  })

  it('materializes the standing mention as the whole roster on a bare multi-agent send', () => {
    expect(wireMentions(roster, [])).toEqual(['a-primary', 'b-peer'])
  })

  it('stays empty for single-agent conversations', () => {
    expect(wireMentions([{ agentId: 'solo' }], [])).toEqual([])
  })
})
