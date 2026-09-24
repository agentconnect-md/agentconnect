import {
  selectDecisionTarget,
  DecisionRuntimeTarget,
  type AgentModelSelection,
  type DecisionEvaluation,
  type DecisionGetReply,
  type DecisionToolDefinition
} from '@agentconnect.md/protocol'
import { DECISION_REQUEST_MAX_BYTES, decisionRequestBody, type DecisionEvaluationInput } from './evaluator.js'
import type { PullRequestContext } from '../codehost/pull-context.js'
import { DECISION_TOKEN_BUDGET } from './state.js'
import type { LoadedAgent } from '../agents/load-agents.js'
import type { Agent } from '../agents/agent-schema.js'
import { z } from 'zod'

const runtimeSources = new WeakMap<Agent, Agent>()
const PinnedRuntimeTarget = DecisionRuntimeTarget.extend({ model: z.string().max(256) })

// Workspace authority remains the original configuration while execution uses a session-specific runtime.
export function configuredRuntimeAgent(agent: Agent): Agent {
  return runtimeSources.get(agent) ?? agent
}

export function modelSelectionConfiguration(agent: LoadedAgent | undefined): string {
  return JSON.stringify([
    agent?.runtime,
    agent?.runtimeOverrides?.model,
    agent?.reasoningEffort,
    agent?.permissionMode,
    agent?.fastMode,
    agent?.modelSelection
  ])
}

export function pinnedDecisionTarget(snapshot: string | null | undefined): DecisionRuntimeTarget | undefined {
  if (!snapshot) return undefined
  try {
    const saved = PinnedRuntimeTarget.safeParse(JSON.parse(snapshot))
    return saved.success ? saved.data : undefined
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
    ...(target.effort !== undefined ? { reasoningEffort: target.effort || undefined } : {}),
    ...(target.permissionMode !== undefined ? { permissionMode: target.permissionMode } : {}),
    ...(target.fastMode !== undefined ? { fastMode: target.fastMode } : {}),
    runtimeOverrides: { env: [], secrets: [], ...agent.runtimeOverrides, model: target.model }
  }
  runtimeSources.set(selected, configuredRuntimeAgent(agent))
  return selected
}

function textPrefix(text: string, maxBytes: number): string {
  let end = Math.min(Buffer.byteLength(text), maxBytes)
  const bytes = Buffer.from(text)
  while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--
  return bytes.subarray(0, end).toString('utf8')
}

export function modelSelectionState(source: 'chat' | 'pull_request', text: string): Record<string, unknown> {
  const content = textPrefix(text, 8 * 1024)
  return { source, currentMessage: { text: content }, history: [], truncated: content !== text }
}

// Preserve description-based instructions while adding bounded, explicitly partial code-host context.
export function pullRequestModelSelectionState(
  input: PullRequestContext,
  decision: DecisionToolDefinition
): Record<string, unknown> {
  const opening = modelSelectionState('pull_request', input.description)
  const messages = input.commitMessages.join('\n\n')
  const pullRequest = { commitMessages: textPrefix(messages, 4 * 1024), diff: input.diff }
  const reasons = [...input.reasons]
  if (opening.truncated) reasons.push('description_truncated')
  if (pullRequest.commitMessages !== messages) reasons.push('commits_truncated')
  const context = { partial: reasons.length > 0, reasons }
  const state = { ...opening, pullRequest, context }
  const maxBytes = Math.min(DECISION_REQUEST_MAX_BYTES, DECISION_TOKEN_BUDGET * 4)
  while (Buffer.byteLength(decisionRequestBody({ decision, state })) > maxBytes) {
    if (!context.reasons.includes('budget_trimmed')) context.reasons.push('budget_trimmed')
    context.partial = true
    if (pullRequest.diff) {
      pullRequest.diff = textPrefix(pullRequest.diff, Math.floor(Buffer.byteLength(pullRequest.diff) / 2))
    } else if (pullRequest.commitMessages) {
      pullRequest.commitMessages = textPrefix(
        pullRequest.commitMessages,
        Math.floor(Buffer.byteLength(pullRequest.commitMessages) / 2)
      )
    } else return opening
  }
  return state
}

export interface SessionModelSelectionInput {
  agentId: string
  selection: AgentModelSelection
  supported(target: DecisionRuntimeTarget): boolean
  signal: AbortSignal
  current(): boolean
  decision(): Promise<DecisionGetReply>
  state(decision: DecisionToolDefinition): Promise<Record<string, unknown> | undefined>
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
    const state = await input.state(decision)
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
