import { describe, expect, it } from 'vitest'
import {
  DecisionDraft,
  DecisionQuestion,
  decisionConditionIssues,
  decisionConditionNeedsReview,
  decisionRoutingIssues,
  matchDecisionCondition,
  matchDecisionRouting,
  parseDecisionAnswer,
  type DecisionAnswer,
  type SharedBotDecisionRouting
} from './decision.js'

const choice = DecisionQuestion.parse({
  type: 'choice',
  instructions: 'Route this request.',
  criteria: { billing: 'Payments', technical: 'Bugs', sales: 'Quotes' }
})
const answer: DecisionAnswer = {
  type: 'choice',
  value: 'billing',
  probabilities: { billing: 0.4, technical: 0.4, sales: 0.2 },
  confidence: 0.1
}
const score = DecisionQuestion.parse({
  type: 'score',
  instructions: 'Assess frustration.',
  criteria: ['Calm', 'Concerned', 'Unhappy', 'Angry']
})
const scoreAnswer = (value: number): DecisionAnswer => ({
  type: 'score',
  value,
  probabilities: [0.1, 0.2, 0.3, 0.4],
  confidence: 0.8
})
const routing: SharedBotDecisionRouting = {
  enabled: true,
  decisionId: 'category',
  otherwise: { type: 'default_agent' },
  rules: [
    {
      id: 'billing',
      when: { type: 'choice', thresholds: { billing: 0.4 } },
      action: { type: 'agent', agentId: 'billing-agent' }
    },
    {
      id: 'technical',
      when: { type: 'choice', thresholds: { technical: 0.4 } },
      action: { type: 'agent', agentId: 'technical-agent' }
    },
    { id: 'sales', when: { type: 'choice', thresholds: { sales: 0.7 } }, action: { type: 'skip' } }
  ]
}

