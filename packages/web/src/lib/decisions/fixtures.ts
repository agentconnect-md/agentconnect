import type {
  DecisionDefinition,
  DecisionEvaluation,
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
}

export type DecisionMockScenario =
  | 'ready'
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
    id: 'typesafe-byok',
    daemonId: 'example-daemon',
    name: 'TypeSafe · Your API key',
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
    providers: [provider, { ...provider, id: 'typesafe-cloud', name: 'TypeSafe · AC credits', source: 'ac_credits' }],
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
    routings: [{ botId: bot.id, config, readiness }]
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
  } else if (
    scenario === 'missing_credentials' ||
    scenario === 'daemon_offline' ||
    scenario === 'insufficient_credits'
  ) {
    seed.providers.forEach((entry) => {
      if (
        scenario === 'daemon_offline' ||
        (scenario === 'missing_credentials' && entry.source === 'byok') ||
        (scenario === 'insufficient_credits' && entry.source === 'ac_credits')
      )
        entry.readiness = { status: scenario }
    })
    if (scenario === 'insufficient_credits')
      seed.decisions.forEach((decision) => {
        decision.providerId = 'typesafe-cloud'
      })
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
