import {
  selectDecisionModel,
  type AgentModelSelection,
  type DecisionEvaluation,
  type DecisionGetReply
} from '@agentconnect.md/protocol'
import type { DecisionEvaluationInput } from './evaluator.js'
import type { LoadedAgent } from '../agents/load-agents.js'

export function modelSelectionConfiguration(agent: LoadedAgent | undefined): string {
  return JSON.stringify([agent?.runtime, agent?.runtimeOverrides?.model, agent?.modelSelection])
}

export function pinnedDecisionModel(
  snapshot: string | null | undefined,
  runtime: string | undefined
): string | undefined {
  if (!snapshot) return undefined
  try {
    const saved = JSON.parse(snapshot) as { runtime?: unknown; model?: unknown }
    return saved.runtime === runtime && typeof saved.model === 'string' ? saved.model : undefined
  } catch {
    return undefined
  }
}

export function modelSelectionState(source: 'chat' | 'pull_request', text: string): Record<string, unknown> {
  let end = Math.min(Buffer.byteLength(text), 8 * 1024)
  const bytes = Buffer.from(text)
  while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--
  const content = bytes.subarray(0, end).toString('utf8')
  return { source, currentMessage: { text: content }, history: [], truncated: end < bytes.length }
}

export interface SessionModelSelectionInput {
  agentId: string
  selection: AgentModelSelection
  models: readonly string[]
  signal: AbortSignal
  current(): boolean
  decision(): Promise<DecisionGetReply>
  state(): Promise<Record<string, unknown> | undefined>
  evaluate(input: DecisionEvaluationInput, signal: AbortSignal): Promise<DecisionEvaluation>
  evaluationId: string
}

// Evaluate only at session start; the caller pins the chosen model or its fallback before prompting.
export async function evaluateSessionModel(input: SessionModelSelectionInput): Promise<string | undefined> {
  const current = () => {
    input.signal.throwIfAborted()
    return input.current()
  }
  if (!current()) return undefined
  try {
    const { decision } = await input.decision()
    if (!current() || !decision || decision.id !== input.selection.decisionId) return undefined
    const state = await input.state()
    if (!current() || state === undefined) return undefined
    const result = await input.evaluate(
      {
        agentId: input.agentId,
        evaluationId: input.evaluationId,
        decision,
        state
      },
      input.signal
    )
    if (!current() || result.status !== 'answered') return undefined
    const model = selectDecisionModel(decision.question, input.selection, result.answer)
    return model && input.models.includes(model) ? model : undefined
  } catch {
    input.signal.throwIfAborted()
    return undefined
  }
}
