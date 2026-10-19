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

  it('advances fetchTurns without repeating the first page and publishes before returning', async () => {
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
    await state.fetchTurns(chat, undefined, page)
    await state.fetchTurns(chat, undefined, page)
    await state.fetchTurns(chat, undefined, page)
    expect(cursors).toEqual(['first', 'second'])
    expect(journal.replay(1, new Set([chat]))!.map((envelope) => envelope.action.type)).toEqual([
      ActionType.ChatTurnsLoaded,
      ActionType.ChatTurnsLoaded
    ])
  })
})
