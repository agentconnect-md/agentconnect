// A later reached chain step's Model result, read from its frozen detail and trace entry (decisions.md §10.7).

import { useState } from 'react'
import {
  matchDecisionCondition,
  type DecisionAnswer,
  type DecisionChainDetail,
  type DecisionChainStepDetail,
  type DecisionChainTrace,
  type DecisionCondition,
  type DecisionQuestion
} from '@agentconnect.md/protocol/decision'

/** The reached steps a detail can switch between; null for a lone Decision or a daemon that kept no step detail. */
export function selectableSteps(
  chain: DecisionChainTrace | undefined,
  steps: DecisionChainDetail | undefined
): DecisionChainDetail | null {
  if (!chain || !steps || chain.length < 2 || steps.length !== chain.length) return null
  return steps.every((step, index) => step.stepId === chain[index]!.stepId) ? steps : null
}

/** The reached step a detail shows and its selector props; back on the first step whenever `seq` changes. */
export function useChainStep(
  seq: number | null,
  chain: DecisionChainTrace | undefined,
  steps: DecisionChainDetail | undefined
) {
  const [picked, setPicked] = useState<{ seq: number | null; index: number } | null>(null)
  const selectable = selectableSteps(chain, steps)
  const index = selectable && picked?.seq === seq && picked.index < selectable.length ? picked.index : 0
  return {
    index,
    step: index > 0 ? selectable![index]! : null,
    selector: selectable ? { selected: index, onSelect: (next: number) => setPicked({ seq, index: next }) } : {}
  }
}

/** Whether a frozen condition matched; a pair the protocol rejects reads as unmatched rather than throwing. */
export function conditionMatch(
  question: DecisionQuestion,
  condition: DecisionCondition,
  answer: DecisionAnswer
): { matched: boolean; matchedKeys: string[] } {
  try {
    return matchDecisionCondition(question, condition, answer)
  } catch {
    return { matched: false, matchedKeys: [] }
  }
}

/** The Model result props one later step supplies; a gate step's own condition marks what triggered. */
export function chainStepResult(step: DecisionChainStepDetail, entry: DecisionChainTrace[number]) {
  const evaluation = entry.evaluation
  const answer = evaluation.status === 'answered' ? evaluation.answer : null
  const match =
    answer && step.condition
      ? conditionMatch(step.question, step.condition, answer)
      : { matched: false, matchedKeys: [] }
  return {
    question: step.question,
    answer,
    summary: answer,
    condition: step.condition ?? null,
    matchedKeys: match.matchedKeys,
    matched: match.matched,
    requestedModel: step.model,
    actualModel: evaluation.status === 'answered' ? evaluation.model : null,
    latencyMs: null,
    usage: evaluation.status === 'answered' ? evaluation.usage : null,
    status: evaluation.status,
    ...(step.rawRequest !== undefined ? { rawRequest: step.rawRequest } : {}),
    ...(step.rawResponse !== undefined ? { rawResponse: step.rawResponse } : {})
  }
}
