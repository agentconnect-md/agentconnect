import { describe, expect, it, vi } from 'vitest'
import {
  NOBODY,
  NOT_SHARED_HERE,
  NOT_SHARED_UNLINKED,
  type ConsoleVerdict,
  type ReadAsker,
  type TurnAskers
} from '../src/assistant/place-access.js'
import { executeTool, type MessageGateway, type OpsDeps, type SessionContext } from '../src/mcp/ops.js'
import type { PostInterception } from '../src/assistant/drafts.js'
import type { PlaceSnapshotRow, PlaceStore } from '../src/mcp/ops/place-gate.js'
import { ALL_TOOL_NAMES, toolsForIntegrations } from '../src/mcp/tools.js'
import type { MemoryProvider } from '../src/memory/provider.js'
import type { SessionRecord, TranscriptRow } from '../src/store/local-store.js'
import type { Integration } from '../src/agents/agent-schema.js'
import { PlaceMembers, PLACE_MEMBERS_TTL_MS, turnAskers, type TurnMessage } from '../src/assistant/place-members.js'
import { isSubsessionCoordinate } from '../src/session/subsession-coordinate.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'

const AGENT = 'agent-a'

function session(over: Partial<SessionRecord> & Pick<SessionRecord, 'key' | 'platform' | 'channel'>): SessionRecord {
  return {
    agentId: AGENT,
    thread: `append:${over.key}`,
    transportScope: over.platform === 'webchat' ? null : `scope-${over.platform}`,
    acpSessionId: `acp-${over.key}`,
    sessionId: `out-${over.key}`,
    state: 'idle',
    lastDeliveredTs: null,
    updatedAt: 0,
    ...over
  }
}

const SESSIONS: SessionRecord[] = [
  // A peer's wake: its words are that agent's, not the place's own conversation.
  session({
    key: 's-child',
    platform: 'slack',
    channel: 'C_A2A',
    conversationKind: 'channel',
    originSessionId: 'x',
    updatedAt: 950
  }),
  session({ key: 's-dm-p', platform: 'slack', channel: 'D_P', conversationKind: 'dm', updatedAt: 900 }),
  session({ key: 's-dm-q', platform: 'slack', channel: 'D_Q', conversationKind: 'dm', updatedAt: 800 }),
  session({ key: 's-deploys', platform: 'slack', channel: 'C_DEPLOY', conversationKind: 'channel', updatedAt: 700 }),
  session({ key: 's-priv', platform: 'slack', channel: 'C_PRIV', conversationKind: 'channel', updatedAt: 600 }),
  session({ key: 's-mpim', platform: 'slack', channel: 'G_MPIM', conversationKind: 'group_dm', updatedAt: 500 }),
  session({
    key: 's-web',
    platform: 'webchat',
    channel: 'chat-1',
    conversationKind: 'dm',
    title: 'Planning',
    updatedAt: 400
  }),
  session({ key: 's-web2', platform: 'webchat', channel: 'chat-2', conversationKind: 'dm', updatedAt: 350 }),
  session({ key: 's-tg', platform: 'telegram', channel: '-1001', conversationKind: 'channel', updatedAt: 300 }),
  session({ key: 's-tg-closed', platform: 'telegram', channel: '-1002', conversationKind: 'channel', updatedAt: 250 }),
  // An earlier long session of #deploys, retired by `!new`: still the same place.
  session({
    key: 's-deploys-old',
    platform: 'slack',
    channel: 'C_DEPLOY',
    conversationKind: 'channel',
    updatedAt: 100
  }),
  // A session on a platform the agent has no integration on is no place.
  session({ key: 's-hook', platform: 'hook', channel: 'C_DEPLOY', conversationKind: 'channel', updatedAt: 50 }),
  session({ key: 's-dc', platform: 'discord', channel: 'dc-group', conversationKind: 'channel', updatedAt: 40 }),
  session({ key: 's-tg-dm', platform: 'telegram', channel: 'tg-dm-q', conversationKind: 'dm', updatedAt: 30 })
]

let seq = 0
function row(sessionKey: string, sender: string, text: string, minute: number, kind: TranscriptRow['kind'] = 'text') {
  seq += 1
  return {
    sessionKey,
    row: {
      channel: 'x',
      thread: null,
      seq,
      revision: seq,
      eventTimeUs: Date.UTC(2026, 9, 1, 12, minute) * 1000,
      ts: String(minute),
      sender,
      kind,
      text
    } satisfies TranscriptRow
  }
}

const LONG = `${'filler '.repeat(120)}the payments cutover moves to Monday ${'tail '.repeat(80)}`
const ROWS = [
  row('s-deploys-old', 'U_ALICE', 'The old rollout plan for payments was cancelled', 1),
  row('s-deploys', 'U_ALICE', 'We will deploy the payments service on Friday', 10),
  row('s-deploys', AGENT, 'Noted: payments deploy Friday', 11),
  row('s-deploys', AGENT, 'Bash(deploy payments)', 12, 'tool'),
  row('s-deploys', 'U_BOB', 'lunch?', 13),
  row('s-deploys', 'U_BOB', LONG, 14),
  row('s-priv', 'U_ALICE', 'secret merger talk', 20),
  row('s-dm-q', 'U_Q', 'my salary question', 21),
  row('s-mpim', 'U_ALICE', 'group dm planning payments', 22),
  row('s-web2', 'user-2', 'webchat budget notes', 23),
  row('s-child', 'peer', 'peer payments secret', 24),
  row('s-tg', 'tg-user', 'telegram payments chatter', 25),
  row('s-tg-closed', 'tg-user', 'closed group plans', 26),
  row('s-dc', 'dc-user', 'discord group notes', 27),
  row('s-tg-dm', 'tg-q', 'telegram dm notes', 28)
]

function fakeStore(sessions = SESSIONS): PlaceStore {
  return {
    listSessions: async () => sessions,
    latestSession: async (_agent, channel) => sessions.find((s) => s.channel === channel),
    transcriptPageForAgent: async (scope, beforeSeq, limit) => {
      const all = ROWS.filter((r) => r.sessionKey === scope.sessionKey)
        .map((r) => r.row)
        .filter((r) => beforeSeq === null || r.seq < beforeSeq)
        .sort((a, b) => b.seq - a.seq)
      return { rows: all.slice(0, limit), hasMore: all.length > limit }
    },
    getDisplayNames: async (ids) =>
      new Map(
        Object.entries({ C_DEPLOY: 'deploys', C_PRIV: 'leadership', U_ALICE: 'alice', U_BOB: 'bob' }).filter(([id]) =>
          ids.includes(id)
        )
      )
  }
}

