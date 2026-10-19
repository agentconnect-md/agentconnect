import { describe, expect, it, vi } from 'vitest'
import { observeChatTurn } from '../src/session/chat-observer.js'
import type { MaskedChatEvent } from '../src/session/chat-events.js'
import type { ChatTurnContext, ChatTurnOutput } from '../src/session/chat-turn.js'
import { emitChatUpdate } from '../src/session/chat-output.js'
import { legacyChatOutput } from '../src/webchat/chat-output.js'

function fixture() {
  const events: MaskedChatEvent[] = []
  const sink = { output: vi.fn(), done: vi.fn() }
  const context: ChatTurnContext = { conversationId: 'conv', turnId: 'turn', sink }
  const observed = observeChatTurn(context, {
    sessionId: 'outward',
    generation: 0,
    emit: (e) => events.push(e),
    now: () => 42
  })
  return { context: observed, events, sink }
}

describe('shared masked chat observation', () => {
  it('observes the existing output and fences superseded generations without creating a start', () => {
    const w = fixture()
    expect(w.events).toEqual([])
    for (const event of [
      { kind: 'message', text: 'first', segmentId: 'one' },
      { kind: 'superseded', generation: 1 },
      { kind: 'message', text: 'replacement', segmentId: 'two' }
    ] as const)
      w.context.sink.output({ conversationId: 'conv', turnId: 'turn', index: w.events.length, event })
    w.context.sink.done({ conversationId: 'conv', turnId: 'turn', stopReason: 'cancelled' })
    expect(w.events.map((e) => [e.kind, e.generation])).toEqual([
      ['text', 0],
      ['discarded', 0],
      ['text', 1],
      ['finished', 1]
    ])
    expect(w.events[1]).toMatchObject({ nextGeneration: 1, sessionId: 'outward', turnId: 'turn', at: 42 })
    expect(w.events[3]).toMatchObject({ outcome: 'cancelled' })
    expect(w.sink.output).toHaveBeenCalledTimes(3)
    expect(w.sink.done).toHaveBeenCalledOnce()
  })

  it('bounds tool previews after masking and preserves legacy output ordinals', () => {
    const w = fixture()
    const wc: ChatTurnOutput = {
      ...w.context,
      index: 0,
      replyText: '',
      replySegments: [],
      heldText: '',
      messageEmitted: false
    }
    emitChatUpdate(wc, {
      sessionUpdate: 'tool_call',
      toolCallId: 'tool',
      title: 'Read',
      rawInput: { token: '[REDACTED]' },
      rawOutput: '界'.repeat(9000)
    })
    expect(w.events[0]).toMatchObject({ kind: 'tool', input: '{"token":"[REDACTED]"}', status: 'pending' })
    expect(Buffer.byteLength((w.events[0] as Extract<MaskedChatEvent, { kind: 'tool' }>).output!)).toBeLessThanOrEqual(
      8192
    )
    const output = w.sink.output.mock.calls[0]![0]
    expect(legacyChatOutput(output)).toEqual({
      ...output,
      event: { kind: 'tool_call', toolCallId: 'tool', title: 'Read', status: 'pending' }
    })
    expect(
      legacyChatOutput({
        ...output,
        index: 2,
        event: { kind: 'permission_resolved', requestId: 'r', outcome: 'allowed' }
      })
    ).toEqual({ conversationId: 'conv', turnId: 'turn', index: 2 })
  })

  it('retains actual typed answers only on the neutral observation', () => {
    const w = fixture()
    const output = {
      conversationId: 'conv',
      turnId: 'turn',
      index: 3,
      event: {
        kind: 'elicitation_resolved' as const,
        requestId: 'r',
        outcome: 'accepted' as const,
        label: 'Yes',
        answers: { yes: true }
      }
    }
    w.context.sink.output(output)
    expect(w.events[0]).toMatchObject({ answers: { yes: true } })
    expect(legacyChatOutput(output).event).toEqual({
      kind: 'elicitation_resolved',
      requestId: 'r',
      outcome: 'accepted',
      label: 'Yes'
    })
  })

  it('isolates an observer failure from the existing execution sink', () => {
    const sink = { output: vi.fn(), done: vi.fn() }
    const context = observeChatTurn(
      { conversationId: 'c', turnId: 't', sink },
      {
        sessionId: 's',
        generation: 0,
        emit() {
          throw Error('observer')
        }
      }
    )
    context.sink.done({ conversationId: 'c', turnId: 't' })
    expect(sink.done).toHaveBeenCalledOnce()
  })
})
