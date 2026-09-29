// Gate Try's shared run (decisions.md §9.3): one snapshot through the draft chain on one daemon, fenced before each step.
import { randomUUID } from 'node:crypto'
import {
  nextGateStep,
  runDecisionChain,
  type ChannelDecisionGate,
  type DecisionChainTrace,
  type DecisionDefinition,
  type DecisionEvaluation,
  type DecisionGateStep,
  DecisionPreviewRequest
} from '@agentconnect.md/protocol'
import { gatePreviewOutcome } from '../domain/decision-gate-preview.js'
import type { HttpDeps } from './deps.js'

export interface GatePreviewRun {
  evaluation: DecisionEvaluation
  chain?: DecisionChainTrace
  outcome: 'trigger' | 'skip' | 'unavailable'
  matched: boolean
  matchedKeys: string[]
}

/** Throws when the daemon cannot be reached; a provider failure is an `unavailable` outcome, never a skip. */
export async function runGatePreview(
  deps: Pick<HttpDeps, 'control'>,
  input: {
    orgId: string
    daemonId: string
    gate: ChannelDecisionGate
    definitions: ReadonlyMap<string, DecisionDefinition>
    request: DecisionPreviewRequest
    authorized(): Promise<boolean>
  }
): Promise<GatePreviewRun> {
  const { gate, definitions } = input
  let matched = false
  let matchedKeys: string[] = []
  const deadlineAt = performance.timeOrigin + performance.now() + 5000
  const result = await runDecisionChain<DecisionGateStep>({
    root: gate,
    steps: gate.steps,
    deadlineAt,
    evaluate: async (step) => {
      if (!(await input.authorized())) return { status: 'unavailable', reason: 'credentials' }
      const d = definitions.get(step.decisionId)!
      const request = DecisionPreviewRequest.safeParse({
        ...input.request,
        evaluationId: randomUUID(),
        decision: { name: d.name, providerId: d.providerId, model: d.model, question: d.question },
        ...(gate.steps?.length
          ? { budgetMs: Math.max(1, Math.floor(deadlineAt - (performance.timeOrigin + performance.now()))) }
          : {})
      })
      return request.success
        ? (await deps.control.decisionPreview(input.daemonId, input.orgId, request.data)).evaluation
        : { status: 'unavailable', reason: 'unsupported_input' }
    },
    next: (step, evaluation) => {
      const next = nextGateStep(definitions.get(step.decisionId)!.question, step, evaluation.answer)
      matched = next.matched
      matchedKeys = next.matchedKeys
      return next.nextStepId ? [next.nextStepId] : []
    }
  })
  const chain = gate.steps?.length ? { chain: result.trace } : {}
  if (result.evaluation.status === 'unavailable')
    return { ...gatePreviewOutcome(definitions.get(gate.decisionId)!.question, gate.when, result.evaluation), ...chain }
  return { evaluation: result.evaluation, outcome: matched ? 'trigger' : 'skip', matched, matchedKeys, ...chain }
}