// The platform-neutral `isPrivate` facet: Slack reports group DMs and private channels private.
function fakeGateway(over: Partial<MessageGateway> = {}): MessageGateway {
  return {
    postMessage: vi.fn(async () => 'ts-1'),
    getChannelInfo: vi.fn(async (id: string) => ({
      id,
      ...(id.startsWith('D') ? { isIm: true } : {}),
      ...(id.startsWith('G') ? { isMpim: true } : {}),
      isPrivate: id === 'C_PRIV' || id.startsWith('D') || id.startsWith('G')
    })),
    listMembers: vi.fn(async () => []),
    listChannels: vi.fn(async () => []),
    getUserProfile: vi.fn(async (u: string) => ({ id: u })),
    downloadFile: vi.fn(async () => null),
    getChannelHistory: vi.fn(async () => ({
      messages: [{ sender: 'U1', ts: '1.1', text: 'hi', isBot: false }],
      hasMore: false
    })),
    getThreadReplies: vi.fn(async () => []),
    scheduleMessage: vi.fn(async (channel: string, _text: string, postAt: number) => ({ id: 'q1', channel, postAt })),
    addReaction: vi.fn(async () => {}),
    createConversation: vi.fn(async () => ({ id: 'C_NEW' })),
    updateCanvas: vi.fn(async () => {}),
    ...over
  }
}

// What the membership listing and observed chats already say; group DM rows carry no privacy, so the platform is asked.
const SNAPSHOT: Record<string, Record<string, PlaceSnapshotRow>> = {
  'int-slack': {
    C_DEPLOY: { isPrivate: false },
    C_PRIV: { isPrivate: true },
    D_P: { kind: 'im' },
    G_MPIM: { kind: 'mpim' }
  },
  'int-tg': { '-1001': { isPrivate: false, kind: 'channel' }, '-1002': { isPrivate: true, kind: 'channel' } }
}

const noMemory = {} as unknown as MemoryProvider

function makeDeps(over: Partial<OpsDeps> = {}): OpsDeps {
  const gateways: Record<string, MessageGateway> = { 'int-slack': fakeGateway(), 'int-tg': fakeGateway() }
  return {
    gatewayFor: (id) => gateways[id],
    channelAgents: async () => {
      throw new Error('channelAgents not stubbed')
    },
    messageAgent: vi.fn(async (req) => ({ delivered: true, targetSession: `stub:${req.toAgentId}` })),
    replyToSession: vi.fn(async () => ({ delivered: true, targetSession: 'stub' })),
    startOrchestration: async () => ({ orchestrationId: 'o', delivered: [], failed: [] }),
    getOrchestration: async () => null,
    cancelOrchestration: async () => false,
    memory: noMemory,
    recordOutbound: async () => {},
    now: () => 1000,
    assistantModeFor: () => true,
    placeIntegrationFor: (_agent, platform) =>
      platform === 'slack' ? 'int-slack' : platform === 'telegram' ? 'int-tg' : undefined,
    placeSnapshot: (integrationId, channel) => SNAPSHOT[integrationId]?.[channel],
    placeStore: fakeStore(),
    ...over
  }
}

const integrations = [
  { id: 'int-slack', platform: 'slack' },
  { id: 'int-tg', platform: 'telegram' }
]

function ctxAt(platform: string, channel: string, over: Partial<SessionContext> = {}): SessionContext {
  return {
    agentId: AGENT,
    platform,
    ...(platform === 'slack' ? { integrationId: 'int-slack' } : {}),
    isDm: channel.startsWith('D') || platform === 'webchat',
    channel,
    thread: 'append:1',
    deliveryThread: '1.1',
    tools: [],
    integrations,
    ...over
  }
}

const inDmOfP = ctxAt('slack', 'D_P')

/** The same answer to an asker with no linked console account. */
const opaqueUnlinked = (place: string) => ({
  place,
  refused: true,
  answer: NOT_SHARED_UNLINKED,
  note: expect.any(String)
})

/** The one answer for a private place, an undescribed one and an unknown one alike. */
const opaque = (place: string) => ({
  place,
  refused: true,
  answer: NOT_SHARED_HERE,
  note: expect.any(String)
})

describe('recall — listing the places this one may recall', () => {
  it("lists the current DM and the open channels from P's DM, and nothing direct or private", async () => {
    const deps = makeDeps()
    const result = (await executeTool(inDmOfP, 'recall', {}, deps)) as { places: Record<string, unknown>[] }
    expect(result.places).toEqual([
      { place: 'slack:D_P', kind: 'dm', current: true, lastActive: expect.any(String) },
      { place: 'slack:C_DEPLOY', name: 'deploys', kind: 'channel', lastActive: expect.any(String) }
    ])
    // A turn nobody is behind reads nothing off its own bot, so another platform's open group is not offered.
    expect(JSON.stringify(result)).not.toMatch(/C_PRIV|leadership|G_MPIM|-100/)
    // The snapshot answered every channel; only the group DM, whose row carries no privacy, asked the platform.
    expect(deps.gatewayFor('int-slack')!.getChannelInfo).toHaveBeenCalledTimes(1)
    expect(deps.gatewayFor('int-slack')!.getChannelInfo).toHaveBeenCalledWith('G_MPIM')
  })

  it('lists only the conversation itself from webchat when nobody is asking', async () => {
    const result = (await executeTool(ctxAt('webchat', 'chat-1'), 'recall', {}, makeDeps())) as {
      places: { place: string; name?: string }[]
    }
    expect(result.places.map((p) => p.place)).toEqual(['webchat:chat-1'])
    expect(result.places.find((p) => p.place === 'webchat:chat-1')).toMatchObject({ name: 'Planning', current: true })
  })

  it('leaves out a place whose privacy cannot be read while its bot is unreachable', async () => {
    const deps = makeDeps({
      gatewayFor: () => undefined,
      placeSnapshot: (integrationId, channel) =>
        integrationId === 'int-tg' ? SNAPSHOT['int-tg']?.[channel] : undefined
    })
    const result = (await executeTool(inDmOfP, 'recall', {}, deps)) as { places: { place: string }[] }
    expect(result.places.map((p) => p.place)).toEqual(['slack:D_P'])
  })
})

