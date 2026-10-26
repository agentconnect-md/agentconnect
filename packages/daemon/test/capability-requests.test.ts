// The daemon's side of capability requests (capability-requests.md §4): the ask and its card, a card's Decline, and the settling wake.
import { randomUUID } from 'node:crypto'
import type {
  CapabilityAsk,
  CapabilityDecideReq,
  CapabilityRequestReq,
  CapabilityRequestResult,
  SessionCapabilitySettled
} from '@agentconnect.md/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { checkCoordinate, gettingToKnowCoordinate } from '../src/session/subsession-coordinate.js'
import {
  CapabilityRequests,
  inlineCardBody,
  ownAskers,
  type CapabilityOrigin,
  type CapabilityRequestsHost
} from '../src/capability/requests.js'
import {
  capabilityDeclineOption,
  type CapabilityCardFacet,
  type CapabilityCardModel,
  type CapabilityCardOutcome
} from '../src/platforms/capability-card.js'
import type { ElicitCardTurn } from '../src/platforms/elicit-card.js'
import type { LocalStore } from '../src/store/local-store.js'
import { openTestStore } from './store-support.js'
import { executeTool, type OpsDeps } from '../src/mcp/ops.js'
import { capabilityRequestToolsFor } from '../src/mcp/ops/capability-requests.js'
import type { SessionContext } from '../src/mcp/ops/context.js'

let store: LocalStore | undefined
afterEach(async () => {
  await store?.close()
  store = undefined
})

const AGENT = '3c4d5e6f-7081-4293-a4b5-c6d7e8f90a1b'
const REQUEST = '7f3a1c56-8a2b-4c3d-9e4f-0a1b2c3d4e5f'
const LINK = 'https://console.example.test/example-org/requests/7f3a'
const ASK: CapabilityAsk = { kind: 'mcp-server', want: { server: 'Linear' } }

interface Posted {
  where: 'turn' | 'dm'
  channel: string
  model: CapabilityCardModel
}

function fakeFacet(
  log: {
    posted: Posted[]
    rewrites: { ts: string; outcome?: CapabilityCardOutcome; model: CapabilityCardModel }[]
    told: string[]
  },
  dm: Record<string, string | null> = {}
): CapabilityCardFacet {
  let n = 0
  return {
    platform: 'slack',
    declineControl: 'button',
    build: (model) => ({ model }),
    settled: (model, outcome) => ({ model, outcome }),
    send: async (_host, turn, draft) => {
      log.posted.push({
        where: 'turn',
        channel: turn.plan.channel,
        model: (draft as { model: CapabilityCardModel }).model
      })
      return `ts-${++n}`
    },
    post: async (_conn, place, draft) => {
      log.posted.push({ where: 'dm', channel: place.channel, model: (draft as { model: CapabilityCardModel }).model })
      return `ts-${++n}`
    },
    rewrite: async (handle, draft) => {
      const d = draft as { model: CapabilityCardModel; outcome?: CapabilityCardOutcome }
      log.rewrites.push({ ts: handle.ts, model: d.model, ...(d.outcome ? { outcome: d.outcome } : {}) })
      return 'edited'
    },
    tellPrivately: async (_handle, userId, text) => {
      log.told.push(`${userId}: ${text}`)
    },
    openDirectMessage: async (_conn, userId) => `D-${userId}`,
    isPerson: async (_conn, userId) => !userId.startsWith('B'),
    directMessageWith: async (_conn, channel) => (channel in dm ? dm[channel]! : null),
    nameOf: async (_conn, userId) => `name-${userId}`
  }
}

interface Harness {
  service: CapabilityRequests
  log: {
    posted: Posted[]
    rewrites: { ts: string; outcome?: CapabilityCardOutcome; model: CapabilityCardModel }[]
    told: string[]
  }
  requests: CapabilityRequestReq[]
  decides: CapabilityDecideReq[]
  wakes: { req: SessionCapabilitySettled; text: string; askers: unknown }[]
  forgotten: string[]
  inline: { posted: string[]; settled: { status: string; text: string }[]; reopened: number[] }
}

