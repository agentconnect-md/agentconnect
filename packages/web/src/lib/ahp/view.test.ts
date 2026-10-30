import { describe, expect, it } from 'vitest'
import type { ChatState, SessionState } from '@microsoft/agent-host-protocol'
import { ahpAnswer, ahpSteps, ahpUsageFields } from './view'
const chat = (parts: unknown[]): ChatState =>
  ({
    resource: 'ahp-chat:/test',
    title: 'Chat',
    status: 2,
    turns: [],
    activeTurn: {
      id: 'turn',
      startedAt: '2026-10-19T00:00:00Z',
      message: { text: 'Question', origin: { kind: 'user' } },
      responseParts: parts
    }
  }) as unknown as ChatState
describe('standard AHP view', () => {
  it('preserves reply and reasoning boundaries and projects tool identity', () => {
    const state = chat([
      { kind: 'markdown', id: 'one', content: 'One' },
      { kind: 'reasoning', id: 'reason', content: 'Reason' },
      { kind: 'markdown', id: 'two', content: 'Two' },
      { kind: 'toolCall', toolCall: { toolCallId: 'tool', displayName: 'Read file', status: 'running' } }
    ])
    const session = { _meta: { 'agentconnect.md': { sessionId: 'outward' } } } as unknown as SessionState
    const steps = ahpSteps(state, 'agent', session)
    expect(steps.map((step) => step.kind)).toEqual(['msg', 'done', 'plan', 'done', 'tool'])
    expect(steps.filter((step) => step.kind === 'done').map((step) => step.segmentId)).toEqual(['one', 'two'])
    expect(steps.at(-1)).toMatchObject({ toolCallId: 'tool', toolSessionId: 'outward' })
  })
  it('places the turn plan snapshot ahead of its work', () => {
    const state = chat([{ kind: 'toolCall', toolCall: { toolCallId: 'tool', displayName: 'Read', status: 'running' } }])
    const entries = [{ content: 'Read', status: 'in_progress' }]
    const session = (turnId: string) =>
      ({ _meta: { 'agentconnect.md': { plan: { turnId, entries } } } }) as unknown as SessionState
    expect(ahpSteps(state, 'agent', session('turn')).map((step) => step.kind)).toEqual(['msg', 'planblock', 'tool'])
    expect(ahpSteps(state, 'agent', session('turn'))[1]).toMatchObject({ turnId: 'turn', plan: entries })
    expect(ahpSteps(state, 'agent', session('other')).map((step) => step.kind)).toEqual(['msg', 'tool'])
  })
  it('renders capability request cards at the end of their turn', () => {
    const state = chat([{ kind: 'markdown', id: 'one', content: 'I need a repository' }])
    const card = {
      requestId: 'r',
      generation: 1,
      summary: 'Add repo',
      reason: 'Needed',
      link: 'https://console.example.test/r'
    }
    const session = {
      _meta: {
        'agentconnect.md': {
          capabilities: [
            { ...card, turnId: 'turn', resolved: { status: 'declined', text: 'Declined' } },
            { ...card, requestId: 'x', turnId: 'other' }
          ]
        }
      }
    } as unknown as SessionState
    const steps = ahpSteps(state, 'agent', session)
    expect(steps.map((step) => step.kind)).toEqual(['msg', 'done', 'capability'])
    expect(steps.at(-1)).toMatchObject({ text: 'Add repo', capability: card, boundary: true })
    // A reopen or settle outside a turn never reaches the cached outcome, so the card reads the request instead.
    expect(steps.at(-1)?.capability).not.toHaveProperty('resolved')
  })
  it('projects the status snapshot onto session usage, keeping fields it omits', () => {
    expect(ahpUsageFields(undefined, { totalTokens: 1 })).toEqual({})
    expect(ahpUsageFields({ costAmount: 0.5, costCurrency: 'USD' }, { totalTokens: 1200, contextUsed: 9 })).toEqual({
      usage: { totalTokens: 1200, contextUsed: 9, costAmount: 0.5, costCurrency: 'USD' },
      tokens: expect.any(String),
      cost: expect.stringContaining('0.5')
    })
  })
  it('answers approval choices and structured inputs through standard actions', () => {
    const state = chat([
      {
        kind: 'toolCall',
        toolCall: {
          toolCallId: 'tool',
          displayName: 'Write',
          status: 'pending-confirmation',
          invocationMessage: 'Allow write?',
          options: [{ id: 'once', label: 'Allow once', kind: 'approve' }]
        }
      },
      {
        kind: 'inputRequest',
        request: {
          id: 'input',
          questions: [
            { id: 'title', kind: 'text', message: 'Title' },
            { id: 'count', kind: 'integer', message: 'Count' }
          ]
        }
      }
    ])
    expect(ahpAnswer(state, 'tool:turn:tool', 'once')).toMatchObject({
      type: 'chat/toolCallConfirmed',
      approved: true,
      selectedOptionId: 'once'
    })
    expect(ahpAnswer(state, 'input', { title: 'Hello', count: 2 })).toMatchObject({
      type: 'chat/inputCompleted',
      response: 'accept',
      answers: {
        title: { state: 'submitted', value: { kind: 'text', value: 'Hello' } },
        count: { value: { kind: 'number', value: 2 } }
      }
    })
    expect(ahpSteps(state, 'agent').at(-1)?.elicit?.fields).toHaveLength(2)
  })
  it('shows consumed steering and optional apps without a private reducer', () => {
    const state = chat([
      {
        kind: 'systemNotification',
        content: 'Direction changed',
        _meta: { 'agentconnect.md': { steeringId: 'steer', text: 'New direction' } }
      }
    ])
    const session = {
      _meta: {
        'agentconnect.md': {
          apps: [
            {
              turnId: 'turn',
              card: { appId: 'app', title: 'Widget', toolName: 'widget' },
              html: '<p>Widget</p>',
              outcome: 'closed'
            }
          ]
        }
      }
    } as unknown as SessionState
    expect(ahpSteps(state, 'agent', session)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'msg', turnId: 'steer', steer: true, steered: true }),
        expect.objectContaining({
          kind: 'app',
          app: expect.objectContaining({ html: '<p>Widget</p>', outcome: 'closed' })
        })
      ])
    )
  })
})
