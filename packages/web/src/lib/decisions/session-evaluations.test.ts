import { describe, expect, it } from 'vitest'
import type { DecisionEvaluationRecord } from '@agentconnect.md/protocol/decision'
import type { IntegrationChannelRow } from '@/lib/data'
import { evaluationsBySeq, sessionGateLane } from './session-evaluations'

const gated: IntegrationChannelRow = {
  channelId: '-1001',
  name: 'mods',
  trigger: 'decision',
  decisionBinding: { type: 'gate', decisionId: 'd1', when: { type: 'boolean', values: [true] } }
}
const plain: IntegrationChannelRow = { channelId: '-1002', name: 'lobby', trigger: 'mention' }
const integrations = [
  { id: 'int-other', agentId: 'agent-2', platform: 'telegram', channels: [gated] },
  { id: 'int-1', agentId: 'agent-1', platform: 'telegram', channels: [plain, gated] }
]

describe('sessionGateLane', () => {
  it('resolves the owning agent’s install whose row for the conversation has a gate', () => {
    expect(sessionGateLane(integrations, { agentId: 'agent-1', platform: 'telegram', channelId: '-1001' })).toEqual({
      conversation: { integrationId: 'int-1', channelId: '-1001' },
      channelName: 'mods'
    })
  })

  it('returns null for an ungated conversation, another platform, or a session without coordinates', () => {
    expect(sessionGateLane(integrations, { agentId: 'agent-1', platform: 'telegram', channelId: '-1002' })).toBeNull()
    expect(sessionGateLane(integrations, { agentId: 'agent-1', platform: 'slack', channelId: '-1001' })).toBeNull()
    expect(sessionGateLane(integrations, { agentId: 'agent-1', platform: 'telegram' })).toBeNull()
  })
})

describe('evaluationsBySeq', () => {
  const record = (seq: number) => ({ seq }) as DecisionEvaluationRecord
  it('keeps only records judging the session’s own messages', () => {
    const bySeq = evaluationsBySeq([record(30), record(20), record(10)], new Set([10, 30, 40]))
    expect([...bySeq.keys()]).toEqual([30, 10])
  })
})
