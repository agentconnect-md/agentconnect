import { describe, expect, it } from 'vitest'
import {
  mentionQueryAt,
  mentionSpanEnd,
  resolveRoster,
  selfConversationPath,
  typedMentionIds,
  wireMentions
} from './conversation-addressing'

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

describe('mentionQueryAt', () => {
  it('finds the run typed after the triggering @', () => {
    expect(mentionQueryAt('hello @cla', 10)).toEqual({ start: 6, query: 'cla' })
    expect(mentionQueryAt('hi @', 4)).toEqual({ start: 3, query: '' })
  })

  it('ends the query at the first space — a finished word is a stale @', () => {
    expect(mentionQueryAt('hi @agent typing more', 10)).toBeNull()
  })

  it('ignores an @ welded to the word before it', () => {
    expect(mentionQueryAt('mail me at foo@test.dev', 15)).toBeNull()
  })

  it('sees no query without an @', () => {
    expect(mentionQueryAt('no at signs here', 5)).toBeNull()
  })

  it('reads the caret position, not the end of the text', () => {
    expect(mentionQueryAt('@agentconnect', 5)).toEqual({ start: 0, query: 'agen' })
  })
})

describe('mentionSpanEnd', () => {
  it('runs to the end of the token, past where the caret currently sits', () => {
    // "hello @al" with the caret backed up between 'a' and 'l' (position 8) —
    // the token itself still spans 6..9, so a pick must replace all of it.
    expect(mentionSpanEnd('hello @al', 6)).toBe(9)
  })

  it('stops at the next space', () => {
    expect(mentionSpanEnd('@bob says hi', 0)).toBe(4)
  })

  it('runs to the end of the text when the token is unterminated', () => {
    expect(mentionSpanEnd('@bob', 0)).toBe(4)
  })
})

describe('selfConversationPath', () => {
  const multi = { flatView: false, conversationKey: 'c2xhY2s', memberCount: 3 }

  it('redirects a multi-participant session to the merged page', () => {
    expect(selfConversationPath(multi)).toBe('/conversations/c2xhY2s')
  })

  it('carries no query — the landing has no ?focus scroll/highlight', () => {
    // The regression this guards: the redirect used to append
    // `?focus=<agentId>`, which scrolled that participant's first block into
    // view, flashed its background, and auto-paged older windows hunting for
    // it. A deep link opens the conversation, nothing more.
    expect(selfConversationPath(multi)).not.toContain('?')
  })

  it('escapes a key that is not URL-safe', () => {
    expect(selfConversationPath({ ...multi, conversationKey: 'a/b+c' })).toBe('/conversations/a%2Fb%2Bc')
  })

  it('stays on the session page for a single-participant conversation', () => {
    expect(selfConversationPath({ ...multi, memberCount: 1 })).toBeNull()
    expect(selfConversationPath({ ...multi, memberCount: 0 })).toBeNull()
  })

  it('never redirects an unresolved key or the view=flat diagnostic route', () => {
    expect(selfConversationPath({ ...multi, conversationKey: null })).toBeNull()
    expect(selfConversationPath({ ...multi, flatView: true })).toBeNull()
  })
})
