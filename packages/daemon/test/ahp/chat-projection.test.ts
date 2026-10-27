import { describe, expect, it } from 'vitest'
import { ActionType, chatReducer, type ChatAction, type ChatState } from '@microsoft/agent-host-protocol'
import { AhpChatProjection } from '../../src/ahp/chat-projection.js'
import type { MaskedChatEvent } from '../../src/session/chat-events.js'
import { parseFileEditUri } from '../../src/ahp/file-edits.js'

const base = { sessionId: 'session', turnId: 'turn', generation: 0, at: 1000 }
function fixture(initial?: ChatState) {
  const actions: ChatAction[] = []
  const projection = new AhpChatProjection(
    'session',
    'ahp-chat:/one/main',
    'One',
    1000,
    (action) => actions.push(action),
    initial
  )
  const start = projection.snapshot()
  const emit = (event: Omit<MaskedChatEvent, keyof typeof base> & Record<string, unknown>) =>
    projection.accept({ ...base, ...event } as MaskedChatEvent)
  const converges = () =>
    expect(actions.reduce((state, action) => chatReducer(state, action), start)).toEqual(projection.snapshot())
  return { projection, actions, emit, converges }
}

describe('AHP official chat reducer projection', () => {
  it('preserves interleaved text, reasoning, pending tools and final input/output', () => {
    const { projection, emit, converges } = fixture()
    emit({ kind: 'started', text: 'Hello', origin: 'user' })
    emit({ kind: 'text', text: 'First' })
    emit({ kind: 'reasoning', text: 'Thinking' })
    emit({ kind: 'text', text: 'Second' })
    emit({ kind: 'tool', id: 'read', title: 'Read', status: 'pending' })
    expect(projection.snapshot().activeTurn?.responseParts.at(-1)).toMatchObject({ toolCall: { status: 'streaming' } })
    emit({ kind: 'tool', id: 'read', title: 'Read', status: 'running', input: 'fixture.txt' })
    emit({ kind: 'tool', id: 'read', title: 'Read', status: 'completed', output: 'fixture output' })
    emit({ kind: 'finished', outcome: 'complete', at: 2000 })
    expect(projection.snapshot().turns[0]?.responseParts).toMatchObject([
      { kind: 'markdown', content: 'First' },
      { kind: 'reasoning', content: 'Thinking' },
      { kind: 'markdown', content: 'Second' },
      {
        kind: 'toolCall',
        toolCall: {
          toolCallId: 'runtime:read',
          toolInput: 'fixture.txt',
          success: true,
          content: [{ type: 'text', text: 'fixture output' }]
        }
      }
    ])
    converges()
  })

  it('attaches remembered edits to a successful tool result as file edits', () => {
    const { projection, emit, converges } = fixture()
    const edit = { index: 0, path: '/work/a.ts', created: false, added: 2, removed: 1, beforeBytes: 14, afterBytes: 17 }
    const create = { index: 1, path: '/work/new.md', created: true, added: 1, removed: 0, afterBytes: 6 }
    emit({ kind: 'started', text: 'Edit', origin: 'user' })
    emit({ kind: 'tool', id: 'e1', title: 'Edit', status: 'pending', edits: [edit, create] })
    emit({ kind: 'tool', id: 'e1', title: 'Edit', status: 'running' })
    emit({ kind: 'tool', id: 'e1', title: 'Edit', status: 'completed' })
    emit({ kind: 'tool', id: 'e2', title: 'Edit', status: 'running', edits: [edit] })
    emit({ kind: 'tool', id: 'e2', title: 'Edit', status: 'failed', output: 'no match' })
    emit({ kind: 'tool', id: 'e3', title: 'Edit', status: 'running', edits: [edit] })
    emit({ kind: 'tool', id: 'e3', title: 'Edit', status: 'completed', output: 'replaced', edits: [] })
    emit({ kind: 'finished', outcome: 'complete', at: 2000 })
    const [first, second, third] = projection.snapshot().turns[0]!.responseParts as Array<{ toolCall: any }>
    const [changed, created] = first!.toolCall.content
    expect(changed).toMatchObject({
      type: 'fileEdit',
      before: { uri: 'file:///work/a.ts', content: { sizeHint: 14, contentType: 'text/plain' } },
      after: { uri: 'file:///work/a.ts', content: { sizeHint: 17 } },
      diff: { added: 2, removed: 1 }
    })
    expect(parseFileEditUri(changed.before.content.uri)).toEqual({
      sessionUri: 'ahp-session:/one',
      toolCallId: 'e1',
      index: 0,
      path: '/work/a.ts',
      side: 'before'
    })
    expect(changed.after.content.uri).toMatch(/^session-db:\/\/[0-9a-f]+\/[0-9a-f]+\/0\/[0-9a-f]+\/after\/a\.ts$/)
    expect(created.before).toBeUndefined()
    expect(parseFileEditUri(created.after.content.uri)).toMatchObject({ index: 1, path: '/work/new.md', side: 'after' })
    expect(second!.toolCall).toMatchObject({ success: false, content: [{ type: 'text', text: 'no match' }] })
    expect(third!.toolCall.content).toEqual([{ type: 'text', text: 'replaced' }])
    converges()
  })

  it('discards through standard truncation and fences the prior generation', () => {
    const { projection, emit, converges } = fixture()
    emit({ kind: 'started', text: 'Hello', origin: 'user' })
    emit({ kind: 'text', text: 'discard me' })
    emit({ kind: 'discarded', nextGeneration: 1 })
    emit({ kind: 'text', text: 'late old generation' })
    emit({ kind: 'text', text: 'retained', generation: 1 })
    emit({ kind: 'finished', outcome: 'complete', generation: 1 })
    expect(JSON.stringify(projection.snapshot())).not.toContain('discard me')
    expect(JSON.stringify(projection.snapshot())).not.toContain('late old generation')
    expect(projection.snapshot().turns[0]?.responseParts).toMatchObject([{ content: 'retained' }])
    converges()
  })

  it('settles permission only on the final actual result, with noncolliding runtime IDs', () => {
    const { projection, emit, converges } = fixture()
    emit({ kind: 'started', text: 'Hello', origin: 'user' })
    emit({ kind: 'tool', id: 'ask', title: 'Read', status: 'running' })
    emit({
      kind: 'permission',
      requestId: 'ask',
      tool: 'Read',
      detail: 'Allow?',
      options: [{ id: 'yes', label: 'Allow', allow: true }]
    })
    expect(projection.snapshot().activeTurn?.responseParts.at(-1)).toMatchObject({
      toolCall: { status: 'pending-confirmation' }
    })
    emit({ kind: 'permission_resolved', requestId: 'ask', outcome: 'allowed', selectedOptionId: 'yes' })
    expect(projection.snapshot().activeTurn?.responseParts.at(-1)).toMatchObject({
      toolCall: { status: 'completed', success: true, pastTenseMessage: 'Permission granted' }
    })
    const snapshot = projection.snapshot()
    emit({ kind: 'permission_resolved', requestId: 'ask', outcome: 'denied' })
    expect(projection.snapshot()).toEqual(snapshot)
    converges()
  })

  it('persists actual typed answers and cancels unanswered cards before terminal echoes', () => {
    const { projection, emit, converges } = fixture()
    emit({ kind: 'started', text: 'Hello', origin: 'user' })
    emit({ kind: 'elicitation', requestId: 'answered', message: 'Choose', options: [{ label: 'One', value: 'one' }] })
    emit({ kind: 'elicitation_resolved', requestId: 'answered', outcome: 'accepted', answers: { value: 'one' } })
    emit({ kind: 'elicitation', requestId: 'unanswered', message: 'Choose', options: [] })
    emit({ kind: 'permission', requestId: 'permission', tool: 'Read', detail: 'Allow?' })
    projection.apply({ type: ActionType.ChatTurnCancelled, turnId: 'turn', duration: 1000 })
    expect(projection.snapshot().turns[0]?.responseParts).toMatchObject([
      {
        response: 'accept',
        request: { answers: { value: { state: 'submitted', value: { kind: 'selected', value: 'one' } } } }
      },
      { response: 'cancel' },
      { toolCall: { status: 'cancelled', reason: 'skipped' } }
    ])
    converges()
  })

  it('restores active checkpoint without colliding parts and retains an explicit archive cursor', () => {
    const first = fixture()
    first.emit({ kind: 'started', text: 'Hello', origin: 'user' })
    first.emit({ kind: 'text', text: 'Before' })
    const restored = fixture(first.projection.snapshot())
    restored.emit({ kind: 'text', text: 'After' })
    const parts = restored.projection.snapshot().activeTurn!.responseParts
    expect(parts[0]).toMatchObject({ id: 'turn:0:1' })
    expect(parts[1]).toMatchObject({ id: 'turn:0:2' })
    restored.emit({ kind: 'finished', outcome: 'complete' })
    restored.emit({ kind: 'started', turnId: 'second', text: 'Next', origin: 'user' })
    restored.emit({ kind: 'finished', turnId: 'second', outcome: 'complete' })
    restored.converges()
    restored.projection.retainCompleted(1)
    expect(restored.projection.snapshot().turns.map((turn) => turn.id)).toEqual(['second'])
    expect(restored.projection.snapshot().turnsNextCursor).toBe(
      `archive:${Buffer.from('second').toString('base64url')}`
    )
  })
})
