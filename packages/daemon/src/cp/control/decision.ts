import {
  DECISION_RAW_JSON_MAX_CHARS,
  DecisionEvaluationRequest,
  DecisionEvaluationsRequest,
  DecisionPreviewRequest,
  DecisionRoutingEvaluationRequest,
  DecisionRoutingEvaluationsRequest,
  DecisionModelEvaluationsRequest,
  DecisionModelEvaluationRequest,
  ApiGateEvaluationsRequest,
  ApiGateEvaluationRequest
} from '@agentconnect.md/protocol'
import { DecisionEvaluationScopeError, type DecisionEvaluationReader } from '../../decisions/evaluations.js'
import type { DecisionModelEvaluationReader } from '../../decisions/model-evaluations.js'
import type { DecisionApiGateEvaluationReader } from '../../decisions/api-gate-evaluations.js'
import type { DecisionEvaluator } from '../../decisions/evaluator.js'
import type { ControlHandler } from './context.js'

export interface DecisionControlDeps {
  decisionEvaluator?: Pick<DecisionEvaluator, 'catalog' | 'evaluate'>
  decisionEvaluations?: Pick<DecisionEvaluationReader, 'list' | 'get' | 'listRouting' | 'getRouting'>
  decisionModelEvaluations?: Pick<DecisionModelEvaluationReader, 'list' | 'get'>
  decisionApiGateEvaluations?: Pick<DecisionApiGateEvaluationReader, 'list' | 'get'>
}

export const decisionCatalog: ControlHandler<DecisionControlDeps> = (frame, deps, wire) => {
  if (!deps.decisionEvaluator) {
    wire.sendError(frame.id, 'BAD_PAYLOAD', 'Decision preview is unavailable', false)
    return
  }
  wire.reply(frame, 'decision/catalog/result', deps.decisionEvaluator.catalog())
}

const rawJson = (text: string | null) =>
  text === null
    ? null
    : { text: text.slice(0, DECISION_RAW_JSON_MAX_CHARS), truncated: text.length > DECISION_RAW_JSON_MAX_CHARS }

export const decisionPreview: ControlHandler<DecisionControlDeps> = async (frame, deps, wire) => {
  if (!deps.decisionEvaluator) {
    wire.sendError(frame.id, 'BAD_PAYLOAD', 'Decision preview is unavailable', false)
    return
  }
  try {
    const { raw, ...input } = DecisionPreviewRequest.parse(frame.payload)
    // Only a Try that asked for them gets the provider bodies back, for its detail; nothing keeps them.
    const bodies: { rawRequest: string | null; rawResponse: string | null } = { rawRequest: null, rawResponse: null }
    const evaluation = await deps.decisionEvaluator.evaluate({
      ...input,
      ...(input.budgetMs ? { deadlineAt: performance.timeOrigin + performance.now() + input.budgetMs } : {}),
      ...(raw
        ? {
            onRawRequest: (text: string) => void (bodies.rawRequest = text),
            onRawResponse: (text: string) => void (bodies.rawResponse = text)
          }
        : {})
    })
    wire.reply(
      frame,
      'decision/preview/result',
      raw
        ? { evaluation, rawRequest: rawJson(bodies.rawRequest), rawResponse: rawJson(bodies.rawResponse) }
        : { evaluation }
    )
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

export const decisionModelEvaluations: ControlHandler<DecisionControlDeps> = async (frame, deps, wire) => {
  const reader = deps.decisionModelEvaluations
  if (!reader) return wire.sendError(frame.id, 'BAD_PAYLOAD', 'Model evaluations are unavailable', false)
  await readEvaluations(
    frame,
    wire,
    () => DecisionModelEvaluationsRequest.parse(frame.payload),
    (orgId, req) => reader.list(orgId, req),
    'decision/model-evaluations/page'
  )
}

export const decisionModelEvaluation: ControlHandler<DecisionControlDeps> = async (frame, deps, wire) => {
  const reader = deps.decisionModelEvaluations
  if (!reader) return wire.sendError(frame.id, 'BAD_PAYLOAD', 'Model evaluations are unavailable', false)
  await readEvaluations(
    frame,
    wire,
    () => DecisionModelEvaluationRequest.parse(frame.payload),
    (orgId, req) => reader.get(orgId, req),
    'decision/model-evaluation/result'
  )
}

export const decisionApiGateEvaluations: ControlHandler<DecisionControlDeps> = async (frame, deps, wire) => {
  const reader = deps.decisionApiGateEvaluations
  if (!reader) return wire.sendError(frame.id, 'BAD_PAYLOAD', 'API gate evaluations are unavailable', false)
  await readEvaluations(
    frame,
    wire,
    () => ApiGateEvaluationsRequest.parse(frame.payload),
    (orgId, req) => reader.list(orgId, req),
    'decision/api-gate-evaluations/page'
  )
}

export const decisionApiGateEvaluation: ControlHandler<DecisionControlDeps> = async (frame, deps, wire) => {
  const reader = deps.decisionApiGateEvaluations
  if (!reader) return wire.sendError(frame.id, 'BAD_PAYLOAD', 'API gate evaluations are unavailable', false)
  await readEvaluations(
    frame,
    wire,
    () => ApiGateEvaluationRequest.parse(frame.payload),
    (orgId, req) => reader.get(orgId, req),
    'decision/api-gate-evaluation/result'
  )
}
