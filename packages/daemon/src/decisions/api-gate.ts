// An API turn's Decision gate (shared-bot-relay.md §10.4): evaluated on the turn's text before admission, failing open like every chat gate (decisions.md §5).
import {
  nextGateStep,
  runDecisionChain,
  type AgentApiGateProjection,
  type DecisionChainTrace,
  type DecisionEvaluation,
  type DecisionGateStep,
  type DecisionToolDefinition
} from '@agentconnect.md/protocol'
import type { DecisionEvaluationInput } from './evaluator.js'
import type { SlotResult } from './limiter.js'
import { modelSelectionState } from './model-selection.js'

// Inside the relay's five-second acknowledgement, so a verdict always arrives before the relay retries.
export const API_GATE_DEADLINE_MS = 4_500

export type ApiGateVerdict =
  { admit: true; reason: 'matched' | 'unavailable'; detail?: string } | { admit: false; reason: 'declined' }

export interface ApiGateInput {
  agentId: string
  /** The gate and its Decisions, shipped in the agent's spec: admission reads nothing remote. */
  projection: AgentApiGateProjection
  text: string
  evaluationId: string
  now(): number
  acquire(providerId: string, deadlineAt: number, signal: AbortSignal): Promise<SlotResult>
  evaluate(input: DecisionEvaluationInput, signal: AbortSignal): Promise<DecisionEvaluation>
  /** What the gate saw and answered, reported once the verdict is settled, for Recent evaluations. */
  onEvidence?(evidence: ApiGateEvidence): void
}

export interface ApiGateEvidence {
  root: DecisionToolDefinition | null
  evaluation: DecisionEvaluation | null
  chain: DecisionChainTrace
  rawRequest: string | null
  rawResponse: string | null
  latencyMs: number
}

const unavailable = (detail: string): ApiGateVerdict => ({ admit: true, reason: 'unavailable', detail })

export async function evaluateApiGate(input: ApiGateInput): Promise<ApiGateVerdict> {
  const startedAt = input.now()
  const evidence: ApiGateEvidence = {
    root: null,
    evaluation: null,
    chain: [],
    rawRequest: null,
    rawResponse: null,
    latencyMs: 0
  }
  const abort = new AbortController()
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<ApiGateVerdict>((resolve) => {
    timer = setTimeout(() => {
      abort.abort()
      resolve(unavailable('timeout'))
    }, API_GATE_DEADLINE_MS)
  })
  try {
    return await Promise.race([evaluate(input, evidence, input.now() + API_GATE_DEADLINE_MS, abort.signal), deadline])
  } finally {
    clearTimeout(timer)
    abort.abort()
    input.onEvidence?.({ ...evidence, latencyMs: Math.max(0, Math.round(input.now() - startedAt)) })
  }
}

async function evaluate(
  input: ApiGateInput,
  evidence: ApiGateEvidence,
  deadlineAt: number,
  signal: AbortSignal
): Promise<ApiGateVerdict> {
  const { gate, definitions } = input.projection
  const byId = new Map(definitions.map((d) => [d.id, d]))
  const root = byId.get(gate.decisionId)
  evidence.root = root ?? null
  if (!root || (gate.steps ?? []).some((s) => !byId.has(s.decisionId))) return unavailable('decision_missing')
  let release: (() => void) | undefined
  try {
    const slot = await input.acquire(root.providerId, deadlineAt, signal)
    if (slot.kind !== 'acquired') return unavailable(slot.kind)
    release = slot.release
    const state = modelSelectionState('chat', input.text)
    let matched = false
    const { evaluation, trace } = await runDecisionChain<DecisionGateStep>({
      root: gate,
      steps: gate.steps,
      deadlineAt,
      now: input.now,
      signal,
      evaluate: (step, index, stepSignal) =>
        input.evaluate(
          {
            agentId: input.agentId,
            evaluationId: index === 0 ? input.evaluationId : `${input.evaluationId}:${index}`,
            decision: byId.get(step.decisionId)!,
            state,
            deadlineAt,
            onRawRequest: (text) => {
              if (index === 0) evidence.rawRequest = text
            },
            onRawResponse: (text) => {
              if (index === 0) evidence.rawResponse = text
            }
          },
          stepSignal
        ),
      next: (step, result) => {
        const next = nextGateStep(byId.get(step.decisionId)!.question, step, result.answer)
        matched = next.matched
        return next.nextStepId ? [next.nextStepId] : []
      }
    })
    evidence.evaluation = evaluation
    evidence.chain = trace
    if (evaluation.status === 'unavailable') return unavailable(evaluation.reason)
    return matched ? { admit: true, reason: 'matched' } : { admit: false, reason: 'declined' }
  } catch (err) {
    return unavailable(err instanceof Error ? err.name : 'error')
  } finally {
    release?.()
  }
}
