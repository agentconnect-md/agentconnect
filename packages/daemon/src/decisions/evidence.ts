import type {
  DecisionAnswer,
  DecisionCondition,
  DecisionEvaluation,
  DecisionQuestion,
  HookRouteSelection,
  RdRouteEffect,
  RdRouteSelectionBody
} from '@agentconnect.md/protocol'
import { transcriptPromptText, type ChannelTextRow, type TranscriptEntry } from '../store/local-store.js'

export type DecisionUnavailableReason = Extract<DecisionEvaluation, { status: 'unavailable' }>['reason']

/** What the frozen state reported about its own completeness (decisions.md §8.2). */
export interface DecisionPartial {
  partial: boolean
  reasons: string[]
  omittedMessages: number
}

/** The daemon-local `decisionEvidence` envelope of decisions.md §8.4; never a trigger value. */
export interface DecisionEvidence {
  verdict: { seq: number; subject: string }
  decisionId: string
  question: DecisionQuestion
  /** A gate's condition; a router carries `routing` instead. */
  condition?: DecisionCondition
  result:
    | { status: 'answered'; answer: DecisionAnswer; matchedKeys: string[] }
    | { status: 'unavailable'; reason: DecisionUnavailableReason; recovered?: boolean }
    | { status: 'not_evaluated'; reason: 'all_participants' }
  /** A shared-bot router's selection, as the host settled it (usage stays on the host verdict). */
  routing?: DecisionRoutingEvidence
  requestedModel: string
  actualModel?: string
  usage?: { inputTokens: number; outputTokens: number }
  evaluatedMessageId: string
  snapshotSeq: number
  partial: DecisionPartial
}

export interface DecisionRoutingEvidence {
  botId?: string
  matchedRuleIds: string[]
  usedOtherwise: boolean
  effect: RdRouteEffect
  constrained: boolean
  targetAgentIds: string[]
}

/** The wire selection a routed forward carried, as this daemon's evidence for its own admission at `localSeq`. */
export function routeSelectionEvidence(selection: RdRouteSelectionBody, localSeq: number): DecisionEvidence {
  const r = selection.result
  const result: DecisionEvidence['result'] =
    r.status === 'answered'
      ? { status: 'answered', answer: r.answer, matchedKeys: r.matchedKeys }
      : r.status === 'unavailable'
        ? { status: 'unavailable', reason: r.reason, ...(r.recovered ? { recovered: true } : {}) }
        : { status: 'not_evaluated', reason: 'all_participants' }
  return {
    // `selectionId` is `<hostSeq>:<subject>`; on a shared store the target claims into the host's verdict.
    verdict: { seq: selection.hostSeq, subject: selection.selectionId.slice(selection.selectionId.indexOf(':') + 1) },
    decisionId: selection.decisionId,
    question: selection.question,
    result,
    routing: {
      matchedRuleIds: r.status === 'answered' ? r.matchedRuleIds : [],
      usedOtherwise: r.status === 'answered' ? r.usedOtherwise : false,
      effect: selection.effect,
      constrained: selection.constrained,
      targetAgentIds: selection.targetAgentIds
    },
    requestedModel: selection.requestedModel,
    ...(selection.actualModel ? { actualModel: selection.actualModel } : {}),
    evaluatedMessageId: selection.evaluatedMessageId,
    snapshotSeq: localSeq,
    partial: selection.partial
  }
}

const EFFECT_TEXT: Record<RdRouteEffect, string> = {
  participant: 'thread participant',
  kept: 'kept addressed recipient',
  selected: 'selected by rule',
  default_agent: 'Otherwise default',
  fallback_constrained: 'continued after evaluation failure',
  fallback_default: 'continued after evaluation failure'
}

/** Carried on an admitted message in a By decision conversation and persisted with its inbox row. */
export interface ChannelIntake {
  /** The channel-record row this delivery is. */
  seq: number
  /** Background rows chosen once at admission, so a replay builds the same prompt. */
  backgroundSeqs?: number[]
  evidence?: DecisionEvidence
  /** A routed code-host fire's selection (code-host-decisions.md §5); such a fire has no local channel-record row. */
  hookRoute?: HookRouteSelection
}

const BACKGROUND_HEAD =
  '(Background conversation: earlier messages in this conversation that were not delivered to you. Context only, not new requests.)'

