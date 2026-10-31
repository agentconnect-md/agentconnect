// Sticky choice cards: stored, first click wins, a click starts a turn, a local process can create/update/read them.
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { ChoiceCards, EDIT_CHOICE, type ChoiceCardSurface } from '../src/cards/choice-cards.js'
import { Daemon } from '../src/daemon.js'
import { choiceCardBlocks, decodeCardValue } from '../src/platforms/slack/choice-card.js'
import { LocalStore } from '../src/store/local-store.js'
import { SqliteAsyncDatabase } from '../src/store/sqlite-async-database.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'

const open = () => LocalStore.open({ database: SqliteAsyncDatabase.adopt(new DatabaseSync(':memory:')) })

function service(store: LocalStore, now = { t: 1_000 }) {
  const surface: ChoiceCardSurface & { posted: unknown[]; redrawn: unknown[] } = {
    posted: [],
    redrawn: [],
    async post(card) {
      this.posted.push(card)
      return '1700000000.000900'
    },
    async redraw(card) {
      this.redrawn.push({ ...card })
      return true
    }
  }
  const turns: { cardId: string; text: string }[] = []
  const cards = new ChoiceCards({
    ledger: store.choiceCards,
    resolveAgent: (agent) =>
      agent === 'bot' || agent === 'a1' ? { agentId: 'a1', integrationId: 'i1', platform: 'slack' } : undefined,
    surfaceFor: () => surface,
    startTurn: async (card, text) => void turns.push({ cardId: card.cardId, text }),
    now: () => now.t
  })
  return { cards, surface, turns, now }
}

const spec = {
  agent: 'bot',
  channel: 'C1',
  thread: '1700000000.000100',
  title: 'Commitment',
  body: 'Ship release 1.4 to production?',
  options: [
    { id: 'send-1', label: 'Send' },
    { id: 'skip', label: 'Skip' }
  ],
  editText: 'Ship release 1.4 to production?'
}

