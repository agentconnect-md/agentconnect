import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  DecisionListRequest,
  type DecisionListReply,
  type DecisionGetRequest,
  type DecisionGetReply,
  type DecisionEvaluation
} from '@agentconnect.md/protocol'
import type { DecisionEvaluationInput } from '../../decisions/evaluator.js'
import type { SessionContext } from './context.js'
import { parseArgs } from './args.js'

export const LIST_DECISIONS_ARGS = DecisionListRequest.omit({ requesterAgentId: true })
export const EVALUATE_DECISION_ARGS = z
  .strictObject({ decisionId: z.string().uuid(), state: z.record(z.string(), z.unknown()) })
  .refine((input) => Buffer.byteLength(JSON.stringify(input), 'utf8') <= 32 * 1024, {
    message: 'Decision arguments must fit within 32 KiB.'
  })

export interface DecisionDeps {
  decisions?: {
    list(request: DecisionListRequest): Promise<DecisionListReply>
    get(request: DecisionGetRequest): Promise<DecisionGetReply>
    evaluate(input: DecisionEvaluationInput, signal: AbortSignal): Promise<DecisionEvaluation>
    turn(ctx: SessionContext, decisionId?: string): { signal: AbortSignal; assertCurrent(): void }
  }
}

export async function listDecisions(
  ctx: SessionContext,
  args: Record<string, unknown>,
  deps: DecisionDeps
): Promise<DecisionListReply> {
  const input = parseArgs(LIST_DECISIONS_ARGS, args)
  if (!deps.decisions) throw new Error('Decisions are not available in this session')
  const turn = deps.decisions.turn(ctx)
  turn.assertCurrent()
  const result = await deps.decisions.list({ ...input, requesterAgentId: ctx.agentId })
  turn.assertCurrent()
  return result
}

export async function evaluateDecision(
  ctx: SessionContext,
  args: Record<string, unknown>,
  deps: DecisionDeps
): Promise<{ decisionId: string; evaluation: DecisionEvaluation }> {
  const { decisionId, state } = parseArgs(EVALUATE_DECISION_ARGS, args)
  if (!deps.decisions) throw new Error('Decisions are not available in this session')
  const turn = deps.decisions.turn(ctx, decisionId)
  turn.assertCurrent()
  const { decision } = await deps.decisions.get({ requesterAgentId: ctx.agentId, decisionId })
  turn.assertCurrent()
  if (!decision) throw new Error('Decision not found or unavailable to this agent')
  const evaluation = await deps.decisions.evaluate(
    { agentId: ctx.agentId, evaluationId: randomUUID(), decision, state },
    turn.signal
  )
  turn.assertCurrent()
  return { decisionId, evaluation }
}
