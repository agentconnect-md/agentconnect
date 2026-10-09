import { describe, expect, it, vi } from 'vitest'
import { NOT_SHARED_HERE } from '../src/assistant/place-access.js'
import { executeTool, type MessageGateway, type OpsDeps, type SessionContext } from '../src/mcp/ops.js'
import type { PostInterception } from '../src/assistant/drafts.js'
import type { PlaceSnapshotRow, PlaceStore } from '../src/mcp/ops/place-gate.js'
import { ALL_TOOL_NAMES, toolsForIntegrations } from '../src/mcp/tools.js'
import type { MemoryProvider } from '../src/memory/provider.js'
import type { SessionRecord, TranscriptRow } from '../src/store/local-store.js'
import type { Integration } from '../src/agents/agent-schema.js'
import { PlaceMembers, PLACE_MEMBERS_TTL_MS } from '../src/assistant/place-members.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import { LocalStore, sessionKey } from '../src/store/local-store.js'
import { tempStorePath } from './store-support.js'

const AGENT = 'agent-a'

function session(over: Partial<SessionRecord> & Pick<SessionRecord, 'key' | 'platform' | 'channel'>): SessionRecord {
  return {
    agentId: AGENT,
    thread: `append:${over.key}`,
    transportScope: over.platform === 'webchat' ? null : `scope-${over.platform}`,
    acpSessionId: `acp-${over.key}`,
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
  session({ key: 's-hook', platform: 'hook', channel: 'C_DEPLOY', conversationKind: 'channel', updatedAt: 50 })
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
  row('s-tg-closed', 'tg-user', 'closed group plans', 26)
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
      { place: 'slack:C_DEPLOY', name: 'deploys', kind: 'channel', lastActive: expect.any(String) },
      { place: 'telegram:-1001', kind: 'channel', lastActive: expect.any(String) }
    ])
    expect(JSON.stringify(result)).not.toMatch(/C_PRIV|leadership|G_MPIM|-1002/)
    // The snapshot answered every channel; only the group DM, whose row carries no privacy, asked the platform.
    expect(deps.gatewayFor('int-slack')!.getChannelInfo).toHaveBeenCalledTimes(1)
    expect(deps.gatewayFor('int-slack')!.getChannelInfo).toHaveBeenCalledWith('G_MPIM')
  })

  it('lists open channels from webchat but no DM and no other webchat conversation', async () => {
    const result = (await executeTool(ctxAt('webchat', 'chat-1'), 'recall', {}, makeDeps())) as {
      places: { place: string; name?: string }[]
    }
    expect(result.places.map((p) => p.place)).toEqual(['slack:C_DEPLOY', 'webchat:chat-1', 'telegram:-1001'])
    expect(result.places.find((p) => p.place === 'webchat:chat-1')).toMatchObject({ name: 'Planning', current: true })
  })

  it('leaves out a place whose privacy cannot be read while its bot is unreachable', async () => {
    const deps = makeDeps({
      gatewayFor: () => undefined,
      placeSnapshot: (integrationId, channel) =>
        integrationId === 'int-tg' ? SNAPSHOT['int-tg']?.[channel] : undefined
    })
    const result = (await executeTool(inDmOfP, 'recall', {}, deps)) as { places: { place: string }[] }
    expect(result.places.map((p) => p.place)).toEqual(['slack:D_P', 'telegram:-1001'])
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

  it('says so when nothing matched', async () => {
    expect(
      await executeTool(inDmOfP, 'recall', { place: 'slack:C_DEPLOY', query: 'kubernetes' }, makeDeps())
    ).toMatchObject({ excerpts: [], note: 'Nothing that was searched there matched.' })
  })

  it("reads an open channel by the platform's own privacy facet", async () => {
    const result = (await executeTool(inDmOfP, 'recall', { place: 'telegram:-1001' }, makeDeps())) as {
      excerpts: { text: string }[]
    }
    expect(result.excerpts.map((e) => e.text)).toEqual(['telegram payments chatter'])
  })
})