describe('recall — excerpts', () => {
  it("returns matching excerpts of its own transcript there, oldest first, across the place's sessions", async () => {
    const result = (await executeTool(
      inDmOfP,
      'recall',
      { place: 'slack:C_DEPLOY', query: 'Payments' },
      makeDeps()
    )) as {
      place: string
      name: string
      excerpts: { at: string; from: string; text: string }[]
    }
    expect(result).toMatchObject({ place: 'slack:C_DEPLOY', name: 'deploys', query: 'Payments' })
    expect(result.excerpts.map((e) => [e.from, e.text.slice(0, 40)])).toEqual([
      ['alice', 'The old rollout plan for payments was ca'],
      ['alice', 'We will deploy the payments service on F'],
      ['you', 'Noted: payments deploy Friday'],
      ['bob', expect.stringMatching(/^…/)]
    ])
    // Tool rows never come back, and a long row is clipped around the match.
    expect(result.excerpts.some((e) => e.text.includes('Bash'))).toBe(false)
    const long = result.excerpts[3]!.text
    expect(long.length).toBeLessThanOrEqual(502)
    expect(long).toContain('payments cutover')
    expect(result.excerpts[0]!.at).toBe('2026-10-01T12:01:00.000Z')
  })

  it('returns the most recent excerpts without a query, and resolves a place by its name', async () => {
    const result = (await executeTool(inDmOfP, 'recall', { place: '#deploys' }, makeDeps())) as {
      place: string
      excerpts: { text: string }[]
    }
    expect(result.place).toBe('slack:C_DEPLOY')
    expect(result.excerpts).toHaveLength(5)
  })

  it('says it searched only the recent part when a place has more sessions than recall reads', async () => {
    const recallFrom = async (count: number) => {
      const sessions = Array.from({ length: count }, (_, i) =>
        session({
          key: `s-many-${i}`,
          platform: 'slack',
          channel: 'C_MANY',
          conversationKind: 'channel',
          updatedAt: 900 - i
        })
      )
      const store: PlaceStore = {
        ...fakeStore(sessions),
        transcriptPageForAgent: async (scope) => ({
          rows: [row(scope.sessionKey, 'U_ALICE', `note from ${scope.sessionKey}`, 30).row],
          hasMore: false
        })
      }
      return (await executeTool(
        ctxAt('slack', 'C_MANY'),
        'recall',
        { place: 'slack:C_MANY' },
        makeDeps({ placeStore: store })
      )) as {
        excerpts: unknown[]
        searched?: string
      }
    }
    const nine = await recallFrom(9)
    expect(nine.excerpts).toHaveLength(8)
    expect(nine.searched).toBe('only the most recent part of that conversation')
    const eight = await recallFrom(8)
    expect(eight.excerpts).toHaveLength(8)
    expect(eight.searched).toBeUndefined()
  })

  it('says so when nothing matched', async () => {
    expect(
      await executeTool(inDmOfP, 'recall', { place: 'slack:C_DEPLOY', query: 'kubernetes' }, makeDeps())
    ).toMatchObject({ excerpts: [], note: 'Nothing that was searched there matched.' })
  })

  it("reads an open channel on the session's own bot by the platform's own privacy facet", async () => {
    const group = ctxAt('telegram', '-1003', { integrationId: 'int-tg' })
    const result = (await executeTool(group, 'recall', { place: 'telegram:-1001' }, makeDeps())) as {
      excerpts: { text: string }[]
    }
    expect(result.excerpts.map((e) => e.text)).toEqual(['telegram payments chatter'])
  })
})

describe('recall — refusals the model relays', () => {
  it("refuses another person's DM with the same opaque answer", async () => {
    const result = await executeTool(inDmOfP, 'recall', { place: 'slack:D_Q', query: 'salary' }, makeDeps())
    expect(result).toEqual(opaque('slack:D_Q'))
    expect(JSON.stringify(result)).not.toContain('salary question')
  })

  it('answers a private place exactly as it answers a place that does not exist', async () => {
    for (const place of [
      'slack:C_PRIV',
      '#leadership',
      'slack:G_MPIM',
      'telegram:-1002',
      'slack:C_NOWHERE',
      'slack:C_A2A'
    ]) {
      const result = await executeTool(inDmOfP, 'recall', { place, query: 'plans' }, makeDeps())
      expect(result, place).toEqual(opaque(place))
      const { place: _echoed, ...rest } = result as Record<string, unknown>
      expect(JSON.stringify(rest)).not.toMatch(/private|leadership|merger|C_PRIV|G_MPIM/i)
    }
  })

  it('reads a private channel and a private group DM from themselves', async () => {
    for (const [channel, text] of [
      ['C_PRIV', 'secret merger talk'],
      ['G_MPIM', 'group dm planning payments']
    ] as const) {
      const own = (await executeTool(ctxAt('slack', channel), 'recall', { place: `slack:${channel}` }, makeDeps())) as {
        excerpts: { text: string }[]
        privateSource?: string
      }
      expect(own.excerpts.map((e) => e.text)).toEqual([text])
      expect(own.privateSource).toBeUndefined()
    }
  })

  it('reads nothing elsewhere from webchat when nobody is asking, an open channel included', async () => {
    const web = ctxAt('webchat', 'chat-1')
    for (const place of ['slack:D_P', 'webchat:chat-2', 'slack:C_DEPLOY']) {
      expect(await executeTool(web, 'recall', { place }, makeDeps()), place).toEqual(opaque(place))
    }
  })

  it('refuses webchat and DMs from a channel when nobody is asking', async () => {
    const deploys = ctxAt('slack', 'C_DEPLOY')
    for (const place of ['webchat:chat-1', 'slack:D_P']) {
      expect(await executeTool(deploys, 'recall', { place }, makeDeps())).toEqual(opaque(place))
    }
  })

  it('refuses a channel whose privacy cannot be read', async () => {
    const deps = makeDeps({ gatewayFor: () => undefined, placeSnapshot: () => undefined })
    expect(await executeTool(inDmOfP, 'recall', { place: 'slack:C_DEPLOY' }, deps)).toEqual(opaque('slack:C_DEPLOY'))
  })

  it('is not available to an agent outside assistant mode', async () => {
    await expect(
      executeTool(inDmOfP, 'recall', { place: 'slack:C_DEPLOY' }, makeDeps({ assistantModeFor: () => false }))
    ).rejects.toThrow(/only to an agent in assistant mode/)
  })
})

describe('the read rule on the existing cross-place reads', () => {
  it('reads another open channel and the current conversation', async () => {
    const deps = makeDeps()
    await executeTool(inDmOfP, 'getChannelHistory', { channel: 'C_DEPLOY' }, deps)
    await executeTool(inDmOfP, 'getChannelHistory', {}, deps)
    expect(deps.gatewayFor('int-slack')!.getChannelHistory).toHaveBeenCalledTimes(2)
  })

  it("refuses another person's DM, a private channel and a group DM opaquely, before the platform read", async () => {
    const deps = makeDeps()
    const gw = deps.gatewayFor('int-slack')!
    for (const [tool, args] of [
      ['getChannelHistory', { channel: 'D_Q' }],
      ['getThreadHistory', { channel: 'C_PRIV', thread: '1.1' }],
      ['getChannelHistory', { channel: 'G_MPIM' }]
    ] as const) {
      const refusal = executeTool(inDmOfP, tool, args, deps)
      await expect(refusal).rejects.toThrow("I can't share that here.")
      await expect(refusal).rejects.not.toThrow(/private|direct/i)
    }
    expect(gw.getChannelHistory).not.toHaveBeenCalled()
    expect(gw.getThreadReplies).not.toHaveBeenCalled()
  })

  it('no longer reads a Feishu or Discord DM, or a closed chat, from elsewhere, whatever the mode', async () => {
    const feishu = fakeGateway({
      getChannelInfo: vi.fn(async (id: string) => (id === 'oc_closed' ? { id, isPrivate: true } : { id }))
    })
    const store = fakeStore([session({ key: 'f-dm', platform: 'feishu', channel: 'oc_dm', conversationKind: 'dm' })])
    for (const [platform, integrationId] of [
      ['feishu', 'int-feishu'],
      ['discord', 'int-discord']
    ] as const) {
      const ctx = ctxAt(platform, 'oc_group', { integrationId, integrations: [{ id: integrationId, platform }] })
      const deps = makeDeps({ gatewayFor: () => feishu, placeStore: store })
      for (const assistantModeFor of [() => true, () => false]) {
        for (const channel of ['oc_dm', 'oc_closed']) {
          await expect(
            executeTool(ctx, 'getChannelHistory', { channel }, { ...deps, assistantModeFor }),
            `${platform} ${channel}`
          ).rejects.toThrow("I can't share that here.")
        }
      }
    }
    expect(feishu.getChannelHistory).not.toHaveBeenCalled()
  })
})

