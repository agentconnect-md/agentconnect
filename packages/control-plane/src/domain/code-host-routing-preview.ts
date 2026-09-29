import {
  matchDecisionRouting,
  type CodeHostRoutingProvider,
  type CodeHostTryState,
  type DecisionAnswer,
  type DecisionEvaluation,
  type DecisionQuestion,
  type SharedBotDecisionRouting
} from '@agentconnect.md/protocol'
import { PREVIEW_THREAD } from './decision-routing-preview.js'

/** A code-host routing Try in the host state the daemon builds (code-host-decisions.md §4), with synthetic ids. */
export function codeHostSampleState(
  sample: CodeHostTryState,
  scope: { provider: CodeHostRoutingProvider; repoFullName: string }
): Record<string, unknown> {
  const entry = (e: CodeHostTryState['history'][number], index: number) => ({
    id: `preview-${index + 1}`,
    sender: e.sender,
    text: e.text,
    threadId: PREVIEW_THREAD
  })
  // The live state always reads history from observation, and a change without its supplement says so.
  const isPull = sample.subject.kind === 'pull_request' || sample.subject.kind === 'merge_request'
  const missing = isPull && !sample.pullRequest
  const reasons = ['observed_history', ...(missing ? ['pull_request_unavailable'] : [])]
  return {
    source: scope.provider,
    event: sample.event,
    repository: { fullName: scope.repoFullName },
    subject: sample.subject,
    currentMessage: entry(sample.currentMessage, sample.history.length),
    history: sample.history.map(entry),
    ...(sample.pullRequest
      ? { pullRequest: sample.pullRequest }
      : missing
        ? { pullRequest: { commitMessages: '', files: [], filesTruncated: true } }
        : {}),
    context: { partial: true, reasons, omittedMessages: 0 }
  }
}

export interface CodeHostPreviewSettlement {
  outcome: 'activate' | 'skip' | 'unavailable'
  reason?: string
  agentIds: string[]
  matchedRuleIds: string[]
  matchedKeys: string[]
  usedOtherwise: boolean
}

/** Settle a routing answer as the daemon's hook router does: unavailable and Otherwise-every-agent fire every member. */
export function settleCodeHostPreview(input: {
  question: DecisionQuestion
  routing: SharedBotDecisionRouting
  evaluation: DecisionEvaluation
  chain: ReadonlyMap<string, { question: DecisionQuestion; answer: DecisionAnswer }>
  memberIds: readonly string[]
}): CodeHostPreviewSettlement {
  const none = { matchedRuleIds: [], matchedKeys: [], usedOtherwise: false }
  if (input.evaluation.status !== 'answered')
    return { outcome: 'unavailable', reason: input.evaluation.reason, agentIds: [...input.memberIds], ...none }
  let match: ReturnType<typeof matchDecisionRouting>
  try {
    match = matchDecisionRouting(input.question, input.routing, input.evaluation.answer, undefined, input.chain)
  } catch {
    return { outcome: 'unavailable', reason: 'invalid_response', agentIds: [...input.memberIds], ...none }
  }
  const matched = {
    matchedRuleIds: match.matchedRuleIds,
    matchedKeys: match.matchedKeys,
    usedOtherwise: match.usedOtherwise
  }
  if (match.usedOtherwise && input.routing.otherwise.type === 'default_agent')
    return { outcome: 'activate', agentIds: [...input.memberIds], ...matched }
  const agentIds = input.memberIds.filter((id) => match.agentIds.includes(id))
  return { outcome: agentIds.length ? 'activate' : 'skip', agentIds, ...matched }
}