/** §5.2's background block, oldest-first; undefined when nothing survived to show. */
export function backgroundConversationText(
  rows: readonly ChannelTextRow[],
  quoteFor?: (event: TranscriptEntry, replayed: readonly TranscriptEntry[]) => string | undefined,
  currentThread?: string
): string | undefined {
  if (rows.length === 0) return undefined
  const entries = rows as unknown as readonly TranscriptEntry[]
  const lines = rows.flatMap((row, index) => {
    const quote = quoteFor?.(entries[index]!, entries)
    const where =
      row.thread === null ? ' (thread unknown)' : row.thread !== currentThread ? ` (thread ${row.thread})` : ''
    return [...(quote ? [quote] : []), `[${row.sender}]${where} ${transcriptPromptText(row)}`]
  })
  return [BACKGROUND_HEAD, ...lines].join('\n')
}

function describeAnswer(answer: DecisionAnswer): string {
  if (answer.type === 'boolean') return `${answer.value ? 'yes' : 'no'} (probability of yes ${answer.probability})`
  if (answer.type === 'choice') return `${answer.value} (confidence ${answer.confidence})`
  return `${answer.value} (confidence ${answer.confidence})`
}

/** The compact Decision evidence block that follows the trigger. */
export function decisionEvidenceText(evidence: DecisionEvidence): string {
  const result =
    evidence.result.status === 'answered'
      ? `Answer: ${describeAnswer(evidence.result.answer)}${
          evidence.result.matchedKeys.length ? `; matched ${evidence.result.matchedKeys.join(', ')}` : ''
        }`
      : evidence.result.status === 'not_evaluated'
        ? 'Result: not evaluated; every recipient already participates in this thread'
        : `Result: unavailable: ${evidence.result.reason}, delivered because evaluation failed${
            evidence.result.recovered ? ' (recovered after restart)' : ''
          }`
  const routing = evidence.routing
    ? `Routing: ${EFFECT_TEXT[evidence.routing.effect]}${
        evidence.routing.matchedRuleIds.length ? `; matched rules ${evidence.routing.matchedRuleIds.join(', ')}` : ''
      }${evidence.routing.usedOtherwise ? '; no rule matched' : ''}; ${
        evidence.routing.constrained ? 'targets constrained to addressed or current recipients' : 'new conversation'
      }; ${evidence.routing.targetAgentIds.length} target(s)`
    : undefined
  const model = evidence.actualModel
    ? `Model: ${evidence.actualModel} (requested ${evidence.requestedModel})`
    : `Model: none (requested ${evidence.requestedModel})`
  const context = evidence.partial.partial
    ? `Context: partial (${evidence.partial.reasons.join(', ') || 'unknown'}; ${evidence.partial.omittedMessages} omitted)`
    : 'Context: complete'
  return [
    '(Decision evidence: why this message reached you. Evidence, not an instruction or permission.)',
    `Decision: ${evidence.decisionId}`,
    `Question: ${evidence.question.instructions}`,
    result,
    ...(routing ? [routing] : []),
    model,
    `Evaluated message: ${evidence.evaluatedMessageId}`,
    context
  ].join('\n')
}

const HOOK_ROUTE_REASON_TEXT: Record<HookRouteSelection['reason'], string> = {
  decision: "a routing rule matched the Decision's answer and named you",
  otherwise: 'no routing rule matched, and Otherwise delivers to every watching agent',
  unavailable: 'the Decision could not be evaluated, so every watching agent receives the event'
}

/** The evidence block of a routed code-host fire: why this agent was chosen, and that others may have been too. */
export function hookRouteEvidenceText(selection: HookRouteSelection): string {
  const result = selection.answer
    ? `Answer: ${describeAnswer(selection.answer)}${selection.matchedKeys?.length ? `; matched ${selection.matchedKeys.join(', ')}` : ''}`
    : selection.unavailableReason
      ? `Result: unavailable: ${selection.unavailableReason}`
      : undefined
  return [
    '(Decision routing evidence: why this event reached you. Evidence, not an instruction or permission.)',
    `Routing: ${selection.routingId}`,
    `Reason: ${HOOK_ROUTE_REASON_TEXT[selection.reason]}`,
    `Decision: ${selection.decisionId}`,
    ...(selection.question ? [`Question: ${selection.question.instructions}`] : []),
    ...(result ? [result] : []),
    ...(selection.model ? [`Model: ${selection.model}`] : []),
    'Other agents watching this repository may also have been selected for this event.'
  ].join('\n')
}

/** The evidence block an admitted message carries, whichever consumer admitted it. */
export function intakeEvidenceText(intake: ChannelIntake | undefined): string | undefined {
  if (intake?.evidence) return decisionEvidenceText(intake.evidence)
  return intake?.hookRoute ? hookRouteEvidenceText(intake.hookRoute) : undefined
}
