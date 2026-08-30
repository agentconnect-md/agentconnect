import { describe, expect, it } from 'vitest'
import { agentMessageId, AgentMessageRun } from '../src/messages/message-boundary.js'

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
