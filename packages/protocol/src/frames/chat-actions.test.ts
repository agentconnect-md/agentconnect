import { describe, expect, it } from 'vitest'
import { AgentPermissionDecision, AgentPermissionRequestList, AgentSpec, ChatActions } from './agent.js'
import { RcWebchatParticipant } from './relay-cp.js'
import { RelayWebchatOp } from './relay-daemon.js'

const AGENT = '11111111-2222-4333-8444-555555555555'
const REQUEST = '66666666-7777-4888-8999-aaaaaaaaaaaa'

describe('who answers and changes settings in webchat, on the wire', () => {
  it('binds a list and a decision to one conversation, and either side may predate it', () => {
    const conversation = { sessionId: 'sid-webchat' }
    expect(AgentPermissionRequestList.parse({ agentId: AGENT, conversation }).conversation).toEqual(conversation)
    expect(AgentPermissionRequestList.parse({ agentId: AGENT }).conversation).toBeUndefined()
    const decision = { agentId: AGENT, requestId: REQUEST, decision: 'allow' as const }
    expect(AgentPermissionDecision.parse({ ...decision, conversation }).conversation).toEqual(conversation)
    expect(AgentPermissionDecision.safeParse({ ...decision, conversation: { sessionId: '' } }).success).toBe(false)
  })

  it('carries the verified role on a participant, a turn and each runtime change, never an unknown one', () => {
    expect(RcWebchatParticipant.parse({ agentId: AGENT, callerRole: 'owner' }).callerRole).toBe('owner')
    for (const op of [
      { op: 'turn', text: 'hi' },
      { op: 'set_model', model: 'b' },
      { op: 'set_effort', effort: 'high' },
      { op: 'set_permission_mode', permissionMode: 'plan' },
      { op: 'set_fast', fastMode: true }
    ]) {
      expect(RelayWebchatOp.parse({ ...op, callerRole: 'participant' })).toMatchObject({ callerRole: 'participant' })
      expect(RelayWebchatOp.parse(op)).not.toHaveProperty('callerRole')
      expect(RelayWebchatOp.safeParse({ ...op, callerRole: 'admin' }).success).toBe(false)
    }
  })
})

describe('AgentSpec.chatActions', () => {
  it('parses each level', () => {
    for (const level of ['talk', 'approve', 'settings'] as const) {
      expect(AgentSpec.parse({ name: 'example-agent', chatActions: level }).chatActions).toBe(level)
    }
  })

  it('stays absent when the spec leaves it out', () => {
    expect(AgentSpec.parse({ name: 'example-agent' }).chatActions).toBeUndefined()
  })

  it('rejects anything but a level', () => {
    expect(ChatActions.safeParse(true).success).toBe(false)
    expect(AgentSpec.safeParse({ name: 'example-agent', chatActions: 'everything' }).success).toBe(false)
  })

  it('no longer carries the boolean', () => {
    const parsed = AgentSpec.parse({ name: 'example-agent', allowRuntimeChangesInChat: true })
    expect(parsed).not.toHaveProperty('allowRuntimeChangesInChat')
    expect(parsed.chatActions).toBeUndefined()
  })
})