async function harness(
  opts: {
    reply?: Partial<CapabilityRequestResult>
    facet?: boolean
    live?: boolean
    admits?: boolean
    dm?: Record<string, string | null>
    decide?: 'settled' | 'already_settled' | 'not_found' | 'unreachable'
    v2?: boolean
    v3?: boolean
    inline?: boolean
  } = {}
): Promise<Harness> {
  store = await openTestStore()
  const log: Harness['log'] = { posted: [], rewrites: [], told: [] }
  const facet = fakeFacet(log, opts.dm)
  const requests: CapabilityRequestReq[] = []
  const decides: CapabilityDecideReq[] = []
  const wakes: Harness['wakes'] = []
  const forgotten: string[] = []
  const inline: Harness['inline'] = { posted: [], settled: [], reopened: [] }
  const turn: ElicitCardTurn = {
    plan: {
      platform: 'slack',
      agentId: AGENT,
      integrationId: 'int-1',
      channel: 'C0GENERAL',
      thread: '1.1',
      statusThread: '1.1',
      agentName: 'Ada'
    }
  }
  const cards = store.capabilityCards
  const host: CapabilityRequestsHost = {
    now: () => 1_000,
    log: { info: () => undefined, warn: () => undefined },
    cp: () => ({
      capabilityRequest: async (payload) => {
        requests.push(payload)
        return {
          status: 'pending',
          requestId: REQUEST,
          generation: 1,
          link: LINK,
          summary: 'add the MCP server "Linear"',
          ...opts.reply
        } as CapabilityRequestResult
      },
      capabilityWithdraw: async () => ({ status: 'withdrawn' }),
      capabilityDecide: async (payload) => {
        decides.push(payload)
        if (opts.decide === 'unreachable') throw new Error('offline')
        return { result: opts.decide ?? 'settled' }
      }
    }),
    orgForAgent: () => 'org-1',
    agent: () => ({ name: 'Ada', integrations: [{ id: 'int-1', platform: 'slack' }] }),
    facet: () => (opts.facet === false ? undefined : facet),
    cardHost: { postCardSerialized: async () => undefined, sessionTarget: () => undefined, turnState: () => ({}) },
    liveTurn: () => (opts.live === false ? undefined : turn),
    conn: () => ({}),
    cards: () => cards,
    routeDm: async () => ({ integrationId: 'int-1', userId: 'U-RESP' }),
    admitsAsker: () => opts.admits !== false,
    forgetSession: async (_agent, key) => {
      forgotten.push(key)
    },
    dispatchWake: async (req, text, askers) => {
      wakes.push({ req, text, askers })
      return { accepted: true }
    },
    serves: (ask) =>
      ask.kind === 'secret' && ask.want.use.route === 'live'
        ? opts.v3 === true
        : opts.v2 === true || ['agent-settings', 'mcp-server', 'skill'].includes(ask.kind),
    // A webchat session's live turn takes the card inline; any other session has none.
    inline: {
      post: async (_origin, model) => {
        if (!opts.inline) return undefined
        inline.posted.push(model.requestId)
        return { channel: 'conv-1', thread: 'turn-1', ts: '100.000001' }
      },
      settle: async (_row, status, text) => {
        inline.settled.push({ status, text })
      },
      reopen: async (_row, generation) => {
        inline.reopened.push(generation)
      }
    }
  }
  return { service: new CapabilityRequests(host), log, requests, decides, wakes, forgotten, inline }
}

const origin = (over: Partial<CapabilityOrigin> = {}): CapabilityOrigin => ({
  agentId: AGENT,
  sessionKey: 'key-1',
  sessionId: 'session-1',
  platform: 'slack',
  channel: 'C0GENERAL',
  integrationId: 'int-1',
  askers: {
    people: [{ kind: 'member', platform: 'slack', integrationId: 'int-1', userId: 'U1', name: 'Ana' }],
    nobody: false
  },
  askedBy: 'Ana',
  external: false,
  ...over
})

