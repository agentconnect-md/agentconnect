import { describe, expect, it } from 'vitest'
import type { DecisionEvaluationRecord } from '@agentconnect.md/protocol/decision'
import type { IntegrationChannelRow } from '@/lib/data'
import { coordinatorFilterEvaluationsBySeq, evaluationsBySeq, sessionGateLane } from './session-evaluations'

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

describe('coordinatorFilterEvaluationsBySeq', () => {
  const record = (seq: number, messageId: string | null) => ({ seq, messageId }) as DecisionEvaluationRecord

  it('matches each verdict to the transcript seq of its message in the session’s conversation', () => {
    const bySeq = coordinatorFilterEvaluationsBySeq(
      [
        record(5, 'slack:C1:1.3'),
        record(4, 'slack:C2:1.2'),
        record(3, 'telegram:C1:1.2'),
        record(2, 'slack:C1:1.1'),
        record(1, 'slack:C1:1.1')
      ],
      { platform: 'slack', channelId: 'C1' },
      [
        { seq: 10, messageId: '1.1' },
        { seq: 20, messageId: '1.2' },
        { seq: 30, messageId: '1.3' }
      ]
    )
    expect([...bySeq.entries()].map(([seq, r]) => [seq, r.seq])).toEqual([
      [30, 5],
      [10, 2]
    ])
  })

  it('matches a platform message id that carries an app prefix before the channel', () => {
    const bySeq = coordinatorFilterEvaluationsBySeq(
      [record(7, 'qq:app-1:group:g1:msg-9'), record(6, 'qq:app-1:group:g2:msg-9')],
      { platform: 'qq', channelId: 'group:g1' },
      [{ seq: 42, messageId: 'msg-9' }]
    )
    expect(bySeq.get(42)?.seq).toBe(7)
  })
})
