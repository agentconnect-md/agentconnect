/**
 * slack-streaming-turn-output.md — the CHROME-ONLY stream.
 *
 * The invariants worth pinning are the ones the design argues from rather than the plumbing:
 * the body pipeline is byte-identical whether or not a turn streams, every stop is preceded by
 * a settle append (Slack renders "Something went wrong" otherwise), a cancel settles in-flight
 * cards as errors, a dead stream is never revived or replaced, and a turn that cannot stream
 * renders today's `progress` message instead.
 */
import { describe, expect, it, vi } from 'vitest'
import { SlackConnection, type SlackStreamAppendOutcome, type SlackTurnStream } from '../src/slack/connection.js'
import { OutputConverger, type SlackAction, type SlackStreamChunk } from '../src/slack/render.js'
import {
  applySlackAction,
  slackStreamRecipient,
  type SlackTurn,
  type SlackTurnHost,
  type SlackTurnState
} from '../src/platforms/slack/turn-output.js'

const chunk = (text: string) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }) as never
const tool = (id: string, title: string, status = 'pending') =>
  ({ sessionUpdate: 'tool_call', toolCallId: id, title, status }) as never
const toolDone = (id: string, title: string, output: string, status = 'completed') =>
  ({
    sessionUpdate: 'tool_call_update',
    toolCallId: id,
    title,
    status,
    content: [{ type: 'content', content: { type: 'text', text: output } }]
  }) as never
const think = (text: string) => ({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } }) as never

const attribution = () => ({
  botName: 'Bot A',
  botUrl: 'https://console.example.test/agents/bot-a',
  runtime: 'Claude',
  model: 'opus',
  sessionUrl: 'https://console.example.test/sessions/1'
})

function streaming(mode: 'none' | 'minimal' | 'low' | 'medium' | 'high', addresses: string[] = []): OutputConverger {
  const converger = new OutputConverger(mode, addresses)
  converger.enableStreaming()
  return converger
}

const appends = (actions: SlackAction[]): SlackStreamChunk[] =>
  actions.flatMap((action) => (action.kind === 'stream-append' ? action.chunks : []))

const cards = (actions: SlackAction[]): SlackStreamChunk[] => appends(actions).filter((c) => c.type === 'task_update')

const kinds = (actions: SlackAction[]): string[] => actions.map((a) => a.kind)