describe('recall is offered only under assistant mode', () => {
  const slack = {
    id: 'int-slack',
    platform: 'slack',
    core: {
      mode: 'direct',
      bindRules: [],
      mutedChannels: [],
      gated: true,
      sessionModes: [],
      decisions: { bindings: [], definitions: [] }
    },
    config: { botToken: 'x', appToken: 'y' }
  } as unknown as Integration

  it('adds the tool for an assistant-mode agent only, and reserves its name', () => {
    expect(toolsForIntegrations([slack], { assistantMode: true }).some((t) => t.name === 'recall')).toBe(true)
    expect(toolsForIntegrations([slack]).some((t) => t.name === 'recall')).toBe(false)
    expect(toolsForIntegrations([], { assistantMode: true }).some((t) => t.name === 'recall')).toBe(true)
    expect(ALL_TOOL_NAMES).toContain('recall')
  })
})

// The read rule (assistant-mode.md §5.5): a read of another place is judged by who is asking.
const P = 'U_P'
const inOwnDm = ctxAt('slack', 'D_P', { transportScope: 'scope-slack' })

/** P's own message in P's DM. */
const fromP = {
  msgId: 'm-1',
  traceId: 't-1',
  source: 'user',
  platform: 'slack',
  channel: 'D_P',
  sender: { id: P, isBot: false },
  text: 'what did leadership decide?',
  mentionedBots: [],
  isDm: true
} as NormalizedMessage

/** A person's message in another conversation. */
const from = (userId: string, channel = 'C_DEPLOY'): NormalizedMessage => ({
  ...fromP,
  channel,
  sender: { id: userId, isBot: false },
  isDm: false
})

/** The console as the Control Plane sees it: who a Slack member is linked to, and the sessions each console user sees. */
interface ConsoleWorld {
  /** Slack member → console user; absent ⇒ every Slack member is linked to `user-<member>`. */
  linked?: Record<string, string>
  visible?: Record<string, string[]>
  /** Session → the console user recorded as owning it, beside each Slack DM's own person. */
  owners?: Record<string, string>
  /** Console user → the Slack account they linked in the bot's workspace; absent ⇒ none, so the console decides. */
  accounts?: Record<string, string>
}

/** The console user behind an asker: every Slack member is linked by default, P as user-p; no other platform's member is. */
function personOf(world: ConsoleWorld, asker: ReadAsker): string | null | undefined {
  if (asker.kind === 'console') return asker.userId
  if (asker.platform !== 'slack') return null
  if (world.linked) return world.linked[asker.userId]
  return asker.userId === P ? 'user-p' : `user-${asker.userId}`
}

/** user-p sees the Telegram group the console shows as org-visible. */
function consoleVerdict(
  world: ConsoleWorld,
  asker: ReadAsker,
  sessions: readonly string[],
  ownerOnly: boolean
): ConsoleVerdict {
  const user = personOf(world, asker)
  if (user === null) return { asker: 'unidentifiable' }
  if (!user) return { asker: 'unlinked' }
  const visible = (world.visible ?? { 'user-p': ['out-s-tg'] })[user] ?? []
  const owners: Record<string, string> = { 'out-s-dm-p': 'user-p', 'out-s-dm-q': 'user-q', ...world.owners }
  const sees = (id: string) => visible.includes(id) && (!ownerOnly || owners[id] === user)
  return { asker: 'linked', visible: new Set(sessions.filter(sees)) }
}

interface Live {
  /** The messages the live turn answers; absent ⇒ no live turn. */
  messages?: TurnMessage[]
  /** Who opened a sub-session, read for its messages no person sent. */
  opener?: TurnAskers
}

function perAsker(
  opts: {
    members?: Record<string, string[]>
    failLookups?: boolean
    fullMembers?: string[]
    console?: ConsoleWorld
  } = {}
) {
  const members: Record<string, string[]> = {
    C_PRIV: [P, 'U_ALICE'],
    G_MPIM: [P, 'U_BOB'],
    D_P: [P, 'B_BOT'],
    D_Q: ['U_Q', 'B_BOT'],
    ...opts.members
  }
  const clock = { now: 0 }
  const gw = fakeGateway({
    getChannelInfo: vi.fn(async (id: string) => ({
      id,
      ...(id.startsWith('D') ? { isIm: true } : {}),
      ...(id.startsWith('G') ? { isMpim: true } : {}),
      isPrivate: id === 'C_PRIV' || id.startsWith('D') || id.startsWith('G')
    })),
    listMemberIds: vi.fn(async (channel: string) => {
      if (opts.failLookups) throw new Error('ratelimited')
      return members[channel] ?? []
    }),
    isFullMember: vi.fn(async (user: string) => (opts.fullMembers ?? [P, 'U_ALICE', 'U_BOB', 'U_Q']).includes(user)),
    getReactions: vi.fn(async () => []),
    listBookmarks: vi.fn(async () => [])
  })
  const tg = fakeGateway()
  const readAccess = vi.fn(async (_agent: string, asker: ReadAsker, sessions: readonly string[], ownerOnly: boolean) =>
    consoleVerdict(opts.console ?? {}, asker, sessions, ownerOnly)
  )
  const placeMembers = new PlaceMembers({
    now: () => clock.now,
    gatewayFor: (id) => (id === 'int-slack' ? gw : undefined),
    readAccess,
    linkedMember: async (_agent, integrationId, asker) => {
      const user = personOf(opts.console ?? {}, asker)
      return (integrationId === 'int-slack' && user ? opts.console?.accounts?.[user] : undefined) ?? null
    }
  })
  const live: Live = { messages: [{ msg: fromP, integrationId: 'int-slack' }] }
  const readLookups = vi.fn((agentId: string) => placeMembers.lookupsFor(agentId))
  const deps = makeDeps({
    gatewayFor: (id) => (id === 'int-slack' ? gw : id === 'int-tg' ? tg : undefined),
    readAskers: async (ctx) =>
      live.messages
        ? turnAskers(
            live.messages,
            ctx.integrationId,
            isSubsessionCoordinate(ctx.thread) ? (live.opener ?? NOBODY) : undefined
          )
        : NOBODY,
    readLookups,
    draftPost: vi.fn(async () => ({ handled: true, result: { drafted: true } }) as PostInterception)
  })
  /** The live turn answers one message: a platform member's on its bot, or a console user's. */
  const asks = (msg: NormalizedMessage | undefined, opts2: { console?: boolean; integrationId?: string } = {}) => {
    live.messages = msg
      ? [{ msg, integrationId: opts2.integrationId ?? 'int-slack', ...(opts2.console ? { console: true } : {}) }]
      : undefined
  }
  return { deps, gw, clock, members, live, asks, readAccess }
}

const listedPlaces = async (ctx: SessionContext, deps: OpsDeps): Promise<string[]> =>
  ((await executeTool(ctx, 'recall', {}, deps)) as { places: { place: string }[] }).places.map((p) => p.place)

