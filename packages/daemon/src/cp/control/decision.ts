import { DecisionPreviewRequest } from '@agentconnect.md/protocol'
import type { DecisionEvaluator } from '../../decisions/evaluator.js'
import type { ControlHandler } from './context.js'

export interface DecisionControlDeps {
  decisionEvaluator?: Pick<DecisionEvaluator, 'catalog' | 'evaluate'>
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
    const evaluation = await deps.decisionEvaluator.evaluate(input)
    wire.reply(frame, 'decision/preview/result', { evaluation })
  } catch {
    wire.sendError(frame.id, 'INTERNAL', 'Decision preview could not complete', true)
  }
}