describe('OutputConverger streaming axis', () => {
  it('takes the axis only on the rungs that have tool chrome at all', () => {
    for (const mode of ['none', 'minimal', 'low'] as const) expect(streaming(mode).isStreaming()).toBe(false)
    for (const mode of ['medium', 'high'] as const) expect(streaming(mode).isStreaming()).toBe(true)
  })

  it('leaves the BODY byte-identical to the legacy pipeline', () => {
    // The whole point of the chrome-only shape: the answer takes the same path either way.
    for (const mode of ['medium', 'high'] as const) {
      const streamed = streaming(mode)
      const legacy = new OutputConverger(mode)
      for (const converger of [streamed, legacy]) {
        converger.onUpdate(chunk('Hello world'))
        converger.onUpdate(think('weighing it up'))
        converger.onUpdate(toolDone('t1', 'Read file', 'read 42 lines'))
      }
      const streamedFinal = streamed.onFinal(attribution())
      const legacyFinal = legacy.onFinal(attribution())
      const bodyOnly = (actions: SlackAction[]): SlackAction[] =>
        actions.filter((a) => !a.kind.startsWith('stream-') && a.kind !== 'progress')
      expect(bodyOnly(streamedFinal)).toEqual(bodyOnly(legacyFinal))
      // …and every `post` is a real post, never demoted to a transcript-only copy.
      expect(streamedFinal.some((a) => a.kind === 'post' && a.recordOnly)).toBe(false)
    }
  })

  it('replaces the in-place progress message rather than adding to it', () => {
    const converger = streaming('medium')
    const actions = converger.onUpdate(tool('t1', 'Read file'))
    expect(actions.some((a) => a.kind === 'progress')).toBe(false)
    // The legacy pipeline still emits it, on the same update.
    expect(new OutputConverger('medium').onUpdate(tool('t1', 'Read file')).some((a) => a.kind === 'progress')).toBe(
      true
    )
  })

  it('never streams a markdown_text chunk — this stream carries chrome only', () => {
    const converger = streaming('high')
    converger.onUpdate(chunk('a long answer'))
    converger.onUpdate(tool('t1', 'Read file'))
    const all = [...converger.streamUpdate(), ...converger.onFinal(attribution())]
    expect(appends(all).every((c) => c.type !== ('markdown_text' as string))).toBe(true)
  })

  it('opens the stream lazily, at the first card — a turn with no tools never opens one', () => {
    const noTools = streaming('high')
    noTools.onUpdate(chunk('just an answer'))
    expect(noTools.hasStreamingUpdate()).toBe(false)
    expect(noTools.streamUpdate()).toEqual([])
    // …and nothing is settled either: there is no message to settle.
    expect(noTools.onFinal(attribution()).some((a) => a.kind.startsWith('stream-'))).toBe(false)

    const withTools = streaming('high')
    withTools.onUpdate(tool('t1', 'Read file'))
    expect(kinds(withTools.streamUpdate())).toEqual(['stream-start', 'stream-append'])
    // Only the FIRST batch opens it.
    withTools.onUpdate(tool('t2', 'Run tests'))
    expect(kinds(withTools.streamUpdate())).toEqual(['stream-append'])
  })

  it('turns tool calls into cards keyed by toolCallId', () => {
    const converger = streaming('medium')
    converger.onUpdate(tool('t1', 'Read file'))
    converger.onUpdate(tool('t1', 'Read file', 'completed'))
    converger.onUpdate(tool('t2', 'Run tests', 'failed'))
    expect(cards(converger.streamUpdate())).toEqual([
      { type: 'task_update', id: 't1', title: 'Read file', status: 'complete' },
      { type: 'task_update', id: 't2', title: 'Run tests', status: 'error' }
    ])
  })

  it('collapses a burst of updates for one tool into its newest state', () => {
    const converger = streaming('high')
    converger.onUpdate(tool('t1', 'Read file'))
    converger.onUpdate(tool('t1', 'Read file', 'in_progress'))
    expect(cards(converger.streamUpdate())).toEqual([
      { type: 'task_update', id: 't1', title: 'Read file', status: 'in_progress' }
    ])
    // An unchanged repeat emits nothing at all.
    converger.onUpdate(tool('t1', 'Read file', 'in_progress'))
    expect(converger.streamUpdate()).toEqual([])
  })

  it('labels the container while working and settles it to a counted summary', () => {
    const converger = streaming('medium')
    converger.onUpdate(tool('t1', 'Read file', 'completed'))
    expect(appends(converger.streamUpdate()).at(-1)).toEqual({ type: 'plan_update', title: 'Working…' })
    converger.onUpdate(tool('t2', 'Run tests', 'completed'))
    converger.streamUpdate()
    expect(appends(converger.onFinal(attribution())).filter((c) => c.type === 'plan_update')).toEqual([
      { type: 'plan_update', title: 'Completed 2 steps' }
    ])
  })

  it('names failed steps in the closing label rather than folding them into a success', () => {
    const converger = streaming('medium')
    converger.onUpdate(tool('t1', 'Read file', 'completed'))
    converger.onUpdate(tool('t2', 'Run tests', 'failed'))
    converger.streamUpdate()
    expect(appends(converger.onFinal(attribution())).filter((c) => c.type === 'plan_update')).toEqual([
      { type: 'plan_update', title: 'Completed 2 steps · 1 failed' }
    ])
  })

  it('settles every open card BEFORE the stop, because a stop with live cards is destructive', () => {
    const converger = streaming('medium')
    converger.onUpdate(tool('t1', 'Read file'))
    converger.onUpdate(tool('t2', 'Run tests'))
    converger.streamUpdate()
    const finals = converger.onFinal(attribution())
    const settle = finals.findIndex((a) => a.kind === 'stream-append')
    const stop = finals.findIndex((a) => a.kind === 'stream-stop')
    expect(settle).toBeGreaterThanOrEqual(0)
    expect(stop).toBe(finals.length - 1)
    expect(settle).toBeLessThan(stop)
    expect(appends(finals)).toEqual([
      { type: 'task_update', id: 't1', title: 'Read file', status: 'complete' },
      { type: 'task_update', id: 't2', title: 'Run tests', status: 'complete' },
      { type: 'plan_update', title: 'Completed 2 steps' }
    ])
  })

  it('settles a cancelled turn as errors under a Stopped label', () => {
    const converger = streaming('high')
    converger.onUpdate(tool('t1', 'Read file', 'completed'))
    converger.onUpdate(tool('t2', 'Run tests'))
    converger.streamUpdate()
    const settled = converger.settleStream('stopped')
    // Only the IN-FLIGHT card flips; a step that really finished keeps its status.
    expect(appends(settled)).toEqual([
      { type: 'task_update', id: 't2', title: 'Run tests', status: 'error' },
      { type: 'plan_update', title: 'Stopped' }
    ])
    expect(settled.at(-1)).toEqual({ kind: 'stream-stop' })
  })

  it('settles exactly once per turn, whichever seam gets there first', () => {
    const converger = streaming('medium')
    converger.onUpdate(tool('t1', 'Read file'))
    converger.streamUpdate()
    expect(converger.settleStream('stopped')).not.toEqual([])
    expect(converger.settleStream('completed')).toEqual([])
    expect(converger.onFinal(attribution()).some((a) => a.kind.startsWith('stream-'))).toBe(false)
    // A settled stream takes no further card updates either.
    converger.onUpdate(tool('t2', 'Run tests'))
    expect(converger.hasStreamingUpdate()).toBe(false)
    expect(converger.streamUpdate()).toEqual([])
  })

  it('settles a turn that never opened a stream without emitting anything', () => {
    const converger = streaming('medium')
    expect(converger.settleStream('stopped')).toEqual([])
  })

  it('settles the stream on a terminal failure too, as a finished turn rather than a stopped one', () => {
    const converger = streaming('medium')
    converger.onUpdate(chunk('partial answer'))
    converger.onUpdate(tool('t1', 'Read file'))
    converger.streamUpdate()
    const terminal = converger.flushTerminal()
    // The tool calls did not fail; the turn did, and the ⚠️ notice carries that in the body.
    expect(appends(terminal)).toEqual([
      { type: 'task_update', id: 't1', title: 'Read file', status: 'complete' },
      { type: 'plan_update', title: 'Completed 1 step' }
    ])
    expect(terminal.at(-1)).toEqual({ kind: 'stream-stop' })
  })

  it('settles a silent turn that still ran tools', () => {
    const converger = streaming('medium')
    converger.onUpdate(tool('t1', 'Read file'))
    converger.streamUpdate()
    converger.onUpdate(chunk('AC_NO_RESPONSE'))
    const finals = converger.onFinal(attribution())
    expect(finals.at(-1)).toEqual({ kind: 'stream-stop' })
    expect(appends(finals)).toContainEqual({ type: 'plan_update', title: 'Completed 1 step' })
  })

  it('writes a completed card its output exactly once, on high only', () => {
    const high = streaming('high')
    high.onUpdate(tool('t1', 'Read file'))
    high.streamUpdate()
    high.onUpdate(toolDone('t1', 'Read file', 'read 42 lines'))
    expect(cards(high.streamUpdate())).toEqual([
      { type: 'task_update', id: 't1', title: 'Read file', status: 'complete', output: 'read 42 lines' }
    ])
    // A repeat of the terminal update must not append a second copy — `output` accumulates.
    high.onUpdate(toolDone('t1', 'Read file', 'read 42 lines'))
    expect(high.streamUpdate()).toEqual([])

    const medium = streaming('medium')
    medium.onUpdate(tool('t1', 'Read file'))
    medium.streamUpdate()
    medium.onUpdate(toolDone('t1', 'Read file', 'read 42 lines'))
    const mediumCard = cards(medium.streamUpdate())[0]
    expect(mediumCard).toEqual({ type: 'task_update', id: 't1', title: 'Read file', status: 'complete' })
    expect(mediumCard && 'output' in mediumCard).toBe(false)
  })

  it('flattens markdown emphasis out of card fields, which render as plain text', () => {
    const converger = streaming('medium')
    converger.onUpdate(tool('t1', '**Read** `src/a.ts`'))
    expect(cards(converger.streamUpdate())).toEqual([
      { type: 'task_update', id: 't1', title: 'Read src/a.ts', status: 'in_progress' }
    ])
  })

  it('clamps a card field to the 256-character wire limit', () => {
    const converger = streaming('high')
    converger.onUpdate(toolDone('t1', 'x'.repeat(400), 'y'.repeat(400)))
    const card = cards(converger.streamUpdate())[0]
    expect(card?.type === 'task_update' && card.title.length).toBe(256)
    expect(card?.type === 'task_update' && card.output?.length).toBe(256)
  })

  it('gives a thinking run one card and settles it at the next tool call', () => {
    const converger = streaming('medium')
    converger.onUpdate(think('weighing the options'))
    // Title and status only. `details` appends server-side, so a per-line refresh concatenates
    // instead of replacing — which is how repeated emphasis ran together into literal `****`.
    expect(cards(converger.streamUpdate())).toEqual([
      { type: 'task_update', id: 'thinking-0', title: 'Thinking', status: 'in_progress' }
    ])
    converger.onUpdate(think('\nand another line'))
    converger.onUpdate(think('\nand a third'))
    expect(converger.streamUpdate()).toEqual([])
    converger.onUpdate(tool('t1', 'Read file'))
    expect(cards(converger.streamUpdate())).toContainEqual({
      type: 'task_update',
      id: 'thinking-0',
      title: 'Thinking',
      status: 'complete'
    })
  })

  it('keeps high mode its own in-place Thinking message beside the card', () => {
    const converger = streaming('high')
    converger.onUpdate(think('weighing the options'))
    expect(converger.flushBuffered().some((a) => a.kind === 'reasoning')).toBe(true)
  })

  it('keeps the ACP plan on its own message — a checklist is not a container label', () => {
    const converger = streaming('medium')
    const actions = converger.onUpdate({
      sessionUpdate: 'plan',
      entries: [{ content: 'step one', status: 'pending' }]
    } as never)
    expect(actions.some((a) => a.kind === 'plan')).toBe(true)
    expect(appends(actions)).toEqual([])
  })

  it('still rotates the transient status text — the stream owns no status slot', () => {
    const converger = streaming('medium')
    expect(converger.onUpdate(tool('t1', 'Read file')).some((a) => a.kind === 'set-status')).toBe(true)
    expect(converger.onFinal(attribution()).some((a) => a.kind === 'set-status' && a.text === '')).toBe(true)
  })

  it('carries the legacy progress rendering on the append, so a turn that cannot stream degrades', () => {
    const converger = streaming('medium')
    converger.onUpdate(tool('t1', 'Read file'))
    const append = converger.streamUpdate().find((a) => a.kind === 'stream-append')
    expect(append).toMatchObject({ progressText: ':hammer_and_wrench: `Read file`' })
    // A thinking-only batch has no legacy form, so it carries none.
    const thinking = streaming('medium')
    thinking.onUpdate(think('weighing it up'))
    expect(thinking.streamUpdate().find((a) => a.kind === 'stream-append')).not.toHaveProperty('progressText')
  })
})

