import { describe, expect, it } from 'vitest'
import type { WebchatPost } from '@agentconnect.md/protocol'
import { continuationScope, postNamesAgent, webchatReplyScope } from '../src/webchat/narrowed-scope.js'

const post = (text: string, addressedAgentIds?: string[]): WebchatPost =>
  ({
    postId: '00000000-0000-4000-8000-000000000001',
    conversationId: '00000000-0000-4000-8000-000000000002',
    author: { kind: 'agent', agentId: 'agent-a', hopCount: 0, ...(addressedAgentIds ? { addressedAgentIds } : {}) },
    text,
    at: 1
  }) as WebchatPost

describe('postNamesAgent', () => {
  it('matches a whole @name, case-insensitively, by any of the names', () => {
    expect(postNamesAgent('your turn, @Helper', ['helper'])).toBe(true)
    expect(postNamesAgent('ping @研究助理 please', [undefined, '研究助理'])).toBe(true)
  })

  it('ignores a longer name, an address, and a bare name', () => {
    expect(postNamesAgent('@helper-2 go', ['helper'])).toBe(false)
    expect(postNamesAgent('mail ops@helper.test', ['helper'])).toBe(false)
    expect(postNamesAgent('helper should go', ['helper'])).toBe(false)
  })
})

describe('continuationScope', () => {
  it('leaves an unnarrowed post alone', () => {
    expect(continuationScope(post('hi'), 'agent-b', ['b'])).toEqual({ outsideHumanScope: false })
  })

  it('marks a left-out peer, unless the post @-names it', () => {
    expect(continuationScope(post('done', ['agent-a']), 'agent-b', ['helper'])).toEqual({
      outsideHumanScope: true,
      addressedAgentIds: ['agent-a', 'agent-b']
    })
    expect(continuationScope(post('@Helper over to you', ['agent-a']), 'agent-b', ['helper']).outsideHumanScope).toBe(
      false
    )
  })

  it('keeps an addressed peer inside the scope', () => {
    expect(continuationScope(post('done', ['agent-a', 'agent-b']), 'agent-b', [])).toEqual({
      outsideHumanScope: false,
      addressedAgentIds: ['agent-a', 'agent-b']
    })
  })
})

describe('webchatReplyScope', () => {
  const msg = (source: 'user' | 'agent', mentionedBots: string[]) => ({ source, mentionedBots }) as never

  it('carries the human’s mentions, or a continuation’s inherited scope', () => {
    expect(webchatReplyScope({ msg: msg('user', ['agent-a']) })).toEqual(['agent-a'])
    expect(
      webchatReplyScope({
        msg: msg('agent', []),
        callMeta: {
          callFrom: 'agent-a',
          hopCount: 1,
          deliveryId: 'd',
          conversationContinuation: true,
          addressedAgentIds: ['agent-a', 'agent-b']
        }
      })
    ).toEqual(['agent-a', 'agent-b'])
  })

  it('is absent for a turn with no mentions', () => {
    expect(webchatReplyScope({ msg: msg('user', []) })).toBeUndefined()
  })
})
