// Sticky choice cards: judged presses, the deciding handoff with its restart sweep, the closed state set, the Slack facet and the REST place.
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import {
  CARD_PRESS_FAILED_TEXT,
  ChoiceCards,
  type ChoiceCardPlace,
  type ChoiceCardSurface
} from '../src/cards/choice-cards.js'
import { CHOICE_CARD_REFUSALS } from '../src/agents/chat-actions.js'
import { Daemon } from '../src/daemon.js'
import { toolsForIntegrations } from '../src/mcp/tools.js'
import { EDIT_CHOICE } from '../src/platforms/choice-card.js'
import { declaresPort } from '../src/platforms/read-ports.js'
import { choiceCardBlocks, decodeCardValue, slackChoiceCards } from '../src/platforms/slack/choice-card.js'
import { LocalStore } from '../src/store/local-store.js'
import { SqliteAsyncDatabase } from '../src/store/sqlite-async-database.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'

const open = () => LocalStore.open({ database: SqliteAsyncDatabase.adopt(new DatabaseSync(':memory:')) })

const PLACE: ChoiceCardPlace = {
  agentId: 'a1',
  integrationId: 'i1',
  platform: 'slack',
  channel: 'C1',
  thread: '1700000000.000100',
  isDm: false
}

const CONTENT = {
  title: 'Commitment',
  body: 'Ship release 1.4 to production?',
  options: [
    { id: 'send-1', label: 'Send' },
    { id: 'skip', label: 'Skip' }
  ],
  editText: 'Ship release 1.4 to production?'
}

function service(store: LocalStore) {
  const h = {
    now: 1_000,
    refusal: undefined as string | undefined,
    admit: true as boolean | 'throw',
    deliveries: new Set<string>(),
    posted: [] as unknown[],
    redrawn: [] as { state: string; generation: number }[],
    told: [] as { userId: string; text: string }[],
    turns: [] as { cardId: string; text: string; deliveryId: string }[]
  }
  const surface: ChoiceCardSurface = {
    post: async (card) => (h.posted.push(card), '1700000000.000900'),
    redraw: async (card) => (h.redrawn.push({ state: card.state, generation: card.generation }), true),
    tellPrivately: async (_card, userId, text) => void h.told.push({ userId, text })
  }
  const cards = new ChoiceCards({
    ledger: store.choiceCards,
    surfaceFor: () => surface,
    judge: async () => h.refusal,
    startTurn: async (card, text, deliveryId, admitted) => {
      if (h.admit === 'throw') throw new Error('dispatch exploded')
      if (!h.admit) return false
      h.turns.push({ cardId: card.cardId, text, deliveryId })
      await admitted()
      return true
    },
    hasDelivery: async (id) => h.deliveries.has(id),
    now: () => h.now
  })
  return { cards, h }
}

const idOf = (reply: { body?: unknown }) => (reply.body as { id: string }).id
const press = (cards: ChoiceCards, cardId: string, userId = 'U1', choice = 'send-1') =>
  cards.click({ cardId, choice, actor: { userId, name: userId.toLowerCase() } })

