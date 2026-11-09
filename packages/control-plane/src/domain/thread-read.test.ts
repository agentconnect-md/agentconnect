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
    expect(threadReadable(unowned, new Map())).toBe(true)
    expect(threadReadable(held, new Map([['task-1', true]]))).toBe(true)
    expect(threadReadable(held, new Map([['task-1', false]]))).toBe(false)
    expect(threadReadable(held, new Map([['task-2', true]]))).toBe(false)
    // A task whose session does not exist yet is nobody's to read.
    expect(threadReadable({ ...held, task: { state: 'open' } }, new Map([['task-1', true]]))).toBe(false)
  })

  it('names each held task session once', () => {
    expect(threadTaskSessionIds([held, unowned, held, { ...held, task: { state: 'done' } }])).toEqual(['task-1'])
  })

  it('keeps a readable footer whole', () => {
    expect(threadSummaryFor(held, new Map([['task-1', true]]))).toEqual({ ...held, readable: true })
    expect(threadSummaryFor(unowned, new Map())).toEqual({ ...unowned, readable: true })
  })

  it('leaves the count, authors and state of a footer the viewer may not read, and drops its content', () => {
    expect(threadSummaryFor(held, new Map([['task-1', false]]))).toEqual({
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

  it('marks a held task with no session row yet as starting, not withheld, and still drops its content', () => {
    const view = threadSummaryFor(held, new Map())
    expect(view).toMatchObject({ readable: false, task: { sessionId: 'task-1', state: 'open', starting: true } })
    expect(view.rootExcerpt).toBeUndefined()
    expect(threadSummaryFor({ ...held, task: { state: 'open' } }, new Map()).task).toEqual({
      state: 'open',
      starting: true
    })
    expect(threadSummaryFor(held, new Map([['task-1', false]])).task).not.toHaveProperty('starting')
  })
})
