import { describe, expect, it } from 'vitest'
import type { WebchatPost } from '@agentconnect.md/protocol'
import {
  continuationScope,
  foldWebchatRouting,
  initialWebchatRouting,
  postNamesAgent,
  webchatReplyScope,
  webchatRoutingNoteBlocks
} from '../src/webchat/narrowed-scope.js'

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

  it('does not treat a quoted, code or link mention as an invitation', () => {
    expect(postNamesAgent('> @helper said this earlier\nmy answer', ['helper'])).toBe(false)
    expect(postNamesAgent('run `@helper deploy` locally', ['helper'])).toBe(false)
    expect(postNamesAgent('```\nnotify(@helper)\n```\ndone', ['helper'])).toBe(false)
    expect(postNamesAgent('see https://chat.example.test/@helper/profile', ['helper'])).toBe(false)
  })

  it('still invites outside those spans, and does not parse negation', () => {
    expect(postNamesAgent('> quoted line\n@helper please confirm', ['helper'])).toBe(true)
    // The contract is lexical: a negated mention is still a mention, so the model decides.
    expect(postNamesAgent('no need for @helper here', ['helper'])).toBe(true)
  })
})

describe('continuationScope', () => {
  it('leaves an unnarrowed post alone', () => {
    expect(continuationScope(post('hi'), 'agent-b', ['b'])).toEqual({ outsideHumanScope: false })
  })

  it('marks a left-out peer without widening the scope, unless the post invites it', () => {
    expect(continuationScope(post('done', ['agent-a']), 'agent-b', ['helper'])).toEqual({
      outsideHumanScope: true,
      addressedAgentIds: ['agent-a']
    })
    expect(continuationScope(post('@Helper over to you', ['agent-a']), 'agent-b', ['helper'])).toEqual({
      outsideHumanScope: false,
      addressedAgentIds: ['agent-a', 'agent-b']
    })
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

describe('foldWebchatRouting', () => {
  const wake = (from: string, scope: string[] | undefined, outside: boolean) =>
    ({
      msg: { source: 'agent', mentionedBots: [], sender: { id: from, isBot: true } },
      callMeta: {
        callFrom: from,
        hopCount: 1,
        deliveryId: 'd',
        conversationContinuation: true,
        ...(scope ? { addressedAgentIds: scope } : {}),
        ...(outside ? { outsideHumanScope: true } : {})
      }
    }) as never
  const addressed = initialWebchatRouting(wake('agent-a', ['agent-a', 'agent-b'], false))
  const leftOut = initialWebchatRouting(wake('agent-a', ['agent-a'], true))

  it('an addressed turn ignores a left-out activation for scope, and owes a note naming its author', () => {
    expect(foldWebchatRouting(addressed, wake('agent-c', ['agent-c'], true))).toEqual({
      addressed: true,
      scope: ['agent-a', 'agent-b'],
      notes: { becameAddressed: false, absorbedOutsideFrom: ['agent-c'] }
    })
  })

  it('a left-out turn that absorbs an addressing activation is released into its scope', () => {
    expect(foldWebchatRouting(leftOut, wake('agent-a', ['agent-a', 'agent-b'], false))).toEqual({
      addressed: true,
      scope: ['agent-a', 'agent-b'],
      notes: { becameAddressed: true, absorbedOutsideFrom: [] }
    })
  })

  it('addressing activations merge, and an unscoped one leaves no one out', () => {
    expect(foldWebchatRouting(addressed, wake('agent-c', ['agent-c', 'agent-b'], false)).scope).toEqual([
      'agent-a',
      'agent-b',
      'agent-c'
    ])
    expect(foldWebchatRouting(addressed, wake('agent-c', undefined, false)).scope).toBeUndefined()
  })

  it('a still-left-out turn stays left out', () => {
    expect(foldWebchatRouting(leftOut, wake('agent-c', ['agent-c'], true))).toMatchObject({ addressed: false })
  })
})

describe('webchatRoutingNoteBlocks', () => {
  const texts = (blocks: Array<{ text: string }>) => blocks.map((b) => b.text).join('\n')
  const routing = (addressed: boolean, becameAddressed = false, absorbedOutsideFrom: string[] = []) => ({
    addressed,
    scope: undefined,
    notes: { becameAddressed, absorbedOutsideFrom }
  })

  it('re-reminds a left-out turn only in a replacement prompt, since its first prompt already did', () => {
    expect(webchatRoutingNoteBlocks(routing(false), false)).toEqual([])
    expect(texts(webchatRoutingNoteBlocks(routing(false), true))).toContain('the human @-mentioned other participants')
  })

  it('releases a newly addressed turn and names absorbed left-out authors, in any prompt', () => {
    expect(texts(webchatRoutingNoteBlocks(routing(true, true), false))).toContain('no longer applies')
    expect(texts(webchatRoutingNoteBlocks(routing(true, false, ['agent-c']), false))).toContain('[agent-c]')
    expect(webchatRoutingNoteBlocks(routing(true), true)).toEqual([])
  })
})
