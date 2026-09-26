import {
  selectDecisionTarget,
  DecisionRuntimeTarget,
  AgentModelSelection,
  runDecisionChain,
  type DecisionModelStep,
  type DecisionEvaluation,
  type DecisionGetReply,
  type DecisionToolDefinition,
  type DecisionChainTrace,
  type DecisionQuestion
} from '@agentconnect.md/protocol'
import type { DecisionEvaluationInput } from './evaluator.js'
import { decisionTextPrefix, largestDecisionRequest } from './state.js'
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

export function modelSelectionState(source: 'chat', text: string): Record<string, unknown> {
  const content = decisionTextPrefix(text, 8 * 1024)
  return { source, currentMessage: { text: content }, history: [], truncated: content !== text }
}

export interface SessionModelSelectionInput {
  agentId: string
  selection: AgentModelSelection
  supported(target: DecisionRuntimeTarget): boolean | Promise<boolean>
  signal: AbortSignal
  current(): boolean
  decision(id: string): Promise<DecisionGetReply>
  state(decision: DecisionToolDefinition): Promise<Record<string, unknown> | undefined>
  evaluate(input: DecisionEvaluationInput, signal: AbortSignal): Promise<DecisionEvaluation>
  evaluationId: string
  onResult?: (result: SessionModelEvaluationEvidence) => void
}

export interface SessionModelEvaluationEvidence {
  selection: AgentModelSelection
  question: DecisionQuestion | null
  requestedModel: string | null
  input: Record<string, unknown> | null
  evaluation: DecisionEvaluation | null
  chain: DecisionChainTrace
  rawRequest: string | null
  rawResponse: string | null
  latencyMs: number
}

// Definition and snapshot reads share the chain deadline even when their transport cannot cancel.
function beforeAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
    void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

// Evaluate only at session start; the caller pins the chosen model or its fallback before prompting.
export async function evaluateSessionModel(
  input: SessionModelSelectionInput
): Promise<DecisionRuntimeTarget | undefined> {
  const deadlineAt = performance.timeOrigin + performance.now() + 5_000
  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(), 5_000)
  const signal = AbortSignal.any([input.signal, timeout.signal])
  const current = () => {
    signal.throwIfAborted()
    return input.current()
  }
  const startedAt = performance.now()
  let question: DecisionQuestion | null = null
  let requestedModel: string | null = null
  let state: Record<string, unknown> | null = null
  let evaluation: DecisionEvaluation | null = null
  let chain: DecisionChainTrace = []
  let rawRequest: string | null = null
  let rawResponse: string | null = null
  try {
    if (!current()) return undefined
    const selection = AgentModelSelection.parse(input.selection)
    const { decision } = await beforeAbort(input.decision(selection.decisionId), signal)
    if (!current() || !decision || decision.id !== selection.decisionId) return undefined
    question = decision.question
    requestedModel = decision.model
    const definitions = new Map([[decision.id, decision]])
    const ids = new Set(selection.steps?.map((step) => step.decisionId))
    ids.delete(decision.id)
    for (const id of ids) {
      const definition = (await beforeAbort(input.decision(id), signal)).decision
      if (!current()) return undefined
      if (definition?.id === id) definitions.set(id, definition)
    }
    state =
      (await beforeAbort(input.state(largestDecisionRequest([decision, ...definitions.values()])), signal)) ?? null
    if (!current() || state === null) return undefined
    const snapshot = state
    let selected: DecisionRuntimeTarget | undefined
    const result = await runDecisionChain<DecisionModelStep>({
      root: selection,
      steps: selection.steps,
      deadlineAt,
      signal,
      evaluate: async (step, index, signal) => {
        const definition = definitions.get(step.decisionId)
        signal.throwIfAborted()
        if (!current() || definition?.id !== step.decisionId)
          return { status: 'unavailable', reason: 'invalid_response' }
        definitions.set(definition.id, definition)
        return input.evaluate(
          {
            agentId: input.agentId,
            evaluationId: index === 0 ? input.evaluationId : `${input.evaluationId.slice(0, 120)}:${index}`,
            decision: definition,
            state: snapshot,
            deadlineAt,
            onRawRequest: (text) => {
              if (index === 0) rawRequest = text
            },
            onRawResponse: (text) => {
              if (index === 0) rawResponse = text
            }
          },
          signal
        )
      },
      next: (step, result) => {
        if (!current()) throw new Error('Model selection changed.')
        const target = selectDecisionTarget(definitions.get(step.decisionId)!.question, step, result.answer)
        if (target && 'nextStepId' in target) return [target.nextStepId]
        selected = target
        return []
      }
    })
    evaluation = result.evaluation
    chain = result.trace
    if (
      !current() ||
      result.evaluation.status !== 'answered' ||
      !selected ||
      !(await beforeAbort(Promise.resolve(input.supported(selected)), signal))
    )
      return undefined
    return current() ? selected : undefined
  } catch {
    input.signal.throwIfAborted()
    return undefined
  } finally {
    input.onResult?.({
      selection: input.selection,
      question,
      requestedModel,
      input: state,
      evaluation,
      chain,
      rawRequest,
      rawResponse,
      latencyMs: Math.max(0, Math.round(performance.now() - startedAt))
    })
    clearTimeout(timer)
  }
}
