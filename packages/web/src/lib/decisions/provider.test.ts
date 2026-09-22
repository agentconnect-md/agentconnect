import { describe, expect, it } from 'vitest'
import type { DecisionDefinition } from '@agentconnect.md/protocol/decision'
import { boundDecision, defaultConditionFor, gateIssues } from './provider'

const metadata = {
  orgId: 'example-org',
  createdBy: 'example-user',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  providerId: 'typesafe-byok',
  model: 'jev-1.13.0',
  visibility: 'org' as const,
  sharedWith: []
}

const choice: DecisionDefinition = {
  ...metadata,
  id: 'support-category',
  name: 'Support category',
  question: {
    type: 'choice',
    instructions: 'Classify the request.',
    criteria: { billing: 'Payments', technical: 'Bugs' }
  }
}

const boolean: DecisionDefinition = {
  ...metadata,
  id: 'needs-response',
  name: 'Needs a response',
  question: { type: 'boolean', instructions: 'Does it need a reply?', criteria: { true: 'Yes', false: 'No' } }
}

const score: DecisionDefinition = {
  ...metadata,
  id: 'frustration',
  name: 'Customer frustration',
  question: { type: 'score', instructions: 'How upset?', criteria: ['Calm', 'Annoyed', 'Angry', 'Leaving'] }
}

describe('defaultConditionFor', () => {
  // Every declared key starts enabled at the design's 30%, so a fresh gate matches the
  // obvious answers instead of silently skipping every one of them.
  it('enables every choice key at the 0.3 minimum', () => {
    expect(defaultConditionFor(choice)).toEqual({ type: 'choice', thresholds: { billing: 0.3, technical: 0.3 } })
  })

  it('starts a boolean gate on Yes', () => {
    expect(defaultConditionFor(boolean)).toEqual({ type: 'boolean', values: [true] })
  })

  // The rubric's maximum is levels - 1, and the interval's upper bound is inclusive there.
  it('starts a score gate on the whole rubric', () => {
    expect(defaultConditionFor(score)).toEqual({ type: 'score', min: 0, max: 3 })
  })
})

describe('boundDecision', () => {
  const summaries = [{ ...choice, usageCount: 1 }]

  it('resolves the decision a binding names', () => {
    expect(
      boundDecision(summaries, {
        decisionId: choice.id,
        when: { type: 'boolean', values: [true] },
        channelName: '#help'
      })?.id
    ).toBe(choice.id)
  })

  // A deleted decision leaves its binding behind for repair — never a silent substitute.
  it('returns null once the decision is gone', () => {
    expect(
      boundDecision(summaries, {
        decisionId: 'deleted',
        when: { type: 'boolean', values: [true] },
        channelName: '#help'
      })
    ).toBeNull()
    expect(boundDecision(summaries, null)).toBeNull()
  })
})

describe('gateIssues', () => {
  it('accepts a condition that matches the question', () => {
    expect(gateIssues(choice, { type: 'choice', thresholds: { billing: 0.3 } })).toEqual([])
    expect(gateIssues(score, { type: 'score', min: 1, max: 2.5 })).toEqual([])
  })

  it('rejects a condition whose type is not the question’s', () => {
    expect(gateIssues(choice, { type: 'boolean', values: [true] })).toEqual([
      { path: ['type'], message: 'Condition type must match the question.' }
    ])
  })

  it('flags a key the edited question no longer declares', () => {
    expect(gateIssues(choice, { type: 'choice', thresholds: { refunds: 0.5 } })).toEqual([
      { path: ['thresholds', 'refunds'], message: 'Choice no longer exists.' }
    ])
  })

  it('flags an interval past the rubric maximum', () => {
    expect(gateIssues(score, { type: 'score', min: 0, max: 4 })).toEqual([
      { path: ['max'], message: 'The interval exceeds the rubric maximum.' }
    ])
  })

  it('has nothing to check before a decision is chosen', () => {
    expect(gateIssues(null, { type: 'boolean', values: [true] })).toEqual([])
  })
})
