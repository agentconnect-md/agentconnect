import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Daemon } from '../src/daemon.js'
import { SlackConnection, type SlackStreamAppendOutcome, type SlackTurnStream } from '../src/slack/connection.js'
import { OutputConverger, type SlackAction, type SlackStreamChunk } from '../src/slack/render.js'
import {
  applySlackAction,
  slackStreamRecipient,
  type SlackTurn,
  type SlackTurnHost,
  type SlackTurnState
} from '../src/platforms/slack/turn-output.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'

/**
 * slack-streaming-turn-output.md (Layer 1). The invariants worth pinning are the ones the
 * design argues from rather than the plumbing: the answer rides ONE streaming message while
 * the transcript keeps its own copy, a streaming turn writes the loading TEXT but never the
 * session enum (the stream owns that), a stopped stream is never revived, and every path that
 * cannot stream degrades to today's pipeline unchanged.
 */

const chunk = (text: string) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }) as never
const tool = (id: string, title: string, status = 'pending') =>
  ({ sessionUpdate: 'tool_call', toolCallId: id, title, status }) as never
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

const streamedText = (actions: SlackAction[]): string =>
  appends(actions)
    .map((c) => (c.type === 'markdown_text' ? c.text : ''))
    .join('')

describe('OutputConverger streaming axis', () => {
  it('never streams in `none` mode — the axis cannot be enabled at all', () => {
    const converger = streaming('none')
    expect(converger.isStreaming()).toBe(false)
    expect(converger.onStart()).toEqual([])
  })

  for (const mode of ['minimal', 'low', 'medium', 'high'] as const) {
    it(`${mode}: the body rides the stream and the transcript keeps its own recordOnly copy`, () => {
      const converger = streaming(mode)
      expect(converger.onStart()).toEqual([{ kind: 'stream-start' }])
      converger.onUpdate(chunk('Hello world'))
      const finals = converger.onFinal(attribution())

      expect(streamedText(finals)).toBe('Hello world')
      // Every post on a streaming turn is transcript-only: the stream is display, the
      // transcript is the record.
      const posts = finals.filter((a) => a.kind === 'post')
      expect(posts.length).toBeGreaterThan(0)
      expect(posts.every((a) => a.kind === 'post' && a.recordOnly === true)).toBe(true)
      // The retired cadence: nothing posts, edits in place, or narrates progress.
      expect(finals.some((a) => ['live-reply', 'final-live-reply', 'progress'].includes(a.kind))).toBe(false)
      // §5: no status call of either kind — the two APIs share one slot with the stream.
      expect(finals.some((a) => a.kind === 'set-status')).toBe(false)
      // The footer rides the ONE closing stop, so there is no separate attribution action.
      expect(finals.some((a) => a.kind === 'attribution')).toBe(false)
      expect(finals.at(-1)).toMatchObject({ kind: 'stream-stop', settle: 'final', text: 'Hello world' })
    })
  }

  it('medium/high turn tool calls into task cards keyed by toolCallId', () => {
    const converger = streaming('medium')
    converger.onUpdate(tool('t1', 'Read file'))
    converger.onUpdate(tool('t1', 'Read file', 'completed'))
    converger.onUpdate(tool('t2', 'Run tests', 'failed'))
    const cards = appends(converger.streamUpdate()).filter((c) => c.type === 'task_update')
    expect(cards).toEqual([
      { type: 'task_update', id: 't1', title: 'Read file', status: 'complete' },
      { type: 'task_update', id: 't2', title: 'Run tests', status: 'error' }
    ])
  })

  it('collapses a burst of updates for one tool into its newest state', () => {
    const converger = streaming('high')
    converger.onUpdate(tool('t1', 'Read file'))
    converger.onUpdate(tool('t1', 'Read file', 'in_progress'))
    const cards = appends(converger.streamUpdate()).filter((c) => c.type === 'task_update')
    expect(cards).toEqual([{ type: 'task_update', id: 't1', title: 'Read file', status: 'in_progress' }])
  })

  it('labels the collapsed container while working and settles it to what happened', () => {
    const converger = streaming('medium')
    // The container opens with an honest working label…
    expect(converger.onStart()).toEqual([{ kind: 'stream-start' }])
    expect(appends(converger.streamUpdate())).toEqual([{ type: 'plan_update', title: 'Working…' }])
    converger.onUpdate(tool('t1', 'Read file', 'completed'))
    converger.onUpdate(tool('t2', 'Run tests', 'completed'))
    converger.streamUpdate()
    // …and settles to a counted summary — deterministic, no model call.
    const plans = appends(converger.onFinal(attribution())).filter((c) => c.type === 'plan_update')
    expect(plans).toEqual([{ type: 'plan_update', title: 'Completed 2 steps' }])
  })

  it('names a failed step in the closing label rather than folding it into a success', () => {
    const converger = streaming('medium')
    converger.onStart()
    converger.onUpdate(tool('t1', 'Read file', 'completed'))
    converger.onUpdate(tool('t2', 'Run tests', 'failed'))
    converger.streamUpdate()
    const plans = appends(converger.onFinal(attribution())).filter((c) => c.type === 'plan_update')
    expect(plans).toEqual([{ type: 'plan_update', title: 'Completed 2 steps · 1 failed' }])
  })

  it('says Done when the turn ran no steps at all', () => {
    const converger = streaming('medium')
    converger.onStart()
    converger.onUpdate(chunk('just an answer'))
    const plans = appends(converger.onFinal(attribution())).filter((c) => c.type === 'plan_update')
    expect(plans).toEqual([{ type: 'plan_update', title: 'Done' }])
  })

  it('gives minimal and low no container label — they stream body text alone', () => {
    for (const mode of ['minimal', 'low'] as const) {
      const converger = streaming(mode)
      converger.onStart()
      converger.onUpdate(chunk('an answer'))
      const chunksOut = appends(converger.onFinal(attribution()))
      expect(chunksOut.filter((c) => c.type === 'plan_update')).toEqual([])
    }
  })

  it('never lets the container label alone keep an empty message alive', () => {
    // A medium turn that produced nothing still opened a container; the label is not content,
    // so the message is still removed rather than left as an empty bubble.
    const converger = streaming('medium')
    converger.onStart()
    expect(converger.onFinal(attribution()).at(-1)).toMatchObject({ settle: 'final', discard: true })
  })

  it('writes a completed tool card its output exactly once', () => {
    const converger = streaming('high')
    converger.onUpdate(tool('t1', 'Read file'))
    expect(appends(converger.streamUpdate()).filter((c) => c.type === 'task_update')).toEqual([
      { type: 'task_update', id: 't1', title: 'Read file', status: 'in_progress' }
    ])
    const done = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 't1',
      title: 'Read file',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'read 42 lines' } }]
    } as never
    converger.onUpdate(done)
    expect(appends(converger.streamUpdate()).filter((c) => c.type === 'task_update')).toEqual([
      { type: 'task_update', id: 't1', title: 'Read file', status: 'complete', output: 'read 42 lines' }
    ])
    // A repeat of the terminal update must not append a second copy — `output` accumulates.
    converger.onUpdate(done)
    expect(appends(converger.streamUpdate())).toEqual([])
  })

  it('medium cards carry title + status but no output — the result is a high-only rung', () => {
    const converger = streaming('medium')
    converger.onUpdate(tool('t1', 'Read file'))
    converger.streamUpdate()
    converger.onUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't1',
      title: 'Read file',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'read 42 lines' } }]
    } as never)
    const cards = appends(converger.streamUpdate()).filter((c) => c.type === 'task_update')
    // The completed card has no `output` key — medium shows only that the step finished.
    expect(cards).toEqual([{ type: 'task_update', id: 't1', title: 'Read file', status: 'complete' }])
    expect(cards[0] && 'output' in cards[0]).toBe(false)
  })

  it('flattens markdown emphasis out of card labels, which render as plain text', () => {
    const converger = streaming('medium')
    converger.onUpdate(tool('t1', '**Read** `src/a.ts`'))
    expect(appends(converger.streamUpdate()).filter((c) => c.type === 'task_update')).toEqual([
      { type: 'task_update', id: 't1', title: 'Read src/a.ts', status: 'in_progress' }
    ])
  })

  it('clamps a card label to the wire limit', () => {
    const converger = streaming('medium')
    converger.onUpdate(tool('t1', 'x'.repeat(400)))
    const card = appends(converger.streamUpdate()).find((c) => c.type === 'task_update')
    expect(card?.type === 'task_update' && card.title.length).toBe(256)
  })

  it('minimal and low stream body text only — no task cards on either rung', () => {
    for (const mode of ['minimal', 'low'] as const) {
      const converger = streaming(mode)
      converger.onUpdate(tool('t1', 'Read file'))
      expect(appends(converger.streamUpdate()).filter((c) => c.type === 'task_update')).toEqual([])
    }
  })

  it('gives a thinking run one card and settles it at the next tool call', () => {
    const converger = streaming('medium')
    converger.onUpdate(think('weighing the options'))
    // Title and status only. `details` appends server-side, so a per-line refresh concatenates
    // instead of replacing — which is how repeated emphasis ran together into literal `****`.
    expect(appends(converger.streamUpdate())).toEqual([
      { type: 'task_update', id: 'thinking-0', title: 'Thinking', status: 'in_progress' }
    ])
    // More thinking must not re-send the card at all.
    converger.onUpdate(think('\nand another line'))
    converger.onUpdate(think('\nand a third'))
    expect(appends(converger.streamUpdate())).toEqual([])
    converger.onUpdate(tool('t1', 'Read file'))
    const next = appends(converger.streamUpdate())
    expect(next).toContainEqual({
      type: 'task_update',
      id: 'thinking-0',
      title: 'Thinking',
      status: 'complete'
    })
  })

  it('leaves no card spinning once the turn is over', () => {
    const converger = streaming('medium')
    converger.onUpdate(tool('t1', 'Read file'))
    converger.streamUpdate()
    const cards = appends(converger.onFinal(attribution())).filter((c) => c.type === 'task_update')
    expect(cards).toEqual([{ type: 'task_update', id: 't1', title: 'Read file', status: 'complete' }])
  })

  it('keeps the ACP plan on its own message — a checklist is not a timeline of cards', () => {
    const converger = streaming('medium')
    const actions = converger.onUpdate({
      sessionUpdate: 'plan',
      entries: [{ content: 'step one', status: 'pending' }]
    } as never)
    expect(actions.some((a) => a.kind === 'plan')).toBe(true)
  })

  it('flushes at ~256 characters and otherwise waits for the timer', () => {
    const converger = streaming('low')
    converger.onUpdate(chunk('a'.repeat(100)))
    expect(converger.hasStreamingUpdate()).toBe(true)
    expect(converger.streamReady()).toBe(false)
    converger.onUpdate(chunk('a'.repeat(200)))
    expect(converger.streamReady()).toBe(true)
  })

  it('holds the response-control marker back, so a suppressed turn never flashes a prefix', () => {
    const converger = streaming('low')
    converger.onUpdate(chunk('AC_NO_'))
    expect(converger.hasStreamingUpdate()).toBe(false)
    expect(converger.streamUpdate()).toEqual([])
  })

  it('removes the stream a suppressed reply never wrote to, instead of leaving an empty bubble', () => {
    const converger = streaming('medium')
    converger.onUpdate(chunk('AC_NO_RESPONSE'))
    expect(converger.onFinal(attribution())).toEqual([{ kind: 'stream-stop', settle: 'final', discard: true }])
  })

  it('discards the stream when the turn produced no body at all', () => {
    expect(streaming('low').onFinal(attribution())).toEqual([{ kind: 'stream-stop', settle: 'final', discard: true }])
  })

  it('rolls over at the 12k block limit: no footer, session stays processing, a fresh message', () => {
    const converger = streaming('low')
    converger.onUpdate(chunk('a'.repeat(8_000)))
    expect(converger.streamUpdate()).toEqual([
      { kind: 'stream-append', chunks: [{ type: 'markdown_text', text: 'a'.repeat(8_000) }] }
    ])
    converger.onUpdate(chunk('b'.repeat(6_000)))
    const rolled = converger.streamUpdate()
    // Settle the full message, then open the NEXT one — a stopped stream is unrecoverable,
    // so continuation is a new message by construction (§3.4).
    expect(rolled[0]).toEqual({ kind: 'stream-stop', settle: 'rollover', text: 'a'.repeat(8_000) })
    expect(rolled[1]).toEqual({ kind: 'stream-start' })
    expect(rolled[2]).toEqual({ kind: 'stream-append', chunks: [{ type: 'markdown_text', text: 'b'.repeat(6_000) }] })
    // Only the LAST stop closes the response, and it names the second message's own text.
    expect(converger.onFinal(attribution()).at(-1)).toEqual({
      kind: 'stream-stop',
      settle: 'final',
      text: 'b'.repeat(6_000)
    })
  })

  it('re-anchors the tail below a chronological boundary, reusing the rollover', () => {
    const converger = streaming('low')
    converger.onUpdate(chunk('before the card'))
    converger.streamUpdate()
    // A human-input card (or visible agent-authored text) was posted below the stream.
    converger.reanchorStream()
    converger.onUpdate(chunk('after the card'))
    const rolled = converger.streamUpdate()
    expect(rolled).toEqual([
      { kind: 'stream-stop', settle: 'rollover', text: 'before the card' },
      { kind: 'stream-start' },
      { kind: 'stream-append', chunks: [{ type: 'markdown_text', text: 'after the card' }] }
    ])
    // The closing stop names only the NEW message's text, so §5.5 re-sends what it shows.
    expect(converger.onFinal(attribution()).at(-1)).toEqual({
      kind: 'stream-stop',
      settle: 'final',
      text: 'after the card'
    })
  })

  it('keeps the current message and its footer when the post-boundary tail is empty', () => {
    const converger = streaming('low')
    converger.onUpdate(chunk('all of it'))
    converger.streamUpdate()
    converger.reanchorStream()
    expect(converger.streamUpdate()).toEqual([])
    const finals = converger.onFinal(attribution())
    expect(finals.some((a) => a.kind === 'stream-start')).toBe(false)
    expect(finals.at(-1)).toEqual({ kind: 'stream-stop', settle: 'final', text: 'all of it' })
  })

  it('moves a post-boundary task card below the boundary too', () => {
    const converger = streaming('medium')
    converger.onUpdate(chunk('before'))
    converger.streamUpdate()
    converger.reanchorStream()
    converger.onUpdate(tool('t1', 'Read file'))
    const rolled = converger.streamUpdate()
    expect(rolled[0]).toMatchObject({ kind: 'stream-stop', settle: 'rollover' })
    expect(rolled[1]).toEqual({ kind: 'stream-start' })
  })

  it('ignores a boundary before the stream has shown anything', () => {
    const converger = streaming('low')
    converger.reanchorStream()
    converger.onUpdate(chunk('first words'))
    expect(converger.streamUpdate()).toEqual([
      { kind: 'stream-append', chunks: [{ type: 'markdown_text', text: 'first words' }] }
    ])
  })

  it('never cuts a compound shared-bot address across a rollover', () => {
    const address = '<@U09SHARED> reviewer'
    const converger = streaming('low', [address])
    // One flush larger than a whole message, with the natural cut landing inside the slug.
    converger.onUpdate(chunk(`${'x'.repeat(12_000 - 16)}${address} please verify`))
    const parts = appends(converger.streamUpdate())
      .map((c) => (c.type === 'markdown_text' ? c.text : ''))
      .filter(Boolean)
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.join('')).toBe(`${'x'.repeat(12_000 - 16)}${address} please verify`)
    expect(parts.some((part) => part.startsWith(address))).toBe(true)
  })

  it('appends the terminal failure notice to the open stream rather than posting it', () => {
    const converger = streaming('low')
    converger.onUpdate(chunk('partial answer'))
    const actions = converger.onStreamingFailure('quota exhausted')
    expect(streamedText(actions)).toBe('partial answer\n\n⚠️ Agent failed to respond: quota exhausted')
    expect(actions.filter((a) => a.kind === 'post').every((a) => a.kind === 'post' && a.recordOnly === true)).toBe(true)
    expect(actions.some((a) => a.kind === 'notice')).toBe(false)
    expect(actions.at(-1)).toMatchObject({ kind: 'stream-stop', settle: 'final' })
  })

  it('does not repeat a reason the runtime already narrated into the stream', () => {
    const converger = streaming('low')
    converger.onUpdate(chunk('Error: quota exhausted'))
    const actions = converger.onStreamingFailure('quota exhausted')
    expect(streamedText(actions)).toBe('Error: quota exhausted')
  })

  it('demotion before the first chunk reproduces the legacy pipeline exactly', () => {
    const demoted = streaming('medium')
    demoted.disableStreaming()
    const legacy = new OutputConverger('medium')
    for (const converger of [demoted, legacy]) {
      converger.onUpdate(chunk('hello'))
      converger.onUpdate(tool('t1', 'Read file'))
    }
    expect(demoted.onFinal(attribution())).toEqual(legacy.onFinal(attribution()))
  })
})

