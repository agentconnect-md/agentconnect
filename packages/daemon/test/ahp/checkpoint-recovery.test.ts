import { afterEach, describe, expect, it } from 'vitest'
import { MessageKind, SessionStatus, TurnState, type ChatState, type Turn } from '@microsoft/agent-host-protocol'
import type { LocalStore } from '../../src/store/local-store.js'
import { openTestStore } from '../store-support.js'
import { LocalAhpCheckpoints } from '../../src/ahp/checkpoint-store.js'
import { AhpActionJournal } from '../../src/ahp/action-journal.js'
import { AhpAgentState } from '../../src/ahp/agent-state.js'
const stores: LocalStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
})
const binding = {
  sessionUri: 'ahp-session:/one',
  sessionId: 'physical',
  conversationId: 'conversation',
  reservationId: 'reservation'
}
const chat = 'ahp-chat:/one/main'
function turn(id: string): Turn {
  return {
    id,
    message: { text: id, origin: { kind: MessageKind.User } },
    responseParts: [],
    usage: undefined,
    state: TurnState.Complete
  }
}
async function fixture() {
  const store = await openTestStore()
  stores.push(store)
  const checkpoints = new LocalAhpCheckpoints(
    store,
    'org',
    'agent',
    () => false,
    () => 1000
  )
  const journal = await AhpActionJournal.create({
    reserve: (size) => store.reserveAhpSequenceBlock('org', 'agent', size)
  })
  const state = new AhpAgentState(
    { provider: 'agent', displayName: 'Agent', description: '', models: [] },
    journal,
    () => 1000,
    checkpoints
  )
  return { store, checkpoints, journal, state }
}

describe('AHP checkpoint integration', () => {
  it('preserves the archive chronology while a client loads older pages', async () => {
    const { store, state, journal } = await fixture()
    const initial: ChatState = {
      resource: chat,
      title: 'History',
      status: SessionStatus.Idle,
      modifiedAt: new Date(0).toISOString(),
      turns: [turn('first'), turn('second')],
      turnsNextCursor: 'history:older'
    }
    await state.add(binding, initial)
    const loaded = await state.fetchTurns(chat, undefined, async () => ({ turns: [turn('older')] }))
    expect((state.snapshot(chat) as ChatState).turns.map((turn) => turn.id)).toEqual(['first', 'second'])
    expect((state.snapshot(chat) as ChatState).turnsNextCursor).toBe('history:older')
    expect(journal.replay(1, new Set([chat]))).toEqual([])
    expect(loaded).toMatchObject({
      type: 'chat/turnsLoaded',
      turns: [{ id: 'older' }]
    })
    await expect(store.ahpTurnPage('org', 'agent', 'physical', 'older')).rejects.toThrow('Unknown')
    expect(
      (await store.ahpTurnPage('org', 'agent', 'physical', 'second')).values.map((value) => JSON.parse(value).id)
    ).toEqual(['first'])
  })

  it('keeps Apps presentation on the session channel and expires cold unfinished cards', async () => {
    const { state, checkpoints, store } = await fixture()
    await state.add(binding)
    await state.output('physical', {
      conversationId: 'private-conversation',
      turnId: 'turn',
      index: 1,
      status: { model: 'model', steerable: true },
      event: { kind: 'app', appId: 'app', title: 'Chart', toolName: 'charts__show', htmlBytes: 10 }
    })
    const first = state.snapshot(binding.sessionUri)
    expect(first).toMatchObject({
      _meta: {
        'agentconnect.md': {
          agentId: 'agent',
          sessionId: 'physical',
          status: { model: 'model' },
          steerable: true,
          apps: [{ card: { appId: 'app' } }]
        }
      }
    })
    expect(JSON.stringify(state.snapshot(chat))).not.toContain('charts__show')
    expect(JSON.stringify(first)).not.toContain('private-conversation')
    const before = JSON.stringify(first)
    await state.output('physical', {
      conversationId: 'private-conversation',
      turnId: 'turn',
      index: 2,
      event: {
        kind: 'app_rpc_result',
        appId: 'app',
        callId: 'private-call',
        outcome: { ok: true, result: 'secret-result' }
      }
    })
    expect(JSON.stringify(state.snapshot(binding.sessionUri))).toBe(before)
    const journal = await AhpActionJournal.create({
      reserve: (size) => store.reserveAhpSequenceBlock('org', 'agent', size)
    })
    const restored = new AhpAgentState(state.provider, journal, () => 2000, checkpoints)
    await restored.add(binding)
    expect(restored.snapshot(binding.sessionUri)).toMatchObject({
      _meta: { 'agentconnect.md': { apps: [{ outcome: 'expired' }] } }
    })
  })

  it('continues from the last archive page into existing transcript history', async () => {
    const { checkpoints } = await fixture()
    const value: ChatState = {
      resource: chat,
      title: 'History',
      status: SessionStatus.Idle,
      modifiedAt: new Date(0).toISOString(),
      turns: [turn('first'), turn('second')],
      _meta: { 'agentconnect.md': { historyCursor: 'history:older' } }
    }
    await checkpoints.save('physical', value, 1, 1, value.turns)
    const page = await checkpoints.page('physical', `archive:${Buffer.from('second').toString('base64url')}`)
    expect(page.turns.map((turn) => turn.id)).toEqual(['first'])
    expect(page.nextCursor).toBe('history:older')
    await expect(checkpoints.page('physical', 'archive:not=canonical')).rejects.toThrow('cursor')
    await expect(checkpoints.page('other', `archive:${Buffer.from('second').toString('base64url')}`)).rejects.toThrow(
      'cursor'
    )
  })
})
