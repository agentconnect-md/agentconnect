import { describe, expect, it } from 'vitest'
import type { ChatState, SessionState } from '@microsoft/agent-host-protocol'
import { ahpAnswer, ahpSteps, ahpToolTitle, ahpUsageFields } from './view'
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
  it('titles a runtime call by its refined title once the runtime sends one', () => {
    const tool = { toolCallId: 't', displayName: 'Terminal' }
    expect(ahpToolTitle(tool)).toBe('Terminal')
    expect(ahpToolTitle({ ...tool, invocationMessage: 'sleep 10 && echo first' })).toBe('sleep 10 && echo first')
    expect(ahpToolTitle({ ...tool, invocationMessage: 'ls', pastTenseMessage: { markdown: 'ls -la' } })).toBe('ls -la')
    expect(
      ahpToolTitle({ toolName: 'agentconnect.permission', displayName: 'Approve Bash', invocationMessage: 'rm -rf x' })
    ).toBe('Approve Bash')
    const running = chat([
      { kind: 'toolCall', toolCall: { ...tool, status: 'running', invocationMessage: 'sleep 10 && echo first' } }
    ])
    expect(ahpSteps(running, 'agent').at(-1)).toMatchObject({ kind: 'tool', text: 'sleep 10 && echo first' })
  })
  it('stamps a finished turn last step with the turn end, so its time is its own duration', () => {
    const finished = {
      resource: 'ahp-chat:/test',
      title: 'Chat',
      status: 1,
      turns: [
        {
          id: 'done-turn',
          startedAt: '2026-10-19T00:00:00Z',
          duration: 12_000,
          state: 1,
          message: { text: 'Question', origin: { kind: 'user' } },
          responseParts: [
            {
              kind: 'toolCall',
              toolCall: { toolCallId: 't', displayName: 'Read', status: 'completed', success: true }
            },
            { kind: 'markdown', id: 'a', content: 'Answer' }
          ]
        }
      ]
    } as unknown as ChatState
    const start = Date.parse('2026-10-19T00:00:00Z')
    const steps = ahpSteps(finished, 'agent')
    expect(steps.map((step) => step.observedAtMs)).toEqual([start, start, start + 12_000])
    // A running turn has no duration yet: its steps keep its start.
    expect(
      ahpSteps(chat([{ kind: 'markdown', id: 'a', content: 'x' }]), 'agent').map((step) => step.observedAtMs)
    ).toEqual([start, start])
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
  it('renders Fill cards from session metadata on their turn, settled in place', () => {
    const state = chat([{ kind: 'markdown', id: 'one', content: 'Opening the sign-in form' }])
    const fill = {
      requestId: '7f9d6c1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f',
      computerName: 'Desk',
      website: { origin: 'https://login.example.test' },
      kind: 'login',
      fields: [],
      expiresAt: '2026-11-10T10:10:00.000Z'
    }
    const session = {
      _meta: {
        'agentconnect.md': {
          fills: [
            { ...fill, turnId: 'turn', resolved: 'filled' },
            { ...fill, turnId: 'other' }
          ]
        }
      }
    } as unknown as SessionState
    const steps = ahpSteps(state, 'agent', session)
    expect(steps.map((step) => step.kind)).toEqual(['msg', 'done', 'fill'])
    expect(steps.at(-1)).toMatchObject({
      text: 'https://login.example.test',
      fill: { ...fill, resolved: 'filled' },
      boundary: true
    })
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
