import { describe, expect, expectTypeOf, it } from 'vitest'
import type { RdWebchatPost, WebchatDone, WebchatEvent, WebchatOutput, WebchatStatus } from '@agentconnect.md/protocol'
import type { ChatEvent, ChatOutput, ChatPost, ChatStatus, ChatTurnOutput } from '../src/session/chat-turn.js'
import { legacyChatOutput, legacyChatCompletion } from '../src/webchat/chat-output.js'
import { emitChatUpdate, flushHeldChatText } from '../src/session/chat-output.js'

// The legacy adapter projects shared events without leaking its replay fields into execution.
describe('protocol-neutral chat output', () => {
  it('remains representable by the legacy protocol adapter', () => {
    expectTypeOf<WebchatEvent>().toExtend<ChatEvent>()
    expectTypeOf<ChatStatus>().toEqualTypeOf<WebchatStatus>()
    expectTypeOf<ReturnType<typeof legacyChatOutput>>().toEqualTypeOf<WebchatOutput>()
    expectTypeOf<ReturnType<typeof legacyChatCompletion>>().toEqualTypeOf<WebchatDone>()
    expectTypeOf<ChatPost>().toEqualTypeOf<RdWebchatPost>()
  })

  it('keeps reply boundaries and canonical post identity without allocating a protocol stream', () => {
    const output: ChatOutput[] = []
    const context: ChatTurnOutput = {
      conversationId: 'conversation',
      turnId: 'turn',
      index: 0,
      replyText: '',
      replySegments: [],
      heldText: '',
      messageEmitted: false,
      sink: { output: (update) => output.push(update), done: () => {} }
    }
    emitChatUpdate(context, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'First' } })
    emitChatUpdate(context, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Thinking' } })
    emitChatUpdate(context, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Second' } })
    flushHeldChatText(context)
    expect(context.replySegments.map((segment) => segment.text)).toEqual(['First', 'Second'])
    expect(output.map((update) => update.event?.kind)).toEqual(['message', 'thinking', 'message'])
    const posts = output.flatMap((update) => (update.event?.kind === 'message' ? [update.event.postId] : []))
    expect(posts).toEqual(context.replySegments.map((segment) => segment.postId))
    expect(output.every((update) => !('lastIndex' in update) && !('serverSeq' in update))).toBe(true)
  })
})
