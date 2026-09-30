// The UI message stream encoder, read back through the `ai` package's own client rather than by string assertions.
import { describe, it, expect } from 'vitest'
import { DefaultChatTransport, readUIMessageStream, type UIMessage, type UIMessageChunk } from 'ai'
import type { WebchatDone, WebchatEvent, WebchatOutput } from '@agentconnect.md/protocol'
import {
  UI_MESSAGE_STREAM_HEADERS,
  UiMessageStreamEncoder,
  uiFinishReason,
  type UiMessageChunk
} from './chat-stream-encoder.js'

// Compile-time pin: every chunk this encoder emits is a chunk the AI SDK accepts.
const pinned: (chunk: UiMessageChunk) => UIMessageChunk = (chunk) => chunk
void pinned

const CONV = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TURN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const SEG_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const SEG_B = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

let index = 0
const out = (event?: WebchatEvent, status?: WebchatOutput['status']): WebchatOutput => ({
  conversationId: CONV,
  turnId: TURN,
  index: index++,
  ...(event ? { event } : {}),
  ...(status ? { status } : {})
})
const done = (over: Partial<WebchatDone> = {}): WebchatDone => ({ conversationId: CONV, turnId: TURN, ...over })

/** Serve `wire` to the AI SDK's `DefaultChatTransport` and assemble the assistant message the way `useChat` does. */
async function decode(wire: string): Promise<{ message: UIMessage; chunks: UIMessageChunk[]; errors: string[] }> {
  const transport = new DefaultChatTransport<UIMessage>({
    api: 'https://relay.example.test/ai-sdk/chat/' + CONV,
    fetch: (async () => new Response(wire, { headers: UI_MESSAGE_STREAM_HEADERS })) as typeof fetch
  })
  const stream = await transport.sendMessages({
    trigger: 'submit-message',
    chatId: 'chat-1',
    messageId: undefined,
    messages: [],
    abortSignal: undefined
  })
  const [forMessage, forChunks] = stream.tee()
  const chunks: UIMessageChunk[] = []
  const collected = (async () => {
    for await (const chunk of forChunks) chunks.push(chunk)
  })()
  const errors: string[] = []
  let message: UIMessage | undefined
  for await (const m of readUIMessageStream({
    stream: forMessage,
    onError: (e) => errors.push(e instanceof Error ? e.message : String(e))
  })) {
    message = m
  }
  await collected
  return { message: message!, chunks, errors }
}

function encode(build: (enc: UiMessageStreamEncoder) => string[]): string {
  return build(new UiMessageStreamEncoder(TURN)).join('')
}