describe('recall — refusals the model relays', () => {
  it('refuses another person\'s DM with "ask me in a DM"', async () => {
    const result = await executeTool(inDmOfP, 'recall', { place: 'slack:D_Q', query: 'salary' }, makeDeps())
    expect(result).toEqual({ place: 'slack:D_Q', refused: true, answer: expect.stringContaining('Ask me in a DM.') })
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
      }
      expect(own.excerpts.map((e) => e.text)).toEqual([text])
    }
  })

  it('refuses DMs and other webchat conversations from webchat, and reads open channels there', async () => {
    const web = ctxAt('webchat', 'chat-1')
    expect(await executeTool(web, 'recall', { place: 'slack:D_P' }, makeDeps())).toMatchObject({
      answer: expect.stringContaining('Ask me in a DM.')
    })
    expect(await executeTool(web, 'recall', { place: 'webchat:chat-2' }, makeDeps())).toMatchObject({
      answer: expect.stringContaining('Ask me in a DM.')
    })
    expect(await executeTool(web, 'recall', { place: 'slack:C_DEPLOY', query: 'friday' }, makeDeps())).toMatchObject({
      excerpts: [{ from: 'alice' }, { from: 'you' }]
    })
  })

  it('refuses webchat and DMs from a channel', async () => {
    const deploys = ctxAt('slack', 'C_DEPLOY')
    for (const place of ['webchat:chat-1', 'slack:D_P']) {
      expect(await executeTool(deploys, 'recall', { place }, makeDeps())).toMatchObject({
        refused: true,
        answer: expect.stringContaining('Ask me in a DM.')
      })
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

describe('the place rule on the existing cross-place reads', () => {
  it('reads another open channel and the current conversation', async () => {
    const deps = makeDeps()
    await executeTool(inDmOfP, 'getChannelHistory', { channel: 'C_DEPLOY' }, deps)
    await executeTool(inDmOfP, 'getChannelHistory', {}, deps)
    expect(deps.gatewayFor('int-slack')!.getChannelHistory).toHaveBeenCalledTimes(2)
  })

  it("refuses another person's DM, and a private channel or group DM opaquely, before the platform read", async () => {
    const deps = makeDeps()
    const gw = deps.gatewayFor('int-slack')!
    await expect(executeTool(inDmOfP, 'getChannelHistory', { channel: 'D_Q' }, deps)).rejects.toThrow(/Ask me in a DM/)
    for (const [tool, args] of [
      ['getThreadHistory', { channel: 'C_PRIV', thread: '1.1' }],
      ['getChannelHistory', { channel: 'G_MPIM' }]
    ] as const) {
      const refusal = executeTool(inDmOfP, tool, args, deps)
      await expect(refusal).rejects.toThrow("I can't share that here.")
      await expect(refusal).rejects.not.toThrow(/private/i)
    }
    expect(gw.getChannelHistory).not.toHaveBeenCalled()
    expect(gw.getThreadReplies).not.toHaveBeenCalled()
  })

  it('takes a DM from the session rows where the platform does not say', async () => {
    const feishu = fakeGateway({ getChannelInfo: vi.fn(async (id: string) => ({ id })) })
    const ctx = ctxAt('feishu', 'oc_group', {
      integrationId: 'int-feishu',
      integrations: [{ id: 'int-feishu', platform: 'feishu' }]
    })
    const store = fakeStore([session({ key: 'f-dm', platform: 'feishu', channel: 'oc_dm', conversationKind: 'dm' })])
    const deps = makeDeps({ gatewayFor: () => feishu, placeStore: store })
    await expect(executeTool(ctx, 'getChannelHistory', { channel: 'oc_dm' }, deps)).rejects.toThrow(/Ask me in a DM/)
    // Outside assistant mode the same read is unchanged.
    await executeTool(ctx, 'getChannelHistory', { channel: 'oc_dm' }, { ...deps, assistantModeFor: () => false })
    expect(feishu.getChannelHistory).toHaveBeenCalledTimes(1)
  })
})

describe('the write rule: platform writes stay in the current place', () => {
  it('refuses a post, a DM, a schedule or a reaction aimed at another conversation, and sends nothing', async () => {
    const deps = makeDeps()
    const gw = deps.gatewayFor('int-slack')!
    const postAt = new Date(Date.now() + 3_600_000).toISOString()
    const attempts: [string, Record<string, unknown>][] = [
      ['sendMessage', { channel: 'C_DEPLOY', message: 'hi' }],
      ['sendMessage', { channel: 'C_DEPLOY', thread: '1.1', message: 'hi' }],
      ['sendMessage', { toUser: 'U_Q', message: 'hi' }],
      ['sendMessage', { toUser: ['U_Q'], channel: 'C_DEPLOY', message: 'hi' }],
      ['sendMessage', { channel: 'D_P', platform: 'telegram', message: 'hi' }],
      ['scheduleMessage', { channel: 'C_DEPLOY', message: 'later', postAt }],
      ['addReaction', { channel: 'C_DEPLOY', messageTs: '1.1', emoji: 'eyes' }],
      ['createConversation', { name: 'new-room' }],
      ['createCanvas', { title: 'Notes', markdown: '# hi' }],
      ['updateCanvas', { canvasId: 'F1', edits: [{ operation: 'replace', markdown: 'x' }] }]
    ]
    for (const [tool, args] of attempts) {
      await expect(executeTool(inDmOfP, tool, args, deps), `${tool} ${JSON.stringify(args)}`).rejects.toThrow(
        /write only to the conversation you are in/
      )
    }
    expect(gw.postMessage).not.toHaveBeenCalled()
    expect(gw.scheduleMessage).not.toHaveBeenCalled()
    expect(gw.addReaction).not.toHaveBeenCalled()
    expect(gw.createConversation).not.toHaveBeenCalled()
    expect(gw.updateCanvas).not.toHaveBeenCalled()
  })

  it('lets writes to the current place through', async () => {
    const deps = makeDeps()
    const gw = deps.gatewayFor('int-slack')!
    const postAt = new Date(Date.now() + 3_600_000).toISOString()
    await executeTool(inDmOfP, 'sendMessage', { channel: 'D_P', message: 'hi' }, deps)
    await executeTool(inDmOfP, 'scheduleMessage', { message: 'later', postAt }, deps)
    await executeTool(inDmOfP, 'addReaction', { messageTs: '1.1', emoji: 'eyes' }, deps)
    expect(gw.postMessage).toHaveBeenCalledTimes(1)
    expect(gw.scheduleMessage).toHaveBeenCalledWith('D_P', 'later', expect.any(Number))
    expect(gw.addReaction).toHaveBeenCalledWith('D_P', '1.1', 'eyes')
  })

  it('leaves the agent-to-agent forms and the parent-session reply alone', async () => {
    const deps = makeDeps()
    await executeTool(inDmOfP, 'sendMessage', { toAgent: 'peer-1', message: 'hi' }, deps)
    await executeTool(inDmOfP, 'sendMessage', { sessionId: 'parent-1', message: 'done' }, deps)
    expect(deps.messageAgent).toHaveBeenCalledTimes(1)
    expect(deps.replyToSession).toHaveBeenCalledTimes(1)
  })

  it('changes nothing for an agent outside assistant mode', async () => {
    const deps = makeDeps({ assistantModeFor: () => false })
    const gw = deps.gatewayFor('int-slack')!
    await executeTool(inDmOfP, 'sendMessage', { channel: 'C_DEPLOY', message: 'hi' }, deps)
    await executeTool(inDmOfP, 'createConversation', { name: 'new-room' }, deps)
    expect(gw.postMessage).toHaveBeenCalledTimes(1)
    expect(gw.createConversation).toHaveBeenCalledTimes(1)
  })
})

describe('the write rule under drafts: a post elsewhere goes through approval', () => {
  const drafted = { handled: true as const, result: { drafted: true, draftId: 'd-1' } }

  function draftingDeps(over: Partial<OpsDeps> = {}) {
    const gw = fakeGateway({
      openDirectMessage: vi.fn(async (user: string) => `D_${user}`),
      getThreadReplies: vi.fn(async () => [
        { ts: '1.1', sender: 'U1', text: 'root', isBot: false, chrome: false, attachments: [] }
      ])
    })
    const assistantDraftPost = vi.fn(async () => drafted as PostInterception)
    const deps = makeDeps({ gatewayFor: (id) => (id === 'int-slack' ? gw : undefined), assistantDraftPost, ...over })
    return { deps, gw, assistantDraftPost }
  }

  it('hands every posting form aimed elsewhere to the draft, fully resolved, and posts nothing', async () => {
    const { deps, gw, assistantDraftPost } = draftingDeps()
    expect(await executeTool(inDmOfP, 'sendMessage', { channel: 'C_DEPLOY', message: 'hi' }, deps)).toEqual(
      drafted.result
    )
    await executeTool(inDmOfP, 'sendMessage', { channel: 'C_DEPLOY', thread: '1.1', message: 'update' }, deps)
    await executeTool(inDmOfP, 'sendMessage', { toUser: 'U_Q', message: 'psst' }, deps)
    await executeTool(inDmOfP, 'sendMessage', { toUser: ['U_Q'], channel: 'C_DEPLOY', message: 'look' }, deps)
    expect(assistantDraftPost.mock.calls.map((call) => (call as unknown[])[1])).toEqual([
      { platform: 'slack', integrationId: 'int-slack', channel: 'C_DEPLOY', text: 'hi', directMessage: false },
      {
        platform: 'slack',
        integrationId: 'int-slack',
        channel: 'C_DEPLOY',
        thread: '1.1',
        text: 'update',
        directMessage: false
      },
      {
        platform: 'slack',
        integrationId: 'int-slack',
        channel: 'D_U_Q',
        text: 'psst',
        directMessage: true,
        recipient: 'U_Q'
      },
      { platform: 'slack', integrationId: 'int-slack', channel: 'C_DEPLOY', text: '<@U_Q> look', directMessage: false }
    ])
    expect(gw.postMessage).not.toHaveBeenCalled()
  })

  it('posts as before when a grant lets the post through', async () => {
    const { deps, gw } = draftingDeps({ assistantDraftPost: vi.fn(async () => ({ handled: false as const })) })
    await executeTool(inDmOfP, 'sendMessage', { channel: 'C_DEPLOY', message: 'hi' }, deps)
    expect(gw.postMessage).toHaveBeenCalledTimes(1)
  })

  it('refuses a forwarded file, and keeps refusing the other writes aimed elsewhere', async () => {
    const { deps, gw, assistantDraftPost } = draftingDeps({
      resolveAttachment: vi.fn(async () => ({ bytes: Buffer.from('x'), name: 'a.png', mimeType: 'image/png' }))
    })
    gw.uploadFile = vi.fn(async () => ({ ok: true as const }))
    await expect(
      executeTool(inDmOfP, 'sendMessage', { channel: 'C_DEPLOY', attachment: 'a.png', message: 'see' }, deps)
    ).rejects.toThrow(/a file cannot be sent for approval/)
    await expect(
      executeTool(inDmOfP, 'addReaction', { channel: 'C_DEPLOY', messageTs: '1.1', emoji: 'eyes' }, deps)
    ).rejects.toThrow(/write only to the conversation you are in/)
    expect(assistantDraftPost).not.toHaveBeenCalled()
    expect(gw.uploadFile).not.toHaveBeenCalled()
    expect(gw.addReaction).not.toHaveBeenCalled()
  })

  it('leaves the agent-to-agent forms and every agent outside assistant mode alone', async () => {
    const { deps, gw, assistantDraftPost } = draftingDeps()
    await executeTool(inDmOfP, 'sendMessage', { toAgent: 'peer-1', message: 'hi' }, deps)
    await executeTool(inDmOfP, 'sendMessage', { sessionId: 'parent-1', message: 'done' }, deps)
    expect(deps.messageAgent).toHaveBeenCalledTimes(1)
    expect(deps.replyToSession).toHaveBeenCalledTimes(1)
    const plain = { ...deps, assistantModeFor: () => false }
    await executeTool(inDmOfP, 'sendMessage', { channel: 'C_DEPLOY', message: 'hi' }, plain)
    expect(assistantDraftPost).not.toHaveBeenCalled()
    expect(gw.postMessage).toHaveBeenCalledTimes(1)
  })

  it('in an external place, refuses every write there, drafts a post elsewhere, and still reads', async () => {
    const shared = ctxAt('slack', 'C_SHARED')
    const { deps, gw, assistantDraftPost } = draftingDeps({ placeExternal: (ctx) => ctx.channel === 'C_SHARED' })
    const postAt = new Date(Date.now() + 3_600_000).toISOString()
    const here: [string, Record<string, unknown>][] = [
      ['sendMessage', { channel: 'C_SHARED', message: 'hi' }],
      ['addReaction', { messageTs: '1.1', emoji: 'eyes' }],
      ['scheduleMessage', { message: 'later', postAt }],
      ['shareFile', { path: 'chart.png' }]
    ]
    for (const [tool, args] of here) {
      await expect(executeTool(shared, tool, args, deps), tool).rejects.toThrow(/shared with another organization/)
    }
    expect(gw.postMessage).not.toHaveBeenCalled()
    expect(gw.addReaction).not.toHaveBeenCalled()
    expect(gw.scheduleMessage).not.toHaveBeenCalled()
    await executeTool(shared, 'sendMessage', { channel: 'C_DEPLOY', message: 'for the team' }, deps)
    expect(assistantDraftPost).toHaveBeenCalledTimes(1)
    await executeTool(shared, 'sendMessage', { toAgent: 'peer-1', message: 'hi' }, deps)
    expect(deps.messageAgent).toHaveBeenCalledTimes(1)
    await executeTool(shared, 'getChannelHistory', {}, deps)
    expect(gw.getChannelHistory).toHaveBeenCalledTimes(1)
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

// Per-asker scoping (assistant-mode.md §5.5): in P's own 1:1 DM a private place opens to P while P is a member.
const P = 'U_P'
const inOwnDm = ctxAt('slack', 'D_P', { transportScope: 'scope-slack' })
const keyOf = (ctx: SessionContext): string =>
  sessionKey(ctx.platform, ctx.channel, ctx.thread, ctx.agentId, ctx.transportScope)

/** P's own message in P's DM: the only turn the rule widens. */
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

interface MarkStore {
  mark(agentId: string, key: string, place: { platform: string; channel: string }, at: number): Promise<void>
  has(agentId: string, key: string): Promise<boolean>
  placeMarked(agentId: string, platform: string, channel: string): Promise<boolean>
}

function memoryMarks(): MarkStore {
  const marks = new Map<string, string>()
  return {
    mark: async (agentId, key, place) =>
      void marks.set(`${agentId}|${key}`, `${agentId}|${place.platform}:${place.channel}`),
    has: async (agentId, key) => marks.has(`${agentId}|${key}`),
    placeMarked: async (agentId, platform, channel) => [...marks.values()].includes(`${agentId}|${platform}:${channel}`)
  }
}

/** No mark anywhere, and nothing written: a session that never made a widened read. */
const unmarkedSession = { mark: async () => true, marked: async () => false, placeMarked: async () => false }

function perAsker(opts: { members?: Record<string, string[]>; failLookups?: boolean; marks?: MarkStore } = {}) {
  const members: Record<string, string[]> = { C_PRIV: [P, 'U_ALICE'], G_MPIM: [P, 'U_BOB'], ...opts.members }
  const clock = { now: 0 }
  const gw = fakeGateway({
    getChannelInfo: vi.fn(async (id: string) => ({
      id,
      ...(id.startsWith('D') ? { isIm: true, user: id === 'D_P' ? P : 'U_Q' } : {}),
      ...(id.startsWith('G') ? { isMpim: true } : {}),
      isPrivate: id === 'C_PRIV' || id.startsWith('D') || id.startsWith('G')
    })),
    listMemberIds: vi.fn(async (channel: string) => {
      if (opts.failLookups) throw new Error('ratelimited')
      return members[channel] ?? []
    }),
    getReactions: vi.fn(async () => []),
    listBookmarks: vi.fn(async () => [])
  })
  const tg = fakeGateway()
  const placeMembers = new PlaceMembers({
    now: () => clock.now,
    gatewayFor: (id) => (id === 'int-slack' ? gw : undefined)
  })
  const marks = opts.marks ?? memoryMarks()
  const live: { msg: NormalizedMessage | undefined } = { msg: fromP }
  const placeMember = vi.fn((integrationId: string, channel: string, userId: string) =>
    placeMembers.isMember(integrationId, channel, userId)
  )
  const deps = makeDeps({
    gatewayFor: (id) => (id === 'int-slack' ? gw : id === 'int-tg' ? tg : undefined),
    placeAsker: (ctx) => placeMembers.askerIn(ctx, live.msg),
    placeMember,
    widenedSession: {
      mark: async (ctx) => {
        await marks.mark(ctx.agentId, keyOf(ctx), { platform: ctx.platform, channel: ctx.channel }, clock.now)
        return true
      },
      marked: (ctx) => marks.has(ctx.agentId, keyOf(ctx)),
      placeMarked: (ctx) => marks.placeMarked(ctx.agentId, ctx.platform, ctx.channel)
    },
    assistantDraftPost: vi.fn(async () => ({ handled: true, result: { drafted: true } }) as PostInterception)
  })
  return { deps, gw, clock, members, live, placeMember, marks }
}

const listedPlaces = async (ctx: SessionContext, deps: OpsDeps): Promise<string[]> =>
  ((await executeTool(ctx, 'recall', {}, deps)) as { places: { place: string }[] }).places.map((p) => p.place)

const excerptsOf = async (ctx: SessionContext, place: string, deps: OpsDeps): Promise<string[]> =>
  ((await executeTool(ctx, 'recall', { place }, deps)) as { excerpts: { text: string }[] }).excerpts.map((e) => e.text)

describe("per-asker scoping in the asker's own DM", () => {
  it('reads, but never lists, a private channel and a private group DM the asker belongs to', async () => {
    const { deps, gw } = perAsker()
    expect(await listedPlaces(inOwnDm, deps)).toEqual(['slack:D_P', 'slack:C_DEPLOY', 'telegram:-1001'])
    expect(await excerptsOf(inOwnDm, 'slack:C_PRIV', deps)).toEqual(['secret merger talk'])
    expect(await excerptsOf(inOwnDm, '#leadership', deps)).toEqual(['secret merger talk'])
    expect(await excerptsOf(inOwnDm, 'slack:G_MPIM', deps)).toEqual(['group dm planning payments'])
    // One member listing per conversation within the cache, and one counterpart lookup for the DM.
    expect(gw.listMemberIds).toHaveBeenCalledTimes(2)
    expect(vi.mocked(gw.getChannelInfo).mock.calls.filter(([id]) => id === 'D_P')).toHaveLength(1)
  })

  it('neither lists nor reads a private place the asker is not in, and answers opaquely', async () => {
    const { deps } = perAsker({ members: { C_PRIV: ['U_ALICE'], G_MPIM: ['U_BOB'] } })
    expect(await listedPlaces(inOwnDm, deps)).toEqual(['slack:D_P', 'slack:C_DEPLOY', 'telegram:-1001'])
    for (const place of ['slack:C_PRIV', '#leadership', 'slack:G_MPIM']) {
      expect(await executeTool(inOwnDm, 'recall', { place }, deps), place).toEqual(opaque(place))
    }
  })

  it('refuses once the asker has left, when the cached membership expires', async () => {
    const { deps, clock, members } = perAsker()
    expect(await excerptsOf(inOwnDm, 'slack:C_PRIV', deps)).toEqual(['secret merger talk'])
    members.C_PRIV = ['U_ALICE']
    clock.now = PLACE_MEMBERS_TTL_MS - 1
    expect(await excerptsOf(inOwnDm, 'slack:C_PRIV', deps)).toEqual(['secret merger talk'])
    clock.now = PLACE_MEMBERS_TTL_MS + 1
    expect(await executeTool(inOwnDm, 'recall', { place: 'slack:C_PRIV' }, deps)).toEqual(opaque('slack:C_PRIV'))
    expect(await listedPlaces(inOwnDm, deps)).not.toContain('slack:C_PRIV')
  })

  it('refuses when membership cannot be confirmed or the session cannot carry the mark', async () => {
    const failing = perAsker({ failLookups: true })
    expect(await executeTool(inOwnDm, 'recall', { place: 'slack:C_PRIV' }, failing.deps)).toEqual(
      opaque('slack:C_PRIV')
    )
    await expect(executeTool(inOwnDm, 'getChannelHistory', { channel: 'C_PRIV' }, failing.deps)).rejects.toThrow(
      "I can't share that here."
    )
    const unmarkable = perAsker()
    const noMark = { ...unmarkable.deps, widenedSession: { ...unmarkedSession, mark: async () => false } }
    expect(await executeTool(inOwnDm, 'recall', { place: 'slack:C_PRIV' }, noMark)).toEqual(opaque('slack:C_PRIV'))
    const unwired = { ...unmarkable.deps, widenedSession: undefined }
    expect(await executeTool(inOwnDm, 'recall', { place: 'slack:C_PRIV' }, unwired)).toEqual(opaque('slack:C_PRIV'))
  })

  it("refuses a private place reached through another workspace's bot", async () => {
    const far = session({
      key: 's-far',
      platform: 'slack',
      channel: 'C_FAR',
      conversationKind: 'channel',
      transportScope: 'scope-other',
      updatedAt: 550
    })
    const { deps } = perAsker({ members: { C_FAR: [P] } })
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
    ).rejects.toThrow("I can't share that here.")
    expect(otherBot.getChannelHistory).not.toHaveBeenCalled()
  })

  it('keeps P0a on a platform whose member listing is not authoritative', async () => {
    const placeMember = vi.fn(async () => true)
    const deps = makeDeps({
      placeAsker: async () => ({ integrationId: 'int-tg', userId: 'tg-user' }),
      placeMember,
      widenedSession: unmarkedSession
    })
    const tgDm = ctxAt('telegram', 'tg-dm', { integrationId: 'int-tg', isDm: true, transportScope: 'scope-telegram' })
    expect(await executeTool(tgDm, 'recall', { place: 'telegram:-1002' }, deps)).toEqual(opaque('telegram:-1002'))
    expect(await listedPlaces(tgDm, deps)).not.toContain('telegram:-1002')
    expect(placeMember).not.toHaveBeenCalled()
  })

  it('keeps P0a in a channel, a group DM, webchat and an external place', async () => {
    const placeAsker = vi.fn(async () => ({ integrationId: 'int-slack', userId: P }))
    const placeMember = vi.fn(async () => true)
    const deps = makeDeps({
      placeAsker,
      placeMember,
      widenedSession: unmarkedSession,
      placeExternal: (ctx) => ctx.channel === 'C_SHARED'
    })
    for (const ctx of [
      ctxAt('slack', 'C_DEPLOY'),
      ctxAt('slack', 'G_MPIM'),
      ctxAt('webchat', 'chat-1'),
      ctxAt('slack', 'C_SHARED')
    ]) {
      expect(await executeTool(ctx, 'recall', { place: 'slack:C_PRIV' }, deps), ctx.channel).toEqual(
        opaque('slack:C_PRIV')
      )
      expect(await listedPlaces(ctx, deps), ctx.channel).not.toContain('slack:C_PRIV')
    }
    for (const ctx of [ctxAt('slack', 'C_DEPLOY'), ctxAt('slack', 'G_MPIM'), ctxAt('slack', 'C_SHARED')]) {
      await expect(executeTool(ctx, 'getChannelHistory', { channel: 'C_PRIV' }, deps), ctx.channel).rejects.toThrow(
        "I can't share that here."
      )
    }
    expect(placeAsker).not.toHaveBeenCalled()
    expect(placeMember).not.toHaveBeenCalled()
  })

  it("keeps another person's DM refused, even to a member", async () => {
    const { deps } = perAsker({ members: { D_Q: [P] } })
    expect(await executeTool(inOwnDm, 'recall', { place: 'slack:D_Q' }, deps)).toMatchObject({
      answer: expect.stringContaining('Ask me in a DM.')
    })
    await expect(executeTool(inOwnDm, 'getChannelHistory', { channel: 'D_Q' }, deps)).rejects.toThrow(/Ask me in a DM/)
  })

  it('opens the cross-place read tools to a member, past the reach gate, and refuses them otherwise', async () => {
    const reads: [string, Record<string, unknown>][] = [
      ['getChannelHistory', { channel: 'C_PRIV' }],
      ['getThreadHistory', { channel: 'C_PRIV', thread: '1.1' }],
      ['getReactions', { channel: 'G_MPIM', messageTs: '1.1' }],
      ['listBookmarks', { channel: 'C_PRIV' }]
    ]
    const member = perAsker()
    for (const [tool, args] of reads) await executeTool(inOwnDm, tool, args, member.deps)
    expect(member.gw.getChannelHistory).toHaveBeenCalledWith('C_PRIV', {})
    expect(member.gw.getThreadReplies).toHaveBeenCalledWith('C_PRIV', '1.1', expect.any(Number), expect.anything())
    expect(member.gw.getReactions).toHaveBeenCalledWith('G_MPIM', '1.1')
    expect(member.gw.listBookmarks).toHaveBeenCalledWith('C_PRIV')

    const outsider = perAsker({ members: { C_PRIV: ['U_ALICE'], G_MPIM: ['U_BOB'] } })
    for (const [tool, args] of reads) {
      await expect(executeTool(inOwnDm, tool, args, outsider.deps), tool).rejects.toThrow("I can't share that here.")
    }
    expect(outsider.gw.getChannelHistory).not.toHaveBeenCalled()
    expect(outsider.gw.getThreadReplies).not.toHaveBeenCalled()
    expect(outsider.gw.getReactions).not.toHaveBeenCalled()
    expect(outsider.gw.listBookmarks).not.toHaveBeenCalled()
  })

  it('changes nothing for an agent outside assistant mode', async () => {
    const { deps, placeMember } = perAsker()
    const plain = { ...deps, assistantModeFor: () => false }
    // The platform's own reach gate still refuses a private channel from another conversation.
    await expect(executeTool(inOwnDm, 'getChannelHistory', { channel: 'C_PRIV' }, plain)).rejects.toThrow(
      /private Slack conversation/
    )
    await expect(executeTool(inOwnDm, 'recall', {}, plain)).rejects.toThrow(/only to an agent in assistant mode/)
    expect(placeMember).not.toHaveBeenCalled()
  })
})

describe("only the asker's own turn widens", () => {
  const notTheAsker: [string, NormalizedMessage | undefined, SessionContext?][] = [
    [
      'a report round',
      { ...fromP, source: 'agent', sender: { id: 'peer', isBot: true }, isDm: false, parentReport: true }
    ],
    ['a scheduled run', { ...fromP, source: 'cron' }],
    ['a background-task wake', { ...fromP, source: 'agent', sender: { id: 'background-task:1', isBot: true } }],
    ['a console continuation', { ...fromP, adoptedSession: true }],
    ['a headless turn', { ...fromP, headless: true }],
    ['someone other than the counterpart', { ...fromP, sender: { id: 'U_Q', isBot: false } }],
    ['no live turn', undefined],
    ['a sub-session', fromP, { ...inOwnDm, thread: 'subsession:d-1' }],
    [
      'a patrol',
      fromP,
      {
        ...inOwnDm,
        thread: 'subsession:patrol-d-2',
        tools: [{ name: 'recall' }, { name: 'getChannelHistory' }] as SessionContext['tools']
      }
    ]
  ]

  it.each(notTheAsker)('gives %s in the DM the P0a rule', async (_label, msg, ctx = inOwnDm) => {
    const { deps, live, placeMember } = perAsker()
    live.msg = msg
    expect(await executeTool(ctx, 'recall', { place: 'slack:C_PRIV' }, deps)).toEqual(opaque('slack:C_PRIV'))
    await expect(executeTool(ctx, 'getChannelHistory', { channel: 'C_PRIV' }, deps)).rejects.toThrow(
      "I can't share that here."
    )
    expect(placeMember).not.toHaveBeenCalled()
  })
})

describe('a session marked by a widened read writes only to the DM', () => {
  const barred: [string, Record<string, unknown>][] = [
    ['takeItem', { title: 'Ship it', doneWhen: 'shipped' }],
    ['updateItem', { itemId: 'i-1', version: 1, summary: 'x' }],
    ['followItem', { itemId: 'i-1' }],
    ['sendMessage', { toAgent: AGENT, message: 'look into it' }],
    ['sendMessage', { toAgent: { agentId: AGENT, needsReply: true }, message: 'look into it' }],
    ['sendMessage', { toAgent: 'peer-1', message: 'hi' }],
    ['sendMessage', { toAgent: 'peer-1', channel: 'C_DEPLOY', message: 'hi' }],
    ['sendMessage', { sessionId: 'parent-1', message: 'done' }],
    ['sendMessage', { channel: 'C_DEPLOY', message: 'for the team' }],
    ['sendMessage', { toUser: 'U_Q', message: 'psst' }],
    ['addReaction', { channel: 'C_DEPLOY', messageTs: '1.1', emoji: 'eyes' }]
  ]

  async function expectBarred(ctx: SessionContext, deps: OpsDeps): Promise<void> {
    for (const [tool, args] of barred) {
      await expect(executeTool(ctx, tool, args, deps), `${tool} ${JSON.stringify(args)}`).rejects.toThrow(/`!new`/)
    }
    expect(deps.messageAgent).not.toHaveBeenCalled()
    expect(deps.replyToSession).not.toHaveBeenCalled()
    expect(deps.assistantDraftPost).not.toHaveBeenCalled()
  }

  it('refuses ledger writes, every agent-to-agent send and posts elsewhere on every later turn', async () => {
    const { deps, gw, live } = perAsker()
    expect(await excerptsOf(inOwnDm, 'slack:C_PRIV', deps)).toEqual(['secret merger talk'])
    // A later turn of P's, and a report round in the same session.
    live.msg = { ...fromP, msgId: 'm-2' }
    await expectBarred(inOwnDm, deps)
    live.msg = { ...fromP, source: 'agent', sender: { id: 'peer', isBot: true }, isDm: false, parentReport: true }
    await expectBarred(inOwnDm, deps)
    // The DM itself stays writable, and reads go on under the rule.
    await executeTool(inOwnDm, 'sendMessage', { channel: 'D_P', message: 'here' }, deps)
    expect(gw.postMessage).toHaveBeenCalledTimes(1)
    expect(await excerptsOf(inOwnDm, 'slack:C_DEPLOY', deps)).toContain('Noted: payments deploy Friday')
  })

  it('leaves the session unmarked on a listing, which shows no private place', async () => {
    const { deps, marks } = perAsker()
    expect(await listedPlaces(inOwnDm, deps)).not.toContain('slack:C_PRIV')
    await executeTool(inOwnDm, 'sendMessage', { toAgent: 'peer-1', message: 'hi' }, deps)
    expect(deps.messageAgent).toHaveBeenCalledTimes(1)
    expect(await marks.placeMarked(inOwnDm.agentId, 'slack', 'D_P')).toBe(false)
  })

  it('survives a restart, and a fresh coordinate (`!new`) lifts it', async () => {
    const path = tempStorePath('ac-widened-restart-')
    const first = await LocalStore.open(path)
    try {
      const { deps } = perAsker({ marks: first.assistantWidened })
      expect(await excerptsOf(inOwnDm, 'slack:C_PRIV', deps)).toEqual(['secret merger talk'])
    } finally {
      await first.close()
    }
    const reopened = await LocalStore.open(path)
    try {
      const { deps, live } = perAsker({ marks: reopened.assistantWidened })
      live.msg = { ...fromP, msgId: 'm-3' }
      await expectBarred(inOwnDm, deps)
      const fresh = { ...inOwnDm, thread: 'append:2' }
      await expect(executeTool(fresh, 'takeItem', { title: 'x', doneWhen: 'y' }, deps)).rejects.toThrow(
        /available only to an agent in assistant mode/
      )
      await executeTool(fresh, 'sendMessage', { toAgent: 'peer-1', message: 'hi' }, deps)
      await executeTool(fresh, 'sendMessage', { sessionId: 'parent-1', message: 'done' }, deps)
      await executeTool(fresh, 'sendMessage', { channel: 'C_DEPLOY', message: 'for the team' }, deps)
      expect(deps.messageAgent).toHaveBeenCalledTimes(1)
      expect(deps.replyToSession).toHaveBeenCalledTimes(1)
      expect(deps.assistantDraftPost).toHaveBeenCalledTimes(1)
    } finally {
      await reopened.close()
    }
  })

  it('leaves a session that never made a widened read unchanged', async () => {
    const { deps } = perAsker()
    expect(await excerptsOf(inOwnDm, 'slack:C_DEPLOY', deps)).toContain('Noted: payments deploy Friday')
    await expect(executeTool(inOwnDm, 'takeItem', { title: 'x', doneWhen: 'y' }, deps)).rejects.toThrow(
      /available only to an agent in assistant mode/
    )
    await executeTool(inOwnDm, 'sendMessage', { toAgent: AGENT, message: 'look into it' }, deps)
    await executeTool(inOwnDm, 'sendMessage', { toAgent: 'peer-1', channel: 'C_DEPLOY', message: 'hi' }, deps)
    await executeTool(inOwnDm, 'sendMessage', { sessionId: 'parent-1', message: 'done' }, deps)
    await executeTool(inOwnDm, 'sendMessage', { channel: 'C_DEPLOY', message: 'for the team' }, deps)
    expect(deps.messageAgent).toHaveBeenCalledTimes(2)
    expect(deps.replyToSession).toHaveBeenCalledTimes(1)
    expect(deps.assistantDraftPost).toHaveBeenCalledTimes(1)
  })

  it('leaves an agent outside assistant mode unchanged, whatever its session carries', async () => {
    const { deps } = perAsker()
    expect(await excerptsOf(inOwnDm, 'slack:C_PRIV', deps)).toEqual(['secret merger talk'])
    const marked = vi.fn(async () => true)
    const plain: OpsDeps = {
      ...deps,
      assistantModeFor: () => false,
      widenedSession: { mark: async () => true, marked, placeMarked: marked }
    }
    await executeTool(inOwnDm, 'sendMessage', { toAgent: 'peer-1', message: 'hi' }, plain)
    await executeTool(inOwnDm, 'sendMessage', { sessionId: 'parent-1', message: 'done' }, plain)
    await executeTool(inOwnDm, 'sendMessage', { channel: 'C_DEPLOY', message: 'hi' }, plain)
    expect(deps.messageAgent).toHaveBeenCalledTimes(1)
    expect(deps.replyToSession).toHaveBeenCalledTimes(1)
    expect(marked).not.toHaveBeenCalled()
  })
})

// A widened answer stays in the DM's history after `!new`, so reading that history back takes the mark on again.
describe("reading the DM's history back carries its mark", () => {
  const sendsToAnAgent = (ctx: SessionContext, deps: OpsDeps) =>
    executeTool(ctx, 'sendMessage', { toAgent: 'peer-1', message: 'what the DM said' }, deps)

  async function expectMarked(ctx: SessionContext, deps: OpsDeps): Promise<void> {
    await expect(sendsToAnAgent(ctx, deps), ctx.thread).rejects.toThrow(/`!new`/)
    await expect(executeTool(ctx, 'takeItem', { title: 'x', doneWhen: 'y' }, deps), ctx.thread).rejects.toThrow(
      /`!new`/
    )
  }

  async function widened() {
    const setup = perAsker()
    expect(await excerptsOf(inOwnDm, 'slack:C_PRIV', setup.deps)).toEqual(['secret merger talk'])
    return setup
  }

  it('marks a fresh session that recalls the DM after `!new`', async () => {
    const { deps } = await widened()
    const fresh = { ...inOwnDm, thread: 'append:2' }
    await sendsToAnAgent(fresh, deps)
    expect(deps.messageAgent).toHaveBeenCalledTimes(1)
    await executeTool(fresh, 'recall', { place: 'slack:D_P' }, deps)
    await expectMarked(fresh, deps)
    expect(deps.messageAgent).toHaveBeenCalledTimes(1)
  })

  it("marks a fresh session that reads the DM's history or a thread in it", async () => {
    const { deps, gw } = await widened()
    const reads: [string, Record<string, unknown>][] = [
      ['getChannelHistory', {}],
      ['getChannelHistory', { channel: 'D_P' }],
      ['getThreadHistory', { thread: '1.1' }],
      ['getThreadHistory', { channel: 'D_P', thread: '1.1' }]
    ]
    for (const [i, [tool, args]] of reads.entries()) {
      const fresh = { ...inOwnDm, thread: `append:${i + 2}` }
      await executeTool(fresh, tool, args, deps)
      await expectMarked(fresh, deps)
    }
    expect(gw.getChannelHistory).toHaveBeenCalledTimes(2)
    expect(gw.getThreadReplies).toHaveBeenCalledTimes(2)
  })

  it('leaves a fresh session that does not read the history back unmarked', async () => {
    const { deps } = await widened()
    const fresh = { ...inOwnDm, thread: 'append:2' }
    expect(await excerptsOf(fresh, 'slack:C_DEPLOY', deps)).toContain('Noted: payments deploy Friday')
    await sendsToAnAgent(fresh, deps)
    await executeTool(fresh, 'sendMessage', { channel: 'C_DEPLOY', message: 'for the team' }, deps)
    await expect(executeTool(fresh, 'takeItem', { title: 'x', doneWhen: 'y' }, deps)).rejects.toThrow(
      /available only to an agent in assistant mode/
    )
    expect(deps.messageAgent).toHaveBeenCalledTimes(1)
    expect(deps.assistantDraftPost).toHaveBeenCalledTimes(1)
  })

  it("marks a sub-session of the DM that reads the DM's history", async () => {
    const { deps } = await widened()
    const sub = { ...inOwnDm, thread: 'subsession:d-1' }
    await executeTool(sub, 'getChannelHistory', {}, deps)
    await expectMarked(sub, deps)
  })

  it('marks a cleared context again when it reads the DM back', async () => {
    const path = tempStorePath('ac-widened-readback-')
    const store = await LocalStore.open(path)
    try {
      const ctx = { ...inOwnDm, thread: 'T1' }
      await store.upsertSession({
        key: keyOf(ctx),
        agentId: AGENT,
        platform: 'slack',
        channel: 'D_P',
        thread: 'T1',
        transportScope: 'scope-slack',
        acpSessionId: 'acp-1',
        state: 'idle',
        lastDeliveredTs: null,
        updatedAt: 1
      })
      const { deps } = perAsker({ marks: store.assistantWidened })
      expect(await excerptsOf(ctx, 'slack:C_PRIV', deps)).toEqual(['secret merger talk'])
      // `!new` on a session that keeps its key clears its context and lifts the mark.
      expect(await store.clearSessionContext(keyOf(ctx), '200.0', 2, 'acp-1')).toBe(true)
      await sendsToAnAgent(ctx, deps)
      expect(deps.messageAgent).toHaveBeenCalledTimes(1)
      await executeTool(ctx, 'getChannelHistory', {}, deps)
      await expectMarked(ctx, deps)
    } finally {
      await store.close()
    }
  })

  it('changes nothing for same-place reads where no session was marked', async () => {
    const { deps, gw, marks } = perAsker()
    await executeTool(inOwnDm, 'recall', { place: 'slack:D_P' }, deps)
    await executeTool(inOwnDm, 'getChannelHistory', {}, deps)
    await executeTool(inOwnDm, 'getThreadHistory', { thread: '1.1' }, deps)
    expect(gw.getChannelHistory).toHaveBeenCalledTimes(1)
    expect(await marks.placeMarked(AGENT, 'slack', 'D_P')).toBe(false)
    await sendsToAnAgent(inOwnDm, deps)
    expect(deps.messageAgent).toHaveBeenCalledTimes(1)
  })

  it('refuses a same-place read when the mark cannot be checked or taken on', async () => {
    const { deps, gw } = perAsker()
    const unreadable = {
      ...deps,
      widenedSession: { ...unmarkedSession, placeMarked: async () => Promise.reject(new Error('db')) }
    }
    const unwritable = {
      ...deps,
      widenedSession: { ...unmarkedSession, placeMarked: async () => true, mark: async () => false }
    }
    for (const failing of [unreadable, unwritable]) {
      await expect(executeTool(inOwnDm, 'getChannelHistory', {}, failing)).rejects.toThrow(
        /could not be read right now/
      )
      await expect(executeTool(inOwnDm, 'recall', { place: 'slack:D_P' }, failing)).rejects.toThrow(
        /could not be read right now/
      )
    }
    expect(gw.getChannelHistory).not.toHaveBeenCalled()
  })

  it('changes nothing for an agent outside assistant mode', async () => {
    const { deps, gw } = await widened()
    const placeMarked = vi.fn(async () => true)
    const plain: OpsDeps = {
      ...deps,
      assistantModeFor: () => false,
      widenedSession: { ...unmarkedSession, placeMarked }
    }
    const fresh = { ...inOwnDm, thread: 'append:2' }
    await executeTool(fresh, 'getChannelHistory', {}, plain)
    await sendsToAnAgent(fresh, plain)
    expect(gw.getChannelHistory).toHaveBeenCalledTimes(1)
    expect(deps.messageAgent).toHaveBeenCalledTimes(1)
    expect(placeMarked).not.toHaveBeenCalled()
  })
})