const excerptsOf = async (ctx: SessionContext, place: string, deps: OpsDeps): Promise<string[]> =>
  ((await executeTool(ctx, 'recall', { place }, deps)) as { excerpts: { text: string }[] }).excerpts.map((e) => e.text)

const sourceOf = async (ctx: SessionContext, place: string, deps: OpsDeps): Promise<string | undefined> =>
  ((await executeTool(ctx, 'recall', { place }, deps)) as { privateSource?: string }).privateSource

const NOT_SHARED = "I can't share that here."
const deploys = ctxAt('slack', 'C_DEPLOY')

describe('reads judged by who is asking', () => {
  it('reads, but never lists, a private channel and a group DM the asker belongs to', async () => {
    const { deps, gw } = perAsker()
    expect(await listedPlaces(inOwnDm, deps)).toEqual(['slack:D_P', 'slack:C_DEPLOY', 'telegram:-1001'])
    expect(await excerptsOf(inOwnDm, 'slack:C_PRIV', deps)).toEqual(['secret merger talk'])
    expect(await excerptsOf(inOwnDm, '#leadership', deps)).toEqual(['secret merger talk'])
    expect(await excerptsOf(inOwnDm, 'slack:G_MPIM', deps)).toEqual(['group dm planning payments'])
    // One member listing per conversation within the cache; the current DM is never described.
    expect(gw.listMemberIds).toHaveBeenCalledTimes(2)
    expect(gw.getChannelInfo).not.toHaveBeenCalledWith('D_P')
  })

  it('reads a private channel from a shared conversation for a member, and tells the model it is private', async () => {
    const { deps, gw, asks } = perAsker()
    asks(from(P))
    expect(await sourceOf(deploys, 'slack:C_PRIV', deps)).toMatch(/the private channel "leadership".*one short clause/)
    const page = (await executeTool(deploys, 'getChannelHistory', { channel: 'C_PRIV' }, deps)) as Record<
      string,
      unknown
    >
    expect(page).toMatchObject({ channel: 'C_PRIV', privateSource: expect.stringContaining('private conversation') })
    expect(Object.keys(page)[0]).toBe('privateSource')
    expect(gw.getChannelHistory).toHaveBeenCalledWith('C_PRIV', {})
    // A public source carries no note.
    const open = (await executeTool(deploys, 'getChannelHistory', { channel: 'C_OPEN' }, deps)) as Record<
      string,
      unknown
    >
    expect(open.privateSource).toBeUndefined()
  })

  it('neither lists nor reads a private place the asker is not in, and answers opaquely', async () => {
    const { deps, asks } = perAsker({ members: { C_PRIV: ['U_ALICE'], G_MPIM: ['U_BOB'] } })
    expect(await listedPlaces(inOwnDm, deps)).toEqual(['slack:D_P', 'slack:C_DEPLOY', 'telegram:-1001'])
    for (const place of ['slack:C_PRIV', '#leadership', 'slack:G_MPIM']) {
      expect(await executeTool(inOwnDm, 'recall', { place }, deps), place).toEqual(opaque(place))
    }
    asks(from(P))
    await expect(executeTool(deploys, 'getChannelHistory', { channel: 'C_PRIV' }, deps)).rejects.toThrow(NOT_SHARED)
  })

  it("reads the asker's own DM from anywhere, and never another person's", async () => {
    const { deps, gw, asks } = perAsker()
    asks(from(P))
    expect(await sourceOf(deploys, 'slack:D_P', deps)).toContain('the direct message')
    await executeTool(deploys, 'getChannelHistory', { channel: 'D_P' }, deps)
    expect(gw.getChannelHistory).toHaveBeenCalledWith('D_P', {})
    expect(await executeTool(deploys, 'recall', { place: 'slack:D_Q' }, deps)).toEqual(opaque('slack:D_Q'))
    await expect(executeTool(deploys, 'getChannelHistory', { channel: 'D_Q' }, deps)).rejects.toThrow(NOT_SHARED)
    expect(await executeTool(inOwnDm, 'recall', { place: 'slack:D_Q' }, deps)).toEqual(opaque('slack:D_Q'))
  })

  it('refuses a guest a public channel they are not in, and reads one they are in', async () => {
    const { deps, asks, members, clock } = perAsker({ fullMembers: [P] })
    const room = ctxAt('slack', 'C_GUESTS')
    asks(from('U_GUEST', 'C_GUESTS'))
    await expect(executeTool(room, 'getChannelHistory', { channel: 'C_OPEN' }, deps)).rejects.toThrow(NOT_SHARED)
    expect(await executeTool(room, 'recall', { place: 'slack:C_DEPLOY' }, deps)).toEqual(opaque('slack:C_DEPLOY'))
    expect(await listedPlaces(room, deps)).not.toContain('slack:C_DEPLOY')
    members.C_OPEN = ['U_GUEST']
    clock.now = PLACE_MEMBERS_TTL_MS + 1
    await executeTool(room, 'getChannelHistory', { channel: 'C_OPEN' }, deps)
  })

  it('refuses a read when one of the senders folded into the turn lacks access', async () => {
    const { deps, live } = perAsker()
    live.messages = [
      { msg: from(P), integrationId: 'int-slack' },
      { msg: from('U_BOB'), integrationId: 'int-slack' }
    ]
    expect(await executeTool(deploys, 'recall', { place: 'slack:C_PRIV' }, deps)).toEqual(opaque('slack:C_PRIV'))
    expect(await excerptsOf(deploys, 'slack:G_MPIM', deps)).toEqual(['group dm planning payments'])
  })

  it('refuses once the asker has left, when the cached membership expires', async () => {
    const { deps, clock, members } = perAsker()
    expect(await excerptsOf(inOwnDm, 'slack:C_PRIV', deps)).toEqual(['secret merger talk'])
    members.C_PRIV = ['U_ALICE']
    clock.now = PLACE_MEMBERS_TTL_MS - 1
    expect(await excerptsOf(inOwnDm, 'slack:C_PRIV', deps)).toEqual(['secret merger talk'])
    clock.now = PLACE_MEMBERS_TTL_MS + 1
    expect(await executeTool(inOwnDm, 'recall', { place: 'slack:C_PRIV' }, deps)).toEqual(opaque('slack:C_PRIV'))
  })

  it('refuses when membership cannot be confirmed', async () => {
    const failing = perAsker({ failLookups: true })
    expect(await executeTool(inOwnDm, 'recall', { place: 'slack:C_PRIV' }, failing.deps)).toEqual(
      opaque('slack:C_PRIV')
    )
    await expect(executeTool(inOwnDm, 'getChannelHistory', { channel: 'C_PRIV' }, failing.deps)).rejects.toThrow(
      NOT_SHARED
    )
  })

  it("judges a place on another of the agent's bots as the console shows it, not by that bot's listing", async () => {
    const far = session({
      key: 's-far',
      platform: 'slack',
      channel: 'C_FAR',
      conversationKind: 'channel',
      transportScope: 'scope-other',
      updatedAt: 550
    })
    const visible: Record<string, string[]> = { 'user-p': [] }
    const { deps, clock } = perAsker({ console: { visible } })
    const otherBot = fakeGateway({ listMemberIds: vi.fn(async () => [P]) })
    const ctx = { ...inOwnDm, integrations: [...integrations, { id: 'int-slack-2', platform: 'slack' }] }
    const crossDeps: OpsDeps = {
      ...deps,
      gatewayFor: (id) => (id === 'int-slack-2' ? otherBot : deps.gatewayFor(id)),
      placeStore: fakeStore([...SESSIONS, far]),
      placeIntegrationFor: (_agent, platform, scope) =>
        platform === 'slack' ? (scope === 'scope-other' ? 'int-slack-2' : 'int-slack') : 'int-tg',
      placeSnapshot: (integrationId, channel) =>
        integrationId === 'int-slack-2' && channel === 'C_FAR'
          ? { isPrivate: true }
          : SNAPSHOT[integrationId]?.[channel]
    }
    expect(await listedPlaces(ctx, crossDeps)).not.toContain('slack:C_FAR')
    expect(await executeTool(ctx, 'recall', { place: 'slack:C_FAR' }, crossDeps)).toEqual(opaque('slack:C_FAR'))
    await expect(
      executeTool(ctx, 'getChannelHistory', { channel: 'C_FAR', integrationId: 'int-slack-2' }, crossDeps)
    ).rejects.toThrow(NOT_SHARED)
    expect(otherBot.getChannelHistory).not.toHaveBeenCalled()
    expect(otherBot.listMemberIds).not.toHaveBeenCalled()
    visible['user-p'] = ['out-s-far']
    clock.now = PLACE_MEMBERS_TTL_MS + 1
    expect(await excerptsOf(ctx, 'slack:C_FAR', crossDeps)).toEqual([])
    await executeTool(ctx, 'getChannelHistory', { channel: 'C_FAR', integrationId: 'int-slack-2' }, crossDeps)
    expect(otherBot.getChannelHistory).toHaveBeenCalledWith('C_FAR', {})
  })

  it('refuses a private place on a platform whose member listing is not authoritative', async () => {
    const deps = makeDeps({
      readAskers: async () => ({
        people: [{ kind: 'member', platform: 'telegram', integrationId: 'int-tg', userId: 'tg-user' }],
        nobody: false
      })
    })
    const tgDm = ctxAt('telegram', 'tg-dm', { integrationId: 'int-tg', isDm: true, transportScope: 'scope-telegram' })
    expect(await executeTool(tgDm, 'recall', { place: 'telegram:-1002' }, deps)).toEqual(opaque('telegram:-1002'))
    expect(await listedPlaces(tgDm, deps)).not.toContain('telegram:-1002')
    expect(await excerptsOf(tgDm, 'telegram:-1001', deps)).toEqual(['telegram payments chatter'])
  })

  it('reads for the asker alike in a group DM and an external place', async () => {
    const { deps, asks } = perAsker()
    for (const ctx of [ctxAt('slack', 'G_MPIM'), ctxAt('slack', 'C_SHARED')]) {
      asks(from(P, ctx.channel))
      expect(await excerptsOf(ctx, 'slack:C_PRIV', deps), ctx.channel).toEqual(['secret merger talk'])
      expect(await listedPlaces(ctx, deps), ctx.channel).not.toContain('slack:C_PRIV')
      await executeTool(ctx, 'getChannelHistory', { channel: 'C_PRIV' }, deps)
    }
  })

  it('reads for a webchat asker exactly what the console shows them', async () => {
    const web = ctxAt('webchat', 'chat-1')
    const { deps, asks } = perAsker({
      console: {
        visible: { 'user-p': ['out-s-priv', 'out-s-dm-p'], 'user-x': ['out-s-deploys', 'out-s-deploys-old'] }
      }
    })
    asks({ ...fromP, platform: 'webchat', sender: { id: 'user-p', isBot: false } }, { console: true })
    expect(await excerptsOf(web, 'slack:C_PRIV', deps)).toEqual(['secret merger talk'])
    expect(await sourceOf(web, 'slack:D_P', deps)).toContain('the direct message')
    expect(await executeTool(web, 'recall', { place: 'slack:C_DEPLOY' }, deps)).toEqual(opaque('slack:C_DEPLOY'))
    // With sync off the console shows every organization member a channel's sessions, so they read it.
    asks({ ...fromP, platform: 'webchat', sender: { id: 'user-x', isBot: false } }, { console: true })
    expect(await excerptsOf(web, 'slack:C_DEPLOY', deps)).toContain('Noted: payments deploy Friday')
    expect(await executeTool(web, 'recall', { place: 'slack:C_PRIV' }, deps)).toEqual(opaque('slack:C_PRIV'))
  })

  it('reads a webchat conversation only for its owner, from the console or a linked chat identity', async () => {
    // Both members are shown the conversation; only its owner reads it.
    const { deps, asks } = perAsker({
      console: {
        linked: { [P]: 'user-p' },
        visible: { 'user-p': ['out-s-web2'], 'user-q': ['out-s-web2'] },
        owners: { 'out-s-web2': 'user-p' }
      }
    })
    asks({ ...fromP, platform: 'webchat', sender: { id: 'user-p', isBot: false } }, { console: true })
    expect(await excerptsOf(ctxAt('webchat', 'chat-1'), 'webchat:chat-2', deps)).toEqual(['webchat budget notes'])
    asks(from(P))
    expect(await excerptsOf(deploys, 'webchat:chat-2', deps)).toEqual(['webchat budget notes'])
    asks({ ...fromP, platform: 'webchat', sender: { id: 'user-q', isBot: false } }, { console: true })
    expect(await executeTool(ctxAt('webchat', 'chat-1'), 'recall', { place: 'webchat:chat-2' }, deps)).toEqual(
      opaque('webchat:chat-2')
    )
  })

  it('opens getChannelHistory, getThreadHistory, getReactions and listBookmarks to a member, and refuses them otherwise', async () => {
    const reads: [string, Record<string, unknown>][] = [
      ['getChannelHistory', { channel: 'C_PRIV' }],
      ['getThreadHistory', { channel: 'C_PRIV', thread: '1.1' }],
      ['getReactions', { channel: 'G_MPIM', messageTs: '1.1' }],
      ['listBookmarks', { channel: 'C_PRIV' }]
    ]
    const member = perAsker()
    for (const [tool, args] of reads) {
      expect(await executeTool(inOwnDm, tool, args, member.deps), tool).toMatchObject({
        privateSource: expect.any(String)
      })
    }
    expect(member.gw.getChannelHistory).toHaveBeenCalledWith('C_PRIV', {})
    expect(member.gw.getThreadReplies).toHaveBeenCalledWith('C_PRIV', '1.1', expect.any(Number), expect.anything())
    expect(member.gw.getReactions).toHaveBeenCalledWith('G_MPIM', '1.1')
    expect(member.gw.listBookmarks).toHaveBeenCalledWith('C_PRIV')

    const outsider = perAsker({ members: { C_PRIV: ['U_ALICE'], G_MPIM: ['U_BOB'] } })
    for (const [tool, args] of reads) {
      await expect(executeTool(inOwnDm, tool, args, outsider.deps), tool).rejects.toThrow(NOT_SHARED)
    }
    expect(outsider.gw.getChannelHistory).not.toHaveBeenCalled()
    expect(outsider.gw.getThreadReplies).not.toHaveBeenCalled()
    expect(outsider.gw.getReactions).not.toHaveBeenCalled()
    expect(outsider.gw.listBookmarks).not.toHaveBeenCalled()
  })

  it('judges an agent outside assistant mode by the same rule', async () => {
    const { deps } = perAsker()
    const plain = { ...deps, assistantModeFor: () => false }
    expect(await executeTool(inOwnDm, 'getChannelHistory', { channel: 'C_PRIV' }, plain)).toMatchObject({
      privateSource: expect.any(String)
    })
    await expect(executeTool(inOwnDm, 'getChannelHistory', { channel: 'D_Q' }, plain)).rejects.toThrow(NOT_SHARED)
    await expect(executeTool(inOwnDm, 'recall', {}, plain)).rejects.toThrow(/only to an agent in assistant mode/)
  })
})