describe('choice cards', () => {
  it('creates, reads and updates a card through its routes', async () => {
    const store = await open()
    const { cards, surface } = service(store)
    const created = await cards.create(spec)
    expect(created.status).toBe(201)
    const id = (created.body as { id: string }).id
    expect(surface.posted).toHaveLength(1)
    expect((await cards.read(id)).body).toMatchObject({ id, state: 'open', ts: '1700000000.000900' })
    const updated = await cards.update(id, { state: 'stale', label: 'Stale: a newer reply arrived' })
    expect(updated.body).toMatchObject({ state: 'stale', label: 'Stale: a newer reply arrived' })
    expect(surface.redrawn).toHaveLength(1)
    expect((await cards.read('nope')).status).toBe(404)
    expect((await cards.create({ ...spec, agent: 'other' })).status).toBe(404)
    await store.close()
  })

  it('lets the first click win, records it, and starts one turn', async () => {
    const store = await open()
    const { cards, turns } = service(store)
    const id = ((await cards.create(spec)).body as { id: string }).id
    const first = cards.click({ cardId: id, choice: 'send-1', actor: { userId: 'U1', name: 'ana' } })
    const second = cards.click({ cardId: id, choice: 'skip', actor: { userId: 'U2', name: 'bo' } })
    expect(await Promise.all([first, second])).toEqual([true, false])
    expect(turns).toHaveLength(1)
    expect(turns[0]!.text).toBe(`[card ${id}] ana chose "Send" (option send-1) on "Commitment".`)
    expect((await cards.read(id)).body).toMatchObject({ state: 'decided', choice: 'send-1', clickedBy: 'U1' })
    await store.close()
  })

  it('keeps the edited text and survives a fresh service over the same store (a restart)', async () => {
    const store = await open()
    const id = ((await service(store).cards.create(spec)).body as { id: string }).id
    const after = service(store)
    expect(
      await after.cards.click({
        cardId: id,
        choice: EDIT_CHOICE,
        editedText: 'Ship release 1.5 to production?',
        actor: { userId: 'U3' }
      })
    ).toBe(true)
    expect((await after.cards.read(id)).body).toMatchObject({ editedText: 'Ship release 1.5 to production?' })
    expect(after.turns[0]!.text).toContain('Ship release 1.5 to production?')
    await store.close()
  })

  it('refuses clicks on a settled or expired card', async () => {
    const store = await open()
    const s = service(store)
    const id = ((await s.cards.create({ ...spec, expiresAt: 2_000 })).body as { id: string }).id
    s.now.t = 3_000
    expect(await s.cards.click({ cardId: id, choice: 'send-1', actor: { userId: 'U1' } })).toBe(false)
    expect((await s.cards.read(id)).body).toMatchObject({ state: 'expired' })
    const other = ((await s.cards.create(spec)).body as { id: string }).id
    await s.cards.update(other, { state: 'stale' })
    expect(await s.cards.click({ cardId: other, choice: 'send-1', actor: { userId: 'U1' } })).toBe(false)
    expect(s.turns).toEqual([])
    await store.close()
  })

  it('renders buttons while open and the decision after', async () => {
    const store = await open()
    const { cards } = service(store)
    const id = ((await cards.create(spec)).body as { id: string }).id
    const card = (await store.choiceCards.get(id))!
    const openBlocks = JSON.stringify(choiceCardBlocks(card))
    expect(openBlocks).toContain('ac_card:0')
    expect(openBlocks).toContain('ac_card_edit')
    expect(decodeCardValue(`${id}|send-1`)).toEqual({ cardId: id, choice: 'send-1' })
    await cards.click({ cardId: id, choice: 'skip', actor: { userId: 'U9' } })
    const done = JSON.stringify(choiceCardBlocks((await store.choiceCards.get(id))!))
    expect(done).not.toContain('ac_card:0')
    expect(done).toContain('Skip — <@U9>')
    await store.close()
  })

  it('dispatches the click turn into the card thread as the clicker, in the daemon', async () => {
    const daemon: any = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
    daemon.store = await open()
    daemon.agents.set('a1', { id: 'a1', name: 'bot', integrations: [{ id: 'i1', platform: 'slack' }] })
    daemon.connByIntegration.set('i1', {
      postBlocks: vi.fn(async () => '1700000000.000900'),
      updateBlocks: vi.fn(async () => true)
    })
    daemon.dispatch = vi.fn(async () => 'acp-1')
    const id = ((await daemon.choiceCards().create(spec)).body as { id: string }).id
    await daemon.choiceCards().click({ cardId: id, choice: 'send-1', actor: { userId: 'U1', name: 'ana' } })
    const [agentId, msg, integrationId] = daemon.dispatch.mock.calls[0]
    expect([agentId, integrationId]).toEqual(['a1', 'i1'])
    expect(msg).toMatchObject({ channel: 'C1', thread: '1700000000.000100', sender: { id: 'U1', name: 'ana' } })
    await daemon.store.close()
  })
})

describe('choice card tools', () => {
  it('post into the session conversation and touch only the agent’s own cards', async () => {
    const { postChoiceCard, readChoiceCard, updateChoiceCard } = await import('../src/mcp/ops/choice-cards.js')
    const store = await open()
    const s = service(store)
    const deps = { choiceCards: () => s.cards }
    const ctx = {
      agentId: 'a1',
      platform: 'slack',
      integrationId: 'i1',
      isDm: false,
      channel: 'C1',
      thread: '1700000000.000100',
      deliveryThread: '1700000000.000100',
      tools: []
    } as never
    const card = (await postChoiceCard(ctx, { title: 'Pick', options: [{ id: 'a', label: 'A' }] }, deps)) as {
      id: string
    }
    expect(s.surface.posted).toHaveLength(1)
    expect(await readChoiceCard(ctx, { cardId: card.id }, deps)).toMatchObject({
      state: 'open',
      thread: '1700000000.000100'
    })
    expect(await updateChoiceCard(ctx, { cardId: card.id, state: 'done', label: 'Closed' }, deps)).toMatchObject({
      state: 'done'
    })
    const stranger = { ...(ctx as object), agentId: 'a2' } as never
    await expect(readChoiceCard(stranger, { cardId: card.id }, deps)).rejects.toThrow('unknown card')
    await store.close()
  })
})
