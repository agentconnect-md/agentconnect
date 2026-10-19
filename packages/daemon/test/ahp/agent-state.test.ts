import { describe, expect, it } from 'vitest'
import { ActionType, chatReducer, SessionStatus, type ChatAction, type ChatState } from '@microsoft/agent-host-protocol'
import { AhpActionJournal } from '../../src/ahp/action-journal.js'
import { AhpAgentState, type AhpCheckpointStore } from '../../src/ahp/agent-state.js'

const binding = {
  sessionUri: 'ahp-session:/one',
  sessionId: 'physical',
  conversationId: 'conversation',
  reservationId: 'reservation'
}
const chat = 'ahp-chat:/one/main'
const event = { sessionId: 'physical', turnId: 'turn', generation: 0, at: 1000 }
async function fixture(checkpoints?: AhpCheckpointStore) {
  let high = 0
  const journal = await AhpActionJournal.create({ reserve: async (size) => ({ start: high + 1, end: (high += size) }) })
  const state = new AhpAgentState(
    { provider: 'agent', displayName: 'Agent', description: '', models: [] },
    journal,
    () => 2000,
    checkpoints
  )
  return { state, journal }
}

describe('AHP logical agent state', () => {
  it('keeps standard reducer state convergent across observers without browser conversation metadata', async () => {
    const { state, journal } = await fixture()
    await state.add(binding)
    const initial = state.snapshot(chat) as ChatState
    await state.accept({ ...event, kind: 'started', text: 'Hello', origin: 'user' })
    await state.accept({ ...event, kind: 'text', text: 'World' })
    await state.accept({ ...event, kind: 'finished', outcome: 'complete' })
    const actions = journal.replay(1, new Set([chat]))!.map((envelope) => envelope.action as ChatAction)
    expect(actions.reduce((state, action) => chatReducer(state, action), initial)).toEqual(state.snapshot(chat))
    expect(JSON.stringify(state.snapshot(binding.sessionUri))).not.toContain('conversationId')
    expect(state.summary(binding.sessionUri)?.status).toBe(SessionStatus.Idle)
  })

  it('fails closed before persisting or journaling unrepresentable active output', async () => {
    let saved: ChatState | undefined
    const { state, journal } = await fixture({
      load: async () => undefined,
      save: async (_id, value) => {
        saved = value
      },
      running: () => true
    })
    await state.add(binding)
    await state.accept({ ...event, kind: 'started', text: 'Hello', origin: 'user' })
    const before = journal.currentSequence
    await expect(state.accept({ ...event, kind: 'text', text: 'x'.repeat(64 * 1024) })).rejects.toThrow('wire capacity')
    expect(journal.currentSequence).toBe(before)
    expect(saved?.activeTurn?.responseParts).toEqual([])
  })

  it('preserves the live generation and part identity when binding an already observed session', async () => {
    const { state } = await fixture()
    await state.accept({ ...event, kind: 'started', text: 'Hello', origin: 'user' })
    await state.accept({ ...event, kind: 'discarded', nextGeneration: 1 })
    await state.accept({ ...event, generation: 1, kind: 'text', text: 'Before' })
    await state.add(binding)
    await state.accept({ ...event, generation: 1, kind: 'text', text: 'After' })
    await state.accept({ ...event, generation: 0, kind: 'text', text: 'stale' })
    expect((state.snapshot(chat) as ChatState).activeTurn?.responseParts).toMatchObject([
      { id: 'turn:1:1', content: 'BeforeAfter' }
    ])
  })

  it('holds active references after disconnect then evicts on completion', async () => {
    const { state } = await fixture()
    state.retain(binding.sessionUri)
    await state.add(binding)
    await state.accept({ ...event, kind: 'started', text: 'Hello', origin: 'user' })
    state.release(binding.sessionUri)
    expect(state.snapshot(chat)).toBeDefined()
    await state.accept({ ...event, kind: 'finished', outcome: 'complete' })
    expect(state.snapshot(chat)).toBeUndefined()
    state.release('ahp-session:/not-loaded')
    state.retain(binding.sessionUri)
    await state.add(binding)
    expect(state.snapshot(chat)).toBeDefined()
  })

  it('durably finalizes cold pending input before exposing a recovered snapshot', async () => {
    let saved: ChatState | undefined
    const checkpoints: AhpCheckpointStore = {
      load: async () => saved,
      save: async (_id, state) => {
        saved = structuredClone(state)
      },
      running: () => false
    }
    const first = await fixture(checkpoints)
    await first.state.add(binding)
    await first.state.accept({ ...event, kind: 'started', text: 'Hello', origin: 'user' })
    await first.state.accept({ ...event, kind: 'elicitation', requestId: 'ask', message: 'Choose', options: [] })
    await first.state.accept({ ...event, kind: 'permission', requestId: 'permission', tool: 'Read', detail: 'Allow?' })
    const next = await fixture(checkpoints)
    await next.state.add(binding)
    expect((next.state.snapshot(chat) as ChatState).activeTurn).toBeUndefined()
    expect(saved?.turns[0]?.responseParts).toMatchObject([
      { response: 'cancel' },
      { toolCall: { status: 'cancelled' } },
      { kind: 'error' }
    ])
  })

  it('returns bounded history without changing shared snapshots or replay', async () => {
    const { state, journal } = await fixture()
    await state.add(binding, {
      resource: chat,
      title: 'History',
      status: SessionStatus.Idle,
      modifiedAt: new Date(0).toISOString(),
      turns: [],
      turnsNextCursor: 'first'
    })
    const cursors: string[] = []
    const page = async (_id: string, cursor: string) => {
      cursors.push(cursor)
      return { turns: [], ...(cursor === 'first' ? { nextCursor: 'second' } : {}) }
    }
    const first = await state.fetchTurns(chat, undefined, page)
    expect(first?.turnsNextCursor).toBe('second')
    expect((await state.fetchTurns(chat, first?.turnsNextCursor, page))?.turnsNextCursor).toBeUndefined()
    expect(cursors).toEqual(['first', 'second'])
    expect(journal.replay(1, new Set([chat]))).toEqual([])
    expect((state.snapshot(chat) as ChatState).turnsNextCursor).toBe('first')
  })
})