describe('turns no person is behind, and sub-sessions', () => {
  const noPerson: [string, NormalizedMessage | undefined, SessionContext?][] = [
    [
      'a report round',
      { ...fromP, source: 'agent', sender: { id: 'peer', isBot: true }, isDm: false, parentReport: true }
    ],
    ['a scheduled run', { ...fromP, source: 'cron' }],
    ['a background-task wake', { ...fromP, source: 'agent', sender: { id: 'background-task:1', isBot: true } }],
    ['a headless turn', { ...fromP, headless: true }],
    ['no live turn', undefined],
    [
      'a patrol',
      { ...fromP, source: 'agent', sender: { id: AGENT, isBot: true } },
      {
        ...inOwnDm,
        thread: 'subsession:patrol-d-2',
        tools: [{ name: 'recall' }, { name: 'getChannelHistory' }] as SessionContext['tools']
      }
    ]
  ]

  it.each(noPerson)('reads only public sources on %s', async (_label, msg, ctx = inOwnDm) => {
    const { deps, asks, gw } = perAsker()
    asks(msg)
    expect(await executeTool(ctx, 'recall', { place: 'slack:C_PRIV' }, deps)).toEqual(opaque('slack:C_PRIV'))
    await expect(executeTool(ctx, 'getChannelHistory', { channel: 'C_PRIV' }, deps)).rejects.toThrow(NOT_SHARED)
    await executeTool(ctx, 'getChannelHistory', { channel: 'C_DEPLOY' }, deps)
    expect(gw.listMemberIds).not.toHaveBeenCalled()
  })

  it('reads a sub-session as the person whose turn opened it', async () => {
    const { deps, asks, live } = perAsker()
    const sub = { ...inOwnDm, thread: 'subsession:d-1' }
    asks({ ...fromP, source: 'agent', sender: { id: AGENT, isBot: true }, headless: true })
    live.opener = turnAskers([{ msg: fromP, integrationId: 'int-slack' }], 'int-slack')
    expect(await excerptsOf(sub, 'slack:C_PRIV', deps)).toEqual(['secret merger talk'])
    live.opener = NOBODY
    expect(await executeTool(sub, 'recall', { place: 'slack:C_PRIV' }, deps)).toEqual(opaque('slack:C_PRIV'))
  })

  it('reads for a webchat asker as the Slack account they linked in the bot workspace', async () => {
    const web = ctxAt('webchat', 'chat-1')
    // The console shows user-p none of these sessions; the account they linked decides.
    const { deps, asks, readAccess } = perAsker({ console: { visible: {}, accounts: { 'user-p': P } } })
    asks({ ...fromP, platform: 'webchat', sender: { id: 'user-p', isBot: false } }, { console: true })
    expect(await excerptsOf(web, 'slack:C_PRIV', deps)).toEqual(['secret merger talk'])
    expect(await excerptsOf(web, 'slack:C_DEPLOY', deps)).toContain('Noted: payments deploy Friday')
    expect(await sourceOf(web, 'slack:D_P', deps)).toContain('the direct message')
    expect(await executeTool(web, 'recall', { place: 'slack:D_Q' }, deps)).toEqual(opaque('slack:D_Q'))
    expect(readAccess).not.toHaveBeenCalled()
    // A console user who linked nothing in that workspace reads only what the console shows them.
    asks({ ...fromP, platform: 'webchat', sender: { id: 'user-q', isBot: false } }, { console: true })
    expect(await executeTool(web, 'recall', { place: 'slack:C_DEPLOY' }, deps)).toEqual(opaque('slack:C_DEPLOY'))
  })

  it('reads for whoever sent the message, not for the DM it arrived in', async () => {
    const { deps, asks } = perAsker()
    asks({ ...fromP, sender: { id: 'U_Q', isBot: false } })
    expect(await executeTool(inOwnDm, 'recall', { place: 'slack:C_PRIV' }, deps)).toEqual(opaque('slack:C_PRIV'))
    expect(await executeTool(inOwnDm, 'recall', { place: 'slack:D_P' }, deps)).toMatchObject({ place: 'slack:D_P' })
  })

  it('reads a console continuation for the console user, as the console shows it to them', async () => {
    const { deps, asks } = perAsker({ console: { visible: { 'user-p': ['out-s-priv'] } } })
    asks({ ...fromP, adoptedSession: true, sender: { id: 'user-p', isBot: false } }, { console: true })
    expect(await excerptsOf(deploys, 'slack:C_PRIV', deps)).toEqual(['secret merger talk'])
    asks({ ...fromP, adoptedSession: true, sender: { id: 'user-x', isBot: false } }, { console: true })
    expect(await executeTool(deploys, 'recall', { place: 'slack:C_PRIV' }, deps)).toEqual(opaque('slack:C_PRIV'))
  })

  it("reads a patrol or a task as its item's asker, and refuses what that person is not in", async () => {
    const { deps, asks, live } = perAsker()
    const patrol: SessionContext = {
      ...inOwnDm,
      thread: 'subsession:patrol-d-3',
      tools: [{ name: 'recall' }, { name: 'getChannelHistory' }] as SessionContext['tools']
    }
    asks({ ...fromP, source: 'agent', sender: { id: AGENT, isBot: true }, headless: true })
    live.opener = {
      people: [{ kind: 'member', platform: 'slack', integrationId: 'int-slack', userId: P }],
      nobody: false
    }
    expect(await excerptsOf(patrol, 'slack:C_PRIV', deps)).toEqual(['secret merger talk'])
    live.opener = {
      people: [{ kind: 'member', platform: 'slack', integrationId: 'int-slack', userId: 'U_Q' }],
      nobody: false
    }
    expect(await executeTool(patrol, 'recall', { place: 'slack:C_PRIV' }, deps)).toEqual(opaque('slack:C_PRIV'))
    await expect(executeTool(patrol, 'getChannelHistory', { channel: 'C_PRIV' }, deps)).rejects.toThrow(NOT_SHARED)
  })

  it("reads a schedule's run as the console user its row records, and as nobody when it records none", async () => {
    const { deps, live } = perAsker({ console: { visible: { 'user-p': ['out-s-priv'] } } })
    const run = (person?: ReadAsker): void => {
      live.messages = [
        {
          msg: { ...from(AGENT), source: 'cron', sender: { id: AGENT, isBot: true } },
          integrationId: 'int-slack',
          ...(person ? { person } : {})
        }
      ]
    }
    run({ kind: 'console', userId: 'user-p' })
    expect(await excerptsOf(deploys, 'slack:C_PRIV', deps)).toEqual(['secret merger talk'])
    run({ kind: 'console', userId: 'user-q' })
    expect(await executeTool(deploys, 'recall', { place: 'slack:C_PRIV' }, deps)).toEqual(opaque('slack:C_PRIV'))
    run()
    expect(await executeTool(deploys, 'recall', { place: 'slack:C_PRIV' }, deps)).toEqual(opaque('slack:C_PRIV'))
    expect(await excerptsOf(deploys, 'slack:C_DEPLOY', deps)).toContain('Noted: payments deploy Friday')
  })

  it('reads a hook run as nobody, except in the conversation an editor anchored it to', async () => {
    const { deps, asks, gw } = perAsker()
    asks({ ...from('gh-actor'), source: 'hook', sender: { id: 'gh-actor', isBot: false } })
    await expect(executeTool(deploys, 'getChannelHistory', { channel: 'C_PRIV' }, deps)).rejects.toThrow(NOT_SHARED)
    expect(await executeTool(deploys, 'recall', { place: 'slack:G_MPIM' }, deps)).toEqual(opaque('slack:G_MPIM'))
    await executeTool(deploys, 'getChannelHistory', { channel: 'C_OPEN' }, deps)
    // Anchored to a private channel, the run reads that channel as its own conversation.
    const anchored = ctxAt('slack', 'C_PRIV')
    await executeTool(anchored, 'getChannelHistory', {}, deps)
    expect(await excerptsOf(anchored, 'slack:C_PRIV', deps)).toEqual(['secret merger talk'])
    expect(gw.getChannelHistory).toHaveBeenCalledWith('C_PRIV', {})
    expect(gw.listMemberIds).not.toHaveBeenCalled()
  })
})

