import { describe, expect, it } from 'vitest'
import {
  ChannelDecisionGate,
  DecisionBundle,
  DecisionBundleDefinition,
  AgentModelSelection,
  decisionModelSelectionIssues,
  modelSelectionDecisionIds,
  modelSelectionTargets,
  selectDecisionTarget,
  DecisionDraft,
  DecisionEvaluationRecord,
  DecisionEvaluationRecordDetail,
  DecisionPreviewSample,
  DecisionQuestion,
  decisionConditionIssues,
  decisionConditionNeedsReview,
  decisionRoutingIssues,
  decisionRoutingAgentIds,
  SharedBotRoutingProjection,
  matchDecisionCondition,
  matchDecisionRouting,
  parseDecisionAnswer,
  partitionRoutingConstraint,
  resolveRoutingTargets,
  routingEvaluationOutcome,
  settleRoutingPreview,
  DecisionRoutingEvaluationRecord,
  DecisionRoutingEvaluationRecordDetail,
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

describe('Decision model selection', () => {
  const selection = AgentModelSelection.parse({
    decisionId: '33333333-3333-4333-8333-333333333333',
    rules: [
      {
        when: { type: 'choice', thresholds: { billing: 0.3 } },
        runtime: 'claude',
        model: 'model-a',
        effort: 'high',
        permissionMode: 'plan',
        fastMode: false
      },
      { when: { type: 'choice', thresholds: { technical: 0.3 } }, runtime: 'claude', model: 'model-b' }
    ]
  })
  it('selects one eligible model by probability and rule order, leaving no match to the consumer', () => {
    expect(selectDecisionTarget(choice, selection, answer)).toEqual({
      runtime: 'claude',
      model: 'model-a',
      effort: 'high',
      permissionMode: 'plan',
      fastMode: false
    })
    expect(
      selectDecisionTarget(choice, selection, {
        ...answer,
        value: 'technical',
        probabilities: { billing: 0.3, technical: 0.5, sales: 0.2 }
      })
    ).toEqual({ runtime: 'claude', model: 'model-b' })
    expect(
      selectDecisionTarget(choice, selection, {
        ...answer,
        value: 'sales',
        probabilities: { billing: 0.1, technical: 0.1, sales: 0.8 }
      })
    ).toBeUndefined()
  })
  it('rejects overlapping score ranges and rules invalidated by question edits', () => {
    const ranges: AgentModelSelection = {
      ...selection,
      rules: [
        { when: { type: 'score', min: 0, max: 2.5 }, runtime: 'claude', model: 'model-a' },
        { when: { type: 'score', min: 2, max: 3 }, runtime: 'claude', model: 'model-b' }
      ]
    }
    expect(decisionModelSelectionIssues(score, ranges)).not.toHaveLength(0)
    expect(() => selectDecisionTarget(score, ranges, scoreAnswer(2))).toThrow()
    ranges.rules[0]!.when = { type: 'score', min: 0, max: 1 }
    expect(selectDecisionTarget(score, ranges, scoreAnswer(2))).toEqual({ runtime: 'claude', model: 'model-b' })
    expect(() => selectDecisionTarget(score, selection, scoreAnswer(2))).toThrow()
  })

  it('chains winning rules and validates the complete graph and each referenced question', () => {
    const childId = '44444444-4444-4444-8444-444444444444'
    const chained: AgentModelSelection = {
      ...selection,
      rules: [{ when: selection.rules[0]!.when, nextStepId: 'complexity' }, selection.rules[1]!],
      steps: [
        {
          id: 'complexity',
          decisionId: childId,
          rules: [{ when: { type: 'score', min: 0, max: 3 }, runtime: 'codex', model: 'model-c' }]
        }
      ]
    }
    expect(AgentModelSelection.parse(chained)).toEqual(chained)
    expect(selectDecisionTarget(choice, chained, answer)).toEqual({ nextStepId: 'complexity' })
    expect(modelSelectionDecisionIds(chained)).toEqual([selection.decisionId, childId])
    expect(modelSelectionTargets(chained)).toEqual([
      { runtime: 'claude', model: 'model-b' },
      { runtime: 'codex', model: 'model-c' }
    ])
    expect(decisionModelSelectionIssues(choice, chained, new Map([[childId, score]]))).toEqual([])
    expect(decisionModelSelectionIssues(choice, chained, new Map([[childId, choice]]))).toEqual([
      expect.objectContaining({ path: ['steps', 0, 'rules', 0, 'when', 'type'] })
    ])
    const child = chained.steps![0]!
    for (const invalid of [
      { ...chained, steps: [] },
      { ...chained, steps: [child, child] },
      { ...chained, steps: [child, { ...child, id: 'unused' }] },
      { ...chained, steps: [{ ...child, rules: [{ when: child.rules[0]!.when, nextStepId: child.id }] }] },
      { ...chained, steps: Array.from({ length: 8 }, (_, index) => ({ ...child, id: String(index) })) }
    ])
      expect(AgentModelSelection.safeParse(invalid).success).toBe(false)
  })
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

describe('Decision wire bundle', () => {
  const gate = { type: 'gate', decisionId: 'd1', when: { type: 'boolean', values: [true] } }
  const definition = {
    id: 'd1',
    orgId: 'org1',
    name: 'Needs help',
    providerId: 'typesafe',
    model: 'jev-1.13.0',
    question: { type: 'boolean', instructions: 'Is help needed?', criteria: { true: 'Yes', false: 'No' } }
  }

  it('accepts a gate and rejects an incomplete one', () => {
    expect(ChannelDecisionGate.parse(gate)).toEqual(gate)
    expect(ChannelDecisionGate.safeParse({ type: 'gate', decisionId: 'd1' }).success).toBe(false)
    expect(ChannelDecisionGate.safeParse({ ...gate, extra: true }).success).toBe(false)
  })

  it('accepts only executable definition fields and strips the rest', () => {
    expect(DecisionBundleDefinition.parse({ ...definition, visibility: 'org' })).toEqual(definition)
    expect(DecisionBundleDefinition.safeParse({ ...definition, question: { type: 'score' } }).success).toBe(false)
  })

  it('defaults an empty bundle and accepts shared-bot routing structurally', () => {
    expect(DecisionBundle.parse({})).toEqual({ bindings: [], definitions: [] })
    const parsed = DecisionBundle.parse({
      bindings: [{ channel: 'C1', consumer: { type: 'shared_bot_routing' }, enabled: false }],
      definitions: [definition]
    })
    expect(parsed.bindings[0]?.consumer).toEqual({ type: 'shared_bot_routing' })
    expect(
      DecisionBundle.safeParse({ bindings: [{ channel: 'C1', consumer: gate, enabled: false, disabledReason: 'x' }] })
        .success
    ).toBe(false)
  })
})

describe('shared-bot routing projection (decisions.md §7.1)', () => {
  const definition = {
    id: 'd1',
    orgId: 'org1',
    name: 'Triage',
    providerId: 'typesafe',
    model: 'jev-1.13.0',
    question: { type: 'boolean', instructions: 'Is help needed?', criteria: { true: 'Yes', false: 'No' } }
  } as const
  const agent = '00000000-0000-4000-8000-00000000000a'
  const config = {
    enabled: true,
    decisionId: 'd1',
    rules: [
      {
        id: 'r1',
        when: { type: 'boolean' as const, values: [true] },
        action: { type: 'agent' as const, agentId: agent }
      },
      { id: 'r2', when: { type: 'boolean' as const, values: [false] }, action: { type: 'skip' as const } }
    ],
    otherwise: { type: 'default_agent' as const }
  }
  const routed = {
    bindings: [{ channel: 'C1', consumer: { type: 'shared_bot_routing' as const }, enabled: true }],
    definitions: [definition],
    sharedBotRouting: { botId: 'b1', config, channels: [{ channel: 'C1', defaultAgentId: agent }] }
  }

  it('round-trips a bundle with the host projection and still parses one without it', () => {
    expect(DecisionBundle.parse(routed)).toEqual(routed)
    const { sharedBotRouting: _omitted, ...plain } = routed
    expect(DecisionBundle.parse(plain)).toEqual(plain)
    expect(DecisionBundle.parse(plain)).not.toHaveProperty('sharedBotRouting')
  })

  it('rejects a projection whose config or channel list is malformed', () => {
    expect(SharedBotRoutingProjection.safeParse({ botId: 'b1', config, channels: [{ channel: '' }] }).success).toBe(
      false
    )
    expect(
      SharedBotRoutingProjection.safeParse({ botId: 'b1', config: { ...config, extra: 1 }, channels: [] }).success
    ).toBe(false)
    expect(
      SharedBotRoutingProjection.safeParse({
        botId: 'b1',
        config,
        channels: [{ channel: 'C1', defaultAgentId: 'not-a-uuid' }]
      }).success
    ).toBe(false)
  })

  it('accepts a paused router binding', () => {
    const paused = { channel: 'C1', consumer: { type: 'shared_bot_routing' }, enabled: false, disabledReason: 'paused' }
    expect(DecisionBundle.parse({ bindings: [paused] }).bindings[0]?.disabledReason).toBe('paused')
  })

  it('lists the distinct rule targets', () => {
    const twice = { ...config, rules: [...config.rules, { ...config.rules[0]!, id: 'r3' }] }
    expect(decisionRoutingAgentIds(twice)).toEqual([agent])
    expect(decisionRoutingAgentIds({ rules: [] })).toEqual([])
  })
})

describe('Gate Try samples and Recent evaluations records', () => {
  it('bounds a preview sample and requires a current message', () => {
    const sample = { history: [{ sender: 'U1', text: 'Earlier' }], currentMessage: { sender: 'U2', text: ' Now ' } }
    expect(DecisionPreviewSample.parse(sample).currentMessage.text).toBe('Now')
    expect(DecisionPreviewSample.safeParse({ ...sample, currentMessage: { text: '   ' } }).success).toBe(false)
    expect(DecisionPreviewSample.safeParse({ ...sample, history: [{ sender: ' ', text: 'x' }] }).success).toBe(false)
    const long = Array.from({ length: 51 }, () => ({ sender: 'U1', text: 'x' }))
    expect(DecisionPreviewSample.safeParse({ ...sample, history: long }).success).toBe(false)
    expect(
      DecisionPreviewSample.safeParse({ ...sample, currentMessage: { text: 'x'.repeat(16 * 1024 + 1) } }).success
    ).toBe(false)
    expect(DecisionPreviewSample.safeParse({ ...sample, extra: true }).success).toBe(false)
  })

  const record = {
    seq: 7,
    at: '2026-01-01T00:00:00.000Z',
    messageId: '1700000000.0001',
    decisionId: 'd1',
    outcome: 'triggered',
    reason: null,
    answer: { type: 'boolean', value: true, probability: 0.9 },
    matchedKeys: [],
    latencyMs: 120,
    requestedModel: 'jev-latest',
    actualModel: 'jev-1.13.0',
    usage: { inputTokens: 10, outputTokens: 1 },
    detailsExpired: false
  }

  it('accepts a summary row and refuses unknown fields or probability vectors', () => {
    expect(DecisionEvaluationRecord.parse(record)).toEqual(record)
    expect(DecisionEvaluationRecord.safeParse({ ...record, text: 'body' }).success).toBe(false)
    expect(
      DecisionEvaluationRecord.safeParse({
        ...record,
        answer: { type: 'choice', value: 'a', confidence: 0.5, probabilities: { a: 1 } }
      }).success
    ).toBe(false)
    expect(DecisionEvaluationRecord.safeParse({ ...record, outcome: 'routed' }).success).toBe(false)
  })

  it('accepts an expired detail with its snapshot and no bodies', () => {
    const detail = {
      ...record,
      detailsExpired: true,
      answer: null,
      snapshot: {
        decisionId: 'd1',
        providerId: 'typesafe',
        model: 'jev-latest',
        question: { type: 'boolean', instructions: 'Reply?', criteria: { true: 'Yes', false: 'No' } },
        condition: { type: 'boolean', values: [true] },
        sessionMode: 'createNew'
      },
      input: null,
      fullAnswer: null,
      evidence: { snapshotSeq: 7, suppliedBackground: null }
    }
    expect(DecisionEvaluationRecordDetail.parse(detail)).toEqual(detail)
    expect(
      DecisionEvaluationRecordDetail.safeParse({ ...detail, snapshot: { ...detail.snapshot, x: 1 } }).success
    ).toBe(false)
  })
})

describe('router settlement (message-intake.md §6, decisions.md §3.2)', () => {
  const candidates = [
    { agentId: 'billing-agent', daemonId: 'd-1', integrationId: 'i-1' },
    { agentId: 'technical-agent', daemonId: 'd-2', integrationId: 'i-2' },
    { agentId: 'default-agent', daemonId: 'd-1', integrationId: 'i-3' },
    { agentId: 'A', daemonId: 'd-1' },
    { agentId: 'B', daemonId: 'd-2' }
  ]
  const settle = (over: Partial<Parameters<typeof resolveRoutingTargets>[0]> = {}) =>
    resolveRoutingTargets({
      question: choice,
      routing,
      answer,
      constraint: [],
      defaultAgentId: 'default-agent',
      candidates,
      ...over
    })
  const ids = (result: ReturnType<typeof settle>) => result.targets.map((t) => [t.agentId, t.effect])
  const pick = (probabilities: Record<string, number>): DecisionAnswer => ({
    type: 'choice',
    value: Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]![0],
    probabilities,
    confidence: 0.5
  })

  it('(b) ties and non-top passing keys each contribute, in rule order, with their daemon', () => {
    const result = settle()
    expect(result.evaluate).toBe(true)
    expect(ids(result)).toEqual([
      ['billing-agent', 'selected'],
      ['technical-agent', 'selected']
    ])
    expect(result.targets.map((t) => t.daemonId)).toEqual(['d-1', 'd-2'])
    expect(result.disposition).toBe('match')
  })

  it('(b) dedupes one agent from two rules; a mixed skip still admits the agent', () => {
    const same = structuredClone(routing)
    same.rules[1]!.action = { type: 'agent', agentId: 'billing-agent' }
    expect(ids(settle({ routing: same }))).toEqual([['billing-agent', 'selected']])
    const mixed = structuredClone(routing)
    mixed.rules[0]!.action = { type: 'skip' }
    expect(ids(settle({ routing: mixed }))).toEqual([['technical-agent', 'selected']])
  })

  it('(b) no match uses Otherwise: the default agent, or skip', () => {
    const none = pick({ billing: 0.1, technical: 0.1, sales: 0.8 })
    const noRule = structuredClone(routing)
    noRule.rules = noRule.rules.filter((rule) => rule.id !== 'sales')
    expect(ids(settle({ routing: noRule, answer: none }))).toEqual([['default-agent', 'default_agent']])
    const skip = { ...noRule, otherwise: { type: 'skip' as const } }
    expect(settle({ routing: skip, answer: none })).toMatchObject({ targets: [], disposition: 'skip' })
    expect(settle({ routing: noRule, answer: none, defaultAgentId: undefined }).disposition).toBe('skip')
    // A matched skip rule never falls through to Otherwise.
    expect(settle({ answer: none }).disposition).toBe('skip')
  })

  it('(b) Score boundaries and Boolean mapping select exactly one destination', () => {
    const ranges: SharedBotDecisionRouting = {
      enabled: true,
      decisionId: 'frustration',
      otherwise: { type: 'skip' },
      rules: [
        { id: 'low', when: { type: 'score', min: 0, max: 1 }, action: { type: 'skip' } },
        { id: 'mid', when: { type: 'score', min: 1, max: 2.5 }, action: { type: 'agent', agentId: 'A' } },
        { id: 'high', when: { type: 'score', min: 2.5, max: 3 }, action: { type: 'agent', agentId: 'B' } }
      ]
    }
    for (const [value, expected] of [
      [1, ['A']],
      [2.49, ['A']],
      [2.5, ['B']],
      [3, ['B']],
      [0.5, []]
    ] as const)
      expect(
        settle({ question: score, routing: ranges, answer: scoreAnswer(value) }).targets.map((t) => t.agentId)
      ).toEqual(expected)
    const yesNo = DecisionQuestion.parse({
      type: 'boolean',
      instructions: 'Urgent?',
      criteria: { true: 'Yes', false: 'No' }
    })
    const bool: SharedBotDecisionRouting = {
      enabled: true,
      decisionId: 'urgent',
      otherwise: { type: 'skip' },
      rules: [
        { id: 'yes', when: { type: 'boolean', values: [true] }, action: { type: 'agent', agentId: 'A' } },
        { id: 'no', when: { type: 'boolean', values: [false] }, action: { type: 'agent', agentId: 'B' } }
      ]
    }
    const b = (value: boolean): DecisionAnswer => ({ type: 'boolean', value, probability: value ? 0.9 : 0.1 })
    expect(ids(settle({ question: yesNo, routing: bool, answer: b(true) }))).toEqual([['A', 'selected']])
    expect(ids(settle({ question: yesNo, routing: bool, answer: b(false) }))).toEqual([['B', 'selected']])
  })

  it('(c) a constraint of participant A and eligible B evaluates once; skip keeps A, match keeps both', () => {
    const constraint = [
      { agentId: 'A', daemonId: 'd-1', participant: true },
      { agentId: 'B', daemonId: 'd-2', participant: false, via: 'mention' as const }
    ]
    expect(partitionRoutingConstraint(constraint)).toMatchObject({ evaluate: true })
    const none = pick({ billing: 0.1, technical: 0.1, sales: 0.8 })
    expect(ids(settle({ constraint, answer: none }))).toEqual([['A', 'participant']])
    expect(settle({ constraint, answer: none }).disposition).toBe('match')
    expect(ids(settle({ constraint }))).toEqual([
      ['A', 'participant'],
      ['B', 'kept']
    ])
    // The answer never adds the rules' agents to a constrained conversation.
    expect(settle({ constraint }).targets.map((t) => t.agentId)).not.toContain('billing-agent')
    expect(settle({ constraint: [constraint[1]!], answer: none }).disposition).toBe('skip')
  })

  it('(c) an all-participant reply needs no evaluation; an unconstrained message always evaluates', () => {
    const all = [
      { agentId: 'A', participant: true },
      { agentId: 'A', participant: false },
      { agentId: 'B', participant: true }
    ]
    expect(partitionRoutingConstraint(all)).toMatchObject({ evaluate: false, eligible: [] })
    expect(settle({ constraint: all, answer: undefined })).toMatchObject({ evaluate: false, disposition: 'match' })
    expect(ids(settle({ constraint: all, answer: undefined }))).toEqual([
      ['A', 'participant'],
      ['B', 'participant']
    ])
    expect(partitionRoutingConstraint([]).evaluate).toBe(true)
  })

  it('(d) unavailable keeps the constrained, else the default for a new conversation, else nothing', () => {
    const constraint = [
      { agentId: 'A', participant: true },
      { agentId: 'B', participant: false }
    ]
    expect(ids(settle({ constraint, answer: 'unavailable' }))).toEqual([
      ['A', 'participant'],
      ['B', 'fallback_constrained']
    ])
    expect(settle({ answer: 'unavailable' })).toMatchObject({ disposition: 'unavailable', fallback: 'default' })
    expect(ids(settle({ answer: 'unavailable' }))).toEqual([['default-agent', 'fallback_default']])
    expect(settle({ answer: 'unavailable', defaultAgentId: undefined })).toMatchObject({
      targets: [],
      fallback: 'none'
    })
  })

  it('(d) a selected agent missing from the directory is unavailable, never rerouted', () => {
    const result = settle({ candidates: candidates.filter((c) => c.agentId !== 'technical-agent') })
    expect(result.targets).toEqual([
      expect.objectContaining({ agentId: 'billing-agent', daemonId: 'd-1' }),
      expect.objectContaining({ agentId: 'technical-agent', daemonId: null, unavailableReason: 'not_member' })
    ])
  })
})

describe('routing preview settlement (decisions.md §9.3)', () => {
  const candidates = [
    { agentId: 'billing-agent', daemonId: 'd-1' },
    { agentId: 'technical-agent', daemonId: 'd-1' },
    { agentId: 'default-agent', daemonId: 'd-1' },
    { agentId: 'A', daemonId: 'd-1' },
    { agentId: 'B', daemonId: 'd-1' }
  ]
  const preview = (over: Partial<Parameters<typeof settleRoutingPreview>[0]> = {}) =>
    settleRoutingPreview({
      question: choice,
      routing,
      answer,
      constraint: [],
      defaultAgentId: 'default-agent',
      candidates,
      ...over
    })
  const choiceAnswer = (probabilities: Record<string, number>): DecisionAnswer => ({
    type: 'choice',
    value: Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]![0],
    probabilities,
    confidence: 0.5
  })
  const agents = (result: ReturnType<typeof preview>) => result.targets.map((t) => t.agentId)

  it('Choice: no passing option uses Otherwise, several and tied options all match', () => {
    const noRuleSkip = { ...routing, rules: routing.rules.slice(0, 2) }
    const none = preview({ routing: noRuleSkip, answer: choiceAnswer({ billing: 0.2, technical: 0.2, sales: 0.6 }) })
    expect(none).toMatchObject({ outcome: 'activate', match: { usedOtherwise: true } })
    expect(agents(none)).toEqual(['default-agent'])
    expect(none.rules.map((r) => r.matched)).toEqual([false, false])
    const several = preview({ answer: choiceAnswer({ billing: 0.45, technical: 0.4, sales: 0.15 }) })
    expect(agents(several)).toEqual(['billing-agent', 'technical-agent'])
    expect(several.rules.map((r) => [r.ruleId, r.matched])).toEqual([
      ['billing', true],
      ['technical', true],
      ['sales', false]
    ])
    const tie = preview({ answer: choiceAnswer({ billing: 0.4, technical: 0.4, sales: 0.2 }) })
    expect(agents(tie)).toEqual(['billing-agent', 'technical-agent'])
  })

  it('Choice: several matches to one agent deduplicate; a mixed skip keeps the agent', () => {
    const same = structuredClone(routing)
    same.rules[1]!.action = { type: 'agent', agentId: 'billing-agent' }
    expect(agents(preview({ routing: same }))).toEqual(['billing-agent'])
    const mixed = structuredClone(routing)
    mixed.rules[0]!.action = { type: 'skip' }
    const result = preview({ routing: mixed })
    expect(agents(result)).toEqual(['technical-agent'])
    expect(result.match?.matchedRuleIds).toEqual(['billing', 'technical'])
    mixed.rules[1]!.action = { type: 'skip' }
    expect(preview({ routing: mixed })).toMatchObject({ outcome: 'skip', targets: [] })
  })

  it('Boolean Yes/No and Score 1, 2.49, 2.5, 3 select one destination', () => {
    const yesNo = DecisionQuestion.parse({
      type: 'boolean',
      instructions: 'Urgent?',
      criteria: { true: 'Y', false: 'N' }
    })
    const bool: SharedBotDecisionRouting = {
      enabled: true,
      decisionId: 'urgent',
      otherwise: { type: 'skip' },
      rules: [
        { id: 'yes', when: { type: 'boolean', values: [true] }, action: { type: 'agent', agentId: 'A' } },
        { id: 'no', when: { type: 'boolean', values: [false] }, action: { type: 'agent', agentId: 'B' } }
      ]
    }
    const b = (value: boolean): DecisionAnswer => ({ type: 'boolean', value, probability: value ? 0.9 : 0.1 })
    expect(agents(preview({ question: yesNo, routing: bool, answer: b(true) }))).toEqual(['A'])
    expect(agents(preview({ question: yesNo, routing: bool, answer: b(false) }))).toEqual(['B'])
    const ranges: SharedBotDecisionRouting = {
      enabled: true,
      decisionId: 'frustration',
      otherwise: { type: 'skip' },
      rules: [
        { id: 'low', when: { type: 'score', min: 0, max: 1 }, action: { type: 'skip' } },
        { id: 'mid', when: { type: 'score', min: 1, max: 2.5 }, action: { type: 'agent', agentId: 'A' } },
        { id: 'high', when: { type: 'score', min: 2.5, max: 3 }, action: { type: 'agent', agentId: 'B' } }
      ]
    }
    for (const [value, expected] of [
      [1, ['A']],
      [2.49, ['A']],
      [2.5, ['B']],
      [3, ['B']]
    ] as const)
      expect(agents(preview({ question: score, routing: ranges, answer: scoreAnswer(value) }))).toEqual(expected)
    expect(preview({ question: score, routing: ranges, answer: scoreAnswer(0.5) }).outcome).toBe('skip')
  })

  it('a constrained answer continues with the recipients or skips; participants alone need no evaluation', () => {
    const constraint = [{ agentId: 'B', participant: false, via: 'mention' as const }]
    const kept = preview({ constraint })
    expect(kept).toMatchObject({ outcome: 'continue', evaluate: true })
    expect(kept.targets.map((t) => [t.agentId, t.effect])).toEqual([['B', 'kept']])
    const skip = preview({ constraint, answer: choiceAnswer({ billing: 0.1, technical: 0.1, sales: 0.8 }) })
    expect(skip).toMatchObject({ outcome: 'skip', targets: [] })
    const participants = preview({ constraint: [{ agentId: 'A', participant: true }], answer: undefined })
    expect(participants).toMatchObject({ outcome: 'continue', evaluate: false, rules: [] })
  })

  it('unavailable names the constrained, default, or no continuation; an invalid answer settles the same way', () => {
    const constrained = preview({ constraint: [{ agentId: 'B', participant: false }], answer: 'unavailable' })
    expect(constrained).toMatchObject({ outcome: 'unavailable', fallback: 'constrained' })
    expect(preview({ answer: 'unavailable' })).toMatchObject({ outcome: 'unavailable', fallback: 'default' })
    expect(preview({ answer: 'unavailable', defaultAgentId: undefined })).toMatchObject({
      outcome: 'unavailable',
      fallback: 'none',
      targets: []
    })
    const invalid = preview({ answer: { ...answer, probabilities: { billing: 1 } } })
    expect(invalid).toMatchObject({ outcome: 'unavailable', reason: 'invalid_response', fallback: 'default' })
  })

  it('marks both overlapping Score rows and both rows sharing a key', () => {
    const overlap: SharedBotDecisionRouting = {
      enabled: true,
      decisionId: 'frustration',
      otherwise: { type: 'skip' },
      rules: [
        { id: 'a', when: { type: 'score', min: 0, max: 2 }, action: { type: 'skip' } },
        { id: 'b', when: { type: 'score', min: 1, max: 3 }, action: { type: 'skip' } }
      ]
    }
    expect(decisionRoutingIssues(score, overlap).map((issue) => issue.path)).toEqual([
      ['rules', 0, 'when'],
      ['rules', 1, 'when']
    ])
    const duplicate = structuredClone(routing)
    duplicate.rules[2]!.when = { type: 'choice', thresholds: { billing: 0.1 } }
    expect(decisionRoutingIssues(choice, duplicate).map((issue) => issue.path)).toEqual([
      ['rules', 0, 'when'],
      ['rules', 2, 'when']
    ])
  })
})

describe('routing evaluation outcomes (decisions.md §9.5)', () => {
  const t = (...dispositions: Array<'pending' | 'admitted' | 'rejected' | 'unavailable'>) =>
    dispositions.map((disposition) => ({ disposition }))
  it('classifies every outcome', () => {
    expect(
      routingEvaluationOutcome({ state: 'admitted', disposition: 'match', targets: t('admitted', 'admitted') })
    ).toBe('routed')
    expect(
      routingEvaluationOutcome({ state: 'admitted', disposition: 'match', targets: t('admitted', 'unavailable') })
    ).toBe('partially_routed')
    expect(
      routingEvaluationOutcome({ state: 'admitted', disposition: 'match', targets: t('admitted', 'rejected') })
    ).toBe('partially_routed')
    expect(routingEvaluationOutcome({ state: 'skipped', disposition: 'skip', targets: [] })).toBe('skipped')
    expect(routingEvaluationOutcome({ state: 'admitted', disposition: 'unavailable', targets: t('admitted') })).toBe(
      'fallback'
    )
    // A fallback target that is itself unavailable is Unavailable, never Fallback or Routed.
    expect(
      routingEvaluationOutcome({
        state: 'canceled',
        disposition: 'unavailable',
        targets: t('unavailable'),
        cancelReason: 'targets_rejected'
      })
    ).toBe('unavailable')
    expect(
      routingEvaluationOutcome({
        state: 'canceled',
        disposition: 'unavailable',
        targets: [],
        cancelReason: 'no_default'
      })
    ).toBe('unavailable')
    expect(
      routingEvaluationOutcome({
        state: 'canceled',
        disposition: 'match',
        targets: t('rejected'),
        cancelReason: 'targets_rejected'
      })
    ).toBe('unavailable')
    expect(routingEvaluationOutcome({ state: 'canceled', disposition: null, targets: [], cancelReason: 'stop' })).toBe(
      'canceled'
    )
    for (const state of ['reserved', 'evaluating'])
      expect(routingEvaluationOutcome({ state, disposition: null, targets: [] })).toBe('pending')
    expect(
      routingEvaluationOutcome({ state: 'settled', disposition: 'match', targets: t('admitted', 'pending') })
    ).toBe('pending')
  })

  it('bounds the routing record and its detail', () => {
    const row = {
      seq: 3,
      at: '2026-01-01T00:00:00.000Z',
      channel: 'C1',
      messageId: null,
      decisionId: 'd1',
      outcome: 'routed',
      reason: null,
      evaluated: true,
      answer: null,
      matchedKeys: [],
      matchedRuleIds: ['r1'],
      usedOtherwise: false,
      fallback: null,
      targets: [
        { agentId: 'A', effect: 'selected', via: 'implicit', participant: false, disposition: 'admitted', reason: null }
      ],
      latencyMs: 12,
      requestedModel: 'jev-latest',
      actualModel: null,
      usage: null,
      detailsExpired: false
    }
    expect(DecisionRoutingEvaluationRecord.parse(row)).toEqual(row)
    expect(DecisionRoutingEvaluationRecord.safeParse({ ...row, outcome: 'triggered' }).success).toBe(false)
    expect(DecisionRoutingEvaluationRecord.safeParse({ ...row, extra: 1 }).success).toBe(false)
    const detail = {
      ...row,
      snapshot: null,
      constraint: [{ agentId: 'A', participant: true, via: 'mention' }],
      input: null,
      fullAnswer: null
    }
    expect(DecisionRoutingEvaluationRecordDetail.parse(detail)).toEqual(detail)
    expect(
      DecisionRoutingEvaluationRecordDetail.safeParse({
        ...detail,
        constraint: [{ agentId: 'A', participant: true, via: 'mention', text: 'x' }]
      }).success
    ).toBe(false)
  })
})
