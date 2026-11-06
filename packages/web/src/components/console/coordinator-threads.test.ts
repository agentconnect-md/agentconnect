import { describe, expect, it } from 'vitest'
import type { SessionStep } from '@/lib/data'
import {
  firstWords,
  isThreadId,
  liveReplyThreads,
  replyToMessageThread,
  threadAutoOpen,
  threadToAutoOpen
} from './coordinator-threads'

const ROOT = '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b'
const OTHER = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'

describe('replyToMessageThread', () => {
  const call = (rawInput: unknown, over: Record<string, unknown> = {}) => ({
    kind: 'tool',
    body: JSON.stringify({ toolCallId: 'call-1', rawInput }),
    ...over
  })

  it('reads the thread a replyToMessage call answered in from its row, else from its message id', () => {
    const input = { action: 'replyToMessage', messageId: `msg-${OTHER}`, message: 'Done.' }
    expect(replyToMessageThread(call(input, { thread: ROOT }))).toBe(ROOT)
    expect(replyToMessageThread(call(input))).toBe(OTHER)
  })

  it('reads nothing off another action, a failed call, a non-tool row or an unreadable body', () => {
    expect(replyToMessageThread(call({ action: 'delegateTask', messageId: `msg-${ROOT}` }))).toBeUndefined()
    expect(
      replyToMessageThread(call({ action: 'replyToMessage', messageId: `msg-${ROOT}` }, { toolStatus: 'failed' }))
    ).toBeUndefined()
    expect(replyToMessageThread({ kind: 'text', body: '{}', thread: ROOT })).toBeUndefined()
    expect(replyToMessageThread({ kind: 'tool', body: '{"rawInput":' })).toBeUndefined()
    expect(replyToMessageThread(call({ action: 'replyToMessage', messageId: 'msg-1784098843.000100' }))).toBeUndefined()
  })
})

describe('the thread helpers', () => {
  it('names a thread by a UUID only', () => {
    expect(isThreadId(ROOT)).toBe(true)
    expect(isThreadId(`webchat:${ROOT}`)).toBe(false)
    expect(isThreadId(undefined)).toBe(false)
  })

  it('cuts a root to its first words', () => {
    expect(firstWords('  Why is   the deploy slow? ')).toBe('Why is the deploy slow?')
    expect(firstWords('one two three four five six', 12)).toBe('one two…')
  })

  it('orders the threads agents spoke in by their latest step, leaving out people’s messages', () => {
    const steps = [
      { kind: 'done', turnId: 'a', text: 'x', thread: ROOT },
      { kind: 'msg', turnId: 'b', text: 'y', thread: 'mine' },
      { kind: 'done', turnId: 'c', text: 'z', thread: OTHER },
      { kind: 'tool', turnId: 'd', text: 'w', thread: ROOT },
      { kind: 'done', turnId: 'e', text: 'v' }
    ] satisfies SessionStep[]
    expect(liveReplyThreads(steps)).toEqual([OTHER, ROOT])
  })
})

describe('threadToAutoOpen', () => {
  it('opens a thread whose first reply starts while the reader watches, and only once', () => {
    const state = threadAutoOpen()
    expect(threadToAutoOpen(state, [{ rootId: ROOT, replies: 0 }], [])).toBeUndefined()
    expect(threadToAutoOpen(state, [{ rootId: ROOT, replies: 1 }], [])).toBe(ROOT)
    expect(threadToAutoOpen(state, [{ rootId: ROOT, replies: 2 }], [ROOT])).toBeUndefined()
  })

  it('leaves the threads that had replies when the page opened, and those agents spoke in before', () => {
    const state = threadAutoOpen()
    expect(threadToAutoOpen(state, [{ rootId: ROOT, replies: 3 }], [OTHER])).toBeUndefined()
    expect(threadToAutoOpen(state, [{ rootId: ROOT, replies: 4 }], [OTHER, ROOT])).toBeUndefined()
  })

  it('opens the latest when several start, from a live answer in a thread the page has not seen', () => {
    const state = threadAutoOpen()
    expect(threadToAutoOpen(state, [{ rootId: ROOT, replies: 0 }], [])).toBeUndefined()
    expect(threadToAutoOpen(state, [{ rootId: ROOT, replies: 1 }], [OTHER])).toBe(OTHER)
    expect(threadToAutoOpen(state, [{ rootId: ROOT, replies: 1 }], [OTHER])).toBeUndefined()
  })
})