describe('requestCapability', () => {
  it('forwards the ask with its asker context and posts the card in the turn', async () => {
    const h = await harness()
    const result = await h.service.request(origin(), ASK, 'filing needs Linear')
    expect(h.requests[0]).toMatchObject({
      agentId: AGENT,
      sessionId: 'session-1',
      sessionKey: 'key-1',
      ask: ASK,
      platform: 'slack'
    })
    expect(h.requests[0]!.askers.people).toHaveLength(1)
    expect(h.log.posted).toMatchObject([
      { where: 'turn', channel: 'C0GENERAL', model: { requestId: REQUEST, generation: 1, context: 'Asked for Ana' } }
    ])
    expect(result).toMatchObject({ status: 'pending', requestId: REQUEST, link: LINK })
    expect(result.message).toContain('do not repeat the link')
    expect((await store!.capabilityCards.forRequest(REQUEST, 'key-1'))[0]).toMatchObject({
      ts: 'ts-1',
      settledAt: null
    })
  })

  it('does not post a second card for the same conversation', async () => {
    const h = await harness()
    await h.service.request(origin(), ASK, 'filing needs Linear')
    const again = await h.service.request(origin(), ASK, 'filing needs Linear')
    expect(h.log.posted).toHaveLength(1)
    expect(again.message).toContain('already asked for this in this conversation')
  })

  it('hands the agent the link where no card can be shown', async () => {
    const h = await harness({ facet: false })
    const result = await h.service.request(origin(), ASK, 'filing needs Linear')
    expect(h.log.posted).toHaveLength(0)
    expect(result.message).toContain(LINK)
  })

  it('keeps an external place free of the request and carries the card to the responsible user', async () => {
    const h = await harness()
    const result = await h.service.request(origin({ external: true }), ASK, 'filing needs Linear')
    expect(h.requests[0]!.external).toBe(true)
    expect(h.log.posted).toMatchObject([{ where: 'dm', channel: 'D-U-RESP' }])
    expect(result.message).toContain("I've asked an admin for access.")
    expect(result.message).not.toContain(LINK)
  })

  it('sends a card to the responsible user when nobody is behind the turn', async () => {
    const h = await harness()
    const result = await h.service.request(origin({ askers: { people: [], nobody: true } }), ASK, 'r')
    expect(h.log.posted).toMatchObject([{ where: 'dm' }])
    expect(result.message).toContain('direct message')
  })

  it('answers what the CP refused without posting anything', async () => {
    const satisfied = await harness({ reply: { status: 'already_satisfied', link: undefined } })
    expect((await satisfied.service.request(origin(), ASK, 'r')).message).toContain('You already have')
    const declined = await harness({
      reply: { status: 'declined_recently', declined: { by: 'Ben', note: 'Use GitHub', at: new Date(0).toISOString() } }
    })
    const text = (await declined.service.request(origin(), ASK, 'r')).message
    expect(text).toContain('declined by "Ben"')
    expect(text).toContain('"Use GitHub"')
    const limit = await harness({ reply: { status: 'refused', refused: 'limit' } })
    expect((await limit.service.request(origin(), ASK, 'r')).message).toContain('3 open requests')
    expect(limit.log.posted).toHaveLength(0)
  })
})

