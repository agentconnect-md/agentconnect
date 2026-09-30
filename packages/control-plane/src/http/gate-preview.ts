// Try's shared run (decisions.md §9.3): one snapshot through the draft chain on one daemon, fenced before each step.
import { randomUUID } from 'node:crypto'
import {
  DECISION_PREVIEW_RAW_V1_FEATURE,
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
import type { PreviewRun, PreviewStepRaw } from '../domain/decision-preview-detail.js'
import type { HttpDeps } from './deps.js'

/** Whether the daemon hands back a preview's provider bodies, so the request may ask for them. */
export const previewsRaw = (deps: Pick<HttpDeps, 'daemonConns'>, daemonId: string): boolean =>
  deps.daemonConns.get(daemonId)?.capabilities?.features.includes(DECISION_PREVIEW_RAW_V1_FEATURE) === true

/** One chain step on the daemon, keeping its provider bodies at `index` for the run's detail. */
export async function previewStep(
  deps: Pick<HttpDeps, 'control'>,
  input: { orgId: string; daemonId: string; request: unknown; raws: Array<PreviewStepRaw | undefined>; index: number }
): Promise<DecisionEvaluation> {
  const request = DecisionPreviewRequest.safeParse(input.request)
  if (!request.success) return { status: 'unavailable', reason: 'unsupported_input' }
  const reply = await deps.control.decisionPreview(input.daemonId, input.orgId, request.data)
  if (reply.rawRequest !== undefined || reply.rawResponse !== undefined)
    input.raws[input.index] = { rawRequest: reply.rawRequest ?? null, rawResponse: reply.rawResponse ?? null }
  return reply.evaluation
}

export interface GatePreviewRun {
  evaluation: DecisionEvaluation
  chain?: DecisionChainTrace
  outcome: 'trigger' | 'skip' | 'unavailable'
  matched: boolean
  matchedKeys: string[]
  run: PreviewRun
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
  const raws: Array<PreviewStepRaw | undefined> = []
  const at = new Date()
  const startedAt = performance.now()
  const deadlineAt = performance.timeOrigin + startedAt + 5000
  const result = await runDecisionChain<DecisionGateStep>({
    root: gate,
    steps: gate.steps,
    deadlineAt,
    evaluate: async (step, index) => {
      if (!(await input.authorized())) return { status: 'unavailable', reason: 'credentials' }
      const d = definitions.get(step.decisionId)!
      return previewStep(deps, {
        orgId: input.orgId,
        daemonId: input.daemonId,
        raws,
        index,
        request: {
          ...input.request,
          evaluationId: randomUUID(),
          decision: { name: d.name, providerId: d.providerId, model: d.model, question: d.question },
          ...(gate.steps?.length
            ? { budgetMs: Math.max(1, Math.floor(deadlineAt - (performance.timeOrigin + performance.now()))) }
            : {})
        }
      })
    },
    next: (step, evaluation) => {
      const next = nextGateStep(definitions.get(step.decisionId)!.question, step, evaluation.answer)
      matched = next.matched
      matchedKeys = next.matchedKeys
      return next.nextStepId ? [next.nextStepId] : []
    }
  })
  const run: PreviewRun = {
    evaluation: result.evaluation,
    trace: result.trace,
    raws,
    latencyMs: performance.now() - startedAt,
    at
  }
  const chain = gate.steps?.length ? { chain: result.trace } : {}
  if (result.evaluation.status === 'unavailable')
    return {
      ...gatePreviewOutcome(definitions.get(gate.decisionId)!.question, gate.when, result.evaluation),
      ...chain,
      run
    }
  return { evaluation: result.evaluation, outcome: matched ? 'trigger' : 'skip', matched, matchedKeys, ...chain, run }
}
