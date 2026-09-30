// Try states: templates pass their own schema, bound fields are refused by name, and addressing maps to the router's situation.

import { describe, expect, it } from 'vitest'
import {
  apiTemplate,
  checkTryState,
  codeHostTemplate,
  conversationSample,
  conversationTemplate,
  parseTryState,
  routingTargets,
  routingTemplate
} from './try-state'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const withText = <T extends { currentMessage: { text: string } }>(state: T): T => ({
  ...state,
  currentMessage: { ...state.currentMessage, text: 'Hello' }
})

describe('Try state', () => {
  it('fills every template with a state its lane accepts once the message has text', () => {
    expect(checkTryState('conversation', withText(conversationTemplate())).ok).toBe(true)
    expect(checkTryState('routing', withText(routingTemplate())).ok).toBe(true)
    expect(checkTryState('api', withText(apiTemplate())).ok).toBe(true)
    for (const [provider, family] of [
      ['github', 'issues'],
      ['github', 'pull_request'],
      ['gitlab', 'merge_request'],
      ['gitea', 'merge_request']
    ] as const)
      expect(checkTryState('code_host', withText(codeHostTemplate(provider, family))).ok).toBe(true)
    expect(checkTryState('api', apiTemplate())).toMatchObject({
      ok: false,
      error: { kind: 'schema', path: 'currentMessage.text' }
    })
  })

  it('parses a blank message without losing it, and names a bound field instead of dropping it', () => {
    const blank = parseTryState('conversation', JSON.stringify(conversationTemplate()))
    expect(blank).toEqual({ ok: true, value: conversationTemplate() })
    expect(parseTryState('api', '{"source":"chat","currentMessage":{"text":"x"}}')).toEqual({
      ok: false,
      error: { kind: 'bound', key: 'source' }
    })
    expect(
      parseTryState(
        'conversation',
        '{"currentMessage":{"text":"x"},"history":[{"id":"1","sender":{"id":"u"},"text":"y"}]}'
      )
    ).toEqual({
      ok: false,
      error: { kind: 'bound', key: 'history[0].id' }
    })
    expect(parseTryState('conversation', '{"currentMessage":{"text":"x"},"addressing":{}}')).toMatchObject({
      error: { kind: 'bound', key: 'addressing' }
    })
    expect(parseTryState('routing', '{"currentMessage":{"text":"x"},"addressing":{}}').ok).toBe(true)
    expect(parseTryState('api', '{"currentMessage":{"text":"x"},"history":[{"text":"y"}]}')).toMatchObject({
      error: { kind: 'schema', path: 'history' }
    })
    expect(parseTryState('api', '{')).toMatchObject({ error: { kind: 'json' } })
    expect(parseTryState('api', '[]')).toEqual({ ok: false, error: { kind: 'shape' } })
  })

  it("flattens senders to the gate preview's sample", () => {
    expect(
      conversationSample({
        currentMessage: { text: ' Help ' },
        history: [{ sender: { id: 'U1' }, text: 'Hi' }]
      })
    ).toEqual({ currentMessage: { text: 'Help' }, history: [{ sender: 'U1', text: 'Hi' }] })
  })

  it('reads the routing situation from addressing as the router states it', () => {
    const state = (addressing?: Parameters<typeof routingTargets>[0]['addressing']) => ({
      currentMessage: { text: 'x' },
      history: [],
      ...(addressing ? { addressing } : {})
    })
    expect(routingTargets(state())).toEqual({ type: 'new' })
    expect(
      routingTargets(state({ mentions: [A, B], constraint: { eligibleAgentIds: [A], participantAgentIds: [B] } }))
    ).toEqual({ type: 'mention', agentIds: [A, B], participantAgentIds: [B] })
    expect(
      routingTargets(state({ mentions: [], constraint: { eligibleAgentIds: [A], participantAgentIds: [B] } }))
    ).toEqual({ type: 'thread', agentIds: [A, B], participantAgentIds: [B] })
  })
})
