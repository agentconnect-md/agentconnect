import type {
  DecisionCondition,
  DecisionDefinition,
  DecisionEvaluation,
  DecisionEvaluationEntry,
  DecisionEvaluationRecordDetail,
  SharedBotDecisionRouting
} from '@agentconnect.md/protocol/decision'
import type {
  DecisionBot,
  DecisionChannel,
  DecisionPreviewEvaluator,
  DecisionProviderOption,
  DecisionReadiness
} from '@agentconnect.md/protocol/decision-api'

export interface DecisionMockSeed {
  orgId: string
  userId: string
  providers: DecisionProviderOption[]
  decisions: DecisionDefinition[]
  bots: DecisionBot[]
  channels: DecisionChannel[]
  routings: Array<{ botId: string; config: SharedBotDecisionRouting; readiness: DecisionReadiness }>
  /** Canned Recent evaluations, newest first, shown for any conversation in mock mode. */
  evaluations: DecisionEvaluationRecordDetail[]
}

export type DecisionMockScenario =
  | 'ready'
  | 'ac_credits'
  | 'missing_credentials'
  | 'needs_review'
  | 'provider_unavailable'
  | 'pending_sync'
  | 'daemon_offline'
  | 'insufficient_credits'

export function createDecisionMockSeed(scenario: DecisionMockScenario = 'ready'): DecisionMockSeed {
  const readiness: DecisionReadiness = { status: 'ready' }
  const metadata = {
    orgId: 'example-org',
    createdBy: 'example-user',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    visibility: 'org' as const,
    sharedWith: []
  }
  const provider: DecisionProviderOption = {
    id: 'typesafe',
    daemonId: 'example-daemon',
    name: 'TypeSafe',
    kind: 'typesafe',
    source: 'byok',
    readiness,
    models: [{ id: 'jev-1.13.0', label: 'Jev 1.13', questionTypes: ['boolean', 'choice', 'score'] }]
  }
  const decisions: DecisionDefinition[] = [
    {
      ...metadata,
      id: 'support-category',
      name: 'Support category',
      providerId: provider.id,
      model: 'jev-1.13.0',
      question: {
        type: 'choice',
        instructions: 'Classify the support request using history and currentMessage.',
        criteria: {
          billing: 'Payments, charges, and subscriptions',
          technical: 'Bugs and API problems',
          sales: 'Pricing, accounts, and contracts'
        }
      }
    },
    {
      ...metadata,
      id: 'needs-response',
      name: 'Needs a response',
      providerId: provider.id,
      model: 'jev-1.13.0',
      question: {
        type: 'boolean',
        instructions: 'Does currentMessage need a response, considering prior replies and repeated mentions?',
        criteria: {
          true: 'An actionable request that still needs help',
          false: 'Spam, repeated mentions, or a resolved request'
        }
      }
    },
    {
      ...metadata,
      id: 'frustration',
      name: 'Customer frustration',
      providerId: provider.id,
      model: 'jev-1.13.0',
      question: {
        type: 'score',
        instructions: 'Assess customer frustration using history and currentMessage.',
        criteria: ['Calm', 'Concerned but polite', 'Clearly dissatisfied', 'Threatening to cancel']
      }
    }
  ]
  const bot: DecisionBot = {
    id: 'support-bot',
    name: 'Support bot',
    shared: true,
    daemonId: provider.daemonId,
    defaultAgentId: 'billing-agent',
    agents: [
      { id: 'billing-agent', name: 'Billing', available: true },
      { id: 'technical-agent', name: 'Technical', available: true },
      { id: 'sales-agent', name: 'Sales', available: true }
    ]
  }
  const config: SharedBotDecisionRouting = {
    enabled: true,
    decisionId: 'support-category',
    rules: [
      {
        id: 'billing',
        when: { type: 'choice', thresholds: { billing: 0.3 } },
        action: { type: 'agent', agentId: 'billing-agent' }
      },
      {
        id: 'technical',
        when: { type: 'choice', thresholds: { technical: 0.3 } },
        action: { type: 'agent', agentId: 'technical-agent' }
      },
      {
        id: 'sales',
        when: { type: 'choice', thresholds: { sales: 0.7 } },
        action: { type: 'agent', agentId: 'sales-agent' }
      }
    ],
    otherwise: { type: 'skip' }
  }
  const channels: DecisionChannel[] = [
    {
      id: 'help-channel',
      botId: bot.id,
      name: '#help',
      kind: 'channel',
      agentId: bot.defaultAgentId,
      daemonId: provider.daemonId,
      settings: { trigger: 'decision', decisionBinding: { type: 'shared_bot_routing' } },
      readiness
    },
    {
      id: 'new-channel',
      botId: bot.id,
      name: '#questions',
      kind: 'channel',
      agentId: bot.defaultAgentId,
      daemonId: provider.daemonId,
      settings: { trigger: 'mention' },
      readiness
    },
    {
      id: 'off-channel',
      botId: bot.id,
      name: '#announcements',
      kind: 'channel',
      agentId: bot.defaultAgentId,
      daemonId: provider.daemonId,
      settings: { trigger: 'off' },
      readiness
    },
    {
      id: 'moderation-channel',
      botId: 'moderator-bot',
      name: '#community',
      kind: 'channel',
      agentId: 'moderator-agent',
      daemonId: provider.daemonId,
      settings: {
        trigger: 'decision',
        decisionBinding: { type: 'gate', decisionId: 'needs-response', when: { type: 'boolean', values: [true] } }
      },
      readiness
    }
  ]
  const seed: DecisionMockSeed = structuredClone({
    orgId: metadata.orgId,
    userId: metadata.createdBy,
    providers: [provider],
    decisions,
    channels,
    bots: [
      bot,
      {
        id: 'moderator-bot',
        name: 'Moderator bot',
        shared: false,
        daemonId: provider.daemonId,
        defaultAgentId: 'moderator-agent',
        agents: [{ id: 'moderator-agent', name: 'Moderator', available: true }]
      }
    ],
    routings: [{ botId: bot.id, config, readiness }],
    evaluations: mockEvaluations(decisions)
  })
  if (scenario === 'needs_review') {
    seed.channels[3]!.settings = {
      trigger: 'decision',
      decisionBinding: {
        type: 'gate',
        decisionId: 'needs-response',
        when: { type: 'choice', thresholds: { removed: 0.5 } }
      }
    }
    seed.channels[3]!.readiness = { status: 'needs_review' }
  } else if (scenario === 'pending_sync') {
    seed.channels.forEach((channel) => {
      channel.readiness = { status: 'pending_sync' }
    })
    seed.routings[0]!.readiness = { status: 'pending_sync' }
  } else if (scenario === 'ac_credits' || scenario === 'insufficient_credits') {
    seed.providers[0]!.source = 'ac_credits'
    if (scenario === 'insufficient_credits') seed.providers[0]!.readiness = { status: scenario }
  } else if (scenario === 'missing_credentials' || scenario === 'daemon_offline') {
    seed.providers[0]!.readiness = { status: scenario }
    if (scenario === 'missing_credentials') seed.providers[0]!.source = null
  }
  return seed
}

