import {
  ChannelDecisionGate,
  DecisionChannelSettings,
  DecisionDraft,
  DecisionEvaluation,
  DecisionPreviewSample,
  SharedBotDecisionRouting,
  decisionConditionIssues,
  decisionConditionNeedsReview,
  decisionRoutingIssues,
  matchDecisionCondition,
  matchDecisionRouting,
  parseDecisionAnswer,
  type DecisionDefinition,
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
        settings.decisionBinding.decisionId === id
      )
        result.push({ kind: 'gate', id: channel.id, label: channel.name })
    }
    for (const routing of routings.values()) {
      if (routing.config.decisionId === id)
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
    const issues = decisionRoutingIssues(draft.question, config)
    if (!bot.shared) issues.push({ path: ['botId'], message: 'Routing requires a shared bot.' })
    config.rules.forEach((rule, index) => {
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
    return copy({
      botId,
      config: saved?.config ?? null,
      channelIds: [...channels.values()]
        .filter(
          (channel) =>
            channel.botId === botId &&
            channel.settings.trigger === 'decision' &&
            channel.settings.decisionBinding.type === 'shared_bot_routing'
        )
        .map((channel) => channel.id),
      readiness
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
          settings.decisionBinding.decisionId === id &&
          decisionConditionNeedsReview(previous.question, draft.question, settings.decisionBinding.when)
        )
          channel.readiness = { status: 'needs_review' }
      }
      for (const saved of routings.values()) {
        if (
          saved.config.decisionId === id &&
          (decisionRoutingIssues(draft.question, saved.config).length ||
            saved.config.rules.some((rule) =>
              decisionConditionNeedsReview(previous.question, draft.question, rule.when)
            ))
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
        invalid(decisionConditionIssues(definition.question, binding.when))
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
        if (channel.settings.trigger === 'off') conflict('Enable the channel before adding it to routing.')
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
          channel?.settings.trigger === 'off'
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
      invalid(decisionConditionIssues(definition.question, binding.when))
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
      const evaluation = await evaluateDraft(definition, { ...state })
      if (evaluation.status !== 'answered')
        return copy({ mode: 'mock', readiness: { status: 'ready' }, evaluation, consumer: consumer('unavailable') })
      try {
        const match = matchDecisionCondition(definition.question, binding.when, evaluation.answer)
        return copy({
          mode: 'mock',
          readiness: { status: 'ready' },
          evaluation,
          consumer: consumer(match.matched ? 'trigger' : 'skip', {
            matched: match.matched,
            matchedKeys: match.matchedKeys
          })
        })
      } catch {
        return {
          mode: 'mock',
          readiness: { status: 'ready' },
          evaluation: { status: 'unavailable', reason: 'invalid_response' },
          consumer: consumer('unavailable')
        }
      }
    },
    async listEvaluations(_ref, page = {}) {
      if (options.scenario === 'daemon_offline') throw offline()
      const limit = Math.min(50, Math.max(1, page.limit ?? 20))
      const after = evaluations.filter((entry) => page.cursor === undefined || entry.seq < page.cursor)
      const items: DecisionEvaluationRecord[] = after.slice(0, limit).map((entry) => {
        const { snapshot: _snapshot, input: _input, fullAnswer: _fullAnswer, evidence: _evidence, ...summary } = entry
        return summary
      })
      return copy({ items, nextCursor: after.length > limit ? (items.at(-1)?.seq ?? null) : null })
    },
    async getEvaluation(_ref, seq) {
      if (options.scenario === 'daemon_offline') throw offline()
      const found = evaluations.find((entry) => entry.seq === seq)
      if (!found) throw missing()
      return copy(found)
    }
  }
}
