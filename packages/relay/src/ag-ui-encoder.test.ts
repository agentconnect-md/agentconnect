// The AG-UI encoder, read back through `@ag-ui/client`'s own HttpAgent and checked against `@ag-ui/core`'s event schemas.
import { describe, it, expect } from 'vitest'
import { HttpAgent, type Message } from '@ag-ui/client'
import { EventSchemas } from '@ag-ui/core/schemas'
import type { WebchatDone, WebchatEvent, WebchatOutput } from '@agentconnect.md/protocol'
import { AG_UI_CHAT_PROTOCOL, AG_UI_HEADERS, AgUiEventEncoder, agUiThreadId, agUiTurnText } from './ag-ui-encoder.js'

const CONV = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TURN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const TURN_2 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const SEG_A = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const SEG_B = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const THREAD = 'chat-1'
const RUN = 'run-1'

let index = 0
const out = (event?: WebchatEvent): WebchatOutput => ({
  conversationId: CONV,
  turnId: TURN,
  index: index++,
  ...(event ? { event } : {})
})
const done = (over: Partial<WebchatDone> = {}): WebchatDone => ({ conversationId: CONV, turnId: TURN, ...over })

/** One run's wire text from `build`, with every event it holds checked against the AG-UI event schema. */
function encode(build: (enc: AgUiEventEncoder) => string[], turnId = TURN): string {
  const wire = build(new AgUiEventEncoder(turnId, THREAD, RUN)).join('')
  for (const frame of wire.split('\n\n')) {
    const data = frame.split('\n').find((l) => l.startsWith('data: '))
    if (data) EventSchemas.parse(JSON.parse(data.slice(6)))
  }
  return wire
}

/** Run an HttpAgent against `wires`, one response per run, and return what it assembled the way an AG-UI app would. */
async function run(...wires: string[]): Promise<{ agent: HttpAgent; errors: string[]; events: string[] }> {
  const pending = [...wires]
  const agent = new HttpAgent({
    url: 'https://relay.example.test/ag-ui/agents/example/chat',
    threadId: THREAD,
    fetch: async () => new Response(pending.shift()!, { headers: AG_UI_HEADERS })
  })
  const errors: string[] = []
  const events: string[] = []
  for (let i = 0; i < wires.length; i++) {
    agent.addMessage({ id: `u${i}`, role: 'user', content: 'hello' })
    await agent
      .runAgent(
        { runId: RUN },
        {
          onEvent: ({ event }) => void events.push(event.type),
          onRunErrorEvent: ({ event }) => void errors.push(event.message)
        }
      )
      .catch((e: unknown) => errors.push(e instanceof Error ? e.message : String(e)))
  }
  return { agent, errors, events }
}

const replies = (messages: Message[]) => messages.filter((m) => m.role !== 'user')