// These are canned model outputs; editing a threshold runs the real matcher, not a language model.
export const evaluateDecisionFixture: DecisionPreviewEvaluator = (decision) => {
  const question = decision.question
  let answer: Extract<DecisionEvaluation, { status: 'answered' }>['answer']
  if (question.type === 'boolean') answer = { type: 'boolean', value: true, probability: 0.8 }
  else if (question.type === 'choice') {
    const keys = Object.keys(question.criteria)
    const probabilities = Object.fromEntries(
      keys.map((key, index) => [key, keys.length === 2 ? 0.5 : index < 2 ? 0.4 : 0.2 / (keys.length - 2)])
    )
    answer = { type: 'choice', value: keys[0]!, probabilities, confidence: 0.8 }
  } else {
    answer = {
      type: 'score',
      value: (question.criteria.length - 1) / 2,
      probabilities: question.criteria.map(() => 1 / question.criteria.length),
      confidence: 0.8
    }
  }
  return { status: 'answered', model: decision.model, answer, usage: { inputTokens: 100, outputTokens: 0 } }
}

export const repeatedMentionFixture = {
  history: [
    { id: 'message-1', sender: 'Customer', text: '@Moderator please reply', timestamp: '2026-01-01T10:00:00Z' },
    {
      id: 'message-2',
      sender: 'Moderator',
      text: 'Your request is already being handled.',
      timestamp: '2026-01-01T10:00:10Z'
    }
  ],
  currentMessage: {
    id: 'message-3',
    sender: 'Customer',
    text: '@Moderator @Moderator @Moderator',
    timestamp: '2026-01-01T10:00:20Z'
  }
}

export const evaluateRepeatedMentionFixture: DecisionPreviewEvaluator = (decision) => ({
  status: 'answered',
  model: decision.model,
  answer: { type: 'boolean', value: false, probability: 0.1 },
  usage: { inputTokens: 100, outputTokens: 0 }
})