describe('a Decline clicked on a card', () => {
  async function posted(h: Harness): Promise<string> {
    await h.service.request(origin(), ASK, 'r')
    return h.log.posted[0]!.model.cardId
  }

  it('sends the decision with the clicker and the card generation; the card waits for the wake', async () => {
    const h = await harness()
    const cardId = await posted(h)
    const handled = await h.service.decline({
      requestId: REQUEST,
      optionId: capabilityDeclineOption(1, cardId),
      actor: { userId: 'U2' }
    })
    expect(handled).toBe(true)
    expect(h.decides).toEqual([
      {
        agentId: AGENT,
        requestId: REQUEST,
        generation: 1,
        decision: 'decline',
        by: { kind: 'member', platform: 'slack', integrationId: 'int-1', userId: 'U2', name: 'name-U2' }
      }
    ])
    expect(h.log.rewrites).toHaveLength(0)
  })

  it('refuses privately someone who could not ask the agent there, or a bot', async () => {
    const closed = await harness({ admits: false })
    const cardId = await posted(closed)
    await closed.service.decline({
      requestId: REQUEST,
      optionId: capabilityDeclineOption(1, cardId),
      actor: { userId: 'U2' }
    })
    expect(closed.decides).toHaveLength(0)
    expect(closed.log.told[0]).toContain('Only someone who can ask Ada here')
    const bot = await harness()
    const botCard = await posted(bot)
    await bot.service.decline({
      requestId: REQUEST,
      optionId: capabilityDeclineOption(1, botCard),
      actor: { userId: 'B1' }
    })
    expect(bot.decides).toHaveLength(0)
  })

  it('in a direct message, only its person may decline', async () => {
    const h = await harness({ dm: { C0GENERAL: 'U1' } })
    const cardId = await posted(h)
    await h.service.decline({
      requestId: REQUEST,
      optionId: capabilityDeclineOption(1, cardId),
      actor: { userId: 'U2' }
    })
    expect(h.decides).toHaveLength(0)
    await h.service.decline({
      requestId: REQUEST,
      optionId: capabilityDeclineOption(1, cardId),
      actor: { userId: 'U1' }
    })
    expect(h.decides).toHaveLength(1)
  })

  it('ignores a click for another bot or another request, and says so when the CP cannot settle it', async () => {
    const h = await harness({ decide: 'unreachable' })
    const cardId = await posted(h)
    await h.service.decline({
      requestId: randomUUID(),
      optionId: capabilityDeclineOption(1, cardId),
      actor: { userId: 'U2' }
    })
    await h.service.decline({
      requestId: REQUEST,
      optionId: capabilityDeclineOption(1, cardId),
      actor: { userId: 'U2' },
      integrationId: 'int-9'
    })
    // A Socket Mode click names the bots of the connection it arrived on.
    await h.service.decline({
      requestId: REQUEST,
      optionId: capabilityDeclineOption(1, cardId),
      actor: { userId: 'U2' },
      srcIntegrationIds: ['int-9']
    })
    expect(h.decides).toHaveLength(0)
    await h.service.decline({
      requestId: REQUEST,
      optionId: capabilityDeclineOption(1, cardId),
      actor: { userId: 'U2' }
    })
    expect(h.log.told.at(-1)).toContain('Try again')
    expect(await h.service.decline({ requestId: REQUEST, optionId: 'approve', actor: { userId: 'U2' } })).toBe(false)
  })
})

describe('the settling wake', () => {
  const wake = (over: Partial<SessionCapabilitySettled> = {}): SessionCapabilitySettled => ({
    agentId: AGENT,
    sessionId: 'session-1',
    sessionKey: 'key-1',
    requestId: REQUEST,
    generation: 1,
    status: 'declined',
    askers: {
      people: [
        { kind: 'member', platform: 'slack', integrationId: 'int-1', userId: 'U1' },
        { kind: 'member', platform: 'slack', integrationId: 'int-foreign', userId: 'U9' },
        { kind: 'console', userId: 'user-1' }
      ],
      nobody: false
    },
    summary: 'add the MCP server "Linear"',
    reason: 'r',
    outcome: '',
    by: { name: 'Ben' },
    reload: false,
    ...over
  })

  it("rewrites the origin card once, enqueues the reminder with only the agent's own askers, and forgets on reload", async () => {
    const h = await harness()
    await h.service.request(origin(), ASK, 'r')
    expect(await h.service.settled(wake({ reload: true }))).toEqual({ accepted: true })
    expect(h.log.rewrites).toMatchObject([{ ts: 'ts-1', outcome: { status: 'declined', by: 'Ben' } }])
    expect(h.forgotten).toEqual(['key-1'])
    expect(h.wakes[0]!.text).toContain('Declined by "Ben"')
    expect(h.wakes[0]!.askers).toEqual({
      people: [
        { kind: 'member', platform: 'slack', integrationId: 'int-1', userId: 'U1' },
        { kind: 'console', userId: 'user-1' }
      ],
      nobody: true
    })
    // A re-sent wake for the same origin rewrites nothing twice.
    await h.service.settled(wake())
    expect(h.log.rewrites).toHaveLength(1)
  })

  it('reopens a settled card with the new generation in its Decline', async () => {
    const h = await harness()
    await h.service.request(origin(), ASK, 'r')
    await h.service.settled(wake())
    await h.service.reopened({
      agentId: AGENT,
      requestId: REQUEST,
      generation: 2,
      summary: 'add the MCP server "Linear"',
      reason: 'r',
      link: LINK
    })
    expect(h.log.rewrites.at(-1)).toMatchObject({ model: { generation: 2 } })
    expect(h.log.rewrites.at(-1)!.outcome).toBeUndefined()
    expect((await store!.capabilityCards.forRequest(REQUEST))[0]).toMatchObject({ generation: 2, settledAt: null })
  })

  it('rewrites a card that missed its reopen when the next generation settles', async () => {
    const h = await harness()
    await h.service.request(origin(), ASK, 'r')
    await h.service.settled(wake())
    // No `capability/reopened` reached this daemon; generation 2 completes.
    await h.service.settled(wake({ generation: 2, status: 'completed', outcome: 'Added.' }))
    expect(h.log.rewrites).toHaveLength(2)
    expect(h.log.rewrites.at(-1)).toMatchObject({ outcome: { status: 'completed' } })
    expect((await store!.capabilityCards.forRequest(REQUEST))[0]).toMatchObject({ generation: 2 })
  })

  it("forwards the card into the named person's direct message, and rewrites it with any origin", async () => {
    const h = await harness()
    expect(
      await h.service.forward({
        agentId: AGENT,
        requestId: REQUEST,
        generation: 1,
        consoleUserId: 'user-2',
        forwardedBy: 'Carol',
        summary: 'add the MCP server "Linear"',
        reason: 'r',
        link: LINK
      })
    ).toEqual({ delivered: true })
    expect(h.log.posted).toMatchObject([{ where: 'dm', model: { context: 'Forwarded by Carol' } }])
    await h.service.settled(wake({ status: 'completed', outcome: 'Added.' }))
    expect(h.log.rewrites).toHaveLength(1)
  })
})

