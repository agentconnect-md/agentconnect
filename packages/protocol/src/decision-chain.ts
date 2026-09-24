import { DECISION_CHAIN_MAX_STEPS, type DecisionChainStep, type DecisionEvaluation } from './decision.js'

export interface DecisionChainEvaluation {
  stepId: string
  decisionId: string
  evaluation: DecisionEvaluation
}

export function decisionChainUsage(trace: readonly DecisionChainEvaluation[]): {
  inputTokens: number
  outputTokens: number
} {
  return trace.reduce(
    (total, { evaluation }) =>
      evaluation.status === 'answered'
        ? {
            inputTokens: total.inputTokens + evaluation.usage.inputTokens,
            outputTokens: total.outputTokens + evaluation.usage.outputTokens
          }
        : total,
    { inputTokens: 0, outputTokens: 0 }
  )
}

// Each reached node executes once; all branches share the caller's snapshot and deadline.
export async function runDecisionChain<T extends DecisionChainStep>(input: {
  root: T
  steps?: readonly (T & { id: string })[]
  deadlineAt: number
  signal?: AbortSignal
  now?: () => number
  evaluate(step: T, index: number, signal: AbortSignal): Promise<DecisionEvaluation>
  next(step: T, evaluation: Extract<DecisionEvaluation, { status: 'answered' }>): readonly string[]
}): Promise<{ evaluation: DecisionEvaluation; trace: DecisionChainEvaluation[] }> {
  const timeout = new AbortController()
  const signal = input.signal ? AbortSignal.any([input.signal, timeout.signal]) : timeout.signal
  const remaining = input.deadlineAt - (input.now?.() ?? performance.timeOrigin + performance.now())
  const timer = setTimeout(() => timeout.abort(), Math.max(0, remaining))
  const trace: DecisionChainEvaluation[] = []
  const steps = new Map(input.steps?.map((step) => [step.id, step]))
  const pending: Array<{ id: string; step: T }> = [{ id: '', step: input.root }]
  const visited = new Set<string>()
  try {
    if (remaining <= 0) return { evaluation: { status: 'unavailable', reason: 'timeout' }, trace }
    while (pending.length) {
      signal.throwIfAborted()
      const { id, step } = pending.shift()!
      if (visited.has(id)) continue
      if (visited.size >= DECISION_CHAIN_MAX_STEPS) throw new Error('Decision chain exceeds the step limit.')
      visited.add(id)
      const evaluation = await abortableDecision(input.evaluate(step, trace.length, signal), signal)
      signal.throwIfAborted()
      trace.push({ stepId: id, decisionId: step.decisionId, evaluation })
      if (evaluation.status === 'unavailable') return { evaluation, trace }
      let nextIds: readonly string[]
      try {
        nextIds = input.next(step, evaluation)
      } catch {
        return { evaluation: { status: 'unavailable', reason: 'invalid_response' }, trace }
      }
      for (const nextId of nextIds) {
        const next = steps.get(nextId)
        if (!next) return { evaluation: { status: 'unavailable', reason: 'invalid_response' }, trace }
        pending.push({ id: nextId, step: next })
      }
    }
    return { evaluation: trace[0]!.evaluation, trace }
  } catch (error) {
    input.signal?.throwIfAborted()
    if (!signal.aborted) throw error
    return { evaluation: { status: 'unavailable', reason: 'timeout' }, trace }
  } finally {
    clearTimeout(timer)
  }
}

function abortableDecision<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
    void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}
