import { describe, expect, it } from 'vitest'
import type { DecisionDefinition } from '@agentconnect.md/protocol/decision'
import { boundDecision, defaultConditionFor, gateIssues, gateKey, gateUsages } from './provider'
import type { DecisionGateBinding } from './provider'

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
  // docs/designs/decisions.md §2: Choice starts with all keys enabled at 0.5, so an untouched
  // gate does not activate a low-confidence answer the model was unsure about.
  it('enables every choice key at the 0.5 minimum', () => {
    expect(defaultConditionFor(choice)).toEqual({ type: 'choice', thresholds: { billing: 0.5, technical: 0.5 } })
  })

  // §2: Boolean starts with BOTH answers selected — a Yes-only default silently skips every No.
  it('starts a boolean gate on both answers', () => {
    expect(defaultConditionFor(boolean)).toEqual({ type: 'boolean', values: [true, false] })
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

describe('gateKey', () => {
  // A platform coordinate is not an identity: two bots share a Slack channel id, and the
  // shell-wide provider outlives an organization switch.
  it('separates two bots in one conversation, and one bot in two organizations', () => {
    const keys = new Set([
      gateKey('org-a', 'bot-a', 'C123'),
      gateKey('org-a', 'bot-b', 'C123'),
      gateKey('org-b', 'bot-a', 'C123')
    ])
    expect(keys.size).toBe(3)
  })

  // Sibling integrations of one bot report the same conversation, and must converge on one gate.
  it('separates conversations of one bot', () => {
    expect(gateKey('org-a', 'bot-a', 'C123')).not.toBe(gateKey('org-a', 'bot-a', 'C456'))
  })
})

describe('gateUsages', () => {
  const binding = (decisionId: string, channelName: string, needsReview?: boolean): DecisionGateBinding => ({
    decisionId,
    when: { type: 'boolean', values: [true] },
    channelName,
    ...(needsReview === undefined ? {} : { needsReview })
  })

  it('lists only the gates on the named decision, carrying each one’s review state', () => {
    const gates = {
      'org-a|bot-a|C1': binding('support-category', '#help'),
      'org-a|bot-b|C1': binding('other', '#help', true),
      'org-a|bot-a|C2': binding('support-category', '#deploys', true)
    }
    expect(gateUsages(gates, 'support-category').map((usage) => [usage.channelName, usage.needsReview])).toEqual([
      ['#help', false],
      ['#deploys', true]
    ])
  })

  it('reports no usages for a decision nothing gates', () => {
    expect(gateUsages({ 'org-a|bot-a|C1': binding('support-category', '#help') }, 'unused')).toEqual([])
  })
})