describe('choice cards', () => {
  it('lets the first permitted press win: deciding, then decided once its turn is admitted', async () => {
    const store = await open()
    const { cards, h } = service(store)
    const id = idOf(await cards.create(PLACE, CONTENT))
    await Promise.all([press(cards, id, 'U1'), press(cards, id, 'U2', 'skip')])
    expect(h.turns).toEqual([
      { cardId: id, text: `[card ${id}] u1 chose "Send" (option send-1) on "Commitment".`, deliveryId: `card:${id}:0` }
    ])
    expect(h.redrawn.map((r) => r.state)).toEqual(['deciding', 'decided'])
    expect((await cards.read(id)).body).toMatchObject({ state: 'decided', choice: 'send-1', clickedBy: 'U1' })
    await store.close()
  })

  it('refuses a press it judges closed: only the presser is told, the card is untouched, a permitted press still wins', async () => {
    const store = await open()
    const { cards, h } = service(store)
    const id = idOf(await cards.create(PLACE, CONTENT))
    h.refusal = CHOICE_CARD_REFUSALS['not-editor']
    expect(await press(cards, id, 'U9')).toBeUndefined()
    expect(h.told).toEqual([{ userId: 'U9', text: CHOICE_CARD_REFUSALS['not-editor'] }])
    expect(h.redrawn).toEqual([])
    expect((await cards.read(id)).body).toMatchObject({ state: 'open' })
    expect((await store.choiceCards.get(id))!.clickedBy).toBeNull()
    // A bot is refused without a word.
    h.refusal = ''
    await press(cards, id, 'B1')
    expect(h.told).toHaveLength(1)
    h.refusal = undefined
    await press(cards, id, 'U1')
    expect((await cards.read(id)).body).toMatchObject({ state: 'decided', clickedBy: 'U1' })
    await store.close()
  })

  it('hands the refusal back to the ingress when the surface cannot tell the presser privately', async () => {
    const store = await open()
    const surface: ChoiceCardSurface = { post: async () => '1.2', redraw: async () => true }
    const cards = new ChoiceCards({
      ledger: store.choiceCards,
      surfaceFor: () => surface,
      judge: async () => CHOICE_CARD_REFUSALS.closed,
      startTurn: async () => true,
      hasDelivery: async () => false,
      now: () => 1
    })
    const id = idOf(await cards.create(PLACE, CONTENT))
    expect(await press(cards, id)).toBe(CHOICE_CARD_REFUSALS.closed)
    await store.close()
  })

  it('reopens under the next generation when the turn is refused or dispatch throws; a second press starts a turn', async () => {
    const store = await open()
    const { cards, h } = service(store)
    const id = idOf(await cards.create(PLACE, CONTENT))
    h.admit = false
    await press(cards, id, 'U1')
    expect(await store.choiceCards.get(id)).toMatchObject({
      state: 'open',
      generation: 1,
      clickedBy: null,
      choice: null
    })
    expect(h.told).toEqual([{ userId: 'U1', text: CARD_PRESS_FAILED_TEXT }])
    expect(h.redrawn.map((r) => r.state)).toEqual(['deciding', 'open'])
    h.admit = 'throw'
    await press(cards, id, 'U1')
    expect(await store.choiceCards.get(id)).toMatchObject({ state: 'open', generation: 2 })
    h.admit = true
    await press(cards, id, 'U2', 'skip')
    expect(h.turns.map((t) => t.deliveryId)).toEqual([`card:${id}:2`])
    expect(await store.choiceCards.get(id)).toMatchObject({ state: 'decided', clickedBy: 'U2', choice: 'skip' })
    await store.close()
  })

  it('sweeps cards a restart caught deciding: decided when the delivery is durable, else reopened', async () => {
    const store = await open()
    const { cards } = service(store)
    const admitted = idOf(await cards.create(PLACE, CONTENT))
    const lost = idOf(await cards.create(PLACE, CONTENT))
    const peer = idOf(await cards.create({ ...PLACE, agentId: 'a2' }, CONTENT))
    for (const id of [admitted, lost, peer])
      await store.choiceCards.claim(id, 0, { choice: 'skip', clickedBy: 'U1' }, 1)
    // A fresh service over the same store is a restart.
    const restarted = service(store)
    restarted.h.deliveries.add(`card:${admitted}:0`)
    await restarted.cards.sweep((agentId) => agentId === 'a1')
    expect(await store.choiceCards.get(admitted)).toMatchObject({ state: 'decided', choice: 'skip', generation: 0 })
    expect(await store.choiceCards.get(lost)).toMatchObject({ state: 'open', generation: 1, choice: null })
    expect(await store.choiceCards.get(peer)).toMatchObject({ state: 'deciding' })
    await store.close()
  })

  it('closes the state set: PATCH never re-arms a card, never touches a deciding one, never overwrites the press', async () => {
    const store = await open()
    const { cards } = service(store)
    const routes = cards.routes(async () => PLACE)
    const patch = routes.find((r) => r.method === 'PATCH')!
    const id = idOf(await cards.create(PLACE, CONTENT))
    for (const state of ['open', 'deciding', 'whatever'])
      expect((await patch.handle({ params: { id }, body: { state } } as never)).status).toBe(400)
    await press(cards, id)
    const sent = await patch.handle({ params: { id }, body: { state: 'sent', label: 'Sent at 10:02' } } as never)
    expect(sent).toMatchObject({ status: 200, body: { state: 'sent', label: 'Sent at 10:02', clickedBy: 'U1' } })
    expect(await press(cards, id, 'U2')).toBeUndefined()
    expect((await store.choiceCards.get(id))!.clickedBy).toBe('U1')
    const other = idOf(await cards.create(PLACE, CONTENT))
    await store.choiceCards.claim(other, 0, { choice: 'skip', clickedBy: 'U1' }, 1)
    expect((await patch.handle({ params: { id: other }, body: { state: 'stale' } } as never)).status).toBe(409)
    expect((await patch.handle({ params: { id: 'nope' }, body: { label: null } } as never)).status).toBe(404)
    await store.close()
  })

  it('expires an open card past its time instead of taking the press', async () => {
    const store = await open()
    const { cards, h } = service(store)
    const id = idOf(await cards.create(PLACE, { ...CONTENT, expiresAt: 2_000 }))
    h.now = 3_000
    await press(cards, id)
    expect((await cards.read(id)).body).toMatchObject({ state: 'expired' })
    expect(h.turns).toEqual([])
    await store.close()
  })

  it('keeps the edited text and makes a top-level card its own thread', async () => {
    const store = await open()
    const { cards, h } = service(store)
    const id = idOf(await cards.create({ ...PLACE, thread: undefined }, CONTENT))
    expect((await cards.read(id)).body).toMatchObject({ thread: '1700000000.000900' })
    await cards.click({ cardId: id, choice: EDIT_CHOICE, editedText: 'Ship 1.5', actor: { userId: 'U3' } })
    expect((await cards.read(id)).body).toMatchObject({ editedText: 'Ship 1.5' })
    expect(h.turns[0]!.text).toContain('Ship 1.5')
    await store.close()
  })
})

