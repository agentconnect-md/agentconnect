// A Try run in the shape its lane's Recent evaluations detail reads (decisions.md §9.3, §9.5), from the exact state sent.
import {
  chainStepDetails,
  decisionAnswerSummary,
  decisionChainUsage,
  routingEvaluationOutcome,
  DecisionEvaluationAgent,
  DecisionEvaluationEntry,
  type ChannelDecisionGate,
  type DecisionChainTrace,
  type DecisionDefinition,
  type DecisionEvaluation,
  type DecisionEvaluationInput,
  type DecisionEvaluationRecordDetail,
  type DecisionRawJson,
  type DecisionRoutingEvaluationRecordDetail,
  type RoutingTargetDisposition,
  type SharedBotDecisionRouting
} from '@agentconnect.md/protocol'
import { PREVIEW_SENDER } from './decision-gate-preview.js'

export type PreviewStepRaw = { rawRequest?: DecisionRawJson | null; rawResponse?: DecisionRawJson | null }

/** What one run measured: the chain it reached, each step's provider bodies, and its wall time. */
export interface PreviewRun {
  evaluation: DecisionEvaluation
  trace: DecisionChainTrace
  raws: ReadonlyArray<PreviewStepRaw | undefined>
  latencyMs: number
  at: Date
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

const entryOf = (value: unknown) => {
  const parsed = DecisionEvaluationEntry.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

/** The state's input as the daemon reads a verdict's back; an API call's bare text gets the preview sender. */
export function previewInput(state: Record<string, unknown>): DecisionEvaluationInput {
  const current = record(state.currentMessage)
  const currentMessage = entryOf(current) ?? {
    id: 'preview-1',
    sender: { id: PREVIEW_SENDER },
    text: typeof current?.text === 'string' ? current.text : '',
    threadId: null,
    ...(state.truncated === true ? { truncated: true as const } : {})
  }
  const history = (Array.isArray(state.history) ? state.history : []).flatMap((entry) => entryOf(entry) ?? [])
  const context = record(state.context)
  const agent = DecisionEvaluationAgent.safeParse(state.agent)
  return {
    ...(agent.success ? { agent: agent.data } : {}),
    currentMessage,
    history: history.slice(-100),
    historyOmitted: Math.max(0, history.length - 100),
    context: {
      partial: context?.partial === true,
      reasons: (Array.isArray(context?.reasons) ? context.reasons : [])
        .filter((reason): reason is string => typeof reason === 'string' && reason.length <= 64)
        .slice(0, 8),
      omittedMessages: typeof context?.omittedMessages === 'number' ? context.omittedMessages : 0
    }
  }
}

/** The one-line title a Recent evaluations row gives the judged message. */
export const previewTitle = (text: string): string | null =>
  text
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean)
    ?.slice(0, 256) ?? null

function common(run: PreviewRun, root: DecisionDefinition, state: Record<string, unknown>) {
  const input = previewInput(state)
  const answered = run.evaluation.status === 'answered' ? run.evaluation : null
  return {
    seq: 0,
    at: run.at.toISOString(),
    messageId: null,
    title: previewTitle(input.currentMessage.text),
    decisionId: root.id,
    answer: answered ? decisionAnswerSummary(answered.answer) : null,
    latencyMs: Math.max(0, Math.round(run.latencyMs)),
    requestedModel: root.model,
    actualModel: answered ? answered.model.slice(0, 256) : null,
    usage: run.trace.length ? decisionChainUsage(run.trace) : answered ? answered.usage : null,
    detailsExpired: false,
    input,
    fullAnswer: answered ? answered.answer : null,
    rawRequest: run.raws[0]?.rawRequest ?? null,
    rawResponse: run.raws[0]?.rawResponse ?? null
  }
}

function chainOf(
  run: PreviewRun,
  definitions: ReadonlyMap<string, DecisionDefinition>,
  condition?: (stepId: string) => unknown
): Pick<DecisionEvaluationRecordDetail, 'chain' | 'steps'> {
  if (run.trace.length < 2) return {}
  const steps = chainStepDetails({
    trace: run.trace,
    definition: (id) => definitions.get(id),
    ...(condition ? { condition } : {}),
    raw: (index) => ({
      rawRequest: run.raws[index]?.rawRequest ?? null,
      rawResponse: run.raws[index]?.rawResponse ?? null
    })
  })
  return { chain: run.trace, ...(steps ? { steps } : {}) }
}

/** A gate Try, conversation or API, as the gate's Recent evaluations detail. */
export function gatePreviewDetail(input: {
  gate: ChannelDecisionGate
  definitions: ReadonlyMap<string, DecisionDefinition>
  state: Record<string, unknown>
  run: PreviewRun
  outcome: 'trigger' | 'skip' | 'unavailable'
  matchedKeys: string[]
  sessionMode: string
}): DecisionEvaluationRecordDetail {
  const root = input.definitions.get(input.gate.decisionId)!
  const { evaluation } = input.run
  return {
    ...common(input.run, root, input.state),
    outcome: input.outcome === 'trigger' ? 'triggered' : input.outcome === 'skip' ? 'skipped' : 'unavailable',
    reason: evaluation.status === 'unavailable' ? evaluation.reason : null,
    matchedKeys: input.matchedKeys.slice(0, 32),
    snapshot: {
      decisionId: root.id,
      providerId: root.providerId,
      model: root.model,
      question: root.question,
      condition: input.gate.when,
      sessionMode: input.sessionMode
    },
    ...chainOf(input.run, input.definitions, (stepId) =>
      stepId ? input.gate.steps?.find((step) => step.id === stepId)?.when : input.gate.when
    ),
    evidence: null
  }
}

/** A code-host routing Try as its Recent evaluations detail: a gate-shaped row with no gate snapshot. */
export function codeHostPreviewDetail(input: {
  config: SharedBotDecisionRouting
  definitions: ReadonlyMap<string, DecisionDefinition>
  state: Record<string, unknown>
  run: PreviewRun
  outcome: 'activate' | 'skip' | 'unavailable'
  reason?: string
  matchedKeys: string[]
}): DecisionEvaluationRecordDetail {
  const root = input.definitions.get(input.config.decisionId)!
  return {
    ...common(input.run, root, input.state),
    outcome: input.outcome === 'activate' ? 'triggered' : input.outcome === 'skip' ? 'skipped' : 'unavailable',
    reason: input.reason?.slice(0, 128) ?? null,
    matchedKeys: input.matchedKeys.slice(0, 32),
    snapshot: null,
    ...chainOf(input.run, input.definitions),
    evidence: null
  }
}

/** A shared-bot routing Try as its Recent evaluations detail; a target would be admitted unless unavailable. */
export function routingPreviewDetail(input: {
  config: SharedBotDecisionRouting
  definitions: ReadonlyMap<string, DecisionDefinition>
  state: Record<string, unknown>
  run: PreviewRun
  channelId: string
  defaultAgentId: string | null
  constraint: Array<{ agentId: string; participant: boolean; via: 'mention' | 'implicit' }>
  consumer: {
    outcome: 'activate' | 'continue' | 'skip' | 'unavailable'
    reason?: string
    evaluated: boolean
    matchedKeys: string[]
    matchedRuleIds: string[]
    usedOtherwise: boolean
    fallback: 'constrained' | 'default' | 'none' | null
    targets: Array<{
      agentId: string
      effect: DecisionRoutingEvaluationRecordDetail['targets'][number]['effect']
      via: 'mention' | 'implicit'
      participant: boolean
      status: 'available' | 'unavailable' | 'removed'
    }>
  }
}): DecisionRoutingEvaluationRecordDetail {
  const root = input.definitions.get(input.config.decisionId)!
  const { consumer } = input
  const targets = consumer.targets.map((target) => {
    const disposition: RoutingTargetDisposition =
      target.status === 'available' ? 'admitted' : target.status === 'removed' ? 'rejected' : 'unavailable'
    return {
      agentId: target.agentId,
      effect: target.effect,
      via: target.via,
      participant: target.participant,
      disposition,
      reason: target.status === 'available' ? null : target.status
    }
  })
  const base = common(input.run, root, input.state)
  return {
    ...base,
    channel: input.channelId.slice(0, 512),
    outcome: routingEvaluationOutcome({
      state: 'admitted',
      disposition: consumer.outcome === 'skip' ? 'skip' : consumer.outcome === 'unavailable' ? 'unavailable' : 'match',
      targets
    }),
    reason: consumer.reason?.slice(0, 128) ?? null,
    evaluated: consumer.evaluated,
    ...(consumer.evaluated ? {} : { answer: null, fullAnswer: null, actualModel: null, usage: null }),
    matchedKeys: consumer.matchedKeys.slice(0, 32),
    matchedRuleIds: consumer.matchedRuleIds.slice(0, 32),
    usedOtherwise: consumer.usedOtherwise,
    fallback: consumer.fallback,
    targets,
    snapshot: {
      decisionId: root.id,
      providerId: root.providerId,
      model: root.model,
      question: root.question,
      routing: input.config,
      defaultAgentId: input.defaultAgentId
    },
    constraint: input.constraint,
    ...chainOf(input.run, input.definitions)
  }
}
