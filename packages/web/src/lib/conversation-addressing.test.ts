import { describe, expect, it } from 'vitest'
import { resolveRoster, wireMentions } from './conversation-addressing'

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

describe('resolveRoster', () => {
  const names = new Map([
    ['a', 'Alpha'],
    ['b', 'Beta']
  ])
  const nameOf = (agentId: string) => names.get(agentId)

  it('prefers settled session participants, then the adopted detail roster', () => {
    const settled = [{ agentId: 'a', name: 'Alpha', primary: true }]
    const adopted = [{ agentId: 'b', name: 'Beta' }]
    expect(resolveRoster(settled, adopted, ['a', 'b'], nameOf)).toBe(settled)
    expect(resolveRoster(undefined, adopted, ['a', 'b'], nameOf)).toBe(adopted)
  })

  it('falls back to creation-time staged ids on the same-tick first send, first id primary', () => {
    expect(resolveRoster(undefined, undefined, ['a', 'b'], nameOf)).toEqual([
      { agentId: 'a', name: 'Alpha', primary: true },
      { agentId: 'b', name: 'Beta' }
    ])
    expect(resolveRoster(undefined, undefined, ['a', 'unknown'], nameOf)).toEqual([
      { agentId: 'a', name: 'Alpha', primary: true },
      { agentId: 'unknown', name: '' }
    ])
  })

  it('yields no roster for single-agent or unstaged sends', () => {
    expect(resolveRoster(undefined, undefined, ['a'], nameOf)).toEqual([])
    expect(resolveRoster(undefined, undefined, undefined, nameOf)).toEqual([])
  })
})
