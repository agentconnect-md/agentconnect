import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Daemon } from '../src/daemon.js'
import { SlackConnection, type SlackTurnStream } from '../src/slack/connection.js'
import { OutputConverger, type SlackAction, type SlackStreamChunk } from '../src/slack/render.js'
import {
  applySlackAction,
  slackStreamRecipient,
  type SlackTurnHost,
  type SlackTurnState
} from '../src/platforms/slack/turn-output.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'

/**
 * slack-streaming-turn-output.md (Layer 1). The invariants worth pinning are the ones the
 * design argues from rather than the plumbing: the answer rides ONE streaming message while
 * the transcript keeps its own copy, a streaming turn writes NEITHER status API (they share
 * one slot with the stream), a stopped stream is never revived, and every path that cannot
 * stream degrades to today's pipeline unchanged.
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
    expect(appends(converger.streamUpdate())).toEqual([
      {
        type: 'task_update',
        id: 'thinking-0',
        title: 'Thinking',
        status: 'in_progress',
        details: 'weighing the options'
      }
    ])
    converger.onUpdate(tool('t1', 'Read file'))
    const next = appends(converger.streamUpdate())
    expect(next).toContainEqual({
      type: 'task_update',
      id: 'thinking-0',
      title: 'Thinking',
      status: 'complete',
      details: 'weighing the options'
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
      appendTurnStream: vi.fn(async (_stream: SlackTurnStream, _chunks: SlackStreamChunk[]) => true),
      stopTurnStream: vi.fn(async (_stream: SlackTurnStream, _options?: Record<string, unknown>) => true),
      deleteMessage: vi.fn(async (_channel: string, _ts: string) => true),
      setStatus: vi.fn(async () => {}),
      postMessage: vi.fn(async () => 'p1'),
      ...over
    }
    const turn = {
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
      degradeStreaming: vi.fn()
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

  it('settles the stream and demotes the turn when an append is refused', async () => {
    const { apply, conn, state, host } = fixture({ appendTurnStream: vi.fn(async () => false) })
    await apply({ kind: 'stream-start' })
    await apply({ kind: 'stream-append', chunks: [{ type: 'markdown_text', text: 'hi' }] })
    expect(conn.stopTurnStream).toHaveBeenCalledOnce()
    expect(state.stream).toBeUndefined()
    // The rest of the answer must reach the channel the ordinary way (§7).
    expect(host.degradeStreaming).toHaveBeenCalledOnce()
  })

  it('attaches the attribution footer to the final stop only, and hands §5.5 the message it closes', async () => {
    const { apply, conn, turn } = fixture()
    await apply({ kind: 'stream-start' })
    await apply({ kind: 'stream-stop', settle: 'final', text: 'the answer' })
    expect(conn.stopTurnStream).toHaveBeenCalledWith(
      { channel: 'C1', threadTs: 'T1', ts: '900.1' },
      expect.objectContaining({ blocks: [{ type: 'context' }], agentAuthorId: 'bot-a' })
    )
    expect(conn.stopTurnStream.mock.calls[0]![1]).not.toHaveProperty('sessionStatus')
    expect(turn.reply).toMatchObject({
      lastResponse: { ts: '900.1', text: 'the answer' },
      lastReply: { ts: '900.1', text: 'the answer', footerKey: 'footer-1' }
    })
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
      task_display_mode: 'timeline',
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
    expect(await conn.stopTurnStream(stream)).toBe(false)
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

    expect(await conn.appendTurnStream(stream, [{ type: 'markdown_text', text: 'more' }])).toBe(false)
    expect(await conn.stopTurnStream(stream)).toBe(false)
    expect(app.client.chat.appendStream).not.toHaveBeenCalled()
    expect(app.client.chat.stopStream).not.toHaveBeenCalled()
    // The turn is still cancelled and the session still transitions exactly once.
    expect(actions).toEqual([{ kind: 'cancel', sessionKey: 'slack:C1:T1:bot-a', actor: { userId: 'U1' } }])
    const lifecycle = app.client.apiCall.mock.calls.filter((call) => call[0] === 'agents.sessions.setStatus')
    expect(lifecycle).toHaveLength(1)
    expect(lifecycle[0]![1]).toMatchObject({ status: 'active' })
  })

  it('treats a post-stop append refusal as benign rather than a capability loss', async () => {
    const { conn } = await connect({
      chat: {
        appendStream: vi.fn(async () => {
          throw slackError('message_not_in_streaming_state')
        })
      }
    })
    const stream = (await conn.startTurnStream('C1', 'T1'))!
    expect(await conn.appendTurnStream(stream, [{ type: 'markdown_text', text: 'x' }])).toBe(false)
    expect(conn.streamingLikely()).toBe(true)
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
      streamingLikely: vi.fn(() => true),
      startTurnStream: vi.fn(async (channel: string, threadTs: string, _o?: unknown) => ({
        channel,
        threadTs,
        ts: '900.1'
      })),
      appendTurnStream: vi.fn(async (_stream: SlackTurnStream, _chunks: SlackStreamChunk[]) => true),
      stopTurnStream: vi.fn(async (_stream: SlackTurnStream, _options?: Record<string, unknown>) => true),
      deleteMessage: vi.fn(async (_channel: string, _ts: string) => true),
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

  it('writes NEITHER status API, and delivers the answer on the stream', async () => {
    const { daemon } = booted(scaffold())
    await daemon.start()
    const conn = connect(daemon)

    await (daemon as never as { dispatch: (a: string, m: NormalizedMessage, i: string) => Promise<unknown> }).dispatch(
      'bot-a',
      inbound(),
      'int-a'
    )

    expect(conn.setStatus).not.toHaveBeenCalled()
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
})