describe('slackStreamRecipient', () => {
  const sender = (over: Record<string, unknown> = {}) => ({ id: 'U1', ...over })

  it('names the human a streamed message is for', () => {
    expect(slackStreamRecipient({ source: 'user', sender: sender() })).toBe('U1')
  })

  it('has no honest value for a cron / hook / headless / agent-to-agent turn', () => {
    expect(slackStreamRecipient({ source: 'cron', sender: sender() })).toBeUndefined()
    expect(slackStreamRecipient({ source: 'hook', sender: sender() })).toBeUndefined()
    expect(slackStreamRecipient({ source: 'agent', sender: sender() })).toBeUndefined()
    expect(slackStreamRecipient({ source: 'user', headless: true, sender: sender() })).toBeUndefined()
    expect(slackStreamRecipient({ source: 'user', sender: sender({ isBot: true }) })).toBeUndefined()
  })
})

describe('applySlackAction — streaming actions', () => {
  function fixture(over: Record<string, unknown> = {}) {
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
      deleteMessage: vi.fn(async (_channel: string, _ts: string) => true),
      setStatus: vi.fn(async () => {}),
      setLoadingStatus: vi.fn(async (_c: string, _t: string, _s: string) => {}),
      postMessage: vi.fn(async (_channel: string, _text: string, _thread?: string, _options?: unknown) => 'p1'),
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
        isDm: true
      },
      chrome: {},
      reply: { responseId: 'resp-1' },
      attribution: { blocks: [{ type: 'context' }], key: 'footer-1' }
    }
    const state: SlackTurnState = { recipient: 'U1' }
    const host: SlackTurnHost<typeof turn> = {
      recordReplySegment: vi.fn(),
      appendTranscript: vi.fn(),
      getStatusBarTs: vi.fn(async () => undefined),
      setStatusBarTs: vi.fn(),
      clearStatusBarTs: vi.fn(),
      monotonicTs: () => '1',
      debug: vi.fn(),
      resolveFinalization: vi.fn(() => ({ mentionedAgentIds: ['agent-2'], addressedAnyone: true }))
    }
    return {
      conn,
      turn,
      state,
      host,
      apply: (action: SlackAction) => applySlackAction(host, turn as never, state, action)
    }
  }

  it('opens the stream with the recipient and the agent identity, and records the handle', async () => {
    const { apply, conn, state } = fixture()
    await apply({ kind: 'stream-start' })
    expect(conn.startTurnStream).toHaveBeenCalledWith('C1', 'T1', {
      recipientUserId: 'U1',
      identity: { username: 'Bot A', icon_url: 'https://icons.example.test/a.png' }
    })
    expect(state.stream).toEqual({ channel: 'C1', threadTs: 'T1', ts: '900.1' })
  })

  it('refuses to open a second stream beside a live one', async () => {
    const { apply, conn } = fixture()
    await apply({ kind: 'stream-start' })
    await apply({ kind: 'stream-start' })
    expect(conn.startTurnStream).toHaveBeenCalledOnce()
  })

  it('cannot stream without a thread — a streamed message must be a reply', async () => {
    const { apply, conn, turn } = fixture()
    delete (turn.plan as { thread?: string }).thread
    await apply({ kind: 'stream-start' })
    expect(conn.startTurnStream).not.toHaveBeenCalled()
  })

  it('settles the stream and degrades the turn when an append is refused', async () => {
    const { apply, conn, state } = fixture({
      appendTurnStream: vi.fn(
        async (_s: SlackTurnStream, _c: SlackStreamChunk[]) => 'refused' as SlackStreamAppendOutcome
      )
    })
    await apply({ kind: 'stream-start' })
    await apply({ kind: 'stream-append', chunks: [{ type: 'markdown_text', text: 'hi' }] })
    expect(conn.stopTurnStream).toHaveBeenCalledOnce()
    expect(state.stream).toBeUndefined()
    // The refused text is the only remaining copy of that display body — the converger has
    // already advanced past it — so it must be held for the ordinary post boundary (§7).
    expect(state.streamFallback).toBe('hi')
  })

  it('replays the whole uncommitted tail exactly once through the legacy post boundary', async () => {
    // Application is asynchronous: appends the converger produced before the refusal, and the
    // terminal ones after it, are already queued when the refusal lands. None may be dropped,
    // and none may be shown twice.
    let accept = true
    const { apply, conn, turn } = fixture({
      appendTurnStream: vi.fn(
        async (_s: SlackTurnStream, _c: SlackStreamChunk[]) => (accept ? 'ok' : 'refused') as SlackStreamAppendOutcome
      )
    })
    await apply({ kind: 'stream-start' })
    await apply({ kind: 'stream-append', chunks: [{ type: 'markdown_text', text: 'accepted. ' }] })
    accept = false
    await apply({ kind: 'stream-append', chunks: [{ type: 'markdown_text', text: 'refused. ' }] })
    // Queued before the refusal was known — a task card is chrome and has no legacy form.
    await apply({
      kind: 'stream-append',
      chunks: [
        { type: 'task_update', id: 't1', title: 'Read file', status: 'complete' },
        { type: 'markdown_text', text: 'and the tail.' }
      ]
    })
    await apply({ kind: 'stream-stop', settle: 'final', text: 'accepted. refused. and the tail.' })

    // Exactly one legacy post, carrying exactly what Slack never displayed.
    expect(conn.postMessage).toHaveBeenCalledOnce()
    expect(conn.postMessage.mock.calls[0]![1]).toBe('refused. and the tail.')
    // …with the footer and the §5.5 anchor on the message that actually holds the answer,
    // never on the dead stream.
    expect(conn.postMessage.mock.calls[0]![3]).toMatchObject({ trailingBlocks: [{ type: 'context' }] })
    expect(turn.reply.lastResponse).toEqual({ ts: 'p1', text: 'refused. and the tail.' })
  })

  it('a degraded turn opens no replacement stream, and its cleanup stop carries no footer', async () => {
    const { apply, conn } = fixture({
      appendTurnStream: vi.fn(
        async (_s: SlackTurnStream, _c: SlackStreamChunk[]) => 'refused' as SlackStreamAppendOutcome
      )
    })
    await apply({ kind: 'stream-start' })
    await apply({ kind: 'stream-append', chunks: [{ type: 'markdown_text', text: 'tail' }] })
    // The converger keeps producing rollovers; a second bubble is not a continuation.
    await apply({ kind: 'stream-stop', settle: 'rollover', text: 'tail' })
    await apply({ kind: 'stream-start' })
    expect(conn.startTurnStream).toHaveBeenCalledOnce()
    expect(conn.stopTurnStream.mock.calls[0]![1]).toEqual({})
  })

  it('drops the buffered tail when suppression tears the turn down', async () => {
    const { apply, conn, state } = fixture({
      appendTurnStream: vi.fn(
        async (_s: SlackTurnStream, _c: SlackStreamChunk[]) => 'refused' as SlackStreamAppendOutcome
      )
    })
    await apply({ kind: 'stream-start' })
    await apply({ kind: 'stream-append', chunks: [{ type: 'markdown_text', text: 'never shown' }] })
    await apply({ kind: 'stream-stop', settle: 'abort' })
    expect(conn.postMessage).not.toHaveBeenCalled()
    expect(state.streamFallback).toBe('never shown')
  })

  it('a task-only refusal still lets the accepted stream close as the attributed answer', async () => {
    // "body → tool card → end": the body is already visible on the stream, and the refusal
    // dropped nothing but chrome. The stream must still get the footer and the §5.5 anchor,
    // or the answer ends footerless and unroutable.
    let accept = true
    const { apply, conn, turn, state } = fixture({
      appendTurnStream: vi.fn(
        async (_s: SlackTurnStream, _c: SlackStreamChunk[]) => (accept ? 'ok' : 'refused') as SlackStreamAppendOutcome
      )
    })
    await apply({ kind: 'stream-start' })
    await apply({ kind: 'stream-append', chunks: [{ type: 'markdown_text', text: 'the whole answer' }] })
    accept = false
    await apply({
      kind: 'stream-append',
      chunks: [{ type: 'task_update', id: 't1', title: 'Read file', status: 'complete' }]
    })
    // Degraded for appends, but the buffer holds no body — so the response has not moved.
    expect(state.streamFallback).toBe('')
    await apply({ kind: 'stream-stop', settle: 'final', text: 'the whole answer' })

    // Exactly one attributed close, on the message that actually shows the answer.
    expect(conn.postMessage).not.toHaveBeenCalled()
    const closing = conn.stopTurnStream.mock.calls.at(-1)![1] as Record<string, unknown>
    expect(closing).toMatchObject({
      blocks: [{ type: 'context' }],
      agentAuthorId: 'bot-a',
      response: expect.objectContaining({ deliveryState: 'final' })
    })
    expect(state.streamFinalized).toBe(true)
    expect(turn.reply).not.toHaveProperty('lastResponse')
  })

  it('defers the replacement message when a ROLLOVER stop is left unsettled', async () => {
    // The retained handle is the OLD message. Appending the post-rollover tail there would put
    // it back above the boundary, defeat the size cap, and let finalization replace the
    // combined message with just the tail.
    const { apply, conn, turn, state } = fixture({
      stopTurnStream: vi.fn(async (_s: SlackTurnStream, o?: Record<string, unknown>) => o?.sessionStatus === undefined)
    })
    await apply({ kind: 'stream-start' })
    await apply({ kind: 'stream-append', chunks: [{ type: 'markdown_text', text: 'the prefix' }] })
    // Rollover, refused — the converger has already reset its per-message text.
    await apply({ kind: 'stream-stop', settle: 'rollover', text: 'the prefix' })
    await apply({ kind: 'stream-start' })
    await apply({ kind: 'stream-append', chunks: [{ type: 'markdown_text', text: 'the tail' }] })
    await apply({ kind: 'stream-stop', settle: 'final', text: 'the tail' })

    // The old handle was never reused: exactly one append, the accepted prefix.
    expect(conn.appendTurnStream).toHaveBeenCalledOnce()
    expect(conn.startTurnStream).toHaveBeenCalledOnce()
    // The tail landed BELOW as an ordinary reply, which is what the rollover wanted…
    expect(conn.postMessage).toHaveBeenCalledOnce()
    expect(conn.postMessage.mock.calls[0]![1]).toBe('the tail')
    // …and finalization names THAT message, so the prefix is never overwritten.
    expect(turn.reply.lastResponse).toEqual({ ts: 'p1', text: 'the tail' })
    // The old message keeps its prefix and was settled bare — no footer, no §5.5 claim.
    expect(state.stream).toBeUndefined()
    expect(state.streamStopOwed).toBeUndefined()
    expect(conn.stopTurnStream.mock.calls.at(-1)![1]).toEqual({})
  })

  it('never re-anoints the old message when BOTH the rollover and the terminal stop fail', async () => {
    // The flush empties the buffer, so ownership read from its length would flip back to "the
    // stream owns the response" on the settlement retry — putting the footer and the §5.5
    // anchor on the old message, with the tail's text under the old ts.
    let acceptStops = false
    const { apply, conn, turn, state } = fixture({
      stopTurnStream: vi.fn(async (_s: SlackTurnStream, _o?: Record<string, unknown>) => acceptStops)
    })
    await apply({ kind: 'stream-start' })
    await apply({ kind: 'stream-append', chunks: [{ type: 'markdown_text', text: 'the prefix' }] })
    await apply({ kind: 'stream-stop', settle: 'rollover', text: 'the prefix' })
    await apply({ kind: 'stream-start' })
    await apply({ kind: 'stream-append', chunks: [{ type: 'markdown_text', text: 'the tail' }] })
    // Terminal stop ALSO refused — the tail still posts, and the stop stays owed.
    await apply({ kind: 'stream-stop', settle: 'final', text: 'the tail' })
    expect(conn.postMessage).toHaveBeenCalledOnce()
    expect(turn.reply.lastResponse).toEqual({ ts: 'p1', text: 'the tail' })
    expect(state.streamFallback).toBe('')
    expect(state.streamStopOwed).toMatchObject({ settle: 'final' })

    // Settlement replays that owed stop against the still-open OLD message.
    acceptStops = true
    await apply(state.streamStopOwed!)

    // It settles BARE: no footer, no response metadata…
    expect(conn.stopTurnStream.mock.calls.at(-1)![1]).toEqual({})
    // …and the response anchor still names the message that actually holds the answer.
    expect(turn.reply.lastResponse).toEqual({ ts: 'p1', text: 'the tail' })
    expect(turn.reply.lastReply).toMatchObject({ ts: 'p1' })
    expect(conn.postMessage).toHaveBeenCalledOnce()
    expect(state.stream).toBeUndefined()
  })

  it('stops everything when the append reports the person pressed Stop', async () => {
    const { apply, conn, turn, state } = fixture({
      appendTurnStream: vi.fn(
        async (_s: SlackTurnStream, _c: SlackStreamChunk[]) => 'stopped' as SlackStreamAppendOutcome
      )
    })
    await apply({ kind: 'stream-start' })
    await apply({ kind: 'stream-append', chunks: [{ type: 'markdown_text', text: 'never shown' }] })
    expect(state.streamStopped).toBe(true)
    // No buffer opened, so nothing can be re-delivered by another route.
    expect(state.streamFallback).toBeUndefined()

    // Everything still queued for this turn is inert — no post, no replacement message,
    // no closing edit on a message the person ended (§6).
    await apply({ kind: 'stream-append', chunks: [{ type: 'markdown_text', text: 'nor this' }] })
    await apply({ kind: 'stream-start' })
    await apply({ kind: 'stream-stop', settle: 'final', text: 'nor this' })
    expect(conn.postMessage).not.toHaveBeenCalled()
    expect(conn.startTurnStream).toHaveBeenCalledOnce()
    expect(conn.stopTurnStream).not.toHaveBeenCalled()
    expect(turn.reply).not.toHaveProperty('lastResponse')
  })

  it('keeps the handle and the exact stop when Slack leaves the message streaming', async () => {
    let settled = false
    const { apply, conn, state } = fixture({
      stopTurnStream: vi.fn(async (_s: SlackTurnStream, _o?: Record<string, unknown>) => settled)
    })
    await apply({ kind: 'stream-start' })
    const closing = { kind: 'stream-stop', settle: 'final', text: 'the answer' } as const
    await apply(closing)
    // Nothing may be retired while the message might still be streaming.
    expect(state.stream).toEqual({ channel: 'C1', threadTs: 'T1', ts: '900.1' })
    expect(state.streamStopOwed).toEqual(closing)

    // The settlement backstop reissues THAT stop, so the retry keeps its footer.
    settled = true
    await apply(state.streamStopOwed!)
    expect(state.stream).toBeUndefined()
    expect(state.streamStopOwed).toBeUndefined()
    expect(conn.stopTurnStream).toHaveBeenCalledTimes(2)
    expect(conn.stopTurnStream.mock.calls[1]![1]).toMatchObject({ blocks: [{ type: 'context' }] })
  })

  it('does not claim the response, or delete the message, until Slack accepts the stop', async () => {
    const { apply, conn, turn } = fixture({
      stopTurnStream: vi.fn(async (_s: SlackTurnStream, _o?: Record<string, unknown>) => false)
    })
    await apply({ kind: 'stream-start' })
    await apply({ kind: 'stream-stop', settle: 'final', text: 'the answer', discard: true })
    expect(conn.deleteMessage).not.toHaveBeenCalled()
    expect(turn.reply).not.toHaveProperty('lastResponse')
  })

  it('re-anchors below a chronological boundary: settle, reopen, then append the tail', async () => {
    const { apply, conn, state } = fixture()
    await apply({ kind: 'stream-start' })
    await apply({ kind: 'stream-append', chunks: [{ type: 'markdown_text', text: 'before the card' }] })
    // What the converger emits once a boundary was posted below the open message.
    conn.startTurnStream.mockResolvedValueOnce({ channel: 'C1', threadTs: 'T1', ts: '900.2' })
    await apply({ kind: 'stream-stop', settle: 'rollover', text: 'before the card' })
    await apply({ kind: 'stream-start' })
    await apply({ kind: 'stream-append', chunks: [{ type: 'markdown_text', text: 'after the card' }] })

    // A fresh message below the boundary, and the session was never released mid-turn.
    expect(state.stream).toEqual({ channel: 'C1', threadTs: 'T1', ts: '900.2' })
    expect(conn.stopTurnStream.mock.calls[0]![1]).toMatchObject({ sessionStatus: 'processing' })
    expect(conn.stopTurnStream.mock.calls[0]![1]).not.toHaveProperty('blocks')
    expect(conn.appendTurnStream.mock.calls[1]![0]).toMatchObject({ ts: '900.2' })
  })

  it('closes the response ON the final stop — footer and §5.5 metadata, no follow-up edit', async () => {
    const { apply, conn, turn, state } = fixture()
    await apply({ kind: 'stream-start' })
    await apply({ kind: 'stream-stop', settle: 'final', text: 'the answer' })
    expect(conn.stopTurnStream).toHaveBeenCalledWith(
      { channel: 'C1', threadTs: 'T1', ts: '900.1' },
      expect.objectContaining({
        blocks: [{ type: 'context' }],
        agentAuthorId: 'bot-a',
        response: expect.objectContaining({
          responseId: 'resp-1',
          deliveryState: 'final',
          mentionedAgentIds: ['agent-2'],
          addressedAnyone: true
        })
      })
    )
    expect(conn.stopTurnStream.mock.calls[0]![1]).not.toHaveProperty('sessionStatus')
    // No handle is left for a closing edit: chat.update replaces the whole message, which
    // would erase every task card and stamp the answer "(edited)".
    expect(state.streamFinalized).toBe(true)
    expect(turn.reply).not.toHaveProperty('lastResponse')
    expect(turn.reply).not.toHaveProperty('lastReply')
  })

  it('a retried closing stop still carries the footer and the §5.5 metadata', async () => {
    let settled = false
    const { apply, conn, state } = fixture({
      stopTurnStream: vi.fn(async (_s: SlackTurnStream, _o?: Record<string, unknown>) => settled)
    })
    await apply({ kind: 'stream-start' })
    await apply({ kind: 'stream-stop', settle: 'final', text: 'the answer' })
    expect(state.streamFinalized).toBeUndefined()

    // Settlement replays the owed stop; the finals are rebuilt, not lost with the first try.
    settled = true
    await apply(state.streamStopOwed!)
    expect(conn.stopTurnStream.mock.calls.at(-1)![1]).toMatchObject({
      blocks: [{ type: 'context' }],
      agentAuthorId: 'bot-a',
      response: expect.objectContaining({ deliveryState: 'final', mentionedAgentIds: ['agent-2'] })
    })
    expect(state.streamFinalized).toBe(true)
  })

  it('leaves a rollover stop with no footer and no finalization metadata', async () => {
    const { apply, conn, host } = fixture()
    await apply({ kind: 'stream-start' })
    await apply({ kind: 'stream-stop', settle: 'rollover', text: 'first half' })
    const options = conn.stopTurnStream.mock.calls[0]![1] as Record<string, unknown>
    expect(options.blocks).toBeUndefined()
    expect(options.response).toBeUndefined()
    expect(host.resolveFinalization).not.toHaveBeenCalled()
  })

  it('keeps a rollover stop footerless and the session processing', async () => {
    const { apply, conn, turn } = fixture()
    await apply({ kind: 'stream-start' })
    await apply({ kind: 'stream-stop', settle: 'rollover', text: 'first half' })
    const options = conn.stopTurnStream.mock.calls[0]![1] as Record<string, unknown>
    expect(options.sessionStatus).toBe('processing')
    expect(options.blocks).toBeUndefined()
    // A rollover closes no response — only the last stop does.
    expect(turn.reply).not.toHaveProperty('lastResponse')
  })

  it('carries no footer when suppression tears the stream down', async () => {
    const { apply, conn } = fixture()
    await apply({ kind: 'stream-start' })
    await apply({ kind: 'stream-stop', settle: 'abort' })
    expect(conn.stopTurnStream.mock.calls[0]![1]).toEqual({})
  })

  it('removes a message nothing ever reached', async () => {
    const { apply, conn } = fixture()
    await apply({ kind: 'stream-start' })
    await apply({ kind: 'stream-stop', settle: 'final', discard: true })
    expect(conn.deleteMessage).toHaveBeenCalledWith('C1', '900.1')
  })

  it('re-issues the loading row beside the stream and clears it only at the stop', async () => {
    const { apply, conn, state } = fixture()
    // The daemon stashes the snapshot the applier re-issues (§5).
    state.loadingStatus = { text: 'is thinking…', options: { username: 'Bot A' } }
    await apply({ kind: 'stream-start' })
    // startStream displaces the row, so it is re-issued right after the stream opens.
    expect(conn.setLoadingStatus).toHaveBeenLastCalledWith('C1', 'T1', 'is thinking…', undefined, { username: 'Bot A' })
    const afterStart = conn.setLoadingStatus.mock.calls.length
    // The container label alone is not content, so a plan-only append does not re-issue.
    await apply({ kind: 'stream-append', chunks: [{ type: 'plan_update', title: 'Working…' }] })
    expect(conn.setLoadingStatus.mock.calls.length).toBe(afterStart)
    // A card or body text re-issues the row so it survives the append that would displace it.
    await apply({ kind: 'stream-append', chunks: [{ type: 'markdown_text', text: 'the answer' }] })
    expect(conn.setLoadingStatus.mock.calls.length).toBe(afterStart + 1)
    // Never a clear until the turn ends.
    expect(conn.setLoadingStatus.mock.calls.every((call) => call[2] !== '')).toBe(true)
    await apply({ kind: 'stream-append', chunks: [{ type: 'markdown_text', text: ' and more' }] })
    // …then exactly one clear at the terminal stop, and no more re-issues after it.
    await apply({ kind: 'stream-stop', settle: 'final', text: 'the answer and more' })
    expect(conn.setLoadingStatus).toHaveBeenLastCalledWith('C1', 'T1', '')
    expect(conn.setLoadingStatus.mock.calls.filter((call) => call[2] === '')).toHaveLength(1)
    expect(state.streamLoadingCleared).toBe(true)
    // The enum is never driven from here — chat.startStream owns it.
    expect(conn.setStatus).not.toHaveBeenCalled()
  })

  it('still clears the loading state when the stream never showed anything', async () => {
    const { apply, conn } = fixture()
    await apply({ kind: 'stream-start' })
    await apply({ kind: 'stream-stop', settle: 'final', discard: true })
    expect(conn.setLoadingStatus).toHaveBeenCalledWith('C1', 'T1', '')
    expect(conn.setStatus).not.toHaveBeenCalled()
  })

  it('skips the status write while a stream is open — the two share one slot', async () => {
    const { apply, conn } = fixture()
    await apply({ kind: 'stream-start' })
    await apply({ kind: 'set-status', text: 'is thinking…' })
    expect(conn.setStatus).not.toHaveBeenCalled()
    // …and resumes the moment the stream is gone.
    await apply({ kind: 'stream-stop', settle: 'abort' })
    await apply({ kind: 'set-status', text: 'is thinking…' })
    expect(conn.setStatus).toHaveBeenCalledOnce()
  })
})

