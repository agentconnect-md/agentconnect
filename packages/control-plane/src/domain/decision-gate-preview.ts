import {
  matchDecisionCondition,
  type DecisionCondition,
  type DecisionEvaluation,
  type DecisionPreviewSample,
  type DecisionQuestion
} from '@agentconnect.md/protocol'

/** The sender a Gate Try sample's current message gets when the operator names none. */
export const PREVIEW_SENDER = 'preview-user'

/** A Gate Try sample in the live state shape the daemon builds (decisions.md §8.2), with synthetic ids. */
export function gateSampleState(
  sample: DecisionPreviewSample,
  target: { agentId: string; conversationName?: string }
): Record<string, unknown> {
  const history = sample.history.map((entry, index) => ({
    id: `preview-${index + 1}`,
    sender: { id: entry.sender },
    text: entry.text,
    threadId: null
  }))
  return {
    currentMessage: {
      id: `preview-${history.length + 1}`,
      sender: { id: sample.currentMessage.sender ?? PREVIEW_SENDER },
      text: sample.currentMessage.text,
      threadId: null
    },
    history,
    conversation: target.conversationName ? { name: target.conversationName } : {},
    addressing: { mentions: [], target: { agentId: target.agentId, via: 'implicit' } },
    context: { partial: false, reasons: [], omittedMessages: 0 }
  }
}

export interface GatePreviewOutcome {
  outcome: 'trigger' | 'skip' | 'unavailable'
  matched: boolean
  matchedKeys: string[]
  evaluation: DecisionEvaluation
}

/** Apply the draft condition; a provider failure or an answer the matcher rejects is unavailable, never a skip. */
export function gatePreviewOutcome(
  question: DecisionQuestion,
  when: DecisionCondition,
  evaluation: DecisionEvaluation
): GatePreviewOutcome {
  if (evaluation.status !== 'answered') return { outcome: 'unavailable', matched: false, matchedKeys: [], evaluation }
  try {
    const match = matchDecisionCondition(question, when, evaluation.answer)
    return {
      outcome: match.matched ? 'trigger' : 'skip',
      matched: match.matched,
      matchedKeys: match.matchedKeys,
      evaluation
    }
  } catch {
    return {
      outcome: 'unavailable',
      matched: false,
      matchedKeys: [],
      evaluation: { status: 'unavailable', reason: 'invalid_response' }
    }
  }
}
