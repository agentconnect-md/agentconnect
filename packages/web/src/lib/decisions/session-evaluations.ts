// Pure joins between a session transcript and its conversation's By decision evaluations.

import type { DecisionEvaluationRecord } from '@agentconnect.md/protocol/decision'
import type { DecisionConversationRef } from '@agentconnect.md/protocol/decision-api'
import type { IntegrationRow } from '@/lib/data'
import { savedGateOf } from './binding'

export interface SessionGateLane {
  conversation: DecisionConversationRef
  channelName: string
}

/** The agent's gated lane this session runs in, or null when its conversation has no By decision gate. */
export function sessionGateLane(
  integrations: readonly Pick<IntegrationRow, 'id' | 'agentId' | 'platform' | 'channels'>[],
  session: { agentId?: string | null; platform?: string | null; channelId?: string | null }
): SessionGateLane | null {
  const { agentId, platform, channelId } = session
  if (!agentId || !platform || !channelId) return null
  for (const integration of integrations) {
    if (!integration.id || integration.agentId !== agentId || integration.platform !== platform) continue
    const row = integration.channels.find((channel) => channel.channelId === channelId)
    if (row && savedGateOf(row))
      return { conversation: { integrationId: integration.id, channelId }, channelName: row.name }
  }
  return null
}

/** Each record keyed by the transcript seq of the message it judged, kept only for the session's own messages. */
export function evaluationsBySeq(
  records: readonly DecisionEvaluationRecord[],
  seqs: ReadonlySet<number>
): Map<number, DecisionEvaluationRecord> {
  const bySeq = new Map<number, DecisionEvaluationRecord>()
  for (const record of records) if (seqs.has(record.seq) && !bySeq.has(record.seq)) bySeq.set(record.seq, record)
  return bySeq
}
