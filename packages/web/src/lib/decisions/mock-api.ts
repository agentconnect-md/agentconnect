import {
  runDecisionChain,
  ChannelDecisionGate,
  DecisionChannelSettings,
  DecisionDraft,
  DecisionEvaluation,
  DecisionPreviewSample,
  SharedBotDecisionRouting,
  decisionConditionIssues,
  decisionGateIssues,
  decisionChainIds,
  nextGateStep,
  type DecisionGateStep,
  type DecisionRoutingStep,
  type DecisionChainTrace,
  type DecisionQuestion,
  type DecisionAnswer,
  decisionConditionNeedsReview,
  decisionRoutingIssues,
  matchDecisionCondition,
  matchDecisionRouting,
  parseDecisionAnswer,
  partitionRoutingConstraint,
  settleRoutingPreview,
  type DecisionDefinition,
  type DecisionRoutingEvaluationRecord,
  type DecisionEvaluationRecord,
  type DecisionValidationIssue
} from '@agentconnect.md/protocol/decision'
import type {
  DecisionApi,
  DecisionApiErrorBody,
  DecisionGatePreviewResult,
  DecisionPreviewEvaluator,
  DecisionPreviewResult,
  DecisionReadiness,
  DecisionRoutingDetail,
  DecisionRoutingNotAppliedReason,
  DecisionRoutingPreviewResult,
  DecisionUsage
} from '@agentconnect.md/protocol/decision-api'
import {
  createDecisionMockSeed,
  evaluateDecisionFixture,
  type DecisionMockScenario,
  type DecisionMockSeed
} from './fixtures'

export class DecisionMockApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: DecisionApiErrorBody
  ) {
    super(body.message)
  }
}

function invalid(issues: DecisionValidationIssue[]): void {
  if (issues.length)
    throw new DecisionMockApiError(400, { error: 'invalid_input', message: 'Check the highlighted fields.', issues })
}

function parse<T>(
  schema: {
    safeParse(
      input: unknown
    ):
      | { success: true; data: T }
      | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } }
  },
  input: unknown
): T {
  const result = schema.safeParse(input)
  if (result.success) return result.data
  invalid(result.error.issues.map((issue) => ({ path: issue.path.map(String), message: issue.message })))
  throw new Error('Unreachable validation result')
}

export interface DecisionMockOptions {
  scenario?: DecisionMockScenario
  seed?: DecisionMockSeed
  evaluate?: DecisionPreviewEvaluator
  beforeSave?: () => void
}

