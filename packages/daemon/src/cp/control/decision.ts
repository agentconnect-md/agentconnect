import {
  DecisionEvaluationRequest,
  DecisionEvaluationsRequest,
  DecisionPreviewRequest,
  DecisionRoutingEvaluationRequest,
  DecisionRoutingEvaluationsRequest
} from '@agentconnect.md/protocol'
import { DecisionEvaluationScopeError, type DecisionEvaluationReader } from '../../decisions/evaluations.js'
import type { DecisionEvaluator } from '../../decisions/evaluator.js'
import type { ControlHandler } from './context.js'

export interface DecisionControlDeps {
  decisionEvaluator?: Pick<DecisionEvaluator, 'catalog' | 'evaluate'>
  decisionEvaluations?: Pick<DecisionEvaluationReader, 'list' | 'get' | 'listRouting' | 'getRouting'>
}

export const decisionCatalog: ControlHandler<DecisionControlDeps> = (frame, deps, wire) => {
  if (!deps.decisionEvaluator) {
    wire.sendError(frame.id, 'BAD_PAYLOAD', 'Decision preview is unavailable', false)
    return
  }
  wire.reply(frame, 'decision/catalog/result', deps.decisionEvaluator.catalog())
}

export const decisionPreview: ControlHandler<DecisionControlDeps> = async (frame, deps, wire) => {
  if (!deps.decisionEvaluator) {
    wire.sendError(frame.id, 'BAD_PAYLOAD', 'Decision preview is unavailable', false)
    return
  }
  try {
    const input = DecisionPreviewRequest.parse(frame.payload)
    const evaluation = await deps.decisionEvaluator.evaluate({
      ...input,
      ...(input.budgetMs ? { deadlineAt: performance.timeOrigin + performance.now() + input.budgetMs } : {})
    })
    wire.reply(frame, 'decision/preview/result', { evaluation })
  } catch {
    wire.sendError(frame.id, 'INTERNAL', 'Decision preview could not complete', true)
  }
}

// Recent evaluations: the org and the served lane are checked here; failures never echo verdict content.
async function readEvaluations<T>(
  frame: Parameters<ControlHandler<DecisionControlDeps>>[0],
  wire: Parameters<ControlHandler<DecisionControlDeps>>[2],
  parse: () => T,
  read: (orgId: string, req: T) => Promise<unknown>,
  replyType: string
): Promise<void> {
  let req: T
  try {
    req = parse()
  } catch {
    wire.sendError(frame.id, 'BAD_PAYLOAD', 'Invalid decision evaluation request', false)
    return
  }
  if (!frame.orgId) {
    wire.sendError(frame.id, 'BAD_PAYLOAD', 'Decision evaluation reads require an organization', false)
    return
  }
  try {
    wire.reply(frame, replyType, await read(frame.orgId, req))
  } catch (err) {
    if (err instanceof DecisionEvaluationScopeError) {
      wire.sendError(frame.id, 'SCOPE_DENIED', err.message, false)
      return
    }
    wire.log.warn(`cp: ${frame.type} failed (${(err as Error).name})`)
    wire.sendError(frame.id, 'INTERNAL', 'Decision evaluations could not be read', true)
  }
}

export const decisionEvaluations: ControlHandler<DecisionControlDeps> = async (frame, deps, wire) => {
  const reader = deps.decisionEvaluations
  if (!reader) {
    wire.sendError(frame.id, 'BAD_PAYLOAD', 'Decision evaluations are unavailable', false)
    return
  }
  await readEvaluations(
    frame,
    wire,
    () => DecisionEvaluationsRequest.parse(frame.payload),
    (orgId, req) => reader.list(orgId, req),
    'decision/evaluations/page'
  )
}

export const decisionEvaluation: ControlHandler<DecisionControlDeps> = async (frame, deps, wire) => {
  const reader = deps.decisionEvaluations
  if (!reader) {
    wire.sendError(frame.id, 'BAD_PAYLOAD', 'Decision evaluations are unavailable', false)
    return
  }
  await readEvaluations(
    frame,
    wire,
    () => DecisionEvaluationRequest.parse(frame.payload),
    (orgId, req) => reader.get(orgId, req),
    'decision/evaluation/result'
  )
}

export const decisionRoutingEvaluations: ControlHandler<DecisionControlDeps> = async (frame, deps, wire) => {
  const reader = deps.decisionEvaluations
  if (!reader) {
    wire.sendError(frame.id, 'BAD_PAYLOAD', 'Decision evaluations are unavailable', false)
    return
  }
  await readEvaluations(
    frame,
    wire,
    () => DecisionRoutingEvaluationsRequest.parse(frame.payload),
    (orgId, req) => reader.listRouting(orgId, req),
    'decision/routing-evaluations/page'
  )
}

export const decisionRoutingEvaluation: ControlHandler<DecisionControlDeps> = async (frame, deps, wire) => {
  const reader = deps.decisionEvaluations
  if (!reader) {
    wire.sendError(frame.id, 'BAD_PAYLOAD', 'Decision evaluations are unavailable', false)
    return
  }
  await readEvaluations(
    frame,
    wire,
    () => DecisionRoutingEvaluationRequest.parse(frame.payload),
    (orgId, req) => reader.getRouting(orgId, req),
    'decision/routing-evaluation/result'
  )
}