describe('Slack choice-card facet', () => {
  it('renders buttons while open, the press while deciding, and the decision after', async () => {
    const card = {
      cardId: 'c1',
      channel: 'C1',
      ts: '1.2',
      title: 'Pick',
      body: '',
      options: [{ id: 'a', label: 'A' }],
      editText: 'x',
      state: 'open',
      label: null,
      choice: null,
      clickedBy: null,
      editedText: null
    }
    const openBlocks = JSON.stringify(choiceCardBlocks(card))
    expect(openBlocks).toContain('ac_card:0')
    expect(openBlocks).toContain('ac_card_edit')
    expect(decodeCardValue('c1|a')).toEqual({ cardId: 'c1', choice: 'a' })
    const deciding = JSON.stringify(choiceCardBlocks({ ...card, state: 'deciding', choice: 'a', clickedBy: 'U9' }))
    expect(deciding).not.toContain('ac_card:0')
    expect(deciding).toContain('A — <@U9> (starting…)')
    expect(JSON.stringify(choiceCardBlocks({ ...card, state: 'decided', choice: 'a', clickedBy: 'U9' }))).toContain(
      'A — <@U9>"'
    )
  })

  it('declines a send-only (relay-ingress) connection, whose presses never reach the daemon', () => {
    expect(slackChoiceCards.serves({ sendOnly: true })).toBe(false)
    expect(slackChoiceCards.serves({ sendOnly: false })).toBe(true)
  })

  it('is declared exactly where a turn surface registers the facet, so the tools follow the declaration', () => {
    const daemon: any = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
    for (const platform of daemon.turnSurfaces.ids() as string[])
      expect([platform, declaresPort(platform, 'choiceCards')]).toEqual([
        platform,
        Boolean(daemon.turnSurfaces.exact(platform)?.choiceCards)
      ])
    const names = (platform: string) =>
      toolsForIntegrations([{ id: 'i', platform } as never], { currentPlatform: platform }).map((t) => t.name)
    expect(names('slack')).toContain('postChoiceCard')
    expect(names('telegram')).not.toContain('postChoiceCard')
  })
})