// Explicit opt-in for prototypes/tests; this module is never installed as a production API fallback.
export function createDecisionMockApi(options: DecisionMockOptions = {}): DecisionApi {
  const seed = structuredClone(options.seed ?? createDecisionMockSeed(options.scenario))
  const definitions = new Map(seed.decisions.map((entry) => [entry.id, entry]))
  const channels = new Map(seed.channels.map((entry) => [entry.id, entry]))
  const bots = new Map(seed.bots.map((entry) => [entry.id, entry]))
  const routings = new Map(seed.routings.map((entry) => [entry.botId, entry]))
  const evaluate =
    options.evaluate ??
    (options.scenario === 'provider_unavailable'
      ? () => ({ status: 'unavailable', reason: 'provider' }) as const
      : evaluateDecisionFixture)
  const copy = structuredClone
  const missing = () => new DecisionMockApiError(404, { error: 'not_found', message: 'Resource not found.' })
  function get<T>(map: Map<string, T>, id: string): T {
    const item = map.get(id)
    if (!item) throw missing()
    return item
  }
  function conflict(message: string): never {
    throw new DecisionMockApiError(409, { error: 'conflict', message })
  }

  function validateDraft(input: unknown): DecisionDraft {
    const draft = parse(DecisionDraft, input)
    const providers = seed.providers.filter((entry) => entry.id === draft.providerId)
    if (!providers.length) invalid([{ path: ['providerId'], message: 'Select an available provider.' }])
    if (
      !providers.some((provider) =>
        provider.models.some((model) => model.id === draft.model && model.questionTypes.includes(draft.question.type))
      )
    )
      invalid([{ path: ['model'], message: 'This model does not support the selected question type.' }])
    return draft
  }

  function providerReadiness(draft: DecisionDraft, daemonId: string): DecisionReadiness {
    const provider = seed.providers.find((entry) => entry.id === draft.providerId && entry.daemonId === daemonId)
    if (
      !provider ||
      !provider.models.some((model) => model.id === draft.model && model.questionTypes.includes(draft.question.type))
    )
      return { status: 'unsupported' }
    return copy(provider.readiness)
  }

  // Canned output is validated first, so an invalid fixture reads as unavailable, never as a No.
  async function evaluateDraft(draft: DecisionDraft, state: Record<string, unknown>): Promise<DecisionEvaluation> {
    let evaluation: DecisionEvaluation
    try {
      const parsed = DecisionEvaluation.safeParse(await evaluate(copy(draft), copy(state)))
      evaluation = parsed.success ? parsed.data : { status: 'unavailable', reason: 'invalid_response' }
    } catch {
      evaluation = { status: 'unavailable', reason: 'provider' }
    }
    if (evaluation.status === 'answered') {
      try {
        parseDecisionAnswer(draft.question, evaluation.answer)
      } catch {
        evaluation = { status: 'unavailable', reason: 'invalid_response' }
      }
    }
    return evaluation
  }

  const evaluations = [...seed.evaluations].sort((a, b) => b.seq - a.seq)
  const routingEvaluations = [...(seed.routingEvaluations ?? [])].sort((a, b) => b.seq - a.seq)
  const offline = () =>
    new DecisionMockApiError(503, {
      error: 'unavailable',
      code: 'DAEMON_OFFLINE',
      message: 'The daemon serving this conversation is offline.'
    })

  function usages(id: string): DecisionUsage[] {
    const result: DecisionUsage[] = []
    for (const channel of channels.values()) {
      const settings = channel.settings
      if (
        settings.trigger === 'decision' &&
        settings.decisionBinding.type === 'gate' &&
        decisionChainIds(settings.decisionBinding).includes(id)
      )
        result.push({
          kind: 'gate',
          id: channel.id,
          label: channel.name,
          integrationId: channel.botId,
          channelId: channel.id
        })
    }
    for (const routing of routings.values()) {
      if (decisionChainIds(routing.config).includes(id))
        result.push({ kind: 'shared_bot_routing', id: routing.botId, label: get(bots, routing.botId).name })
    }
    return result
  }

  function routingIssues(
    botId: string,
    config: SharedBotDecisionRouting,
    draft: DecisionDraft
  ): DecisionValidationIssue[] {
    const bot = get(bots, botId)
    for (const id of decisionChainIds(config)) get(definitions, id)
    const issues = decisionRoutingIssues(
      draft.question,
      config,
      new Map([...definitions].map(([id, d]) => [id, d.question]))
    )
    if (!bot.shared) issues.push({ path: ['botId'], message: 'Routing requires a shared bot.' })
    const rules = [config, ...(config.steps ?? [])].flatMap((step) => step.rules)
    rules.forEach((rule, index) => {
      if (
        rule.action.type === 'agent' &&
        !bot.agents.some((agent) => rule.action.type === 'agent' && agent.id === rule.action.agentId)
      )
        issues.push({ path: ['rules', index, 'action'], message: 'Choose an agent connected to this bot.' })
    })
    return issues
  }

  function routingDetail(botId: string): DecisionRoutingDetail {
    const bot = get(bots, botId)
    const saved = routings.get(botId)
    let readiness: DecisionReadiness = saved?.readiness ?? { status: 'ready' }
    if (saved && readiness.status === 'ready') {
      const definition = get(definitions, saved.config.decisionId)
      const issues = routingIssues(botId, saved.config, definition)
      readiness = issues.length ? { status: 'needs_review', issues } : providerReadiness(definition, bot.daemonId)
    }
    const scoped = [...channels.values()].filter(
      (channel) =>
        channel.botId === botId &&
        channel.settings.trigger === 'decision' &&
        channel.settings.decisionBinding.type === 'shared_bot_routing'
    )
    const defaultAgent = bot.agents.find((agent) => agent.id === bot.defaultAgentId)
    return copy({
      botId,
      config: saved?.config ?? null,
      channelIds: scoped.map((channel) => channel.id),
      readiness,
      evaluationHost: { daemonId: bot.daemonId, name: null, source: 'default_agent', status: 'ready' },
      channels: scoped.map((channel) => ({
        channelId: channel.id,
        name: channel.name,
        defaultAgent: defaultAgent ? { id: defaultAgent.id, name: defaultAgent.name } : null,
        evaluationDaemonId: bot.daemonId,
        readiness
      })),
      updatedAt: null
    })
  }

  function channelView(id: string) {
    const channel = copy(get(channels, id))
    if (channel.readiness.status !== 'ready' || channel.settings.trigger !== 'decision') return channel
    const binding = channel.settings.decisionBinding
    if (binding.type === 'gate') {
      const definition = get(definitions, binding.decisionId)
      const issues = decisionConditionIssues(definition.question, binding.when)
      channel.readiness = issues.length
        ? { status: 'needs_review', issues }
        : providerReadiness(definition, channel.daemonId)
    } else channel.readiness = routingDetail(channel.botId).readiness
    return channel
  }

  return {
    mode: 'mock',
    async listProviders(daemonId) {
      return copy(seed.providers.filter((entry) => !daemonId || entry.daemonId === daemonId))
    },
    async listDecisions() {
      return copy([...definitions.values()].map((entry) => ({ ...entry, usageCount: usages(entry.id).length })))
    },
    async getDecision(id) {
      return copy({ decision: get(definitions, id), usages: usages(id) })
    },
    async createDecision(input) {
      options.beforeSave?.()
      const draft = validateDraft(input)
      const timestamp = new Date().toISOString()
      const definition: DecisionDefinition = {
        ...draft,
        id: crypto.randomUUID(),
        orgId: seed.orgId,
        createdBy: seed.userId,
        createdAt: timestamp,
        updatedAt: timestamp
      }
      definitions.set(definition.id, definition)
      return copy(definition)
    },
    async updateDecision(id, input) {
      options.beforeSave?.()
      const previous = get(definitions, id)
      const draft = validateDraft({
        ...input,
        visibility: input.visibility === undefined ? previous.visibility : input.visibility,
        sharedWith: input.sharedWith === undefined ? previous.sharedWith : input.sharedWith
      })
      const definition = { ...previous, ...draft, updatedAt: new Date().toISOString() }
      definitions.set(id, definition)
      for (const channel of channels.values()) {
        const settings = channel.settings
        if (
          settings.trigger === 'decision' &&
          settings.decisionBinding.type === 'gate' &&
          [settings.decisionBinding, ...(settings.decisionBinding.steps ?? [])].some(
            (step) =>
              step.decisionId === id && decisionConditionNeedsReview(previous.question, draft.question, step.when)
          )
        )
          channel.readiness = { status: 'needs_review' }
      }
      for (const saved of routings.values()) {
        if (
          [saved.config, ...(saved.config.steps ?? [])].some(
            (step) =>
              step.decisionId === id &&
              step.rules.some((rule) => decisionConditionNeedsReview(previous.question, draft.question, rule.when))
          )
        )
          saved.readiness = { status: 'needs_review' }
      }
      return copy(definition)
    },
    async deleteDecision(id) {
      options.beforeSave?.()
      get(definitions, id)
      const used = usages(id)
      if (used.length)
        throw new DecisionMockApiError(409, {
          error: 'conflict',
          message: 'This Decision is still used. Remove its bindings before deleting it.',
          usages: used,
          hiddenUsageCount: 0
        })
      definitions.delete(id)
    },
    async listBots() {
      return copy([...bots.values()])
    },
    async listChannels(botId) {
      return [...channels.values()]
        .filter((entry) => !botId || entry.botId === botId)
        .map((entry) => channelView(entry.id))
    },
    async saveChannel(id, input) {
      options.beforeSave?.()
      const channel = get(channels, id)
      const settings = parse(DecisionChannelSettings, input)
      if (settings.trigger === 'decision') {
        if (settings.decisionBinding.type === 'shared_bot_routing')
          conflict('Edit shared-bot routing and channel scope together.')
        const binding = settings.decisionBinding
        const definition = get(definitions, binding.decisionId)
        invalid(
          decisionGateIssues(definition.question, binding, new Map([...definitions].map(([id, d]) => [id, d.question])))
        )
      }
      channels.set(id, { ...channel, settings, readiness: { status: 'ready' } })
      return channelView(id)
    },
    async getRouting(botId) {
      return routingDetail(botId)
    },
    async saveRouting(botId, input) {
      options.beforeSave?.()
      const config = parse(SharedBotDecisionRouting, input.config)
      const definition = get(definitions, config.decisionId)
      invalid(routingIssues(botId, config, definition))
      const current = routingDetail(botId).channelIds
      const selected = new Set(input.channelIds)
      invalid(
        selected.size === input.channelIds.length ? [] : [{ path: ['channelIds'], message: 'Channels must be unique.' }]
      )
      const removals = new Map(
        input.removals.map((entry) => [entry.channelId, parse(DecisionChannelSettings, entry.settings)])
      )
      invalid(
        removals.size === input.removals.length
          ? []
          : [{ path: ['removals'], message: 'Replacement channels must be unique.' }]
      )
      const removed = current.filter((id) => !selected.has(id))
      if (removed.length !== removals.size || removed.some((id) => !removals.has(id)))
        conflict('Specify replacement settings for every channel removed from routing.')
      for (const id of selected) {
        const channel = get(channels, id)
        if (channel.botId !== botId || channel.kind !== 'channel')
          conflict('Select group channels belonging to this bot.')
      }
      if ([...removals.values()].some((settings) => settings.trigger === 'decision'))
        conflict('Choose Off, Mention, or Any for removed channels.')
      for (const [id, settings] of removals)
        channels.set(id, { ...get(channels, id), settings, readiness: { status: 'ready' } })
      for (const id of selected)
        channels.set(id, {
          ...get(channels, id),
          settings: { trigger: 'decision', decisionBinding: { type: 'shared_bot_routing' } },
          readiness: { status: 'ready' }
        })
      routings.set(botId, { botId, config, readiness: { status: 'ready' } })
      return routingDetail(botId)
    },
    async preview(input) {
      input = copy(input)
      const draft = validateDraft(input.decision)
      const target = input.target ?? { kind: 'daemon' as const, daemonId: input.daemonId }
      const candidates = seed.providers.filter(
        (entry) =>
          entry.id === draft.providerId &&
          (target.kind === 'daemon'
            ? entry.daemonId === target.daemonId
            : target.kind === 'pool'
              ? entry.pool
              : !entry.pool && entry.memberSetId === target.setId)
      )
      const daemonId =
        candidates.find((entry) => providerReadiness(draft, entry.daemonId).status === 'ready')?.daemonId ??
        candidates[0]?.daemonId ??
        ''
      const consumer = input.consumer
      const channel = consumer.type === 'none' ? null : get(channels, consumer.channelId)
      const bot =
        consumer.type === 'shared_bot_routing' ? get(bots, consumer.botId) : channel ? get(bots, channel.botId) : null
      const targets =
        consumer.type === 'shared_bot_routing'
          ? consumer.targets
          : consumer.type === 'gate'
            ? (consumer.targets ?? { type: 'new' as const })
            : { type: 'new' as const }
      if (bot && daemonId !== bot.daemonId) conflict('Use this consumer’s evaluation daemon for preview.')
      if (
        targets.type !== 'new' &&
        (!targets.agentIds.length ||
          targets.agentIds.some(
            (id) =>
              !bot?.agents.some((agent) => agent.id === id) || (consumer.type === 'gate' && channel?.agentId !== id)
          ))
      )
        invalid([{ path: ['targets'], message: 'Select existing recipients of this consumer.' }])
      if (consumer.type === 'gate') invalid(decisionConditionIssues(draft.question, consumer.when))
      if (consumer.type === 'shared_bot_routing') {
        invalid(routingIssues(consumer.botId, parse(SharedBotDecisionRouting, consumer.config), draft))
        for (const id of new Set([consumer.channelId, ...consumer.channelIds])) {
          const selected = get(channels, id)
          if (selected.botId !== consumer.botId || selected.kind !== 'channel')
            conflict('Select group channels belonging to this bot.')
        }
      }
      const readiness = providerReadiness(draft, daemonId)
      const result: DecisionPreviewResult = {
        mode: 'mock',
        readiness,
        evaluation: null,
        consumer:
          consumer.type === 'none'
            ? null
            : {
                outcome: 'blocked',
                matchedRuleIds: [],
                matchedKeys: [],
                matchedAgentIds: [],
                effectiveAgentIds: [],
                unavailableAgentIds: [],
                usedOtherwise: false,
                targetConstraint: copy(targets)
              }
      }
      if (consumer.type === 'shared_bot_routing' && result.consumer) {
        const reason =
          channel?.settings.trigger === 'off' && !consumer.channelIds.includes(consumer.channelId)
            ? 'off'
            : !consumer.channelIds.includes(consumer.channelId)
              ? 'outside_scope'
              : !consumer.config.enabled
                ? 'paused'
                : undefined
        if (reason) {
          result.consumer.outcome = 'not_applied'
          result.consumer.notAppliedReason = reason
          return result
        }
      }
      if (readiness.status !== 'ready') return result
      const evaluation = await evaluateDraft(draft, input.state)
      result.evaluation = copy(evaluation)
      if (!result.consumer) return result
      const defaultAgentId = channel?.agentId ?? bot?.defaultAgentId
      const fallback = defaultAgentId ? [defaultAgentId] : []
      if (evaluation.status === 'unavailable') {
        result.consumer.outcome = 'continue'
        result.consumer.effectiveAgentIds = targets.type === 'new' ? fallback : [...new Set(targets.agentIds)]
      } else {
        let activates = false
        if (consumer.type === 'gate') {
          const match = matchDecisionCondition(draft.question, consumer.when, evaluation.answer)
          result.consumer.matchedKeys = match.matchedKeys
          result.consumer.matchedAgentIds = match.matched ? fallback : []
          activates = match.matched
        } else if (consumer.type === 'shared_bot_routing') {
          const match = matchDecisionRouting(draft.question, consumer.config, evaluation.answer, defaultAgentId)
          result.consumer.matchedKeys = match.matchedKeys
          result.consumer.matchedRuleIds = match.matchedRuleIds
          result.consumer.matchedAgentIds = match.agentIds
          result.consumer.usedOtherwise = match.usedOtherwise
          activates = match.activates
        }
        result.consumer.outcome = activates ? 'activate' : 'skip'
        result.consumer.effectiveAgentIds = activates
          ? targets.type === 'new'
            ? result.consumer.matchedAgentIds
            : [...new Set(targets.agentIds)]
          : []
      }
      result.consumer.unavailableAgentIds = result.consumer.effectiveAgentIds.filter(
        (id) => !bot?.agents.some((agent) => agent.id === id && agent.available)
      )
      return copy(result)
    },
    async previewGate(ref, input) {
      input = copy(input)
      const binding = parse(ChannelDecisionGate, input.decisionBinding)
      const state = parse(DecisionPreviewSample, input.state)
      const definition = definitions.get(binding.decisionId)
      if (!definition) throw new DecisionMockApiError(404, { error: 'not_found', message: 'Decision not found.' })
      invalid(
        decisionGateIssues(definition.question, binding, new Map([...definitions].map(([id, d]) => [id, d.question])))
      )
      const channel = channels.get(ref.channelId)
      const bot = channel ? bots.get(channel.botId) : seed.bots[0]
      const agentId = channel?.agentId ?? bot?.defaultAgentId ?? ''
      const target = { agentId, name: bot?.agents.find((agent) => agent.id === agentId)?.name ?? agentId }
      const consumer = (
        outcome: DecisionGatePreviewResult['consumer']['outcome'],
        extra: Partial<DecisionGatePreviewResult['consumer']> = {}
      ): DecisionGatePreviewResult['consumer'] => ({
        type: 'gate',
        outcome,
        matched: false,
        matchedKeys: [],
        target,
        ...extra
      })
      if (options.scenario === 'needs_review')
        return {
          mode: 'mock',
          readiness: { status: 'needs_review' },
          evaluation: null,
          consumer: consumer('not_applied', { notAppliedReason: 'needs_review' })
        }
      if (options.scenario === 'daemon_offline') throw offline()
      let match = { matched: false, matchedKeys: [] as string[] }
      const { evaluation, trace } = await runDecisionChain<DecisionGateStep>({
        root: binding,
        steps: binding.steps,
        deadlineAt: performance.timeOrigin + performance.now() + 5000,
        evaluate: (step) => evaluateDraft(get(definitions, step.decisionId), { ...state }),
        next: (step, evaluation) => {
          const result = nextGateStep(get(definitions, step.decisionId).question, step, evaluation.answer)
          match = result
          return result.nextStepId ? [result.nextStepId] : []
        }
      })
      return copy({
        mode: 'mock',
        readiness: { status: 'ready' },
        evaluation,
        ...(binding.steps?.length ? { chain: trace } : {}),
        consumer: consumer(
          evaluation.status === 'unavailable' ? 'unavailable' : match.matched ? 'trigger' : 'skip',
          match
        )
      })
    },
    async listEvaluations(_ref, page = {}) {
      if (options.scenario === 'daemon_offline') throw offline()
      const limit = Math.min(50, Math.max(1, page.limit ?? 20))
      const after = evaluations.filter(
        (entry) =>
          (page.cursor === undefined || entry.seq < page.cursor) &&
          (page.decisionId === undefined || entry.decisionId === page.decisionId)
      )
      const items: DecisionEvaluationRecord[] = after.slice(0, limit).map((entry) => {
        const {
          snapshot: _snapshot,
          input: _input,
          fullAnswer: _fullAnswer,
          evidence: _evidence,
          rawRequest: _rawRequest,
          rawResponse: _rawResponse,
          ...summary
        } = entry
        return summary
      })
      return copy({ items, nextCursor: after.length > limit ? (items.at(-1)?.seq ?? null) : null })
    },
    async getEvaluation(_ref, seq) {
      if (options.scenario === 'daemon_offline') throw offline()
      const found = evaluations.find((entry) => entry.seq === seq)
      if (!found) throw missing()
      return copy(found)
    },
    // The live route's order: validation, Not applied without a model call, then the router's own settlement.
    async previewRouting(botId, input) {
      input = copy(input)
      const bot = get(bots, botId)
      if (!bot.shared) invalid([{ path: ['botId'], message: 'Routing requires a shared bot.' }])
      const config = parse(SharedBotDecisionRouting, input.config)
      const sample = parse(DecisionPreviewSample, input.state)
      const definition = definitions.get(config.decisionId)
      if (!definition)
        throw new DecisionMockApiError(404, {
          error: 'not_found',
          code: 'DECISION_NOT_FOUND',
          message: 'Decision not found.'
        })
      invalid(
        decisionRoutingIssues(definition.question, config, new Map([...definitions].map(([id, d]) => [id, d.question])))
      )
      const channel = get(channels, input.channelId)
      if (channel.botId !== botId || channel.kind !== 'channel')
        invalid([{ path: ['channelId'], message: 'Select a group channel of this bot.' }])
      const situation = input.targets
      const recipients = situation.type === 'new' ? [] : situation.agentIds
      const participants = situation.type === 'new' ? [] : (situation.participantAgentIds ?? [])
      if (recipients.some((id) => !bot.agents.some((agent) => agent.id === id)))
        invalid([{ path: ['targets'], message: 'Choose recipients connected to this bot.' }])
      const defaultAgentId = channel.agentId || bot.defaultAgentId
      const named = (id: string) => bot.agents.find((agent) => agent.id === id) ?? null
      const consumer: DecisionRoutingPreviewResult['consumer'] = {
        type: 'shared_bot_routing',
        outcome: 'not_applied',
        evaluated: false,
        rules: [],
        matchedRuleIds: [],
        matchedKeys: [],
        matchedAgentIds: [],
        usedOtherwise: false,
        fallback: null,
        defaultAgent: defaultAgentId ? { id: defaultAgentId, name: named(defaultAgentId)?.name ?? null } : null,
        targetConstraint: copy(situation),
        targets: []
      }
      const saved = routings.get(botId)
      const reason: DecisionRoutingNotAppliedReason | null =
        channel.settings.trigger === 'off' && !input.channelIds.includes(input.channelId)
          ? 'off'
          : !input.channelIds.includes(input.channelId)
            ? 'outside_scope'
            : !config.enabled
              ? 'paused'
              : (options.scenario === 'needs_review' || saved?.readiness.status === 'needs_review') &&
                  !!saved &&
                  JSON.stringify(SharedBotDecisionRouting.parse(saved.config)) === JSON.stringify(config)
                ? 'needs_review'
                : null
      const readiness: DecisionReadiness = { status: options.scenario === 'pending_sync' ? 'pending_sync' : 'ready' }
      if (reason)
        return copy({
          mode: 'mock' as const,
          readiness: reason === 'needs_review' ? { status: 'needs_review' as const } : readiness,
          evaluation: null,
          consumer: { ...consumer, notAppliedReason: reason }
        })
      const constraint = recipients.map((agentId) => ({
        agentId,
        daemonId: bot.daemonId,
        participant: participants.includes(agentId),
        via: situation.type === 'mention' ? ('mention' as const) : ('implicit' as const)
      }))
      const candidates = bot.agents.map((agent) => ({ agentId: agent.id, daemonId: bot.daemonId }))
      let evaluation: DecisionEvaluation | null = null
      let chain: DecisionChainTrace | undefined
      const answers = new Map<string, { question: DecisionQuestion; answer: DecisionAnswer }>()
      if (partitionRoutingConstraint(constraint).evaluate) {
        if (options.scenario === 'daemon_offline') throw offline()
        const result = await runDecisionChain<DecisionRoutingStep>({
          root: config,
          steps: config.steps,
          deadlineAt: performance.timeOrigin + performance.now() + 5000,
          evaluate: async (step) => {
            const d = get(definitions, step.decisionId)
            const status = providerReadiness(d, bot.daemonId).status
            return status === 'ready' || status === 'pending_sync'
              ? evaluateDraft(d, { ...sample })
              : { status: 'unavailable', reason: 'credentials' }
          },
          next: (step, result) => {
            const question = get(definitions, step.decisionId).question
            const id = config.steps?.find((s) => s === step)?.id
            if (id) answers.set(id, { question, answer: result.answer })
            return step.rules.flatMap((rule) =>
              rule.action.type === 'decision' && matchDecisionCondition(question, rule.when, result.answer).matched
                ? [rule.action.nextStepId]
                : []
            )
          }
        })
        evaluation = result.evaluation
        if (config.steps?.length) chain = result.trace
      }
      const settled = settleRoutingPreview({
        question: definition.question,
        routing: config,
        answer: evaluation === null ? undefined : evaluation.status === 'answered' ? evaluation.answer : 'unavailable',
        constraint,
        ...(defaultAgentId ? { defaultAgentId } : {}),
        candidates,
        chain: answers
      })
      const unavailableReason = settled.reason ?? (evaluation?.status === 'unavailable' ? evaluation.reason : undefined)
      return copy({
        mode: 'mock' as const,
        readiness,
        ...(chain ? { chain } : {}),
        evaluation: settled.reason ? { status: 'unavailable' as const, reason: settled.reason } : evaluation,
        consumer: {
          ...consumer,
          outcome: settled.outcome,
          ...(settled.outcome === 'unavailable' ? { reason: unavailableReason ?? 'provider' } : {}),
          evaluated: settled.evaluate,
          rules: settled.rules,
          matchedRuleIds: settled.match?.matchedRuleIds ?? [],
          matchedKeys: settled.match?.matchedKeys ?? [],
          matchedAgentIds: settled.match?.agentIds ?? [],
          usedOtherwise: settled.match?.usedOtherwise ?? false,
          fallback: settled.fallback ?? null,
          targets: settled.targets.map((target) => {
            const agent = named(target.agentId)
            return {
              agentId: target.agentId,
              name: agent?.name ?? null,
              effect: target.effect,
              participant: target.participant,
              via: target.via,
              status: !agent
                ? ('removed' as const)
                : agent.available
                  ? ('available' as const)
                  : ('unavailable' as const)
            }
          })
        }
      })
    },
    async listRoutingEvaluations(botId, page = {}) {
      get(bots, botId)
      if (options.scenario === 'daemon_offline') throw offline()
      const limit = Math.min(50, Math.max(1, page.limit ?? 20))
      const after = routingEvaluations.filter(
        (entry) =>
          (page.cursor === undefined || entry.seq < page.cursor) &&
          (page.decisionId === undefined || entry.decisionId === page.decisionId) &&
          (page.channelId === undefined || entry.channel === page.channelId)
      )
      const items: DecisionRoutingEvaluationRecord[] = after.slice(0, limit).map((entry) => {
        const {
          snapshot: _snapshot,
          constraint: _constraint,
          input: _input,
          fullAnswer: _fullAnswer,
          rawRequest: _rawRequest,
          rawResponse: _rawResponse,
          ...summary
        } = entry
        return summary
      })
      return copy({ items, nextCursor: after.length > limit ? (items.at(-1)?.seq ?? null) : null })
    },
    async getRoutingEvaluation(botId, ref) {
      get(bots, botId)
      if (options.scenario === 'daemon_offline') throw offline()
      const found = routingEvaluations.find((entry) => entry.seq === ref.seq && entry.channel === ref.channelId)
      if (!found) throw missing()
      return copy(found)
    }
  }
}
