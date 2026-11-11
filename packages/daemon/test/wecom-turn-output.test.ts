import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionUpdate } from '@agentclientprotocol/sdk/unstable'
import { WeComRequestError } from '../src/platforms/wecom/client.js'
import {
  WECOM_MARKDOWN_MAX_BYTES,
  WeComConnection,
  type WeComReplyHandle,
  type WeComReplyPort,
  type WeComSentPart
} from '../src/platforms/wecom/connection.js'
import {
  WECOM_CONTINUATION_MS,
  WECOM_REFRESH_MS,
  WECOM_STREAM_HARD_MS,
  WECOM_STREAM_SOFT_MS,
  weComCutPoint
} from '../src/platforms/wecom/stream.js'
import {
  applyWeComAction,
  WeComConverger,
  type WeComTurnHost,
  type WeComTurnState
} from '../src/platforms/wecom/turn-output.js'
import { createWeComTurnOutput } from '../src/platforms/wecom/surface.js'
import { canonicalizeWeComThread } from '../src/platforms/wecom/module.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import { FakeWeComServer, quietLog } from './fakes/wecom-server.js'

afterEach(() => vi.useRealTimers())

const CHANNEL = 'dm:user-alice'
const HANDLE: WeComReplyHandle = { reqId: 'req-1', generation: 1, channel: CHANNEL, receivedAt: 0 }
const turn = { plan: { transcriptChannel: 'tc', statusThread: 'dm', agentId: 'agent', sessionKey: 'key' } }

interface Push {
  id: string
  content: string
  finish: boolean
  optional: boolean
}

function fakePort(opts: { handle?: WeComReplyHandle | null; refuseStream?: boolean; refuseSend?: boolean } = {}) {
  const pushes: Push[] = []
  const sends: string[] = []
  let fits = true
  let claimed = false
  const port: WeComReplyPort = {
    claimReply: () => {
      if (claimed || opts.handle === null) return undefined
      claimed = true
      return opts.handle ?? HANDLE
    },
    refreshFits: () => fits,
    respondStream: async (_handle, stream, optional = false) => {
      if (opts.refuseStream) throw new WeComRequestError(40008, 'invalid req_id')
      pushes.push({ ...stream, optional })
    },
    sendMarkdown: async (_channel, text): Promise<WeComSentPart[]> => {
      sends.push(text)
      return opts.refuseSend ? [{ text, error: new WeComRequestError(93000, 'no permission') }] : [{ text }]
    }
  }
  return { port, pushes, sends, setFits: (value: boolean) => void (fits = value) }
}

function harness(port: WeComReplyPort) {
  const rows: string[] = []
  const warnings: string[] = []
  const host: WeComTurnHost = {
    appendTranscript: async (row) => void rows.push(row.text),
    monotonicTs: () => '1700000000.000001',
    warn: (message) => warnings.push(message)
  }
  const state: WeComTurnState = { conn: port, channel: CHANNEL, msgId: 'wecom:aibot-example:msg-1' }
  const apply = (action: { kind: string; text?: string; recordOnly?: boolean }) =>
    applyWeComAction(host, turn, state, action)
  return { rows, warnings, state, apply }
}

const paragraphs = (count: number, size: number) =>
  Array.from({ length: count }, (_, i) => `${String(i).padStart(4, '0')} ${'x'.repeat(size)}.`).join('\n\n')