describe('Decision contracts and consumer matching', () => {
  it('keeps consumer fields out of definitions and validates real input limits', () => {
    const draft = { name: ' Support ', providerId: 'typesafe-byok', model: 'jev-1.13.0', question: choice }
    expect(DecisionDraft.parse(draft).name).toBe('Support')
    expect(DecisionDraft.safeParse({ ...draft, when: routing.rules[0]!.when }).success).toBe(false)
    expect(DecisionDraft.safeParse({ ...draft, visibility: 'restricted', sharedWith: [] }).success).toBe(false)
    expect(DecisionQuestion.safeParse({ ...choice, instructions: '界'.repeat(6000) }).success).toBe(false)
    expect(
      DecisionQuestion.safeParse({ type: 'choice', instructions: 'Test', criteria: { only: 'One option' } }).success
    ).toBe(false)
  })

  it('matches every passing key, including equality, ties and non-top options, without a confidence veto', () => {
    expect(matchDecisionRouting(choice, routing, answer, 'default-agent')).toEqual({
      matchedRuleIds: ['billing', 'technical'],
      matchedKeys: ['billing', 'technical'],
      agentIds: ['billing-agent', 'technical-agent'],
      usedOtherwise: false,
      activates: true
    })
    const sameTarget = structuredClone(routing)
    sameTarget.rules[1]!.action = { type: 'agent', agentId: 'billing-agent' }
    expect(matchDecisionRouting(choice, sameTarget, answer).agentIds).toEqual(['billing-agent'])
  })

  it('uses Otherwise only for no matches, not matched skips', () => {
    const mixed = structuredClone(routing)
    mixed.rules[0]!.action = { type: 'skip' }
    expect(matchDecisionRouting(choice, mixed, answer, 'default-agent').agentIds).toEqual(['technical-agent'])
    mixed.rules[1]!.action = { type: 'skip' }
    expect(matchDecisionRouting(choice, mixed, answer, 'default-agent')).toMatchObject({
      agentIds: [],
      activates: false,
      usedOtherwise: false
    })
    mixed.rules = []
    expect(matchDecisionRouting(choice, mixed, answer, 'default-agent')).toMatchObject({
      agentIds: ['default-agent'],
      usedOtherwise: true
    })
    expect(matchDecisionRouting(choice, { ...mixed, enabled: false }, answer, 'default-agent').activates).toBe(false)
  })

  it('allows an empty gate but rejects empty or duplicated routing mappings', () => {
    expect(matchDecisionCondition(choice, { type: 'choice', thresholds: {} }, answer).matched).toBe(false)
    expect(decisionConditionIssues(choice, { type: 'choice', thresholds: {} }, true)).not.toHaveLength(0)
    const duplicate = structuredClone(routing)
    duplicate.rules[1]!.when = { type: 'choice', thresholds: { billing: 0.1 } }
    expect(decisionRoutingIssues(choice, duplicate)).not.toHaveLength(0)
    expect(decisionConditionIssues(choice, { type: 'choice', thresholds: { billing: Number.NaN } })).not.toHaveLength(0)
  })

  it('rejects incomplete and invalid distributions instead of substituting zero', () => {
    expect(() => parseDecisionAnswer(choice, { ...answer, probabilities: { billing: 1 } })).toThrow()
    expect(() =>
      parseDecisionAnswer(choice, { ...answer, probabilities: { billing: 0.4, technical: 0.4, sales: 0.3 } })
    ).toThrow()
    expect(() => parseDecisionAnswer(choice, { ...answer, value: 'other' })).toThrow()
    expect(() => parseDecisionAnswer(score, { ...scoreAnswer(1), probabilities: [0.5, 0.5] })).toThrow()
  })

  it('assigns fractional boundaries exactly once and includes the rubric maximum', () => {
    const ranges: SharedBotDecisionRouting = {
      enabled: true,
      decisionId: 'frustration',
      otherwise: { type: 'skip' },
      rules: [
        { id: 'low', when: { type: 'score', min: 0, max: 1 }, action: { type: 'skip' } },
        { id: 'medium', when: { type: 'score', min: 1, max: 2.5 }, action: { type: 'agent', agentId: 'support' } },
        { id: 'high', when: { type: 'score', min: 2.5, max: 3 }, action: { type: 'agent', agentId: 'escalation' } }
      ]
    }
    for (const [value, ruleId] of [
      [0.9999, 'low'],
      [1, 'medium'],
      [2.4999, 'medium'],
      [2.5, 'high'],
      [3, 'high']
    ] as const) {
      expect(matchDecisionRouting(score, ranges, scoreAnswer(value)).matchedRuleIds).toEqual([ruleId])
      expect(
        matchDecisionRouting(score, { ...ranges, rules: [...ranges.rules].reverse() }, scoreAnswer(value))
          .matchedRuleIds
      ).toEqual([ruleId])
    }
    const overlap = structuredClone(ranges)
    overlap.rules[0]!.when = { type: 'score', min: 0, max: 1.1 }
    expect(decisionRoutingIssues(score, overlap)).not.toHaveLength(0)
    const gap = { ...ranges, rules: ranges.rules.filter((rule) => rule.id !== 'medium') }
    expect(matchDecisionRouting(score, gap, scoreAnswer(1.5)).usedOtherwise).toBe(true)
  })

  it('requires review when score maximum changes even if an interval still fits', () => {
    const condition = { type: 'score' as const, min: 1, max: 3 }
    const changed = DecisionQuestion.parse({ ...score, criteria: ['Calm', 'Concerned', 'Unhappy', 'Angry', 'Severe'] })
    expect(decisionConditionNeedsReview(score, changed, condition)).toBe(true)
    expect(decisionConditionNeedsReview(score, { ...score, instructions: 'Updated instructions' }, condition)).toBe(
      false
    )
  })

  it('normalizes Boolean at 0.5 and prevents overlapping Yes/No rules', () => {
    const question = DecisionQuestion.parse({
      type: 'boolean',
      instructions: 'Respond?',
      criteria: { true: 'Actionable', false: 'Spam' }
    })
    const yes: DecisionAnswer = { type: 'boolean', value: true, probability: 0.5 }
    expect(matchDecisionCondition(question, { type: 'boolean', values: [true] }, yes).matched).toBe(true)
    expect(() => parseDecisionAnswer(question, { ...yes, value: false })).toThrow()
    expect(
      decisionRoutingIssues(question, {
        ...routing,
        rules: [
          { id: 'first', when: { type: 'boolean', values: [true] }, action: { type: 'skip' } },
          { id: 'second', when: { type: 'boolean', values: [true, false] }, action: { type: 'skip' } }
        ]
      })
    ).not.toHaveLength(0)
  })
})
