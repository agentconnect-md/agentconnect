/**
 * Google Chat's Layer-2 surface (google-chat-integration.md §5): the converger's block/preview shape, the stream's
 * two-second edit coalescing with the final replacing pending edits, byte-budget segmentation onto client ids,
 * and the applier's transcript bookkeeping and failure surfacing. No timers run for real; no network exists.
 */
import { describe, it, expect } from 'vitest'
import { GoogleChatApiError } from '../src/platforms/googlechat/connection.js'
import {
  applyGoogleChatAction,
  GoogleChatConverger,
  GoogleChatStream,
  googleChatClientId,
  initialGoogleChatTurnState,
  type GoogleChatAction,
  type GoogleChatEgressPort,
  type GoogleChatTurnState
} from '../src/platforms/googlechat/turn-output.js'
import { GOOGLE_CHAT_TEXT_BUDGET_BYTES } from '../src/platforms/googlechat/render.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'

const SPACE = 'spaces/EXAMPLE_SPACE'
const THREAD = `${SPACE}/threads/EXAMPLE_THREAD`
const DELIVERY = 'scope\u001fgooglechat:spaces/EXAMPLE_SPACE:spaces/EXAMPLE_SPACE/messages/T.M'

interface Write {
  kind: 'create' | 'patch'
  id: string
  text: string
  thread?: string
  at: number
}

/** A fake egress port plus a hand-driven clock and timer. */
function rig(opts: { failCreate?: GoogleChatApiError; failPatch?: GoogleChatApiError } = {}) {
  let t = 1_000_000
  const writes: Write[] = []
  let timer: { fn: () => void; due: number } | undefined
  const port: GoogleChatEgressPort = {
    async createMessage(input) {
      if (opts.failCreate) throw opts.failCreate
      writes.push({
        kind: 'create',
        id: input.clientId,
        text: input.text,
        ...(input.thread ? { thread: input.thread } : {}),
        at: t
      })
      return { name: `${input.space}/messages/T.${input.clientId}`, clientId: input.clientId }
    },
    async patchMessage(name, text) {
      if (opts.failPatch) throw opts.failPatch
      writes.push({ kind: 'patch', id: name.slice(name.lastIndexOf('.') + 1), text, at: t })
    }
  }
  const stream = new GoogleChatStream(
    port,
    { space: SPACE, thread: THREAD },
    (segment) => googleChatClientId(DELIVERY, 0, segment),
    {
      minEditIntervalMs: 2_000,
      now: () => t,
      setTimer: (fn, ms) => {
        timer = { fn, due: t + ms }
        return timer
      },
      clearTimer: () => {
        timer = undefined
      }
    }
  )
  const flush = async (): Promise<void> => {
    // Let the stream's own promise chain drain between steps.
    for (let i = 0; i < 5; i += 1) await Promise.resolve()
  }
  return {
    port,
    stream,
    writes,
    advance: async (ms: number) => {
      t += ms
      if (timer && timer.due <= t) {
        const fire = timer.fn
        timer = undefined
        fire()
      }
      await flush()
    },
    flush,
    pendingTimer: () => timer !== undefined
  }
}