describe('slackStreamRecipient', () => {
  const sender = (over: Record<string, unknown> = {}) => ({ id: 'U1', ...over })

  it('names the human that started the turn', () => {
    expect(slackStreamRecipient({ source: 'user', sender: sender() })).toBe('U1')
  })

  it('has no human for a cron / hook / headless / agent-to-agent turn — the bot names itself', () => {
    expect(slackStreamRecipient({ source: 'cron', sender: sender() })).toBeUndefined()
    expect(slackStreamRecipient({ source: 'hook', sender: sender() })).toBeUndefined()
    expect(slackStreamRecipient({ source: 'agent', sender: sender() })).toBeUndefined()
    expect(slackStreamRecipient({ source: 'user', headless: true, sender: sender() })).toBeUndefined()
    expect(slackStreamRecipient({ source: 'user', sender: sender({ isBot: true }) })).toBeUndefined()
  })
})

describe('applySlackAction — chrome stream actions', () => {
  function fixture(over: Record<string, unknown> = {}, plan: Record<string, unknown> = {}) {
    const conn = {
      startTurnStream: vi.fn(async (channel: string, threadTs: string, _o?: unknown) => ({
        channel,
        threadTs,
        ts: '900.1'
      })),
      appendTurnStream: vi.fn(
        async (_stream: SlackTurnStream, _chunks: SlackStreamChunk[]) => 'ok' as SlackStreamAppendOutcome
      ),
      stopTurnStream: vi.fn(async (_stream: SlackTurnStream, _options?: Record<string, unknown>) => true),
      updateMessage: vi.fn(async (_c: string, _ts: string, _text: string, _chrome?: boolean) => true),
      postMessage: vi.fn(async (_channel: string, _text: string, _thread?: string, _options?: unknown) => 'p1'),
      setStatus: vi.fn(async () => {}),
      ...over
    }
    const turn: SlackTurn = {
      conn,
      plan: {
        channel: 'C1',
        thread: 'T1',
        statusThread: 'T1',
        transcriptChannel: 'C1',
        agentId: 'bot-a',
        agentName: 'Bot A',
        iconUrl: 'https://icons.example.test/a.png',
        sessionKey: 'k',
        platform: 'slack',
        isDm: false,
        ...plan
      },
      chrome: {},
      reply: { responseId: 'resp-1' }
    }
    const state: SlackTurnState = { recipient: 'U1' }
    const host: SlackTurnHost<typeof turn> = {
      recordReplySegment: vi.fn(),
      appendTranscript: vi.fn(),
      getStatusBarTs: vi.fn(async () => undefined),
      setStatusBarTs: vi.fn(),
      clearStatusBarTs: vi.fn(),
      monotonicTs: () => '1',
      debug: vi.fn()
    }
    return {
      conn,
      turn,
      state,
      host,
      apply: (action: SlackAction) => applySlackAction(host, turn as never, state, action)
    }
  }

  const card = (id: string, status: 'in_progress' | 'complete' | 'error'): SlackStreamChunk => ({
    type: 'task_update',
    id,
    title: 'Read file',
    status
  })

  it('opens the stream with the recipient and the agent identity, and records the handle', async () => {
    const { apply, conn, state } = fixture()
    await apply({ kind: 'stream-start' })
    expect(conn.startTurnStream).toHaveBeenCalledWith('C1', 'T1', {
      isDm: false,
      recipientUserId: 'U1',
      identity: { username: 'Bot A', icon_url: 'https://icons.example.test/a.png' }
    })
    expect(state.stream).toEqual({ channel: 'C1', threadTs: 'T1', ts: '900.1' })
  })

  it('carries no identity in a DM, exactly like the progress message it replaces', async () => {
    const { apply, conn } = fixture({}, { isDm: true })
    await apply({ kind: 'stream-start' })
    expect(conn.startTurnStream).toHaveBeenCalledWith('C1', 'T1', { isDm: true, recipientUserId: 'U1' })
  })

  it('refuses to open a second stream beside a live one', async () => {
    const { apply, conn } = fixture()
    await apply({ kind: 'stream-start' })
    await apply({ kind: 'stream-start' })
    expect(conn.startTurnStream).toHaveBeenCalledOnce()
  })

  it('degrades to the legacy progress message when the stream cannot open', async () => {
    const { apply, conn, state } = fixture({ startTurnStream: vi.fn(async () => undefined) })
    await apply({ kind: 'stream-start' })
    expect(state.streamDegraded).toBe(true)
    await apply({ kind: 'stream-append', chunks: [card('t1', 'in_progress')], progressText: ':x: `Read file`' })
    expect(conn.appendTurnStream).not.toHaveBeenCalled()
    expect(conn.postMessage).toHaveBeenCalledWith(
      'C1',
      ':x: `Read file`',
      'T1',
      expect.objectContaining({ chrome: true })
    )
    // The second batch edits that one message in place, as the legacy path always did.
    await apply({ kind: 'stream-append', chunks: [card('t1', 'complete')], progressText: ':x: `Run tests`' })
    expect(conn.postMessage).toHaveBeenCalledOnce()
    expect(conn.updateMessage).toHaveBeenCalledWith('C1', 'p1', ':x: `Run tests`', true)
    // …and it never opens a replacement stream.
    await apply({ kind: 'stream-start' })
    expect(conn.startTurnStream).toHaveBeenCalledOnce()
  })

  it('renders no prose for a degraded batch that has no legacy form', async () => {
    const { apply, conn } = fixture({ startTurnStream: vi.fn(async () => undefined) })
    await apply({ kind: 'stream-start' })
    await apply({ kind: 'stream-append', chunks: [card('thinking-0', 'in_progress')] })
    expect(conn.postMessage).not.toHaveBeenCalled()
    expect(conn.updateMessage).not.toHaveBeenCalled()
  })

  it('cannot stream without a thread — a streamed message must be a reply', async () => {
    const { apply, conn, state } = fixture({}, { thread: undefined })
    await apply({ kind: 'stream-start' })
    expect(conn.startTurnStream).not.toHaveBeenCalled()
    expect(state.streamDegraded).toBe(true)
  })

  it('drops one refused card update and keeps the handle for the stop', async () => {
    const { apply, conn, state } = fixture({
      appendTurnStream: vi.fn(
        async (_s: SlackTurnStream, _c: SlackStreamChunk[]) => 'refused' as SlackStreamAppendOutcome
      )
    })
    await apply({ kind: 'stream-start' })
    await apply({ kind: 'stream-append', chunks: [card('t1', 'in_progress')], progressText: ':x: `Read file`' })
    // Chrome is lossy-tolerant: nothing is re-delivered by another route, and nothing degrades.
    expect(conn.postMessage).not.toHaveBeenCalled()
    expect(state.streamDegraded).toBeUndefined()
    expect(state.stream).toEqual({ channel: 'C1', threadTs: 'T1', ts: '900.1' })
    await apply({ kind: 'stream-stop' })
    expect(conn.stopTurnStream).toHaveBeenCalledOnce()
  })

  it('kills the stream for good once an append reports it stopped', async () => {
    const { apply, conn, state } = fixture({
      appendTurnStream: vi.fn(
        async (_s: SlackTurnStream, _c: SlackStreamChunk[]) => 'stopped' as SlackStreamAppendOutcome
      )
    })
    await apply({ kind: 'stream-start' })
    await apply({ kind: 'stream-append', chunks: [card('t1', 'in_progress')], progressText: ':x: `Read file`' })
    expect(state.streamDead).toBe(true)
    expect(state.stream).toBeUndefined()

    // Everything still queued for this turn is inert: no append, no stop, no replacement
    // message of any kind — not even the legacy progress one.
    await apply({ kind: 'stream-append', chunks: [card('t2', 'complete')], progressText: ':x: `Run tests`' })
    await apply({ kind: 'stream-start' })
    await apply({ kind: 'stream-stop' })
    expect(conn.appendTurnStream).toHaveBeenCalledOnce()
    expect(conn.startTurnStream).toHaveBeenCalledOnce()
    expect(conn.stopTurnStream).not.toHaveBeenCalled()
    expect(conn.postMessage).not.toHaveBeenCalled()
  })

  it('stamps the chrome marker on the stop so a peer backfill skips the finalized card', async () => {
    const { apply, conn, state } = fixture()
    await apply({ kind: 'stream-start' })
    await apply({ kind: 'stream-stop' })
    expect(conn.stopTurnStream).toHaveBeenCalledWith(
      { channel: 'C1', threadTs: 'T1', ts: '900.1' },
      { chromeOwnerAgentId: 'bot-a' }
    )
    expect(state.stream).toBeUndefined()
    expect(state.streamDead).toBe(true)
  })

  it('keeps the handle when Slack leaves the message streaming, so settlement can retry', async () => {
    let settled = false
    const { apply, conn, state } = fixture({
      stopTurnStream: vi.fn(async (_s: SlackTurnStream, _o?: Record<string, unknown>) => settled)
    })
    await apply({ kind: 'stream-start' })
    await apply({ kind: 'stream-stop' })
    expect(state.stream).toEqual({ channel: 'C1', threadTs: 'T1', ts: '900.1' })
    expect(state.streamDead).toBeUndefined()

    settled = true
    await apply({ kind: 'stream-stop' })
    expect(state.stream).toBeUndefined()
    expect(conn.stopTurnStream).toHaveBeenCalledTimes(2)
  })

  it('leaves the transient status alone — the two do not share a slot here', async () => {
    const { apply, conn } = fixture()
    await apply({ kind: 'stream-start' })
    await apply({ kind: 'set-status', text: 'is thinking…' })
    expect(conn.setStatus).toHaveBeenCalledOnce()
  })
})