describe('WeCom streamed answer', () => {
  it('opens one stream, throttles refreshes to the newest snapshot, and finishes it with the whole answer', async () => {
    vi.useFakeTimers()
    const { port, pushes, sends } = fakePort()
    const { apply, rows } = harness(port)
    await apply({ kind: 'wecom-stream', text: 'Hel' })
    await vi.advanceTimersByTimeAsync(0)
    await apply({ kind: 'wecom-stream', text: 'Hello' })
    await apply({ kind: 'wecom-stream', text: 'Hello, wor' })
    await vi.advanceTimersByTimeAsync(WECOM_REFRESH_MS - 1)
    expect(pushes.map((p) => p.content)).toEqual(['Hel'])
    await vi.advanceTimersByTimeAsync(1)
    expect(pushes.map((p) => p.content)).toEqual(['Hel', 'Hello, wor'])
    await apply({ kind: 'post', text: 'Hello, world.' })
    expect(pushes.map((p) => [p.content, p.finish])).toEqual([
      ['Hel', false],
      ['Hello, wor', false],
      ['Hello, world.', true]
    ])
    expect(new Set(pushes.map((p) => p.id)).size).toBe(1)
    expect(pushes.slice(0, 2).every((p) => p.optional)).toBe(true)
    expect(pushes[2]!.optional).toBe(false)
    expect(sends).toEqual([])
    expect(rows).toEqual(['Hello, world.'])
  })

  it('skips refreshes the conversation budget cannot spare, but always delivers the answer', async () => {
    vi.useFakeTimers()
    const { port, pushes, setFits } = fakePort()
    const { apply } = harness(port)
    setFits(false)
    await apply({ kind: 'wecom-stream', text: 'Working' })
    await vi.advanceTimersByTimeAsync(WECOM_REFRESH_MS * 3)
    expect(pushes).toEqual([])
    await apply({ kind: 'post', text: 'Working on it. Done.' })
    expect(pushes.map((p) => [p.content, p.finish])).toEqual([['Working on it. Done.', true]])
  })

  it('closes the stream at a paragraph break before 20,480 bytes and continues in Markdown messages', async () => {
    vi.useFakeTimers()
    const { port, pushes, sends } = fakePort()
    const { apply, rows } = harness(port)
    const answer = paragraphs(30, 1000)
    expect(Buffer.byteLength(answer)).toBeGreaterThan(WECOM_MARKDOWN_MAX_BYTES)
    await apply({ kind: 'wecom-stream', text: answer })
    await vi.advanceTimersByTimeAsync(0)
    expect(pushes).toHaveLength(1)
    const closed = pushes[0]!
    expect(closed.finish).toBe(true)
    expect(Buffer.byteLength(closed.content)).toBeLessThanOrEqual(WECOM_MARKDOWN_MAX_BYTES)
    expect(closed.content.endsWith('.')).toBe(true)
    await apply({ kind: 'post', text: answer })
    expect(pushes).toHaveLength(1)
    expect(sends.length).toBeGreaterThan(0)
    expect(`${closed.content}\n\n${sends.join('\n\n')}`).toBe(answer)
    for (const sent of sends) expect(Buffer.byteLength(sent)).toBeLessThanOrEqual(WECOM_MARKDOWN_MAX_BYTES)
    expect(rows).toEqual([answer])
  })

  it('closes a stream at a paragraph break before its 10 minutes run out, then sends completed paragraphs', async () => {
    vi.useFakeTimers()
    const { port, pushes, sends } = fakePort()
    const { apply } = harness(port)
    await apply({ kind: 'wecom-stream', text: 'First paragraph.' })
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(WECOM_STREAM_SOFT_MS - 1_000)
    await apply({ kind: 'wecom-stream', text: 'First paragraph.\n\nSecond paragraph, still being writ' })
    await vi.advanceTimersByTimeAsync(WECOM_REFRESH_MS)
    // The refresh at 9 min closes the stream at the break; the half-written sentence is never cut.
    const last = pushes.at(-1)!
    expect([last.content, last.finish]).toEqual(['First paragraph.', true])
    await apply({ kind: 'wecom-stream', text: 'First paragraph.\n\nSecond paragraph, written.\n\nThird, partial' })
    await vi.advanceTimersByTimeAsync(WECOM_CONTINUATION_MS)
    expect(sends).toEqual(['Second paragraph, written.\n\n'])
    await apply({ kind: 'post', text: 'First paragraph.\n\nSecond paragraph, written.\n\nThird, done.' })
    expect(sends).toEqual(['Second paragraph, written.\n\n', 'Third, done.'])
    expect(pushes.filter((p) => p.finish)).toHaveLength(1)
  })

  it('closes a silent stream on its own clock, at the best cut once no paragraph break comes', async () => {
    vi.useFakeTimers()
    const { port, pushes } = fakePort()
    const { apply } = harness(port)
    await apply({ kind: 'wecom-stream', text: 'One long line with no break yet' })
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(WECOM_STREAM_SOFT_MS)
    expect(pushes.some((p) => p.finish)).toBe(false)
    await vi.advanceTimersByTimeAsync(WECOM_STREAM_HARD_MS - WECOM_STREAM_SOFT_MS)
    expect(pushes.at(-1)).toMatchObject({ content: 'One long line with no break yet', finish: true })
  })

  it('sends proactively when no live callback is left to answer', async () => {
    vi.useFakeTimers()
    const { port, pushes, sends } = fakePort({ handle: null })
    const { apply, rows } = harness(port)
    await apply({ kind: 'wecom-stream', text: 'Scheduled report' })
    await vi.advanceTimersByTimeAsync(WECOM_REFRESH_MS)
    await apply({ kind: 'post', text: 'Scheduled report: all green.' })
    expect(pushes).toEqual([])
    expect(sends).toEqual(['Scheduled report: all green.'])
    expect(rows).toEqual(['Scheduled report: all green.'])
  })

  it('falls back to a proactive message when WeCom refuses the stream', async () => {
    vi.useFakeTimers()
    const { port, sends } = fakePort({ refuseStream: true })
    const { apply } = harness(port)
    await apply({ kind: 'wecom-stream', text: 'Partial' })
    await vi.advanceTimersByTimeAsync(0)
    await apply({ kind: 'post', text: 'Partial answer, complete.' })
    expect(sends).toEqual(['Partial answer, complete.'])
  })

  it('records a clear notice when WeCom refuses a proactive send, instead of dropping it silently', async () => {
    const { port, sends } = fakePort({ handle: null, refuseSend: true })
    const { apply, rows, warnings } = harness(port)
    await apply({ kind: 'post', text: 'Nightly summary.' })
    await vi.waitFor(() => expect(rows).toHaveLength(2))
    expect(sends).toEqual(['Nightly summary.'])
    expect(rows[0]).toBe('Nightly summary.')
    expect(rows[1]).toContain('WeCom did not deliver this reply (errcode 93000: no permission)')
    expect(rows[1]).toContain('only after someone there has messaged it')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).not.toContain('Nightly')
  })

  it('seals the answer so far before a card, so what follows is sent below it', async () => {
    vi.useFakeTimers()
    const { port, pushes, sends } = fakePort()
    const { apply, state } = harness(port)
    await apply({ kind: 'wecom-stream', text: 'Let me check.' })
    await vi.advanceTimersByTimeAsync(0)
    await apply({ kind: 'wecom-stream', text: 'Let me check. I need one answer.' })
    await state.stream!.seal()
    expect(pushes.map((p) => [p.content, p.finish])).toEqual([
      ['Let me check.', false],
      ['Let me check. I need one answer.', true]
    ])
    await apply({ kind: 'post', text: 'Let me check. I need one answer.\n\nThanks, cutting from main.' })
    expect(pushes).toHaveLength(2)
    expect(sends).toEqual(['Thanks, cutting from main.'])
  })

  it('sends throttled text before a card even when the stream never opened', async () => {
    vi.useFakeTimers()
    const { port, pushes, setFits } = fakePort()
    const { apply, state } = harness(port)
    setFits(false)
    await apply({ kind: 'wecom-stream', text: 'Before the card.' })
    await vi.advanceTimersByTimeAsync(0)
    expect(pushes).toEqual([])
    await state.stream!.seal()
    expect(pushes.map((p) => [p.content, p.finish])).toEqual([['Before the card.', true]])
  })

  it('closes a suppressed turn’s open stream with what it last showed', async () => {
    vi.useFakeTimers()
    const { port, pushes } = fakePort()
    const surface = createWeComTurnOutput({
      appendTranscript: async () => {},
      monotonicTs: () => '1',
      warn: () => {}
    })
    const message = { msgId: 'wecom:aibot-example:msg-1', channel: CHANNEL, isDm: true } as NormalizedMessage
    const ctx = { mode: 'medium', isDm: true, showFooter: true, message, egress: port }
    expect(surface.answerDelivery!(ctx)).toBe('live')
    expect(surface.answerDelivery!({ ...ctx, mode: 'none' })).toBe('staged')
    const pending = { ...turn, turnState: surface.initialTurnState(ctx) } as never
    await surface.apply(pending, { kind: 'wecom-stream', text: 'Halfway' } as never)
    await vi.advanceTimersByTimeAsync(0)
    surface.onSuppress!(pending)
    await surface.apply(pending, { kind: 'wecom-stream', text: 'Halfway there' } as never)
    await vi.advanceTimersByTimeAsync(WECOM_REFRESH_MS)
    await surface.onSettle!(pending)
    expect(pushes.map((p) => [p.content, p.finish])).toEqual([
      ['Halfway', false],
      ['Halfway', true]
    ])
  })

  it('answers through a real connection under the callback req_id', async () => {
    const server = new FakeWeComServer()
    const messages: NormalizedMessage[] = []
    const conn = new WeComConnection(
      { botId: 'aibot-example', secret: 'secret-placeholder', integrations: [] },
      { onMessage: (msg) => messages.push(msg), log: quietLog, createSocket: server.createSocket }
    )
    try {
      await conn.start()
      server.last.message('req-live', {
        msgid: 'msg-1',
        aibotid: 'aibot-example',
        chattype: 'single',
        from: { userid: 'user-alice' },
        msgtype: 'text',
        text: { content: 'hi' }
      })
      const { apply } = harness(conn)
      await apply({ kind: 'post', text: 'Hi there.' })
      const [frame] = server.last.frames('aibot_respond_msg')
      expect(frame!.headers.req_id).toBe('req-live')
      expect(frame!.body).toMatchObject({ msgtype: 'stream', stream: { content: 'Hi there.', finish: true } })
      expect(messages).toHaveLength(1)
    } finally {
      await conn.stop()
    }
  })
})