describe('GoogleChatStream', () => {
  it('creates on the first snapshot and coalesces later ones into one edit per interval', async () => {
    const { stream, writes, advance, flush, pendingTimer } = rig()
    stream.update('a')
    await flush()
    expect(writes.map((w) => [w.kind, w.text])).toEqual([['create', 'a']])
    expect(writes[0]!.thread).toBe(THREAD)
    stream.update('ab')
    stream.update('abc')
    await advance(500)
    // Inside the interval nothing is written; the timer holds the newest snapshot.
    expect(writes).toHaveLength(1)
    expect(pendingTimer()).toBe(true)
    stream.update('abcd')
    await advance(1_500)
    expect(writes.map((w) => [w.kind, w.text])).toEqual([
      ['create', 'a'],
      ['patch', 'abcd']
    ])
    expect(writes[1]!.at - writes[0]!.at).toBe(2_000)
  })

  it('lets the final text replace a pending edit, so the pending snapshot never reaches the wire', async () => {
    const { stream, writes, advance, flush } = rig()
    stream.update('draft')
    await flush()
    stream.update('draft continued')
    await advance(100)
    const sent = await stream.finish('final answer')
    expect(writes.map((w) => [w.kind, w.text])).toEqual([
      ['create', 'draft'],
      ['patch', 'final answer']
    ])
    expect(sent).toEqual([
      {
        clientId: googleChatClientId(DELIVERY, 0, 0),
        name: `${SPACE}/messages/T.${googleChatClientId(DELIVERY, 0, 0)}`,
        text: 'final answer'
      }
    ])
    // Nothing after finish is taken.
    stream.update('late')
    await advance(5_000)
    expect(writes).toHaveLength(2)
  })

  it('splits a block over the byte budget onto consecutive segment ids and patches only what changed', async () => {
    const { stream, writes, flush } = rig()
    const first = 'a'.repeat(GOOGLE_CHAT_TEXT_BUDGET_BYTES - 10)
    const text = `${first}\n\n${'b'.repeat(100)}`
    stream.update(text)
    await flush()
    expect(writes.map((w) => w.id)).toEqual([googleChatClientId(DELIVERY, 0, 0), googleChatClientId(DELIVERY, 0, 1)])
    await stream.finish(`${first}\n\n${'b'.repeat(100)} end`)
    // The first segment is unchanged and stays untouched; only the second is patched.
    expect(writes.slice(2).map((w) => [w.kind, w.id])).toEqual([['patch', googleChatClientId(DELIVERY, 0, 1)]])
  })

  it('surfaces a missing thread as the block failure and stops writing', async () => {
    const { stream, writes, flush } = rig({ failCreate: new GoogleChatApiError('thread gone', 'not_found', 404) })
    stream.update('hello')
    await flush()
    stream.update('hello again')
    const err = await stream.finish('hello again').catch((e: unknown) => e)
    expect((err as GoogleChatApiError).kind).toBe('not_found')
    expect(writes).toHaveLength(0)
  })
})

describe('GoogleChatConverger', () => {
  const chunk = (text: string, messageId = 'm1') =>
    ({ sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text } }) as never
  const tool = (id: string) => ({ sessionUpdate: 'tool_call', toolCallId: id, title: 'run' }) as never

  it('previews the rendered block on every chunk and posts it when work starts', () => {
    const conv = new GoogleChatConverger('low')
    expect(conv.onUpdate(chunk('# Title'))).toEqual([{ kind: 'gchat-stream', text: '**Title**' }])
    expect(conv.onUpdate(chunk('\n\nbody'))).toEqual([{ kind: 'gchat-stream', text: '**Title**\n\nbody' }])
    expect(conv.hasBuffered()).toBe(true)
    expect(conv.onUpdate(tool('t1'))).toEqual([{ kind: 'post', text: '**Title**\n\nbody', attributed: false }])
    expect(conv.hasBuffered()).toBe(false)
    // Ongoing output of the same tool opens nothing new.
    expect(conv.onUpdate(tool('t1'))).toEqual([])
  })

  it('closes the block on a new runtime message, and posts the remainder at the final', () => {
    const conv = new GoogleChatConverger('low')
    conv.onUpdate(chunk('first'))
    expect(conv.onUpdate(chunk('second', 'm2'))).toEqual([
      { kind: 'post', text: 'first', attributed: false },
      { kind: 'gchat-stream', text: 'second' }
    ])
    expect(conv.flushBuffered()).toEqual([{ kind: 'gchat-stream', text: 'second' }])
    expect(conv.onFinal()).toEqual([{ kind: 'post', text: 'second', attributed: false }])
    expect(conv.onFinal()).toEqual([])
  })

  it('records without sending in mode none, and drops a bare no-response marker', () => {
    const silent = new GoogleChatConverger('none')
    expect(silent.onUpdate(chunk('hello'))).toEqual([])
    expect(silent.onFinal()).toEqual([{ kind: 'post', text: 'hello', attributed: false, recordOnly: true }])
    const marker = new GoogleChatConverger('low')
    expect(marker.onUpdate(chunk('AC_NO_RESPONSE'))).toEqual([])
    expect(marker.onFinal()).toEqual([])
  })
})

