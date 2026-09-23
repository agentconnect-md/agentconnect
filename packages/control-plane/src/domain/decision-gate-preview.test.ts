import { describe, expect, it } from 'vitest'
import type { DecisionEvaluation, DecisionQuestion } from '@agentconnect.md/protocol'
import { gatePreviewOutcome, gateSampleState, PREVIEW_SENDER } from './decision-gate-preview.js'

const boolean: DecisionQuestion = {
  type: 'boolean',
  instructions: 'Reply?',
  criteria: { true: 'Yes', false: 'No' }
}
const choice: DecisionQuestion = {
  type: 'choice',
  instructions: 'Topic?',
  criteria: { billing: 'Money', tech: 'Code' }
}
const score: DecisionQuestion = { type: 'score', instructions: 'Urgency?', criteria: ['low', 'mid', 'high'] }
const answered = (answer: Extract<DecisionEvaluation, { status: 'answered' }>['answer']): DecisionEvaluation => ({
  status: 'answered',
  answer,
  model: 'jev-1.13.0',
  usage: { inputTokens: 1, outputTokens: 1 }
})

describe('gateSampleState', () => {
  it('builds the live state shape with synthetic ids, sender ids, and an implicit target', () => {
    const state = gateSampleState(
      { history: [{ sender: 'U1', text: 'Earlier' }], currentMessage: { text: 'Now' } },
      { agentId: 'agent-1', conversationName: 'general' }
    )
    expect(state).toEqual({
      currentMessage: { id: 'preview-2', sender: { id: PREVIEW_SENDER }, text: 'Now', threadId: null },
      history: [{ id: 'preview-1', sender: { id: 'U1' }, text: 'Earlier', threadId: null }],
      conversation: { name: 'general' },
      addressing: { mentions: [], target: { agentId: 'agent-1', via: 'implicit' } },
      context: { partial: false, reasons: [], omittedMessages: 0 }
    })
    expect(
      gateSampleState({ history: [], currentMessage: { sender: 'U9', text: 'x' } }, { agentId: 'a' })
    ).toMatchObject({ currentMessage: { id: 'preview-1', sender: { id: 'U9' } }, conversation: {} })
  })
})

describe('gatePreviewOutcome', () => {
  it('triggers or skips on a Boolean answer', () => {
    const yes = answered({ type: 'boolean', value: true, probability: 0.9 })
    expect(gatePreviewOutcome(boolean, { type: 'boolean', values: [true] }, yes)).toMatchObject({
      outcome: 'trigger',
      matched: true
    })
    expect(gatePreviewOutcome(boolean, { type: 'boolean', values: [false] }, yes)).toMatchObject({
      outcome: 'skip',
      matched: false
    })
  })

  it('reports matched Choice keys and applies Score intervals', () => {
    const topic = answered({
      type: 'choice',
      value: 'billing',
      probabilities: { billing: 0.7, tech: 0.3 },
      confidence: 0.7
    })
    expect(gatePreviewOutcome(choice, { type: 'choice', thresholds: { billing: 0.5, tech: 0.5 } }, topic)).toEqual({
      outcome: 'trigger',
      matched: true,
      matchedKeys: ['billing'],
      evaluation: topic
    })
    expect(gatePreviewOutcome(choice, { type: 'choice', thresholds: { tech: 0.5 } }, topic).outcome).toBe('skip')
    const urgent = answered({ type: 'score', value: 2, probabilities: [0.1, 0.2, 0.7], confidence: 0.7 })
    expect(gatePreviewOutcome(score, { type: 'score', min: 1, max: 2 }, urgent).outcome).toBe('trigger')
    expect(gatePreviewOutcome(score, { type: 'score', min: 0, max: 1 }, urgent).outcome).toBe('skip')
  })

  it('never turns a provider failure or a rejected answer into a skip', () => {
    const failed: DecisionEvaluation = { status: 'unavailable', reason: 'timeout' }
    expect(gatePreviewOutcome(boolean, { type: 'boolean', values: [true] }, failed)).toEqual({
      outcome: 'unavailable',
      matched: false,
      matchedKeys: [],
      evaluation: failed
    })
    const mismatched = answered({ type: 'boolean', value: false, probability: 0.9 })
    expect(gatePreviewOutcome(boolean, { type: 'boolean', values: [true] }, mismatched)).toEqual({
      outcome: 'unavailable',
      matched: false,
      matchedKeys: [],
      evaluation: { status: 'unavailable', reason: 'invalid_response' }
    })
  })
})
