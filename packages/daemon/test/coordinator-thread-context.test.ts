// auto-session-mode.md §4.1: a coordinator reads the earlier messages of a thread it meets part-way.
import { describe, it, expect, vi } from 'vitest'
import {
  coordinatorThreadContext,
  THREAD_EXCERPT_CHARS,
  THREAD_EXCERPT_MESSAGES
} from '../src/auto-session/coordinator-thread-context.js'
import { deliveredMessage } from '../src/auto-session/coordinator-sessions.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import { messageOrderingFor } from '../src/platforms/message-ordering.js'
import { openTestStore } from './store-support.js'

const ROOT = '1700000000.000100'
const at = (seconds: number): string => `${1700000000 + seconds}.000100`

const slack = (ts: string, over: Partial<NormalizedMessage> = {}): NormalizedMessage =>
  ({
    msgId: `slack:C1:${ts}`,
    traceId: `t-${ts}`,
    source: 'user',
    platform: 'slack',
    channel: 'C1',
    thread: ts,
    sender: { id: 'U1', isBot: false },
    text: 'hello',
    mentionedBots: [],
    isDm: false,
    ...over
  }) as NormalizedMessage

const reply = (ts: string, over: Partial<NormalizedMessage> = {}) =>
  deliveredMessage(slack(ts, { thread: ROOT, ...over }), 'int-1')

function context(over: Partial<Parameters<typeof coordinatorThreadContext>[0]> = {}) {
  const input = {
    agentId: 'bot-a',
    messages: [reply(at(50))],
    ordering: messageOrderingFor('slack'),
    holds: vi.fn(async () => false),
    fetchHistory: vi.fn(async () => [
      { sender: 'U2', ts: ROOT, text: 'the node reports stale state' },
      { sender: 'bot-a', ts: at(10), text: 'looking into it' },
      { sender: 'U3', ts: at(20), text: 'any news?' }
    ]),
    warn: vi.fn(),
    ...over
  }
  return { input, run: () => coordinatorThreadContext(input) }
}

describe('the thread a coordinator meets part-way', () => {
  it('shows the thread’s earlier messages, its own as “you”, read up to the delivered message', async () => {
    const { input, run } = context()
    expect(await run()).toEqual([
      {
        id: `msg-${ROOT}`,
        earlier: [
          { from: 'U2', text: 'the node reports stale state' },
          { from: 'you', text: 'looking into it' },
          { from: 'U3', text: 'any news?' }
        ]
      }
    ])
    expect(input.holds).toHaveBeenCalledWith(ROOT, [at(50)])
    expect(input.fetchHistory).toHaveBeenCalledWith(ROOT, at(50), 'int-1')
  })

  it('reads nothing for a thread it already holds a message of', async () => {
    const { input, run } = context({ holds: vi.fn(async () => true) })
    expect(await run()).toEqual([])
    expect(input.fetchHistory).not.toHaveBeenCalled()
  })

  it('reads nothing for a root message, a report, or a platform whose ids carry no order', async () => {
    const root = context({ messages: [deliveredMessage(slack(at(50)), 'int-1')] })
    expect(await root.run()).toEqual([])
    const report = context({ messages: [reply(at(50), { source: 'agent' })] })
    expect(await report.run()).toEqual([])
    const opaque = context({ ordering: undefined })
    expect(await opaque.run()).toEqual([])
    for (const { input } of [root, report, opaque]) expect(input.holds).not.toHaveBeenCalled()
  })

  it('reads a thread once for the several messages a batch holds in it, up to the earliest, and leaves them out', async () => {
    const { input, run } = context({
      messages: [reply(at(60)), reply(at(50))],
      fetchHistory: vi.fn(async () => [
        { sender: 'U2', ts: ROOT, text: 'root' },
        { sender: 'U1', ts: at(50), text: 'delivered' },
        { sender: 'U1', ts: at(55), text: 'between' }
      ])
    })
    expect(await run()).toEqual([{ id: `msg-${ROOT}`, earlier: [{ from: 'U2', text: 'root' }] }])
    expect(input.holds).toHaveBeenCalledWith(ROOT, [at(60), at(50)])
    expect(input.fetchHistory).toHaveBeenCalledTimes(1)
    expect(input.fetchHistory).toHaveBeenCalledWith(ROOT, at(50), 'int-1')
  })

  it('keeps the root and the newest messages of a long thread, and cuts a long message', async () => {
    const rows = Array.from({ length: THREAD_EXCERPT_MESSAGES + 5 }, (_, index) => ({
      sender: 'U2',
      ts: index === 0 ? ROOT : at(index),
      text: index === 0 ? 'r'.repeat(THREAD_EXCERPT_CHARS + 10) : `m${index}`
    }))
    const { run } = context({ messages: [reply(at(500))], fetchHistory: vi.fn(async () => rows) })
    const [thread] = await run()
    expect(thread!.elided).toBe(5)
    expect(thread!.earlier).toHaveLength(THREAD_EXCERPT_MESSAGES)
    expect(thread!.earlier[0]!.text).toBe(`${'r'.repeat(THREAD_EXCERPT_CHARS)}… [cut]`)
    expect(thread!.earlier[1]!.text).toBe('m6')
    expect(thread!.earlier.at(-1)!.text).toBe(`m${THREAD_EXCERPT_MESSAGES + 4}`)
  })

  it('goes on without a thread whose read fails', async () => {
    const { input, run } = context({
      fetchHistory: vi.fn(async () => {
        throw new Error('timed out')
      })
    })
    expect(await run()).toEqual([])
    expect(input.warn).toHaveBeenCalledWith(`reading thread ${ROOT} failed: timed out`)
  })
})

describe('what a session holds of a thread', () => {
  it('counts the text rows it was admitted in that thread, apart from the ones named', async () => {
    const store = await openTestStore()
    const scope = { transcriptChannel: 'C1', sessionKey: 'k:coordinator', agentId: 'bot-a' }
    const row = (thread: string, ts: string, sessionKey: string) =>
      store.appendTranscript({
        channel: 'C1',
        thread,
        ts,
        sender: 'U1',
        recipient: 'bot-a',
        kind: 'text',
        text: 'hi',
        admission: { agentId: 'bot-a', sessionKey }
      })
    await row(ROOT, at(50), 'k:coordinator')
    await row(ROOT, at(40), 'k:another-session')
    await row(at(900), at(910), 'k:coordinator')
    expect(await store.sessionHoldsThread(scope, ROOT)).toBe(true)
    // Only the delivered message itself: the thread is one it meets part-way.
    expect(await store.sessionHoldsThread(scope, ROOT, [at(50)])).toBe(false)
    await row(ROOT, at(45), 'k:coordinator')
    expect(await store.sessionHoldsThread(scope, ROOT, [at(50)])).toBe(true)
    expect(await store.sessionHoldsThread(scope, at(800))).toBe(false)
    await store.close()
  })
})
