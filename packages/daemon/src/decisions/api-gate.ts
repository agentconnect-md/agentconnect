// An API turn's Decision gate (shared-bot-relay.md §10.4): evaluated on the turn's text before admission, failing open like every chat gate (decisions.md §5).
import {
  nextGateStep,
  runDecisionChain,
  type ChannelDecisionGate,
  type DecisionEvaluation,
  type DecisionGateStep,
  type DecisionGetReply,
  type DecisionToolDefinition
} from '@agentconnect.md/protocol'
import type { DecisionEvaluationInput } from './evaluator.js'
import type { SlotResult } from './limiter.js'
import { modelSelectionState } from './model-selection.js'

// The relay's ack budget is five seconds a try, so the gate never holds a turn much longer.
export const API_GATE_DEADLINE_MS = 5_000

export type ApiGateVerdict =
  { admit: true; reason: 'matched' | 'unavailable'; detail?: string } | { admit: false; reason: 'declined' }

export interface ApiGateInput {
  agentId: string
  gate: ChannelDecisionGate
  text: string
  evaluationId: string
  now(): number
  decision(id: string): Promise<DecisionGetReply>
  acquire(providerId: string, deadlineAt: number, signal: AbortSignal): Promise<SlotResult>
  evaluate(input: DecisionEvaluationInput, signal: AbortSignal): Promise<DecisionEvaluation>
}

const unavailable = (detail: string): ApiGateVerdict => ({ admit: true, reason: 'unavailable', detail })

export async function evaluateApiGate(input: ApiGateInput): Promise<ApiGateVerdict> {
  const deadlineAt = input.now() + API_GATE_DEADLINE_MS
  const timeout = AbortSignal.timeout(API_GATE_DEADLINE_MS)
  let release: (() => void) | undefined
  try {
    const definitions = new Map<string, DecisionToolDefinition>()
    for (const id of new Set([input.gate.decisionId, ...(input.gate.steps ?? []).map((s) => s.decisionId)])) {
      const { decision } = await input.decision(id)
      if (decision?.id !== id) return unavailable('decision_missing')
      definitions.set(id, decision)
    }
    const root = definitions.get(input.gate.decisionId)!
    const slot = await input.acquire(root.providerId, deadlineAt, timeout)
    if (slot.kind !== 'acquired') return unavailable(slot.kind)
    release = slot.release
    const state = modelSelectionState('chat', input.text)
    let matched = false
    const { evaluation } = await runDecisionChain<DecisionGateStep>({
      root: input.gate,
      steps: input.gate.steps,
      deadlineAt,
      now: input.now,
      signal: timeout,
      evaluate: (step, index, signal) =>
        input.evaluate(
          {
            agentId: input.agentId,
            evaluationId: index === 0 ? input.evaluationId : `${input.evaluationId}:${index}`,
            decision: definitions.get(step.decisionId)!,
            state,
            deadlineAt
          },
          signal
        ),
      next: (step, result) => {
        const next = nextGateStep(definitions.get(step.decisionId)!.question, step, result.answer)
        matched = next.matched
        return next.nextStepId ? [next.nextStepId] : []
      }
    })
    if (evaluation.status === 'unavailable') return unavailable(evaluation.reason)
    return matched ? { admit: true, reason: 'matched' } : { admit: false, reason: 'declined' }
  } catch (err) {
    return unavailable(err instanceof Error ? err.name : 'error')
  } finally {
    release?.()
  }
}
