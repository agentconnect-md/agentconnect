import { describe, expect, it, vi } from 'vitest'
import { observeChatTurn } from '../src/session/chat-observer.js'
import type { MaskedChatEvent } from '../src/session/chat-events.js'
import type { ChatTurnOutput } from '../src/session/chat-turn.js'
import { emitChatUpdate } from '../src/session/chat-output.js'
import { toolEditsOf, toolEditText } from '../src/session/tool-edits.js'

const edit = { type: 'diff', path: '/work/src/a.ts', oldText: 'one\ntwo\nthree\n', newText: 'one\n2\nthree\nfour\n' }
const create = { type: 'diff', path: '/work/new.md', newText: '# New\n' }

describe('ACP diff content as tool edits', () => {
  it('reports metadata for edits and creations and skips malformed items', () => {
    const edits = toolEditsOf({
      content: [
        { type: 'content', content: { type: 'text', text: 'done' } },
        edit,
        create,
        { type: 'diff', path: '', newText: 'x' },
        { type: 'diff', path: '/work/b.ts', oldText: 3, newText: 'x' }
      ]
    })
    expect(edits).toEqual([
      { path: '/work/src/a.ts', created: false, added: 2, removed: 1, beforeBytes: 14, afterBytes: 17 },
      { path: '/work/new.md', created: true, added: 1, removed: 0, afterBytes: 6 }
    ])
    expect(toolEditsOf({ content: [{ type: 'content', content: { type: 'text', text: 'x' } }] })).toBeUndefined()
  })

  it('reads either side back from a persisted tool body', () => {
    const body = { status: 'completed', content: [edit, create] }
    expect(toolEditText(body, '/work/src/a.ts', 'before')).toBe(edit.oldText)
    expect(toolEditText(body, '/work/src/a.ts', 'after')).toBe(edit.newText)
    expect(toolEditText(body, '/work/new.md', 'before')).toBeUndefined()
    expect(toolEditText(body, '/work/new.md', 'after')).toBe('# New\n')
    expect(toolEditText(body, '/work/other.ts', 'after')).toBeUndefined()
    expect(toolEditText({ content: 'nope' }, '/work/src/a.ts', 'after')).toBeUndefined()
  })

  it('carries edits from a runtime tool call onto the observed chat event', () => {
    const events: MaskedChatEvent[] = []
    const sink = { output: vi.fn(), done: vi.fn() }
    const observed = observeChatTurn(
      { conversationId: 'conv', turnId: 'turn', sink },
      { sessionId: 'outward', generation: 0, emit: (e) => events.push(e), now: () => 1 }
    )
    const wc: ChatTurnOutput = {
      ...observed,
      index: 0,
      replyText: '',
      replySegments: [],
      heldText: '',
      messageEmitted: false
    }
    emitChatUpdate(wc, { sessionUpdate: 'tool_call', toolCallId: 'e1', title: 'Edit', content: [edit] })
    emitChatUpdate(wc, { sessionUpdate: 'tool_call_update', toolCallId: 'e1', status: 'completed' })
    expect(events.map((e) => (e.kind === 'tool' ? e.edits : undefined))).toEqual([
      [{ path: '/work/src/a.ts', created: false, added: 2, removed: 1, beforeBytes: 14, afterBytes: 17 }],
      undefined
    ])
  })
})