describe('SlackConnection streaming', () => {
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
      event(type: string, handler: (a: { event: unknown }) => unknown) {
        ;(this as unknown as { handlers: Map<string, unknown> }).handlers.set(type, handler)
      },
      handlers: new Map<string, (a: { event: unknown }) => unknown>(),
      action() {},
      shortcut() {},
      client: {
        auth: { test: async () => ({ user_id: 'U1', bot_id: 'B1', team_id: 'T123' }) },
        views: { open: async () => ({}), update: async () => ({}) },
        chat: {
          postMessage: async () => ({ ts: '1.1' }),
          getPermalink: async () => ({ permalink: 'https://example.test/t' }),
          update: async () => ({}),
          delete: async () => ({}),
          startStream: vi.fn(async () => ({ ts: '900.1' })),
          appendStream: vi.fn(async () => ({})),
          stopStream: vi.fn(async () => ({})),
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

  it('opens, appends and settles one message through the typed SDK methods', async () => {
    const { conn, app } = await connect()
    expect(conn.streamingLikely()).toBe(true)
    const stream = await conn.startTurnStream('C1', 'T1', { recipientUserId: 'U9', identity: { username: 'Bot A' } })
    expect(stream).toEqual({ channel: 'C1', threadTs: 'T1', ts: '900.1' })
    expect(app.client.chat.startStream).toHaveBeenCalledWith({
      channel: 'C1',
      thread_ts: 'T1',
      // The collapsed container: every task card folded behind one chevron (§4).
      task_display_mode: 'plan',
      recipient_user_id: 'U9',
      recipient_team_id: 'T123',
      username: 'Bot A'
    })
    await conn.appendTurnStream(stream!, [{ type: 'markdown_text', text: 'hi' }])
    expect(app.client.chat.appendStream).toHaveBeenCalledWith({
      channel: 'C1',
      ts: '900.1',
      chunks: [{ type: 'markdown_text', text: 'hi' }]
    })
    await conn.stopTurnStream(stream!, { sessionStatus: 'processing', agentAuthorId: 'bot-a' })
    expect(app.client.chat.stopStream).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'C1', ts: '900.1', session_status: 'processing' })
    )
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
    // Still "settled" — the caller's question is whether the message is streaming, and it
    // is not; only an unresolved answer asks for a retry.
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
    // A transient failure must NOT retire the handle: the message is still streaming and the
    // session still processing, which is exactly what the settlement backstop exists to fix.
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

  it('answers `stopped`, not `refused`, once the person has ended the stream', async () => {
    const { conn, app } = await connect(
      {},
      { onMessageShortcut: async () => 'slack:C1:T1:bot-a', onStatusAction: () => {} }
    )
    const stream = (await conn.startTurnStream('C1', 'T1'))!
    await conn.agentSessionStopped('C1', 'T1', 'U1')
    // Collapsing this into the same `false` a rate limit returns is what lets a buffered tail
    // be posted as a new reply after a Stop.
    expect(await conn.appendTurnStream(stream, [{ type: 'markdown_text', text: 'more' }])).toBe('stopped')
    expect(app.client.chat.appendStream).not.toHaveBeenCalled()
  })

  it('reads a stopped_by_user refusal as `stopped` even before the event arrives', async () => {
    const { conn } = await connect({
      chat: {
        appendStream: vi.fn(async () => {
          throw slackError('stopped_by_user')
        })
      }
    })
    const stream = (await conn.startTurnStream('C1', 'T1'))!
    expect(await conn.appendTurnStream(stream, [{ type: 'markdown_text', text: 'x' }])).toBe('stopped')
  })

  it('forgets a previous Stop when a later turn opens its own stream', async () => {
    const { conn } = await connect({}, { onMessageShortcut: async () => 'slack:C1:T1:bot-a', onStatusAction: () => {} })
    await conn.startTurnStream('C1', 'T1')
    await conn.agentSessionStopped('C1', 'T1', 'U1')
    const next = (await conn.startTurnStream('C1', 'T1'))!
    expect(await conn.appendTurnStream(next, [{ type: 'markdown_text', text: 'a new turn' }])).toBe('ok')
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
    expect(await conn.appendTurnStream(stream, [{ type: 'markdown_text', text: 'x' }])).toBe('refused')
    expect(await conn.stopTurnStream(stream)).toBe(true)
    expect(app.client.chat.stopStream).toHaveBeenCalledOnce()
  })

  it('after the native Stop, nothing appends to the dead stream and no second stop is issued', async () => {
    const actions: unknown[] = []
    const { conn, app } = await connect(
      {},
      {
        onMessageShortcut: async () => 'slack:C1:T1:bot-a',
        onStatusAction: (a: unknown) => void actions.push(a)
      }
    )
    const stream = (await conn.startTurnStream('C1', 'T1'))!
    await conn.agentSessionStopped('C1', 'T1', 'U1')

    expect(await conn.appendTurnStream(stream, [{ type: 'markdown_text', text: 'more' }])).toBe('stopped')
    // Settled, and settled by the person — so nothing is retried against it either.
    expect(await conn.stopTurnStream(stream)).toBe(true)
    expect(app.client.chat.appendStream).not.toHaveBeenCalled()
    expect(app.client.chat.stopStream).not.toHaveBeenCalled()
    // The turn is still cancelled and the session still transitions exactly once.
    expect(actions).toEqual([{ kind: 'cancel', sessionKey: 'slack:C1:T1:bot-a', actor: { userId: 'U1' } }])
    const lifecycle = app.client.apiCall.mock.calls.filter((call) => call[0] === 'agents.sessions.setStatus')
    expect(lifecycle).toHaveLength(1)
    expect(lifecycle[0]![1]).toMatchObject({ status: 'active' })
  })

  it('treats a post-stop append refusal as benign rather than a capability loss', async () => {
    const { conn, app } = await connect({
      chat: {
        appendStream: vi.fn(async () => {
          throw slackError('message_not_in_streaming_state')
        })
      }
    })
    const stream = (await conn.startTurnStream('C1', 'T1'))!
    // Settled by something other than us — in practice the person's Stop racing its event —
    // so the content is dropped rather than re-delivered by another route (§6).
    expect(await conn.appendTurnStream(stream, [{ type: 'markdown_text', text: 'x' }])).toBe('stopped')
    expect(conn.streamingLikely()).toBe(true)
    // A DEFINITE already-stopped answer proves the message is settled, so no stop is owed.
    expect(await conn.stopTurnStream(stream)).toBe(true)
    expect(app.client.chat.stopStream).not.toHaveBeenCalled()
  })
})

describe('Daemon Slack streaming turn', () => {
  function scaffold(): string {
    const root = mkdtempSync(join(tmpdir(), 'ac-slack-stream-'))
    writeFileSync(
      join(root, 'config.json'),
      JSON.stringify({
        version: 1,
        controlPlane: { enabled: false },
        runtimes: { claude: { command: 'node', args: ['unused'] } }
      })
    )
    const agentDir = join(root, 'agents', 'bot-a')
    mkdirSync(agentDir, { recursive: true })
    writeFileSync(
      join(agentDir, 'agent.json'),
      JSON.stringify({
        id: 'bot-a',
        name: 'bot-a',
        status: 'active',
        runtime: 'claude',
        workspace: { mode: 'from-scratch', path: join(agentDir, 'workspace') },
        integrations: [],
        output: { mode: 'low' }
      })
    )
    return root
  }

  const inbound = (): NormalizedMessage =>
    ({
      msgId: 'slack:C1:100.1',
      traceId: '100.1',
      source: 'user',
      platform: 'slack',
      channel: 'C1',
      thread: 'T1',
      sender: { id: 'U1', isBot: false },
      text: 'hello',
      mentionedBots: [],
      isDm: true,
      trigger: 'dm'
    }) as NormalizedMessage

  /** A duck-typed reply connection. `setStatus` is the ONLY route the daemon has to either
   *  Slack status API — the free text and the session enum are both behind it — so asserting
   *  on it covers both halves of §5. */
  function connect(daemon: Daemon, over: Record<string, unknown> = {}, shareable = false) {
    const agent = (daemon as unknown as { agents: Map<string, { integrations: unknown[] }> }).agents.get('bot-a')!
    agent.integrations = [
      {
        id: 'int-a',
        platform: 'slack',
        core: { mode: shareable ? 'shared' : 'direct', bindRules: [{ match: { kind: 'dm' } }] },
        config: { botToken: 'b', appToken: 'p', ...(shareable ? { shareable: true } : {}) }
      }
    ]
    const conn = {
      workspaceId: vi.fn(() => 'T1'),
      setStatus: vi.fn(async () => {}),
      postMessage: vi.fn(async () => 'reply-1'),
      postBlocks: vi.fn(async () => 'status-bar'),
      updateBlocks: vi.fn(async () => true),
      setLoadingStatus: vi.fn(async (_c: string, _t: string, _s: string) => {}),
      streamingLikely: vi.fn(() => true),
      startTurnStream: vi.fn(async (channel: string, threadTs: string, _o?: unknown) => ({
        channel,
        threadTs,
        ts: '900.1'
      })),
      appendTurnStream: vi.fn(
        async (_stream: SlackTurnStream, _chunks: SlackStreamChunk[]) => 'ok' as SlackStreamAppendOutcome
      ),
      stopTurnStream: vi.fn(async (_stream: SlackTurnStream, _options?: Record<string, unknown>) => true),
      deleteMessage: vi.fn(async (_channel: string, _ts: string) => true),
      // The §5.5 closing edit. On a streamed turn it must never fire: it replaces the whole
      // message, taking the task cards with it and marking the answer "(edited)".
      finalizeResponse: vi.fn(async () => true),
      ...over
    }
    ;(daemon as unknown as { connByIntegration: Map<string, unknown> }).connByIntegration.set('int-a', conn)
    return conn
  }

  function booted(root: string) {
    let onUpdate!: (sessionId: string, update: unknown) => void
    const host = {
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => 'acp-1'),
      hasSession: vi.fn(() => true),
      prompt: vi.fn(async (sessionId: string) => {
        onUpdate(sessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'streamed answer' }
        })
        return { stopReason: 'end_turn' }
      }),
      cancel: vi.fn(async () => {}),
      stop: vi.fn(async () => {})
    }
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root,
      hostFactory: (_agent: unknown, update: (sessionId: string, u: unknown) => void) => {
        onUpdate = update
        return host as never
      }
    } as never)
    return { daemon, host }
  }

  it('keeps the loading row alive beside the stream, clears it once at the end, never the enum', async () => {
    const { daemon } = booted(scaffold())
    await daemon.start()
    const conn = connect(daemon)

    await (daemon as never as { dispatch: (a: string, m: NormalizedMessage, i: string) => Promise<unknown> }).dispatch(
      'bot-a',
      inbound(),
      'int-a'
    )

    // (a) `setStatus` is the call that ALSO drives agents.sessions.setStatus. A streaming turn
    // never makes it: chat.startStream owns the session, and the enum renders nothing in a
    // channel thread anyway (confirmed live).
    expect(conn.setStatus).not.toHaveBeenCalled()
    const loading = conn.setLoadingStatus.mock.calls.map((call) => call[2])
    // (b) the row is set at the start and RE-ISSUED (startStream and each append displace it),
    // so there is more than one non-empty write and it is never cleared on first content.
    expect(loading.filter((text) => text !== '').length).toBeGreaterThan(1)
    expect(loading.at(0)).not.toBe('')
    expect(loading.slice(0, -1)).not.toContain('')
    // (c) cleared exactly once, at turn end.
    expect(loading.filter((text) => text === '')).toHaveLength(1)
    expect(loading.at(-1)).toBe('')
    expect(conn.startTurnStream).toHaveBeenCalledOnce()
    expect(conn.stopTurnStream).toHaveBeenCalledOnce()
    const streamed = conn.appendTurnStream.mock.calls
      .flatMap((call) => call[1] ?? [])
      .map((c) => (c.type === 'markdown_text' ? c.text : ''))
      .join('')
    expect(streamed).toContain('streamed answer')
    // The answer never takes the post boundary on a streaming turn.
    expect(conn.postMessage).not.toHaveBeenCalledWith(
      'C1',
      expect.stringContaining('streamed answer'),
      expect.anything(),
      expect.anything()
    )
    await daemon.stop()
  }, 15_000)

  it('issues NO closing edit on a streamed turn — the stop already finalized it', async () => {
    const { daemon } = booted(scaffold())
    await daemon.start()
    const conn = connect(daemon)

    await (daemon as never as { dispatch: (a: string, m: NormalizedMessage, i: string) => Promise<unknown> }).dispatch(
      'bot-a',
      inbound(),
      'int-a'
    )

    expect(conn.stopTurnStream).toHaveBeenCalledOnce()
    expect(conn.stopTurnStream.mock.calls[0]![1]).toMatchObject({
      response: expect.objectContaining({ deliveryState: 'final' })
    })
    expect(conn.finalizeResponse).not.toHaveBeenCalled()
    await daemon.stop()
  }, 15_000)

  it('still issues the closing edit when the turn took the legacy pipeline', async () => {
    const { daemon } = booted(scaffold())
    await daemon.start()
    const conn = connect(daemon, { streamingLikely: vi.fn(() => false) })

    await (daemon as never as { dispatch: (a: string, m: NormalizedMessage, i: string) => Promise<unknown> }).dispatch(
      'bot-a',
      inbound(),
      'int-a'
    )

    expect(conn.startTurnStream).not.toHaveBeenCalled()
    expect(conn.postMessage).toHaveBeenCalledWith('C1', 'streamed answer', 'T1', expect.anything())
    expect(conn.finalizeResponse).toHaveBeenCalledOnce()
    await daemon.stop()
  }, 15_000)

  it('keeps a SHAREABLE bot on the legacy pipeline until §10 Q1 is verified live', async () => {
    const { daemon } = booted(scaffold())
    await daemon.start()
    const conn = connect(daemon, {}, true)

    await (daemon as never as { dispatch: (a: string, m: NormalizedMessage, i: string) => Promise<unknown> }).dispatch(
      'bot-a',
      inbound(),
      'int-a'
    )

    expect(conn.startTurnStream).not.toHaveBeenCalled()
    expect(conn.setStatus).toHaveBeenCalled()
    expect(conn.postMessage).toHaveBeenCalledWith('C1', 'streamed answer', 'T1', expect.anything())
    await daemon.stop()
  }, 15_000)

  it('degrades to the legacy pipeline when the stream cannot be opened', async () => {
    const { daemon } = booted(scaffold())
    await daemon.start()
    const conn = connect(daemon, { startTurnStream: vi.fn(async () => undefined) })

    await (daemon as never as { dispatch: (a: string, m: NormalizedMessage, i: string) => Promise<unknown> }).dispatch(
      'bot-a',
      inbound(),
      'int-a'
    )

    expect(conn.startTurnStream).toHaveBeenCalledOnce()
    expect(conn.appendTurnStream).not.toHaveBeenCalled()
    expect(conn.setStatus).toHaveBeenCalled()
    expect(conn.postMessage).toHaveBeenCalledWith('C1', 'streamed answer', 'T1', expect.anything())
    await daemon.stop()
  }, 15_000)

  it('settlement retries a stop Slack left unresolved, so no message is stranded streaming', async () => {
    const { daemon } = booted(scaffold())
    await daemon.start()
    let attempts = 0
    const conn = connect(daemon, {
      stopTurnStream: vi.fn(async (_s: SlackTurnStream, _o?: Record<string, unknown>) => ++attempts > 1)
    })

    await (daemon as never as { dispatch: (a: string, m: NormalizedMessage, i: string) => Promise<unknown> }).dispatch(
      'bot-a',
      inbound(),
      'int-a'
    )

    // Turn end could not settle the message; the settlement backstop reissued the same stop.
    expect(conn.stopTurnStream).toHaveBeenCalledTimes(2)
    expect(conn.stopTurnStream.mock.calls[1]![1]).toMatchObject({ agentAuthorId: 'bot-a' })
    await daemon.stop()
  }, 15_000)

  it('moves the stream below a chronological boundary the turn posts under it', async () => {
    const { daemon } = booted(scaffold())
    await daemon.start()
    connect(daemon)
    const converger = new OutputConverger('low')
    converger.enableStreaming()
    converger.onUpdate(chunk('before the card'))
    converger.streamUpdate()

    // The one place the daemon marks live chrome to continue below a new boundary message.
    ;(daemon as never as { markInPlaceChromeForReanchor: (p: unknown) => void }).markInPlaceChromeForReanchor({
      chrome: {},
      conv: converger
    })

    converger.onUpdate(chunk('after the card'))
    expect(converger.streamUpdate()[0]).toMatchObject({ kind: 'stream-stop', settle: 'rollover' })
    await daemon.stop()
  }, 15_000)
})
