import { describe, it, expect } from 'vitest'
import type { SessionThreadSummary } from '@agentconnect.md/protocol'
import { threadReadable, threadSummaryFor, threadTaskSessionIds } from './thread-read.js'

const held: SessionThreadSummary = {
  rootId: 'root-1',
  rootExcerpt: 'Can you check the deploy?',
  replies: 3,
  lastReplyAt: '2026-11-06T10:00:00.000Z',
  lastReply: { sender: 'agent-1', senderName: 'Ada', excerpt: 'The deploy is green.' },
  participants: [{ sender: 'agent-1', senderName: 'Ada' }, { sender: 'U1' }],
  task: { sessionId: 'task-1', title: 'Check the deploy', state: 'open' },
  running: true
}
const unowned: SessionThreadSummary = {
  rootId: 'root-2',
  rootExcerpt: 'Thanks',
  replies: 1,
  lastReply: { sender: 'U1', excerpt: 'Anytime' },
  participants: [{ sender: 'U1' }]
}

describe('thread reads (webchat-threads.md §7.1)', () => {
  it('reads an unowned thread through the conversation, and a held one only through its task', () => {
    expect(threadReadable(unowned, new Set())).toBe(true)
    expect(threadReadable(held, new Set(['task-1']))).toBe(true)
    expect(threadReadable(held, new Set(['task-2']))).toBe(false)
    // A task whose session does not exist yet is nobody's to read.
    expect(threadReadable({ ...held, task: { state: 'open' } }, new Set(['task-1']))).toBe(false)
  })

  it('names each held task session once', () => {
    expect(threadTaskSessionIds([held, unowned, held, { ...held, task: { state: 'done' } }])).toEqual(['task-1'])
  })

  it('keeps a readable footer whole', () => {
    expect(threadSummaryFor(held, new Set(['task-1']))).toEqual({ ...held, readable: true })
    expect(threadSummaryFor(unowned, new Set())).toEqual({ ...unowned, readable: true })
  })

  it('leaves the count, authors and state of a footer the viewer may not read, and drops its content', () => {
    expect(threadSummaryFor(held, new Set())).toEqual({
      rootId: 'root-1',
      replies: 3,
      lastReplyAt: '2026-11-06T10:00:00.000Z',
      lastReply: { sender: 'agent-1', senderName: 'Ada' },
      participants: [{ sender: 'agent-1', senderName: 'Ada' }, { sender: 'U1' }],
      task: { sessionId: 'task-1', state: 'open' },
      running: true,
      readable: false
    })
  })
})
