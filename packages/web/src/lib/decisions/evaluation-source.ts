// Where a Recent evaluations drawer reads from: a gated conversation or a code-host routing scope (code-host-decisions.md §7).

import type { DecisionEvaluationRecordDetail, DecisionEvaluationRecordPage } from '@agentconnect.md/protocol/decision'
import type { DecisionApi, DecisionConversationRef } from '@agentconnect.md/protocol/decision-api'
import { fetchCodeHostRoutingEvaluation, fetchCodeHostRoutingEvaluations, type CodeHostRoutingFamily } from '@/lib/api'

export interface DecisionEvaluationSource {
  /** Which surface the lane belongs to, so the drawer words its empty and unavailable states. */
  lane: 'conversation' | 'code_host'
  /** SWR identity of the lane, organization and API mode included. */
  key: readonly string[]
  list(page: { cursor?: number; limit?: number }): Promise<DecisionEvaluationRecordPage>
  get(seq: number): Promise<DecisionEvaluationRecordDetail>
}

export function conversationEvaluations(
  api: DecisionApi,
  orgId: string,
  ref: DecisionConversationRef
): DecisionEvaluationSource {
  return {
    lane: 'conversation',
    key: [api.mode, orgId, 'conversation', ref.integrationId, ref.channelId],
    list: (page) => api.listEvaluations(ref, page),
    get: (seq) => api.getEvaluation(ref, seq)
  }
}

// The mock API serves routing lanes from its shared evaluation fixtures, addressed as `integrationId = channel = scope`.
export function codeHostRoutingEvaluations(
  api: DecisionApi,
  orgId: string,
  scope: { repoId: string; family: CodeHostRoutingFamily }
): DecisionEvaluationSource {
  const { repoId, family } = scope
  const ref = { integrationId: `github:${repoId}:${family}`, channelId: `github:${repoId}:${family}` }
  return {
    lane: 'code_host',
    key: [api.mode, orgId, 'code_host', 'github', repoId, family],
    list: (page) =>
      api.mode === 'mock'
        ? api.listEvaluations(ref, page)
        : fetchCodeHostRoutingEvaluations(repoId, family, page, orgId),
    get: (seq) =>
      api.mode === 'mock' ? api.getEvaluation(ref, seq) : fetchCodeHostRoutingEvaluation(repoId, family, seq, orgId)
  }
}