describe('applyGoogleChatAction', () => {
  const turn = { plan: { transcriptChannel: 'tc', statusThread: THREAD, agentId: 'agent-1', sessionKey: 'sk' } }
  function host() {
    const recorded: string[] = []
    const rows: { ts: string; text: string; eventTimeUs: number }[] = []
    const warnings: string[] = []
    return {
      recorded,
      rows,
      warnings,
      host: {
        recordReplySegment: async (_t: typeof turn, text: string) => {
          recorded.push(text)
        },
        appendTranscript: async (row: { ts: string; text: string; eventTimeUs: number }) => {
          rows.push({ ts: row.ts, text: row.text, eventTimeUs: row.eventTimeUs })
        },
        nowUs: () => 42_000_000,
        warn: (m: string) => {
          warnings.push(m)
        }
      }
    }
  }
  const state = (port: GoogleChatEgressPort): GoogleChatTurnState => ({
    conn: port,
    space: SPACE,
    thread: THREAD,
    deliveryId: DELIVERY,
    block: 0,
    streamOptions: { now: () => 0, setTimer: () => 0, clearTimer: () => {} }
  })

  it('records each landed segment under its message name and advances the block for the next stream', async () => {
    const { port, writes } = rig()
    const h = host()
    const s = state(port)
    await applyGoogleChatAction(h.host, turn, s, { kind: 'gchat-stream', text: 'draft' } satisfies GoogleChatAction)
    await applyGoogleChatAction(h.host, turn, s, { kind: 'post', text: 'final' } satisfies GoogleChatAction)
    expect(writes.map((w) => [w.kind, w.text])).toEqual([
      ['create', 'draft'],
      ['patch', 'final']
    ])
    expect(h.rows).toEqual([
      { ts: `${SPACE}/messages/T.${googleChatClientId(DELIVERY, 0, 0)}`, text: 'final', eventTimeUs: 42_000_000 }
    ])
    expect(h.recorded).toEqual([])
    expect(s.block).toBe(1)
    expect(s.stream).toBeUndefined()
    await applyGoogleChatAction(h.host, turn, s, { kind: 'post', text: 'second block' })
    expect(writes.at(-1)!.id).toBe(googleChatClientId(DELIVERY, 1, 0))
  })

  it('keeps the answer in the transcript and names the failure when Google refuses the thread', async () => {
    const { port } = rig({ failCreate: new GoogleChatApiError('no such thread', 'not_found', 404) })
    const h = host()
    await applyGoogleChatAction(h.host, turn, state(port), { kind: 'post', text: 'answer' })
    expect(h.recorded).toEqual(['answer'])
    expect(h.rows).toEqual([])
    expect(h.warnings).toHaveLength(1)
    expect(h.warnings[0]).toContain('not_found')
  })

  it('records only, without touching the port, for a recordOnly post or a turn with no egress', async () => {
    const { port, writes } = rig()
    const h = host()
    await applyGoogleChatAction(h.host, turn, state(port), { kind: 'post', text: 'quiet', recordOnly: true })
    await applyGoogleChatAction(h.host, turn, { ...state(port), conn: undefined }, { kind: 'post', text: 'headless' })
    expect(writes).toEqual([])
    expect(h.recorded).toEqual(['quiet', 'headless'])
  })

  it('seeds the reply target from the delivery: the thread in a Space, none in a DM', () => {
    const base = {
      msgId: 'googlechat:spaces/EXAMPLE_DM:spaces/EXAMPLE_DM/messages/T.M',
      traceId: 't',
      platform: 'googlechat',
      channel: 'spaces/EXAMPLE_DM',
      thread: 'spaces/EXAMPLE_DM',
      sender: { id: 'users/1', isBot: false },
      text: 'hi',
      mentionedBots: [],
      isDm: true,
      source: 'user' as const,
      transportScope: 'scope'
    } as NormalizedMessage
    const dm = initialGoogleChatTurnState({ mode: 'low', isDm: true, showFooter: false, message: base, egress: {} })
    expect(dm).toEqual({ conn: {}, space: 'spaces/EXAMPLE_DM', deliveryId: `scope\u001f${base.msgId}`, block: 0 })
    const space = initialGoogleChatTurnState({
      mode: 'low',
      isDm: false,
      showFooter: false,
      message: { ...base, channel: SPACE, thread: THREAD, isDm: false }
    })
    expect(space.thread).toBe(THREAD)
    expect(space.conn).toBeUndefined()
  })
})