describe('across platforms and bots: as the console would show it to the person', () => {
  const tgDm = ctxAt('telegram', 'tg-dm', {
    integrationId: 'int-tg',
    isDm: true,
    integrations: [...integrations, { id: 'int-dc', platform: 'discord' }]
  })
  const fromTelegram = { ...fromP, platform: 'telegram', channel: 'tg-dm', sender: { id: '42', isBot: false } }

  it('reads a Slack member linked to a console user a Telegram group the console shows them', async () => {
    const { deps } = perAsker({ console: { visible: { 'user-p': ['out-s-tg-closed'] } } })
    expect(await excerptsOf(inOwnDm, 'telegram:-1002', deps)).toEqual(['closed group plans'])
    expect(await sourceOf(inOwnDm, 'telegram:-1002', deps)).toContain('a private conversation')
  })

  it('refuses a Telegram asker a Slack public channel and a Discord group, with no link hint', async () => {
    const { deps, asks } = perAsker({ console: { visible: { 'user-p': ['out-s-deploys', 'out-s-dc'] } } })
    asks(fromTelegram, { integrationId: 'int-tg' })
    for (const place of ['slack:C_DEPLOY', 'discord:dc-group']) {
      expect(await executeTool(tgDm, 'recall', { place }, deps), place).toEqual(opaque(place))
    }
    expect(await listedPlaces(tgDm, deps)).not.toContain('slack:C_DEPLOY')
    // Its own bot still opens what Telegram confirms public.
    expect(await excerptsOf(tgDm, 'telegram:-1001', deps)).toEqual(['telegram payments chatter'])
  })

  it('refuses an unlinked Slack asker a cross-platform read, and tells them how linking opens it', async () => {
    const { deps, asks } = perAsker({ console: { linked: { [P]: 'user-p' } } })
    asks(from('U_STRANGER'))
    expect(await executeTool(deploys, 'recall', { place: 'telegram:-1001' }, deps)).toEqual(
      opaqueUnlinked('telegram:-1001')
    )
    // A place that does not exist gets the same answer, so the hint never tells the two apart.
    expect(await executeTool(deploys, 'recall', { place: 'telegram:-9999' }, deps)).toEqual(
      opaqueUnlinked('telegram:-9999')
    )
    await expect(executeTool(deploys, 'getChannelHistory', { channel: 'C_PRIV' }, deps)).rejects.toThrow(
      /Sign-in methods in their console Profile/
    )
    // A linked asker is never told to link.
    asks(from(P))
    expect(await executeTool(deploys, 'recall', { place: 'telegram:-9999' }, deps)).toEqual(opaque('telegram:-9999'))
  })

  it('refuses a DM on another platform to anyone but its owner, though the console shows it to every member', async () => {
    // A Telegram DM is org-visible in the console: user-p sees it, but user-q owns it.
    const { deps } = perAsker({
      console: { visible: { 'user-p': ['out-s-tg-dm'] }, owners: { 'out-s-tg-dm': 'user-q' } }
    })
    expect(await executeTool(inOwnDm, 'recall', { place: 'telegram:tg-dm-q' }, deps)).toEqual(
      opaque('telegram:tg-dm-q')
    )
    const owner = perAsker({ console: { visible: { 'user-p': ['out-s-tg-dm'] }, owners: { 'out-s-tg-dm': 'user-p' } } })
    expect(await sourceOf(inOwnDm, 'telegram:tg-dm-q', owner.deps)).toContain('the direct message')
  })

  it('refuses a sync-off Slack DM read through another bot to anyone but its person', async () => {
    // With sync off the console shows every member the DM; reading it is still its person's alone.
    const world = {
      visible: { 'user-p': ['out-s-dm-q'], 'user-U_Q': ['out-s-dm-q'] },
      owners: { 'out-s-dm-q': 'user-U_Q' }
    }
    const { deps, asks, readAccess } = perAsker({ console: world })
    const otherBot = fakeGateway()
    const twoBots = { ...deploys, integrations: [...integrations, { id: 'int-slack-2', platform: 'slack' }] }
    const viaOtherBot: OpsDeps = {
      ...deps,
      gatewayFor: (id) => (id === 'int-slack-2' ? otherBot : deps.gatewayFor(id))
    }
    const read = () =>
      executeTool(twoBots, 'getChannelHistory', { channel: 'D_Q', integrationId: 'int-slack-2' }, viaOtherBot)
    asks(from(P))
    await expect(read()).rejects.toThrow(NOT_SHARED)
    expect(readAccess).toHaveBeenCalledWith(AGENT, expect.objectContaining({ userId: P }), ['out-s-dm-q'], true)
    expect(otherBot.getChannelHistory).not.toHaveBeenCalled()
    asks(from('U_Q'))
    await read()
    expect(otherBot.getChannelHistory).toHaveBeenCalledWith('D_Q', {})
  })

  it('refuses every cross-platform read when the Control Plane cannot answer', async () => {
    const { deps, readAccess } = perAsker({ console: { visible: { 'user-p': ['out-s-tg-closed'] } } })
    readAccess.mockRejectedValue(new Error('offline'))
    expect(await executeTool(inOwnDm, 'recall', { place: 'telegram:-1002' }, deps)).toEqual(opaque('telegram:-1002'))
  })
})
