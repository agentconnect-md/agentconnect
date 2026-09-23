import {
  selectDecisionTarget,
  type DecisionRuntimeTarget,
  type AgentModelSelection,
  type DecisionEvaluation,
  type DecisionGetReply
} from '@agentconnect.md/protocol'
import type { DecisionEvaluationInput } from './evaluator.js'
import type { LoadedAgent } from '../agents/load-agents.js'
import type { Agent } from '../agents/agent-schema.js'

const runtimeSources = new WeakMap<Agent, Agent>()

// Workspace authority remains the original configuration while execution uses a session-specific runtime.
export function configuredRuntimeAgent(agent: Agent): Agent {
  return runtimeSources.get(agent) ?? agent
}

export function modelSelectionConfiguration(agent: LoadedAgent | undefined): string {
  return JSON.stringify([agent?.runtime, agent?.runtimeOverrides?.model, agent?.modelSelection])
}

export function pinnedDecisionTarget(snapshot: string | null | undefined): DecisionRuntimeTarget | undefined {
  if (!snapshot) return undefined
  try {
    const saved = JSON.parse(snapshot) as { runtime?: unknown; model?: unknown }
    return typeof saved.runtime === 'string' && typeof saved.model === 'string'
      ? { runtime: saved.runtime, model: saved.model }
      : undefined
  } catch {
    return undefined
  }
}

export function pinnedDecisionModel(
  snapshot: string | null | undefined,
  runtime: string | undefined
): string | undefined {
  const saved = pinnedDecisionTarget(snapshot)
  return saved?.runtime === runtime ? saved?.model : undefined
}

export function agentWithRuntime(agent: LoadedAgent, target: DecisionRuntimeTarget | undefined): LoadedAgent {
  if (!target) return agent
  const selected = {
    ...agent,
    runtime: target.runtime,
    runtimeOverrides: { env: [], secrets: [], ...agent.runtimeOverrides, model: target.model }
  }
  runtimeSources.set(selected, configuredRuntimeAgent(agent))
  return selected
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
  supported(target: DecisionRuntimeTarget): boolean
  signal: AbortSignal
  current(): boolean
  decision(): Promise<DecisionGetReply>
  state(): Promise<Record<string, unknown> | undefined>
  evaluate(input: DecisionEvaluationInput, signal: AbortSignal): Promise<DecisionEvaluation>
  evaluationId: string
}

// Evaluate only at session start; the caller pins the chosen model or its fallback before prompting.
export async function evaluateSessionModel(
  input: SessionModelSelectionInput
): Promise<DecisionRuntimeTarget | undefined> {
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
    const target = selectDecisionTarget(decision.question, input.selection, result.answer)
    return target && input.supported(target) ? target : undefined
  } catch {
    input.signal.throwIfAborted()
    return undefined
  }
}
