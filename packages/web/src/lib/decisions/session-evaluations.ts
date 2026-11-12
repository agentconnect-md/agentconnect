// Pure joins between a session transcript and its conversation's By decision or coordinator filter evaluations.

import type { DecisionEvaluationRecord } from '@agentconnect.md/protocol/decision'
import type { DecisionConversationRef } from '@agentconnect.md/protocol/decision-api'
import type { IntegrationRow } from '@/lib/data'
import { savedGateOf } from './binding'

export interface SessionGateLane {
  conversation: DecisionConversationRef
  channelName: string
}

export interface SessionJudgedMessage {
  seq: number
  messageId?: string | null
  timeMs?: number | null
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

/** Each coordinator filter verdict keyed by the transcript seq of the message in `conversation` it judged. */
export function coordinatorFilterEvaluationsBySeq(
  records: readonly DecisionEvaluationRecord[],
  conversation: { platform: string; channelId: string },
  messages: readonly SessionJudgedMessage[]
): Map<number, DecisionEvaluationRecord> {
  const prefix = `${conversation.platform}:`
  const channelPrefix = `${conversation.platform}:${conversation.channelId}:`
  const byFullId = new Map<string, number>()
  const bySuffix = new Map<string, number>()
  for (const msg of messages) {
    const id = msg.messageId?.trim()
    if (!id) continue
    if (id.startsWith(prefix)) {
      byFullId.set(id, msg.seq)
    } else {
      byFullId.set(`${channelPrefix}${id}`, msg.seq)
      bySuffix.set(`:${conversation.channelId}:${id}`, msg.seq)
    }
  }
  const bySeq = new Map<number, DecisionEvaluationRecord>()
  for (const record of records) {
    const id = record.messageId
    if (!id || !id.startsWith(prefix)) continue
    let seq = byFullId.get(id)
    if (seq === undefined) {
      for (const [suffix, candidateSeq] of bySuffix) {
        if (id.endsWith(suffix)) {
          seq = candidateSeq
          break
        }
      }
    }
    if (seq !== undefined && !bySeq.has(seq)) bySeq.set(seq, record)
  }
  return bySeq
}
