import { describe, expect, it } from 'vitest'
import { resolveRoster, typedMentionIds, wireMentions } from './conversation-addressing'

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

describe('typedMentionIds', () => {
  const named = [
    { agentId: 'a-id', name: 'AgentConnect' },
    { agentId: 'b-id', name: 'test' }
  ]

  it('narrows to the named participant', () => {
    expect(typedMentionIds(named, '@test 你们是谁')).toEqual(['b-id'])
    expect(typedMentionIds(named, '@AgentConnect @test who are you')).toEqual(['a-id', 'b-id'])
  })

  it('reads a name through to its end whatever it ends in', () => {
    // The regression: `\b` finds no boundary after 理/🤖/!, so each of these
    // used to narrow to nobody and wake the whole roster instead.
    const exotic = [
      { agentId: 'cjk', name: '研究助理' },
      { agentId: 'emoji', name: 'ops 🤖' },
      { agentId: 'punct', name: 'deploy!' }
    ]
    expect(typedMentionIds(exotic, '@研究助理 have a look')).toEqual(['cjk'])
    expect(typedMentionIds(exotic, 'ping @ops 🤖 please')).toEqual(['emoji'])
    expect(typedMentionIds(exotic, '@deploy! now')).toEqual(['punct'])
    expect(typedMentionIds(exotic, '@研究助理')).toEqual(['cjk']) // end of text
  })

  it('does not let a name run into the word after it', () => {
    expect(typedMentionIds(named, '@testing the build')).toEqual([])
    expect(typedMentionIds(named, '@test你好')).toEqual([])
  })

  it('gives an ambiguous @ to the longest name that fits it', () => {
    const prefixed = [
      { agentId: 'short', name: 'agent' },
      { agentId: 'long', name: 'agent-2' }
    ]
    expect(typedMentionIds(prefixed, '@agent-2 ship it')).toEqual(['long'])
    expect(typedMentionIds(prefixed, '@agent ship it')).toEqual(['short'])
  })

  it('wakes every participant answering to a shared display name', () => {
    const twins = [
      { agentId: 'x', name: 'claude' },
      { agentId: 'y', name: 'Claude' }
    ]
    expect(typedMentionIds(twins, '@claude?')).toEqual(['x', 'y'])
  })

  it('ignores an @ welded to the word before it', () => {
    expect(typedMentionIds(named, 'mail me at foo@test.dev')).toEqual([])
  })

  it('ignores participants with no usable name', () => {
    expect(typedMentionIds([{ agentId: 'a-id', name: null }, ...named.slice(1)], '@test hi')).toEqual(['b-id'])
  })

  it('never narrows a single-agent conversation', () => {
    expect(typedMentionIds([{ agentId: 'solo', name: 'solo' }], '@solo hi')).toEqual([])
  })
})
