// Where a Recent evaluations drawer reads from: a gated conversation or a code-host routing scope (code-host-decisions.md §7).

import type { DecisionEvaluationRecordDetail, DecisionEvaluationRecordPage } from '@agentconnect.md/protocol/decision'
import type { DecisionApi, DecisionConversationRef } from '@agentconnect.md/protocol/decision-api'
import { fetchCodeHostRoutingEvaluation, fetchCodeHostRoutingEvaluations, type CodeHostRoutingKey } from '@/lib/api'

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
  scope: CodeHostRoutingKey
): DecisionEvaluationSource {
  const key = { provider: scope.provider, repoId: scope.repoId, family: scope.family }
  const lane = `${key.provider}:${key.repoId}:${key.family}`
  const ref = { integrationId: lane, channelId: lane }
  return {
    lane: 'code_host',
    key: [api.mode, orgId, 'code_host', key.provider, key.repoId, key.family],
    list: (page) =>
      api.mode === 'mock' ? api.listEvaluations(ref, page) : fetchCodeHostRoutingEvaluations(key, page, orgId),
    get: (seq) => (api.mode === 'mock' ? api.getEvaluation(ref, seq) : fetchCodeHostRoutingEvaluation(key, seq, orgId))
  }
}