describe('WeCom cut point', () => {
  it('prefers a paragraph break, then a line break, then the byte edge', () => {
    expect(weComCutPoint('aaaa\n\nbbbb\ncccc', 12)).toBe(6)
    expect(weComCutPoint('aaaa\nbbbbbbbbbb', 8)).toBe(5)
    expect(weComCutPoint('界界界界', 7)).toBe(2)
  })
})

describe('WeCom converger', () => {
  const chunk = (text: string, messageId?: string): SessionUpdate =>
    ({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text },
      ...(messageId ? { messageId } : {})
    }) as SessionUpdate

  it('streams every text block of the turn as one growing answer and posts it once', () => {
    const conv = new WeComConverger('low')
    expect(conv.onUpdate(chunk('Looking'))).toEqual([{ kind: 'wecom-stream', text: 'Looking' }])
    conv.onUpdate({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'read', status: 'pending' } as SessionUpdate)
    expect(conv.onUpdate(chunk('Found it.'))).toEqual([{ kind: 'wecom-stream', text: 'Looking\n\nFound it.' }])
    expect(conv.onFinal()).toEqual([{ kind: 'post', text: 'Looking\n\nFound it.' }])
    expect(conv.onFinal()).toEqual([])
  })

  it('records without streaming in the none mode', () => {
    const conv = new WeComConverger('none')
    expect(conv.onUpdate(chunk('Quiet'))).toEqual([])
    expect(conv.onFinal()).toEqual([{ kind: 'post', text: 'Quiet', recordOnly: true }])
  })
})

describe('WeCom session placement', () => {
  const msg = (over: Partial<NormalizedMessage>) =>
    ({
      platform: 'wecom',
      msgId: 'wecom:aibot-example:m',
      channel: 'chat-example-group',
      isDm: false,
      ...over
    }) as NormalizedMessage

  it('keeps one session per person in a direct chat and one per group', async () => {
    const dm = msg({ isDm: true, channel: 'dm:user-alice' })
    await canonicalizeWeComThread(undefined, dm)
    expect(dm.thread).toBe('dm')
    const group = msg({})
    await canonicalizeWeComThread(undefined, group)
    expect(group.thread).toBe('group')
    const second = msg({ msgId: 'wecom:aibot-example:m2' })
    await canonicalizeWeComThread(undefined, second)
    expect(second.thread).toBe(group.thread)
  })

  it('leaves a thread core already placed, and other platforms, alone', async () => {
    const placed = msg({ thread: 'append:1700000000000' })
    await canonicalizeWeComThread(undefined, placed)
    expect(placed.thread).toBe('append:1700000000000')
    const other = msg({ platform: 'qq' })
    await canonicalizeWeComThread(undefined, other)
    expect(other.thread).toBeUndefined()
  })
})