describe('UiMessageStreamEncoder', () => {
  it('frames a turn as one assistant message with text, reasoning, data parts, metadata and a finish', async () => {
    const wire = encode((e) => [
      e.open(),
      e.output(out({ kind: 'message', text: 'Hel' })),
      e.output(out({ kind: 'message', text: 'lo' })),
      e.output(out({ kind: 'thinking', text: 'checking the docs' })),
      e.output(out({ kind: 'message', text: 'Found it.' })),
      e.output(out({ kind: 'tool_call', toolCallId: 'call-1', title: 'Read README.md', status: 'pending' })),
      e.output(out({ kind: 'tool_update', toolCallId: 'call-1', status: 'completed' })),
      e.output(out({ kind: 'plan', entries: [{ content: 'read', status: 'in_progress' }] })),
      e.output(out({ kind: 'plan', entries: [{ content: 'read', status: 'completed' }] })),
      e.output(out({ kind: 'session_info', title: 'Docs question' })),
      e.output(out({ kind: 'notice', text: 'Starting the agent…' })),
      e.output(out({ kind: 'notice', text: '' })),
      e.output(out({ kind: 'notice', text: 'The page asked for a sign-in this surface cannot show.', standing: true })),
      e.output(out({ kind: 'message', text: 'Done.' })),
      e.done(done({ stopReason: 'end_turn' }))
    ])
    const { message, chunks, errors } = await decode(wire)

    expect(errors).toEqual([])
    expect(message.id).toBe(TURN)
    expect(message.metadata).toEqual({ title: 'Docs question' })
    expect(message.parts).toMatchObject([
      { type: 'step-start' },
      { type: 'text', text: 'Hello', state: 'done' },
      { type: 'reasoning', text: 'checking the docs', state: 'done' },
      { type: 'text', text: 'Found it.', state: 'done' },
      // The update replaced the call's part in place and kept its title.
      { type: 'data-tool', id: 'call-1', data: { toolCallId: 'call-1', title: 'Read README.md', status: 'completed' } },
      { type: 'data-plan', id: 'plan', data: { entries: [{ content: 'read', status: 'completed' }] } },
      { type: 'data-notice', id: 'notice', data: { text: '' } },
      {
        type: 'data-notice',
        id: 'notice-1',
        data: { text: 'The page asked for a sign-in this surface cannot show.', standing: true }
      },
      { type: 'text', text: 'Done.', state: 'done' }
    ])
    expect(message.parts).toHaveLength(9)
    expect(chunks.slice(0, 2)).toEqual([{ type: 'start', messageId: TURN }, { type: 'start-step' }])
    expect(chunks.slice(-2)).toEqual([{ type: 'finish-step' }, { type: 'finish', finishReason: 'stop' }])
  })

  it('starts a new text part when the daemon starts a new segment', async () => {
    const wire = encode((e) => [
      e.open(),
      e.output(out({ kind: 'message', text: 'first', segmentId: SEG_A })),
      e.output(out({ kind: 'message', text: ' still first', segmentId: SEG_A })),
      e.output(out({ kind: 'message', text: 'second', segmentId: SEG_B })),
      e.done(done())
    ])
    const { message } = await decode(wire)
    expect(message.parts.filter((p) => p.type === 'text')).toMatchObject([
      { text: 'first still first' },
      { text: 'second' }
    ])
  })

  it('drops kinds the stream has no representation for, and status-only snapshots', async () => {
    const wire = encode((e) => [
      e.open(),
      e.output(out(undefined, { model: 'model-a', contextUsed: 10 })),
      e.output(out({ kind: 'message', text: 'draft' })),
      e.output(out({ kind: 'superseded', generation: 1 })),
      e.output(out({ kind: 'elicitation_resolved', requestId: 'r1', outcome: 'dismissed' })),
      e.output(out({ kind: 'app_resolved', appId: 'app-1', outcome: 'closed' })),
      e.done(done())
    ])
    const { message, errors } = await decode(wire)
    expect(errors).toEqual([])
    expect(message.parts).toMatchObject([{ type: 'step-start' }, { type: 'text', text: 'draft' }])
    expect(message.parts).toHaveLength(2)
  })

  it('hands out the first question as a dynamic tool call, ends the stream on it, and writes nothing after', async () => {
    const encoder = new UiMessageStreamEncoder(TURN)
    const question = out({
      kind: 'elicitation',
      requestId: 'r1',
      message: 'Pick one',
      options: [{ value: 'a', label: 'A' }]
    })
    const wire = [
      encoder.open(),
      encoder.output(out({ kind: 'message', text: 'One moment.' })),
      encoder.output(question),
      encoder.output(out({ kind: 'message', text: 'never streamed' })),
      encoder.output(out({ kind: 'permission', requestId: TURN, tool: 'Bash', detail: 'ls' }))
    ].join('')
    expect(encoder.awaitingCaller).toBe(true)
    const { message, chunks, errors } = await decode(wire)
    expect(errors).toEqual([])
    expect(chunks.at(-1)).toEqual({ type: 'finish', finishReason: 'tool-calls' })
    expect(message.parts).toMatchObject([
      { type: 'step-start' },
      { type: 'text', text: 'One moment.', state: 'done' },
      {
        type: 'dynamic-tool',
        toolName: 'agentconnect_ask',
        toolCallId: 'r1',
        state: 'input-available',
        input: { message: 'Pick one', options: [{ value: 'a', label: 'A' }] },
        callProviderMetadata: { agentconnect: { turnId: TURN, index: question.index } }
      }
    ])
    expect(message.parts).toHaveLength(3)
  })

  it('hands out a runtime approval as an approval request on its own tool call', async () => {
    const wire = encode((e) => [
      e.open(),
      e.output(out({ kind: 'permission', requestId: TURN, tool: 'Bash', detail: 'ls' }))
    ])
    const { message, errors } = await decode(wire)
    expect(errors).toEqual([])
    expect(message.parts.at(-1)).toMatchObject({
      type: 'dynamic-tool',
      toolName: 'agentconnect_approval',
      toolCallId: TURN,
      state: 'approval-requested',
      input: { tool: 'Bash', detail: 'ls' },
      approval: { id: TURN }
    })
  })

  it('ends a failed turn with an error part carrying the reason, and no finish', async () => {
    const wire = encode((e) => [
      e.open(),
      e.output(out({ kind: 'message', text: 'partial' })),
      e.done(done({ error: 'the agent failed to start' }))
    ])
    const { message, chunks, errors } = await decode(wire)
    expect(errors).toEqual(['the agent failed to start'])
    expect(message.parts).toMatchObject([{ type: 'step-start' }, { type: 'text', text: 'partial', state: 'done' }])
    expect(chunks.at(-1)).toEqual({ type: 'error', errorText: 'the agent failed to start' })
    expect(chunks.some((c) => c.type === 'finish')).toBe(false)
  })

  it('writes keepalives the client ignores', async () => {
    const wire = encode((e) => [
      e.open(),
      e.keepalive(),
      e.output(out({ kind: 'message', text: 'hi' })),
      e.keepalive(),
      e.done(done())
    ])
    const { message, errors } = await decode(wire)
    expect(errors).toEqual([])
    expect(message.parts).toMatchObject([{ type: 'step-start' }, { type: 'text', text: 'hi' }])
  })

  it('maps ACP stop reasons to AI SDK finish reasons', () => {
    expect(uiFinishReason(undefined)).toBe('stop')
    expect(uiFinishReason('end_turn')).toBe('stop')
    expect(uiFinishReason('max_tokens')).toBe('length')
    expect(uiFinishReason('refusal')).toBe('content-filter')
    expect(uiFinishReason('cancelled')).toBe('other')
    expect(uiFinishReason('steered_into_turn')).toBe('other')
  })
})