describe('ownAskers', () => {
  it("keeps console users and members of the agent's own bots", () => {
    expect(
      ownAskers({ people: [{ kind: 'member', platform: 'slack', integrationId: 'x', userId: 'U' }], nobody: false }, [
        'int-1'
      ])
    ).toEqual({ people: [], nobody: true })
  })
})

describe('the bridge tools', () => {
  const ctx = {
    agentId: AGENT,
    platform: 'slack',
    channel: 'C1',
    thread: '1.1',
    isDm: false,
    tools: []
  } as unknown as SessionContext

  it('are offered to every agent toward a CP that serves them (§5 item 14)', () => {
    const at = { thread: '1.1' }
    expect(capabilityRequestToolsFor(true, at).map((t) => t.name)).toEqual([
      'requestCapability',
      'withdrawCapabilityRequest'
    ])
    expect(capabilityRequestToolsFor(false, at)).toEqual([])
  })

  it('are never listed in a follow-up check or a getting-to-know task', () => {
    expect(capabilityRequestToolsFor(true, { thread: checkCoordinate('d-1') })).toEqual([])
    expect(capabilityRequestToolsFor(true, { thread: gettingToKnowCoordinate('d-2') })).toEqual([])
  })

  it('refuse unknown want fields and a session that is not offered them', async () => {
    const calls: unknown[] = []
    const deps = {
      gatewayFor: () => undefined,
      capabilityRequests: {
        offered: (c: SessionContext) => c.thread === '1.1',
        request: async (_c: SessionContext, ask: CapabilityAsk, reason: string) => {
          calls.push({ ask, reason })
          return { status: 'pending' }
        },
        withdraw: async () => ({ status: 'withdrawn' })
      }
    } as unknown as OpsDeps
    await expect(
      executeTool(
        ctx,
        'requestCapability',
        { kind: 'mcp-server', want: { server: 'Linear', url: 'x' }, reason: 'r' },
        deps
      )
    ).rejects.toThrow(/want/)
    await expect(
      executeTool(
        { ...ctx, thread: 'other' } as SessionContext,
        'requestCapability',
        { kind: 'skill', want: { skill: 'a/b' }, reason: 'r' },
        deps
      )
    ).rejects.toThrow(/not available/)
    await executeTool(
      ctx,
      'requestCapability',
      { kind: 'mcp-server', want: { server: 'Linear' }, reason: ' needs it ' },
      deps
    )
    expect(calls).toEqual([{ ask: { kind: 'mcp-server', want: { server: 'Linear' } }, reason: 'needs it' }])
  })
})