describe('choice cards in the daemon', () => {
  const AGENT = 'agent-1'
  const INT = 'int-s'
  const CHANNEL = 'C-ALERTS'

  async function world(opts: { sendOnly?: boolean; muted?: boolean; admit?: boolean } = {}) {
    const daemon: any = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
    daemon.store = await open()
    daemon.agents.set(AGENT, {
      id: AGENT,
      name: 'Butler',
      chatActions: 'talk',
      doorbells: [{ id: 'builds', target: { platform: 'slack', channel: CHANNEL } }],
      integrations: [
        {
          id: INT,
          platform: 'slack',
          core: {
            mode: 'direct',
            bindRules: [],
            mutedChannels: opts.muted ? [CHANNEL] : [],
            gated: false,
            sessionModes: [],
            externalChannels: [],
            decisions: { bindings: [], definitions: [] }
          },
          config: { botToken: 'x', appToken: 'y' }
        }
      ]
    })
    const conn = {
      sendOnly: opts.sendOnly === true,
      postBlocks: vi.fn(async () => '1700000000.000900'),
      updateBlocks: vi.fn(async () => true),
      postEphemeral: vi.fn(async () => true),
      getChannelInfo: vi.fn(async (id: string) => ({ id, name: 'alerts' }))
    }
    daemon.connByIntegration.set(INT, conn)
    daemon.dispatch = vi.fn(async (_a: string, _m: unknown, _i: string, _w: unknown, _c: unknown, o: any) => {
      await o?.onAdmission?.({ accepted: opts.admit !== false })
      return opts.admit === false ? null : 'acp-1'
    })
    const post = (body: unknown) =>
      daemon
        .choiceCards()
        .routes((req: never) => daemon.choiceCardPlace(req))
        .find((r: { method: string }) => r.method === 'POST')
        .handle({ params: {}, body })
    return { daemon, conn, post }
  }

  const BODY = { agent: AGENT, target: 'builds', title: 'Deploy?', options: [{ id: 'go', label: 'Go' }] }

  it('places a REST card at the agent’s declared target and refuses a free-form channel or an unknown target', async () => {
    const w = await world()
    expect((await w.post({ ...BODY, channel: 'C-ELSEWHERE' })).status).toBe(400)
    expect((await w.post({ ...BODY, target: 'nope' })).status).toBe(404)
    expect((await w.post({ ...BODY, agent: 'nobody' })).status).toBe(404)
    const created = await w.post(BODY)
    expect(created).toMatchObject({
      status: 201,
      body: { channel: CHANNEL, thread: '1700000000.000900', state: 'open' }
    })
    expect(w.conn.postBlocks.mock.calls[0]!.slice(0, 1)).toEqual([CHANNEL])
    expect((w.conn.postBlocks.mock.calls[0] as unknown[])[3]).toBeUndefined()
    await w.daemon.store.close()
  })

  it('answers 409 where the connection is send-only, so no dead card is posted', async () => {
    const w = await world({ sendOnly: true })
    expect((await w.post(BODY)).status).toBe(409)
    expect(w.conn.postBlocks).not.toHaveBeenCalled()
    await w.daemon.store.close()
  })

  it('dispatches a permitted press durably under its generation’s id, as the presser, and marks it decided', async () => {
    const w = await world()
    const id = idOf(await w.post(BODY))
    await w.daemon.choiceCards().click({ cardId: id, choice: 'go', actor: { userId: 'U1', name: 'ana' } })
    const [agentId, msg, integrationId, , callMeta, opts] = w.daemon.dispatch.mock.calls[0]
    expect([agentId, integrationId, callMeta]).toEqual([AGENT, INT, undefined])
    expect(msg).toMatchObject({
      msgId: `card:${id}:0`,
      source: 'user',
      channel: CHANNEL,
      thread: '1700000000.000900',
      sender: { id: 'U1', isBot: false, name: 'ana' },
      transportScope: w.daemon.transportScopeForIntegrationIds([INT])
    })
    expect(opts).toMatchObject({ requireDurable: true, deliveryId: `card:${id}:0`, receiptId: `card:${id}:0:receipt` })
    expect(await w.daemon.store.choiceCards.get(id)).toMatchObject({ state: 'decided', clickedBy: 'U1' })
    await w.daemon.store.close()
  })

  it('refuses a press in a conversation that takes none, privately, and leaves the card open', async () => {
    const w = await world({ muted: true })
    const id = idOf(await w.post(BODY))
    await w.daemon.choiceCards().click({ cardId: id, choice: 'go', actor: { userId: 'U1' } })
    expect(w.daemon.dispatch).not.toHaveBeenCalled()
    expect(w.conn.postEphemeral.mock.calls[0]!.slice(0, 3)).toEqual([CHANNEL, 'U1', CHOICE_CARD_REFUSALS.closed])
    expect(await w.daemon.store.choiceCards.get(id)).toMatchObject({ state: 'open', generation: 0 })
    await w.daemon.store.close()
  })

  it('reopens a press whose turn was not admitted, and the startup sweep reads the durable inbox', async () => {
    const w = await world({ admit: false })
    const id = idOf(await w.post(BODY))
    await w.daemon.choiceCards().click({ cardId: id, choice: 'go', actor: { userId: 'U1' } })
    expect(await w.daemon.store.choiceCards.get(id)).toMatchObject({ state: 'open', generation: 1 })
    // A restart caught two presses deciding; only one reached the inbox.
    const kept = idOf(await w.post(BODY))
    const lost = idOf(await w.post(BODY))
    for (const card of [kept, lost])
      await w.daemon.store.choiceCards.claim(card, 0, { choice: 'go', clickedBy: 'U1' }, 1)
    await w.daemon.store.appendInbox({
      id: `card:${kept}:0`,
      sessionKey: 'k',
      agentId: AGENT,
      msg: '{}',
      loopGuardCounted: 1,
      enqueuedAt: 1
    })
    w.daemon.choiceCardService = undefined
    await w.daemon.choiceCards().sweep(() => true)
    expect(await w.daemon.store.choiceCards.get(kept)).toMatchObject({ state: 'decided' })
    expect(await w.daemon.store.choiceCards.get(lost)).toMatchObject({ state: 'open', generation: 1 })
    await w.daemon.store.close()
  })
})

describe('choice card tools', () => {
  it('post into the session conversation, refuse re-arming, and touch only the agent’s own cards', async () => {
    const { postChoiceCard, readChoiceCard, updateChoiceCard } = await import('../src/mcp/ops/choice-cards.js')
    const store = await open()
    const { cards, h } = service(store)
    const deps = { choiceCards: () => cards }
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
    expect(h.posted).toHaveLength(1)
    expect(await readChoiceCard(ctx, { cardId: card.id }, deps)).toMatchObject({
      state: 'open',
      thread: '1700000000.000100'
    })
    await expect(updateChoiceCard(ctx, { cardId: card.id, state: 'open' }, deps)).rejects.toThrow('state')
    expect(await updateChoiceCard(ctx, { cardId: card.id, state: 'skipped', label: 'Closed' }, deps)).toMatchObject({
      state: 'skipped'
    })
    const stranger = { ...(ctx as object), agentId: 'a2' } as never
    await expect(readChoiceCard(stranger, { cardId: card.id }, deps)).rejects.toThrow('unknown card')
    await store.close()
  })
})