describe('AgUiEventEncoder', () => {
  it('maps a turn onto one run: text and reasoning messages, activities, and a title', async () => {
    const wire = encode((enc) => [
      enc.open(),
      enc.output(out({ kind: 'thinking', text: 'looking' })),
      enc.output(out({ kind: 'message', text: 'Here ' })),
      enc.keepalive(),
      enc.output(out({ kind: 'message', text: 'it is.' })),
      enc.output(out({ kind: 'tool_call', toolCallId: 'call-1', title: 'Search docs', status: 'in_progress' })),
      enc.output(out({ kind: 'tool_update', toolCallId: 'call-1', status: 'completed' })),
      enc.output(out({ kind: 'plan', entries: [{ content: 'answer', status: 'in_progress' }] })),
      enc.output(out({ kind: 'plan', entries: [{ content: 'answer', status: 'completed' }] })),
      enc.output(out({ kind: 'notice', text: 'waiting for a sandbox' })),
      enc.output(out({ kind: 'notice', text: '' })),
      enc.output(out({ kind: 'notice', text: 'quota is low', standing: true })),
      enc.output(out({ kind: 'session_info', title: 'Docs help' })),
      enc.output(out({ kind: 'message', text: 'Done.' })),
      enc.output(out()),
      enc.done(done({ stopReason: 'end_turn' }))
    ])
    const { agent, errors, events } = await run(wire)
    expect(errors).toEqual([])
    expect(events).toContain('CUSTOM')
    expect(events.at(-1)).toBe('RUN_FINISHED')
    expect(replies(agent.messages)).toMatchObject([
      { id: `${TURN}:reasoning-1`, role: 'reasoning', content: 'looking' },
      { id: `${TURN}:text-2`, role: 'assistant', content: 'Here it is.' },
      {
        id: `${TURN}:tool:call-1`,
        role: 'activity',
        activityType: 'tool',
        content: { toolCallId: 'call-1', title: 'Search docs', status: 'completed' }
      },
      { role: 'activity', activityType: 'plan', content: { entries: [{ content: 'answer', status: 'completed' }] } },
      { role: 'activity', activityType: 'notice', content: { text: '' } },
      { role: 'activity', activityType: 'notice', content: { text: 'quota is low', standing: true } },
      { role: 'assistant', content: 'Done.' }
    ])
  })

  it('keeps each run in its own ids, so a later run never replaces an earlier one', async () => {
    const turn = (turnId: string, text: string) =>
      encode(
        (enc) => [
          enc.open(),
          enc.output(out({ kind: 'plan', entries: [{ content: text, status: 'completed' }] })),
          enc.output(out({ kind: 'message', text })),
          enc.done(done())
        ],
        turnId
      )
    const { agent, errors } = await run(turn(TURN, 'first'), turn(TURN_2, 'second'))
    expect(errors).toEqual([])
    expect(replies(agent.messages)).toMatchObject([
      { role: 'activity', content: { entries: [{ content: 'first' }] } },
      { role: 'assistant', content: 'first' },
      { role: 'activity', content: { entries: [{ content: 'second' }] } },
      { role: 'assistant', content: 'second' }
    ])
  })

  it('starts a new text message when the segment changes, and skips empty deltas', async () => {
    const wire = encode((enc) => [
      enc.open(),
      enc.output(out({ kind: 'message', text: 'one', segmentId: SEG_A })),
      enc.output(out({ kind: 'message', text: '', segmentId: SEG_B })),
      enc.output(out({ kind: 'message', text: 'two', segmentId: SEG_B })),
      enc.done(done())
    ])
    const { agent } = await run(wire)
    expect(replies(agent.messages).map((m) => m.content)).toEqual(['one', 'two'])
  })

  it('ends a failed turn with RUN_ERROR after closing its open message', async () => {
    const failed = encode((enc) => [
      enc.open(),
      enc.output(out({ kind: 'message', text: 'partial' })),
      enc.done(done({ error: 'the runtime crashed' }))
    ])
    expect(failed).toContain('"TEXT_MESSAGE_END"')
    const { agent, errors } = await run(failed)
    expect(errors[0]).toBe('the runtime crashed')
    expect(replies(agent.messages)).toMatchObject([{ role: 'assistant', content: 'partial' }])

    const dropped = encode((enc) => [enc.open(), enc.fail('the agent daemon disconnected')])
    expect((await run(dropped)).errors[0]).toBe('the agent daemon disconnected')
  })

  it('reports a cancelled turn as a cancelled run and any other stop as a completed one', () => {
    const finished = (stopReason?: string) =>
      JSON.parse(encode((enc) => [enc.done(done(stopReason ? { stopReason } : {}))]).slice(6))
    expect(finished('cancelled')).toEqual({
      type: 'RUN_FINISHED',
      threadId: THREAD,
      runId: RUN,
      outcome: { type: 'cancelled' }
    })
    expect(finished('max_tokens')).toEqual({ type: 'RUN_FINISHED', threadId: THREAD, runId: RUN })
    expect(finished()).toEqual({ type: 'RUN_FINISHED', threadId: THREAD, runId: RUN })
  })
})

describe('AG-UI requests', () => {
  it('reads the last user message, as text or text parts', () => {
    expect(
      agUiTurnText({
        messages: [
          { id: 'u0', role: 'user', content: 'earlier' },
          { id: 'a0', role: 'assistant', content: 'answer' },
          {
            id: 'u1',
            role: 'user',
            content: [
              { type: 'text', text: 'first line' },
              { type: 'image', source: { type: 'url', value: 'https://example.test/a.png' } },
              { type: 'text', text: 'second line' }
            ]
          }
        ]
      })
    ).toBe('first line\nsecond line')
    expect(agUiTurnText({ messages: [{ id: 'u', role: 'user', content: '  ' }] })).toBeUndefined()
    expect(agUiTurnText({ messages: [{ id: 'a', role: 'assistant', content: 'hi' }] })).toBeUndefined()
    expect(agUiTurnText(null)).toBeUndefined()
  })

  it('names the conversation by threadId and echoes a usable runId, else the turn', () => {
    expect(agUiThreadId({ threadId: THREAD })).toBe(THREAD)
    expect(agUiThreadId({ threadId: '' })).toBeUndefined()
    expect(agUiThreadId({ threadId: 'x'.repeat(129) })).toBeUndefined()
    const started = (body: unknown) => JSON.parse(AG_UI_CHAT_PROTOCOL.encoder(TURN, body).open().slice(6))
    expect(started({ threadId: THREAD, runId: RUN })).toEqual({ type: 'RUN_STARTED', threadId: THREAD, runId: RUN })
    expect(started({ threadId: THREAD })).toEqual({ type: 'RUN_STARTED', threadId: THREAD, runId: TURN })
  })
})