const entry = (id: string, sender: string, text: string): DecisionEvaluationEntry => ({
  id,
  sender: { id: sender },
  text,
  threadId: null,
  time: '2026-01-01T10:00:00.000Z'
})

// One of each Recent evaluations outcome, plus a row whose bodies retention already stripped.
function mockEvaluations(decisions: DecisionDefinition[]): DecisionEvaluationRecordDetail[] {
  const [category, response] = [decisions[0]!, decisions[1]!]
  const snapshot = (decision: DecisionDefinition, condition: DecisionCondition) => ({
    decisionId: decision.id,
    providerId: decision.providerId,
    model: decision.model,
    question: decision.question,
    condition,
    sessionMode: 'createNew'
  })
  const yesGate = snapshot(response, { type: 'boolean', values: [true] })
  const input = (text: string): NonNullable<DecisionEvaluationRecordDetail['input']> => ({
    currentMessage: entry('1767261660.000600', 'U-customer', text),
    history: [
      entry('1767261600.000100', 'U-customer', 'Is anyone around to help with an invoice?'),
      entry('1767261630.000200', 'U-moderator', 'Someone from billing will reply shortly.')
    ],
    historyOmitted: 0,
    context: { partial: false, reasons: [], omittedMessages: 0 }
  })
  const base = {
    reason: null,
    matchedKeys: [],
    latencyMs: 640,
    requestedModel: 'jev-1.13.0',
    actualModel: 'jev-1.13.0',
    usage: { inputTokens: 412, outputTokens: 3 },
    detailsExpired: false
  }
  return [
    {
      ...base,
      seq: 106,
      at: '2026-01-01T10:06:00.000Z',
      messageId: '1767261960.000600',
      decisionId: response.id,
      outcome: 'triggered',
      answer: { type: 'boolean', value: true, probability: 0.86 },
      snapshot: yesGate,
      input: input('Our invoice charged us twice this month.'),
      fullAnswer: { type: 'boolean', value: true, probability: 0.86 },
      evidence: { snapshotSeq: 106, suppliedBackground: 2 }
    },
    {
      ...base,
      seq: 105,
      at: '2026-01-01T10:05:00.000Z',
      messageId: '1767261900.000500',
      decisionId: category.id,
      outcome: 'skipped',
      answer: { type: 'choice', value: 'sales', confidence: 0.62 },
      snapshot: snapshot(category, { type: 'choice', thresholds: { billing: 0.5 } }),
      input: input('Do you offer an annual plan?'),
      fullAnswer: {
        type: 'choice',
        value: 'sales',
        probabilities: { billing: 0.2, technical: 0.18, sales: 0.62 },
        confidence: 0.62
      },
      evidence: null
    },
    {
      ...base,
      seq: 104,
      at: '2026-01-01T10:04:00.000Z',
      messageId: '1767261840.000400',
      decisionId: response.id,
      outcome: 'unavailable',
      reason: 'timeout',
      answer: null,
      latencyMs: 5000,
      actualModel: null,
      usage: null,
      snapshot: yesGate,
      input: input('Still waiting on that refund.'),
      fullAnswer: null,
      evidence: { snapshotSeq: 104, suppliedBackground: 0 }
    },
    {
      ...base,
      seq: 103,
      at: '2026-01-01T10:03:00.000Z',
      messageId: '1767261780.000300',
      decisionId: response.id,
      outcome: 'canceled',
      reason: 'stop',
      answer: null,
      latencyMs: null,
      actualModel: null,
      usage: null,
      snapshot: yesGate,
      input: input('Never mind, found it.'),
      fullAnswer: null,
      evidence: null
    },
    {
      ...base,
      seq: 102,
      at: '2026-01-01T10:02:00.000Z',
      messageId: '1767261720.000200',
      decisionId: response.id,
      outcome: 'pending',
      answer: null,
      latencyMs: null,
      actualModel: null,
      usage: null,
      snapshot: yesGate,
      input: input('Can someone check order 4411?'),
      fullAnswer: null,
      evidence: null
    },
    {
      ...base,
      seq: 101,
      at: '2025-12-24T09:00:00.000Z',
      messageId: '1766566800.000100',
      decisionId: response.id,
      outcome: 'triggered',
      answer: null,
      detailsExpired: true,
      snapshot: yesGate,
      input: null,
      fullAnswer: null,
      evidence: { snapshotSeq: 101, suppliedBackground: null }
    }
  ]
}
