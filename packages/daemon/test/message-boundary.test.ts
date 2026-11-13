import { describe, expect, it } from 'vitest'
import { agentMessageId, AgentMessageRun, WorkBoundary } from '../src/messages/message-boundary.js'

const chunk = (messageId?: string) => ({
  sessionUpdate: 'agent_message_chunk',
  content: { type: 'text', text: 'x' },
  ...(messageId === undefined ? {} : { messageId })
})

describe('agentMessageId', () => {
  it('reads the runtime’s id and treats anything else as unnamed', () => {
    expect(agentMessageId(chunk('m1'))).toBe('m1')
    expect(agentMessageId(chunk())).toBe('')
    expect(agentMessageId({ messageId: 7 })).toBe('')
    expect(agentMessageId({ messageId: '' })).toBe('')
    expect(agentMessageId(undefined)).toBe('')
    expect(agentMessageId(null)).toBe('')
  })
})

describe('AgentMessageRun', () => {
  it('opens on a change of named id, and never on the first message', () => {
    const run = new AgentMessageRun()
    expect(run.opens(chunk('m1'))).toBe(false)
    expect(run.opens(chunk('m1'))).toBe(false)
    expect(run.opens(chunk('m2'))).toBe(true)
    expect(run.opens(chunk('m2'))).toBe(false)
    expect(run.opens(chunk('m3'))).toBe(true)
  })

  // The pre-existing behavior for every runtime that names nothing, which is what keeps a reply
  // that merely streams in pieces from being split into one message per chunk.
  it('never opens for a runtime that names no message', () => {
    const run = new AgentMessageRun()
    for (let i = 0; i < 5; i++) expect(run.opens(chunk())).toBe(false)
  })

  it('holds the last NAMED id across unnamed chunks rather than forgetting it', () => {
    const run = new AgentMessageRun()
    run.opens(chunk('m1'))
    expect(run.opens(chunk())).toBe(false)
    expect(run.opens(chunk('m1'))).toBe(false)
    expect(run.opens(chunk('m2'))).toBe(true)
  })

  it('reports a return to an earlier id as a new message — the buffer holds only the last one', () => {
    const run = new AgentMessageRun()
    run.opens(chunk('m1'))
    expect(run.opens(chunk('m2'))).toBe(true)
    expect(run.opens(chunk('m1'))).toBe(true)
  })
})

describe('AgentMessageRun.withoutClosedSentinel', () => {
  const said = (messageId: string, text: string) => ({
    sessionUpdate: 'agent_message_chunk',
    messageId,
    content: { type: 'text', text }
  })

  it('removes a just-closed message that was only sentinel text, and nothing else', () => {
    const run = new AgentMessageRun()
    run.opens(said('m1', 'AC_NO'))
    run.opens(said('m1', '_RES'))
    expect(run.opens(said('m2', 'Sure'))).toBe(true)
    expect(run.withoutClosedSentinel('Earlier.AC_NO_RES')).toBe('Earlier.')
    expect(run.withoutClosedSentinel('AC_NO_RE')).toBe('AC_NO_RE')
    run.opens(said('m2', ' there.'))
    expect(run.withoutClosedSentinel('AC_NO_RES')).toBe('AC_NO_RES')
    expect(run.opens(said('m3', 'x'))).toBe(true)
    expect(run.withoutClosedSentinel('Sure there.')).toBe('Sure there.')
  })
})

describe('WorkBoundary', () => {
  it('recognizes new tools even when their first event is an update, and ignores later output or status', () => {
    const run = new WorkBoundary()
    expect(run.opens({ sessionUpdate: 'tool_call', toolCallId: 'first' })).toBe(true)
    expect(run.opens({ sessionUpdate: 'tool_call_update', toolCallId: 'first' })).toBe(false)
    expect(run.opens({ sessionUpdate: 'tool_call_update', toolCallId: 'second' })).toBe(true)
    expect(run.opens({ sessionUpdate: 'tool_call', toolCallId: 'second' })).toBe(false)
    expect(run.opens({ sessionUpdate: 'tool_call_update', toolCallId: 'first', status: 'completed' })).toBe(false)
    expect(run.opens({ sessionUpdate: 'tool_call' })).toBe(true)
    expect(run.opens({ sessionUpdate: 'agent_thought_chunk' })).toBe(true)
    expect(run.opens({ sessionUpdate: 'plan' })).toBe(true)
    expect(run.opens(chunk())).toBe(false)
    expect(run.opens({ sessionUpdate: 'usage_update' })).toBe(false)
  })
})