describe('Phase 2 kinds', () => {
  const repository: CapabilityAsk = {
    kind: 'repository',
    want: { provider: 'github', repository: 'acme/widgets', access: 'write' }
  }

  it('never sends a Phase 2 kind to a CP without capability-requests-v2', async () => {
    const h = await harness()
    const result = await h.service.request(origin(), repository, 'pushing the fix needs write access')
    expect(result.status).toBe('refused')
    expect(result.message).toContain('cannot be made here yet')
    expect(h.requests).toHaveLength(0)
    expect(h.log.posted).toHaveLength(0)
  })

  it('forwards a Phase 2 kind to a CP that takes it', async () => {
    const h = await harness({ v2: true })
    const result = await h.service.request(origin(), repository, 'pushing the fix needs write access')
    expect(h.requests[0]!.ask).toEqual(repository)
    expect(result.status).toBe('pending')
  })

  it('points a refused live secret at the mcp-header route', async () => {
    const h = await harness({ v2: true, reply: { status: 'refused', refused: 'unsupported' } })
    const result = await h.service.request(
      origin(),
      { kind: 'secret', want: { name: 'GRAFANA_TOKEN', description: 'Grafana API token', use: { route: 'live' } } },
      'querying dashboards needs a token'
    )
    expect(result.message).toContain('`mcp-header`')
    expect(h.log.posted).toHaveLength(0)
    // Toward a CP without live secrets nothing is even sent.
    expect(h.requests).toHaveLength(0)
  })

  it('asks for a live secret only toward a CP that serves them', async () => {
    const h = await harness({ v2: true, v3: true })
    const live = {
      kind: 'secret',
      want: { name: 'GRAFANA_TOKEN', description: 'Grafana API token', use: { route: 'live' } }
    } as const
    const result = await h.service.request(origin(), live, 'querying dashboards needs a token')
    expect(h.requests[0]!.ask).toEqual(live)
    expect(result.status).toBe('pending')
  })
})

describe('the inline card in a webchat session', () => {
  const wake = (over: Partial<SessionCapabilitySettled> = {}): SessionCapabilitySettled => ({
    agentId: AGENT,
    sessionId: 'session-1',
    sessionKey: 'key-1',
    requestId: REQUEST,
    generation: 1,
    status: 'declined',
    askers: { people: [{ kind: 'console', userId: 'user-1' }], nobody: false },
    summary: 'add the MCP server "Linear"',
    reason: 'r',
    outcome: '',
    by: { name: 'Ben' },
    reload: false,
    ...over
  })
  const webchat = () => origin({ platform: 'webchat', channel: 'conv-1', integrationId: undefined })

  it('shows the card inline instead of a chat card and says so without the link', async () => {
    const h = await harness({ inline: true })
    const result = await h.service.request(webchat(), ASK, 'filing needs Linear')
    expect(h.inline.posted).toEqual([REQUEST])
    expect(h.log.posted).toHaveLength(0)
    expect(result.message).toContain('shown in this conversation')
    expect(result.message).not.toContain(LINK)
    expect((await store!.capabilityCards.forRequest(REQUEST, 'key-1'))[0]).toMatchObject({ platform: 'webchat' })
  })

  it('settles, reopens and withdraws the inline card through the console port', async () => {
    const h = await harness({ inline: true })
    await h.service.request(webchat(), ASK, 'filing needs Linear')
    await h.service.settled(wake())
    expect(h.inline.settled).toEqual([{ status: 'declined', text: expect.stringContaining('Declined by Ben') }])
    await h.service.reopened({
      agentId: AGENT,
      requestId: REQUEST,
      generation: 2,
      summary: 'add the MCP server "Linear"',
      reason: 'r',
      link: LINK
    })
    expect(h.inline.reopened).toEqual([2])
    await h.service.withdraw({ agentId: AGENT, sessionId: 'session-1', sessionKey: 'key-1' }, REQUEST)
    expect(h.inline.settled.at(-1)).toMatchObject({ status: 'withdrawn' })
    // No chat card was ever involved.
    expect(h.log.rewrites).toHaveLength(0)
  })

  it('records the card body with its settlement', () => {
    const model = { requestId: REQUEST, generation: 2, summary: 's', reason: 'r', link: LINK }
    expect(JSON.parse(inlineCardBody(model))).toEqual({ ...model, status: 'open' })
    expect(JSON.parse(inlineCardBody(model, { status: 'completed', text: 'done' }))).toEqual({
      ...model,
      status: 'completed',
      text: 'done'
    })
  })
})