describe('SlackConnection chrome streaming', () => {
  const deps = (over: Record<string, unknown> = {}) => ({
    group: { appToken: 'xapp-1', botToken: 'xoxb-a', integrations: [] },
    onMessage: () => {},
    newTraceId: () => 't',
    sendIntervalMs: 0,
    ...over
  })

  function streamApp(over: Record<string, unknown> = {}) {
    return {
      message() {},
      event() {},
      action() {},
      shortcut() {},
      client: {
        auth: { test: async () => ({ user_id: 'UBOT', bot_id: 'B1', team_id: 'T123' }) },
        views: { open: async () => ({}), update: async () => ({}) },
        chat: {
          postMessage: async () => ({ ts: '1.1' }),
          getPermalink: async () => ({ permalink: 'https://example.test/t' }),
          update: async () => ({}),
          delete: async () => ({}),
          startStream: vi.fn(async (_a: Record<string, unknown>) => ({ ts: '900.1' })),
          appendStream: vi.fn(async (_a: Record<string, unknown>) => ({})),
          stopStream: vi.fn(async (_a: Record<string, unknown>) => ({})),
          ...(over.chat ?? {})
        },
        assistant: { threads: { setStatus: async () => ({}) } },
        apiCall: vi.fn(async (_method: string, _args?: Record<string, unknown>) => ({}))
      },
      start: async () => {},
      stop: async () => {}
    }
  }

  const slackError = (code: string) =>
    Object.assign(new Error(`An API error occurred: ${code}`), { data: { error: code } })

  async function connect(over: Record<string, unknown> = {}, depsOver: Record<string, unknown> = {}) {
    const app = streamApp(over)
    const conn = new SlackConnection(deps(depsOver) as never, () => app as never)
    await conn.start()
    return { conn, app }
  }

  const readFile: SlackStreamChunk = { type: 'task_update', id: 't1', title: 'Read file', status: 'complete' }

  it('opens, appends and settles one cards-only message through the typed SDK methods', async () => {
    const { conn, app } = await connect()
    expect(conn.streamingLikely()).toBe(true)
    const stream = await conn.startTurnStream('C1', 'T1', { recipientUserId: 'U9', identity: { username: 'Bot A' } })
    expect(stream).toEqual({ channel: 'C1', threadTs: 'T1', ts: '900.1' })
    expect(app.client.chat.startStream).toHaveBeenCalledWith({
      channel: 'C1',
      // thread_ts is REQUIRED live, in DMs too — omitting it fails invalid_thread_ts.
      thread_ts: 'T1',
      // The collapsed container: every task card folded behind one chevron.
      task_display_mode: 'plan',
      recipient_user_id: 'U9',
      recipient_team_id: 'T123',
      username: 'Bot A'
    })
    await conn.appendTurnStream(stream!, [readFile])
    expect(app.client.chat.appendStream).toHaveBeenCalledWith({ channel: 'C1', ts: '900.1', chunks: [readFile] })
    await conn.stopTurnStream(stream!, { chromeOwnerAgentId: 'bot-a' })
    const stop = app.client.chat.stopStream.mock.calls[0]![0] as Record<string, unknown>
    expect(stop).toMatchObject({ channel: 'C1', ts: '900.1' })
    // The chrome marker a peer's thread backfill skips on — and never the session enum.
    expect(stop.metadata).toMatchObject({ event_type: 'agentconnect_chrome' })
    expect(stop).not.toHaveProperty('session_status')
  })

  it('names the bot itself when a channel turn has no human initiator', async () => {
    const { conn, app } = await connect()
    await conn.startTurnStream('C1', 'T1')
    expect(app.client.chat.startStream).toHaveBeenCalledWith(
      expect.objectContaining({ recipient_user_id: 'UBOT', recipient_team_id: 'T123' })
    )
  })

  it('sends no recipient at all in a DM', async () => {
    const { conn, app } = await connect()
    await conn.startTurnStream('D1', 'T1', { isDm: true })
    const payload = app.client.chat.startStream.mock.calls[0]![0] as Record<string, unknown>
    expect(payload).not.toHaveProperty('recipient_user_id')
    expect(payload).not.toHaveProperty('recipient_team_id')
  })

  it('answers "cannot stream" when the SDK has no such method, and latches it', async () => {
    const { conn } = await connect({ chat: { startStream: undefined } })
    expect(await conn.startTurnStream('C1', 'T1')).toBeUndefined()
    expect(conn.streamingLikely()).toBe(false)
  })

  it('latches a CAPABILITY refusal off for the whole connection', async () => {
    for (const code of ['unknown_method', 'missing_scope', 'channel_type_not_supported', 'messages_tab_disabled']) {
      const { conn } = await connect({
        chat: {
          startStream: vi.fn(async () => {
            throw slackError(code)
          })
        }
      })
      expect(await conn.startTurnStream('C1', 'T1')).toBeUndefined()
      expect(conn.streamingLikely()).toBe(false)
    }
  })

  it('degrades only the turn on a CONTEXTUAL refusal — one bad channel must not kill streaming', async () => {
    for (const code of ['channel_not_found', 'not_in_channel', 'missing_recipient_user_id', 'ratelimited']) {
      const { conn } = await connect({
        chat: {
          startStream: vi.fn(async () => {
            throw slackError(code)
          })
        }
      })
      expect(await conn.startTurnStream('C1', 'T1')).toBeUndefined()
      expect(conn.streamingLikely()).toBe(true)
    }
  })

  it('retries the open undecorated when the workspace lacks chat:write.customize', async () => {
    const startStream = vi.fn(async (args: Record<string, unknown>) => {
      if (args.username !== undefined)
        throw Object.assign(new Error('An API error occurred: missing_scope'), {
          data: { error: 'missing_scope', needed: 'chat:write.customize' }
        })
      return { ts: '900.1' }
    })
    const { conn } = await connect({ chat: { startStream } })
    expect(await conn.startTurnStream('C1', 'T1', { identity: { username: 'Bot A' } })).toMatchObject({ ts: '900.1' })
    expect(startStream).toHaveBeenCalledTimes(2)
    // The decoration cooldown absorbed it; streaming itself is untouched.
    expect(conn.streamingLikely()).toBe(true)
  })

  it('stops exactly once per message, however many times the turn asks', async () => {
    const { conn, app } = await connect()
    const stream = (await conn.startTurnStream('C1', 'T1'))!
    expect(await conn.stopTurnStream(stream)).toBe(true)
    // Still "settled" — the caller's question is whether the message is streaming, and it is
    // not; only an unresolved answer asks for a retry.
    expect(await conn.stopTurnStream(stream)).toBe(true)
    expect(app.client.chat.stopStream).toHaveBeenCalledOnce()
  })

  it('keeps a stop retryable while Slack leaves the message streaming', async () => {
    let attempts = 0
    const stopStream = vi.fn(async () => {
      if (++attempts === 1) throw slackError('ratelimited')
      return {}
    })
    const { conn } = await connect({ chat: { stopStream } })
    const stream = (await conn.startTurnStream('C1', 'T1'))!
    expect(await conn.stopTurnStream(stream)).toBe(false)
    expect(await conn.stopTurnStream(stream)).toBe(true)
    expect(stopStream).toHaveBeenCalledTimes(2)
    // …and once accepted, it is retired for good.
    expect(await conn.stopTurnStream(stream)).toBe(true)
    expect(stopStream).toHaveBeenCalledTimes(2)
  })

  it('retires the handle on a DEFINITE already-stopped answer, without retrying', async () => {
    for (const code of ['message_not_in_streaming_state', 'stopped_by_user']) {
      const stopStream = vi.fn(async () => {
        throw slackError(code)
      })
      const { conn } = await connect({ chat: { stopStream } })
      const stream = (await conn.startTurnStream('C1', 'T1'))!
      expect(await conn.stopTurnStream(stream)).toBe(true)
      expect(await conn.stopTurnStream(stream)).toBe(true)
      expect(stopStream).toHaveBeenCalledOnce()
      // A settled message is not a lost capability.
      expect(conn.streamingLikely()).toBe(true)
    }
  })

  it('reads a stopped_by_user append refusal as `stopped`, and never appends again', async () => {
    const appendStream = vi.fn(async () => {
      throw slackError('stopped_by_user')
    })
    const { conn, app } = await connect({ chat: { appendStream } })
    const stream = (await conn.startTurnStream('C1', 'T1'))!
    expect(await conn.appendTurnStream(stream, [readFile])).toBe('stopped')
    expect(await conn.appendTurnStream(stream, [readFile])).toBe('refused')
    expect(appendStream).toHaveBeenCalledOnce()
    // Nothing is stopped against a message the person already ended.
    expect(await conn.stopTurnStream(stream)).toBe(true)
    expect(app.client.chat.stopStream).not.toHaveBeenCalled()
    expect(conn.streamingLikely()).toBe(true)
  })

  it('keeps the handle after a TRANSIENT append failure, so the stop can still land', async () => {
    const { conn, app } = await connect({
      chat: {
        appendStream: vi.fn(async () => {
          throw slackError('ratelimited')
        })
      }
    })
    const stream = (await conn.startTurnStream('C1', 'T1'))!
    expect(await conn.appendTurnStream(stream, [readFile])).toBe('refused')
    expect(await conn.stopTurnStream(stream)).toBe(true)
    expect(app.client.chat.stopStream).toHaveBeenCalledOnce()
  })

  it('never ingests a streaming chrome message as conversation', async () => {
    const seen: unknown[] = []
    const app = streamApp()
    let deliver: ((a: { message: unknown }) => Promise<void>) | undefined
    app.message = ((handler: (a: { message: unknown }) => Promise<void>) => {
      deliver = handler
    }) as never
    const conn = new SlackConnection(deps({ onMessage: (m: unknown) => seen.push(m) }) as never, () => app as never)
    await conn.start()
    // An OPEN stream carries no metadata — only Slack's placeholder body and the state marker.
    await deliver!({
      message: {
        type: 'message',
        channel: 'C1',
        ts: '900.1',
        bot_id: 'BPEER',
        text: 'This message contains interactive elements.',
        streaming_state: 'in_progress'
      }
    })
    expect(seen).toEqual([])
    // The placeholder body alone is enough once the author is an app…
    await deliver!({
      message: {
        type: 'message',
        channel: 'C1',
        ts: '900.2',
        bot_id: 'BPEER',
        text: 'This message contains interactive elements.'
      }
    })
    expect(seen).toEqual([])
    // …but a PERSON typing the same sentence is ordinary conversation and must not vanish.
    await deliver!({
      message: {
        type: 'message',
        channel: 'C1',
        ts: '900.3',
        user: 'U-ALICE',
        text: 'This message contains interactive elements.'
      }
    })
    expect(seen).toHaveLength(1)
    // A real peer message on the same seam still arrives.
    await deliver!({ message: { type: 'message', channel: 'C1', ts: '900.4', bot_id: 'BPEER', text: 'hello' } })
    expect(seen).toHaveLength(2)
  })
})
