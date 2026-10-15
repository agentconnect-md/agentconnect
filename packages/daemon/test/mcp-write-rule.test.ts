import { afterEach, describe, expect, it, vi } from 'vitest'
import { NOBODY, type ConsoleVerdict, type ReadAsker, type TurnAskers } from '../src/assistant/place-access.js'
import { PlaceMembers, turnAskers, type TurnMessage } from '../src/assistant/place-members.js'
import type { PostInterception } from '../src/assistant/drafts.js'
import { executeTool, type MessageGateway, type OpsDeps, type SessionContext } from '../src/mcp/ops.js'
import { FOLLOW_UP_TOOL } from '../src/mcp/ops/assistant-items.js'
import type { PlaceSnapshotRow, PlaceStore } from '../src/mcp/ops/place-gate.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import type { PlatformDocumentReach } from '../src/platforms/contract.js'
import { SlackConnection } from '../src/slack/connection.js'
import type { LocalStore, SessionRecord } from '../src/store/local-store.js'
import { openTestStore } from './store-support.js'

const AGENT = 'agent-a'
/** A private channel the bot was invited to, where the agent has no session yet. */
const ROOM = 'C0EXAMPLE1'
const P = 'U_P'
const GUEST = 'U_GUEST'
const NOT_POSTED = "I can't post there from here."

const integrations = [
  { id: 'int-slack', platform: 'slack' },
  { id: 'int-tg', platform: 'telegram' },
  { id: 'int-feishu', platform: 'feishu' },
  { id: 'int-discord', platform: 'discord' }
]

function session(
  key: string,
  platform: string,
  channel: string,
  kind: SessionRecord['conversationKind']
): SessionRecord {
  return {
    key,
    agentId: AGENT,
    platform,
    channel,
    thread: `append:${key}`,
    transportScope: `scope-${platform}`,
    acpSessionId: `acp-${key}`,
    sessionId: `out-${key}`,
    state: 'idle',
    lastDeliveredTs: null,
    updatedAt: 0,
    conversationKind: kind
  }
}

const SESSIONS = [
  session('s-deploy', 'slack', 'C_DEPLOY', 'channel'),
  session('s-priv', 'slack', 'C_PRIV', 'channel'),
  session('s-shared', 'slack', 'C_SHARED', 'channel'),
  session('s-mpim', 'slack', 'G_MPIM', 'group_dm'),
  session('s-dm-p', 'slack', 'D_P', 'dm'),
  session('s-dm-q', 'slack', 'D_Q', 'dm'),
  session('s-tg', 'telegram', '-1001', 'channel')
]

const placeStore: PlaceStore = {
  listSessions: async () => SESSIONS,
  latestSession: async (_agent, channel) => SESSIONS.find((s) => s.channel === channel),
  transcriptPageForAgent: async () => ({ rows: [], hasMore: false }),
  getDisplayNames: async () => new Map()
}

const SNAPSHOT: Record<string, PlaceSnapshotRow> = {
  C_DEPLOY: { isPrivate: false },
  C_SHARED: { isPrivate: false },
  C_PRIV: { isPrivate: true },
  G_MPIM: { kind: 'mpim' },
  D_P: { kind: 'im' },
  D_Q: { kind: 'im' }
}

function slackGateway(members: Record<string, string[]>, fullMembers: string[], documents: Record<string, unknown>) {
  const gw = {
    postMessage: vi.fn(async () => 'ts-1'),
    openDirectMessage: vi.fn(async (user: string) => `D_${user}`),
    getChannelInfo: vi.fn(async (id: string) => ({
      id,
      ...(id.startsWith('D') ? { isIm: true } : {}),
      ...(id.startsWith('G') ? { isMpim: true } : {}),
      // Every Feishu group here is private.
      isPrivate: id === 'C_PRIV' || id === ROOM || id.startsWith('oc_') || id.startsWith('D') || id.startsWith('G')
    })),
    listMembers: vi.fn(async () => []),
    listMemberIds: vi.fn(async (channel: string) => members[channel] ?? []),
    isFullMember: vi.fn(async (user: string) => fullMembers.includes(user)),
    listChannels: vi.fn(async () => []),
    getUserProfile: vi.fn(async (u: string) => ({ id: u })),
    downloadFile: vi.fn(async () => null),
    getChannelHistory: vi.fn(async () => ({ messages: [], hasMore: false })),
    getThreadReplies: vi.fn(async (_c: string, thread: string) => [
      { ts: thread, sender: 'U1', text: 'root', isBot: false, chrome: false, attachments: [] }
    ]),
    scheduleMessage: vi.fn(async (channel: string, _text: string, postAt: number) => ({ id: 'q1', channel, postAt })),
    addReaction: vi.fn(async () => {}),
    deleteMessage: vi.fn(async () => true),
    addBookmark: vi.fn(async (_c: string, spec: { title: string }) => ({ id: 'b1', title: spec.title })),
    removeBookmark: vi.fn(async () => {}),
    createConversation: vi.fn(async () => ({ id: 'C_NEW' })),
    createCanvas: vi.fn(async () => ({ id: 'F_NEW', title: 't' })),
    updateCanvas: vi.fn(async () => {}),
    addListItem: vi.fn(async () => ({ id: 'row-1', fields: {} })),
    documentReach: vi.fn(async (id: string) => {
      const reach = documents[id]
      if (!reach) throw new Error('file_not_found')
      return reach as PlatformDocumentReach
    })
  } satisfies MessageGateway
  return gw as typeof gw & Pick<MessageGateway, 'uploadFile' | 'resolveChannelName'>
}

function ctxAt(platform: string, channel: string, over: Partial<SessionContext> = {}): SessionContext {
  return {
    agentId: AGENT,
    platform,
    ...(platform === 'slack' ? { integrationId: 'int-slack', transportScope: 'scope-slack' } : {}),
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
const inShared = ctxAt('slack', 'C_SHARED')

/** A person's message on the agent's Slack bot. */
function said(userId: string, channel = 'D_P'): TurnMessage {
  const msg = {
    msgId: `m-${userId}`,
    traceId: 't',
    source: 'user',
    platform: 'slack',
    channel,
    sender: { id: userId, isBot: false },
    text: 'please',
    mentionedBots: [],
    isDm: channel.startsWith('D')
  } as NormalizedMessage
  return { msg, integrationId: 'int-slack' }
}

/** A console user's message: in the Playground or webchat, or a console continuation of a chat session. */
function typed(userId: string): TurnMessage {
  const msg = {
    msgId: `m-${userId}`,
    traceId: 't',
    source: 'user',
    platform: 'webchat',
    channel: 'chat-1',
    sender: { id: userId, isBot: false },
    text: 'please',
    mentionedBots: [],
    isDm: true
  } as NormalizedMessage
  return { msg, console: true }
}

const playground = ctxAt('webchat', 'chat-1')

/** The console user behind an asker: a console user, or the Slack member P, who linked a console account as user-p. */
const personOf = (asker: ReadAsker): string =>
  asker.kind === 'console' ? asker.userId : asker.platform === 'slack' && asker.userId === P ? 'user-p' : ''

// The console shows user-p the agent's session in C_PRIV and no other.
const consoleVerdict = (asker: ReadAsker, sessions: readonly string[]): ConsoleVerdict =>
  personOf(asker) === 'user-p'
    ? { asker: 'linked', visible: new Set(sessions.filter((id) => id === 'out-s-priv')) }
    : { asker: 'unidentifiable' }

const drafted = { handled: true as const, result: { drafted: true, draftId: 'd-1' } }

function harness(
  opts: {
    assistant?: boolean
    members?: Record<string, string[]>
    fullMembers?: string[]
    external?: string[]
    documents?: Record<string, PlatformDocumentReach>
    draft?: boolean
    /** The chat account each console user linked, by the bot whose workspace it is in; user-p linked P by default. */
    linked?: Record<string, Record<string, string>>
    /** The Control Plane cannot say which account a person linked. */
    linkUnknown?: boolean
    /** Feishu group members by union_id. */
    larkMembers?: Record<string, string[]>
  } = {}
) {
  const members = {
    C_PRIV: [P, 'U_ALICE'],
    G_MPIM: [P, 'U_BOB'],
    C_SHARED: [P, 'U_EXT'],
    D_P: [P, 'B_BOT'],
    D_Q: ['U_Q', 'B_BOT'],
    ...opts.members
  }
  const gw = slackGateway(members, opts.fullMembers ?? [P, 'U_ALICE', 'U_BOB', 'U_Q'], opts.documents ?? {})
  const tg = slackGateway({}, [], {})
  const lark = slackGateway(opts.larkMembers ?? { oc_group: ['on_p', 'on_alice'], oc_other: ['on_alice'] }, [], {})
  const discord = slackGateway({}, [], {})
  const bots: Record<string, typeof gw> = { 'int-slack': gw, 'int-tg': tg, 'int-feishu': lark, 'int-discord': discord }
  const placeMembers = new PlaceMembers({
    now: () => 0,
    gatewayFor: (id) => bots[id],
    readAccess: async (_agent, asker, sessions) => consoleVerdict(asker, sessions),
    linkedMember: async (_agent, integrationId, asker) => {
      if (opts.linkUnknown) throw new Error('linked identity unavailable')
      return (opts.linked ?? { 'int-slack': { 'user-p': P } })[integrationId]?.[personOf(asker)] ?? null
    }
  })
  let live: { messages?: TurnMessage[]; askers?: TurnAskers } = { messages: [said(P)] }
  const external = new Set(opts.external ?? ['C_SHARED'])
  const draftPost = vi.fn(async () => drafted as PostInterception)
  const deps: OpsDeps = {
    gatewayFor: (id) => bots[id],
    channelAgents: async () => ({ platform: 'slack', agents: [] }),
    messageAgent: vi.fn(async (req) => ({ delivered: true, targetSession: `stub:${req.toAgentId}` })),
    replyToSession: vi.fn(async () => ({ delivered: true, targetSession: 'stub', inReplyTo: 'msg-stub' })),
    memory: {} as OpsDeps['memory'],
    recordOutbound: async () => {},
    now: () => 1000,
    assistantModeFor: () => opts.assistant === true,
    placeIntegrationFor: (_agent, platform) => (platform === 'slack' ? 'int-slack' : 'int-tg'),
    placeSnapshot: (integrationId, channel) => (integrationId === 'int-slack' ? SNAPSHOT[channel] : undefined),
    placeStore,
    targetExternal: async (_agent, _integration, channel) => external.has(channel),
    ...(opts.draft === false ? {} : { draftPost }),
    readAskers: async (ctx) => live.askers ?? (live.messages ? turnAskers(live.messages, ctx.integrationId) : NOBODY),
    readLookups: (agentId) => placeMembers.lookupsFor(agentId)
  }
  return {
    deps,
    gw,
    lark,
    discord,
    draftPost,
    /** The live turn answers these messages, in order: the first is its own, the rest were folded in. */
    asks: (...messages: TurnMessage[]) => {
      live = { messages }
    },
    nobody: () => {
      live = { askers: NOBODY }
    }
  }
}

const later = () => new Date(Date.now() + 3_600_000).toISOString()

describe('every agent posts wherever the people asking could post', () => {
  for (const assistant of [false, true]) {
    const mode = assistant ? 'in assistant mode' : 'outside assistant mode'

    it(`posts into a private channel the asker is in, and refuses a non-member opaquely (${mode})`, async () => {
      const member = harness({ assistant })
      await executeTool(
        inDmOfP,
        'sendMessage',
        { action: 'postMessage', channel: 'C_PRIV', message: 'for the team' },
        member.deps
      )
      await executeTool(
        inDmOfP,
        'sendMessage',
        { action: 'postMessage', channel: 'G_MPIM', thread: '7.7', message: 'update' },
        member.deps
      )
      expect(member.gw.postMessage).toHaveBeenCalledWith('C_PRIV', 'for the team', undefined, expect.anything())
      expect(member.gw.postMessage).toHaveBeenCalledWith('G_MPIM', 'update', '7.7', expect.anything())
      expect(member.draftPost).not.toHaveBeenCalled()

      const outsider = harness({ assistant, members: { C_PRIV: ['U_ALICE'], G_MPIM: ['U_BOB'] } })
      await expect(
        executeTool(inDmOfP, 'sendMessage', { action: 'postMessage', channel: 'C_PRIV', message: 'hi' }, outsider.deps)
      ).rejects.toThrow(NOT_POSTED)
      await expect(
        executeTool(
          inDmOfP,
          'sendMessage',
          { action: 'postMessage', channel: 'G_MPIM', thread: '7.7', message: 'hi' },
          outsider.deps
        )
      ).rejects.toThrow(NOT_POSTED)
      // Refused before anything reads the target, so no error can tell a closed place from a missing one.
      expect(outsider.gw.getThreadReplies).not.toHaveBeenCalled()
      expect(outsider.gw.postMessage).not.toHaveBeenCalled()
      expect(outsider.draftPost).not.toHaveBeenCalled()
    })

    it(`opens a public channel to a full member and refuses a guest (${mode})`, async () => {
      const { deps, gw, asks } = harness({ assistant })
      await executeTool(
        inDmOfP,
        'sendMessage',
        { action: 'postMessage', channel: 'C_DEPLOY', message: 'shipped' },
        deps
      )
      expect(gw.postMessage).toHaveBeenCalledTimes(1)
      asks(said(GUEST, 'D_GUEST'))
      await expect(
        executeTool(
          ctxAt('slack', 'D_GUEST'),
          'sendMessage',
          { action: 'postMessage', channel: 'C_DEPLOY', message: 'hi' },
          deps
        )
      ).rejects.toThrow(NOT_POSTED)
      expect(gw.postMessage).toHaveBeenCalledTimes(1)
    })

    it(`sends a direct message to a full member of the organization only (${mode})`, async () => {
      const { deps, gw, draftPost } = harness({ assistant })
      await executeTool(inDmOfP, 'sendMessage', { action: 'postMessage', toUser: 'U_Q', message: 'psst' }, deps)
      expect(gw.postMessage).toHaveBeenCalledWith('D_U_Q', 'psst', undefined, expect.anything())
      for (const user of [GUEST, 'U_OUTSIDE']) {
        await expect(
          executeTool(inDmOfP, 'sendMessage', { action: 'postMessage', toUser: user, message: 'hi' }, deps)
        ).rejects.toThrow(/a direct message goes only to a member of your organization/)
      }
      expect(gw.postMessage).toHaveBeenCalledTimes(1)
      expect(draftPost).not.toHaveBeenCalled()
    })

    it(`judges scheduleMessage, reactions, deletion and bookmarks by the same rule (${mode})`, async () => {
      const writes: [string, Record<string, unknown>][] = [
        ['scheduleMessage', { channel: 'C_PRIV', message: 'later', postAt: later() }],
        ['addReaction', { channel: 'C_PRIV', messageTs: '1.1', emoji: 'eyes' }],
        ['deleteMessage', { channel: 'C_PRIV', messageTs: '1.1' }],
        ['addBookmark', { channel: 'C_PRIV', title: 'Runbook', link: 'https://docs.example.test/runbook' }],
        ['removeBookmark', { channel: 'C_PRIV', bookmarkId: 'b1' }]
      ]
      const outsider = harness({ assistant, members: { C_PRIV: ['U_ALICE'] } })
      for (const [tool, args] of writes) {
        await expect(executeTool(inDmOfP, tool, args, outsider.deps), tool).rejects.toThrow(NOT_POSTED)
      }
      expect(outsider.gw.scheduleMessage).not.toHaveBeenCalled()
      expect(outsider.gw.addReaction).not.toHaveBeenCalled()
      expect(outsider.gw.deleteMessage).not.toHaveBeenCalled()
      expect(outsider.gw.addBookmark).not.toHaveBeenCalled()
      expect(outsider.gw.removeBookmark).not.toHaveBeenCalled()

      const member = harness({ assistant })
      for (const [tool, args] of writes) await executeTool(inDmOfP, tool, args, member.deps)
      expect(member.gw.scheduleMessage).toHaveBeenCalledWith('C_PRIV', 'later', expect.any(Number))
      expect(member.gw.addReaction).toHaveBeenCalledWith('C_PRIV', '1.1', 'eyes')
      expect(member.gw.deleteMessage).toHaveBeenCalledWith('C_PRIV', '1.1')
      expect(member.gw.addBookmark).toHaveBeenCalledTimes(1)
      expect(member.gw.removeBookmark).toHaveBeenCalledWith('C_PRIV', 'b1')
    })

    it(`refuses a write when one of the senders folded into the turn lacks access (${mode})`, async () => {
      const { deps, gw, asks } = harness({ assistant })
      const shared = ctxAt('slack', 'C_DEPLOY')
      asks(said(P, 'C_DEPLOY'), said('U_ALICE', 'C_DEPLOY'))
      await executeTool(
        shared,
        'sendMessage',
        { action: 'postMessage', channel: 'C_PRIV', message: 'both of us are in' },
        deps
      )
      asks(said(P, 'C_DEPLOY'), said('U_BOB', 'C_DEPLOY'))
      await expect(
        executeTool(
          shared,
          'sendMessage',
          { action: 'postMessage', channel: 'C_PRIV', message: 'one of us is not' },
          deps
        )
      ).rejects.toThrow(NOT_POSTED)
      await expect(
        executeTool(shared, 'addReaction', { channel: 'C_PRIV', messageTs: '1.1', emoji: 'eyes' }, deps)
      ).rejects.toThrow(NOT_POSTED)
      expect(gw.postMessage).toHaveBeenCalledTimes(1)
      expect(gw.addReaction).not.toHaveBeenCalled()
    })

    it(`creates a conversation only with members of the organization, for a full member (${mode})`, async () => {
      const { deps, gw, asks } = harness({ assistant })
      await executeTool(inDmOfP, 'createConversation', { users: ['U_Q', 'U_ALICE'] }, deps)
      await executeTool(inDmOfP, 'createConversation', { name: 'launch', isPrivate: true, users: ['U_Q'] }, deps)
      await expect(executeTool(inDmOfP, 'createConversation', { users: ['U_Q', GUEST] }, deps)).rejects.toThrow(
        /opened only with members of your organization/
      )
      asks(said(GUEST, 'D_GUEST'))
      await expect(
        executeTool(ctxAt('slack', 'D_GUEST'), 'createConversation', { name: 'guest-room' }, deps)
      ).rejects.toThrow(/full members of this workspace/)
      expect(gw.createConversation).toHaveBeenCalledTimes(2)
    })

    it(`writes a canvas or a list for every conversation it is in (${mode})`, async () => {
      const documents: Record<string, PlatformDocumentReach> = {
        F_PRIV: { conversations: ['C_PRIV'], workspace: false, complete: true },
        F_HERE: { conversations: ['D_P'], workspace: false, complete: true },
        F_PARTIAL: { conversations: ['D_P'], workspace: false, complete: false }
      }
      const edits = [{ operation: 'replace', markdown: '# plan' }]
      const fields = [{ columnId: 'c1', type: 'rich_text', value: [] }]
      const member = harness({ assistant, documents })
      await executeTool(inDmOfP, 'updateCanvas', { canvasId: 'F_PRIV', edits }, member.deps)
      await executeTool(inDmOfP, 'addListItem', { listId: 'F_HERE', fields }, member.deps)
      await executeTool(inDmOfP, 'createCanvas', { title: 'Plan', markdown: '# plan', channel: 'C_PRIV' }, member.deps)
      expect(member.gw.updateCanvas).toHaveBeenCalledTimes(1)
      expect(member.gw.addListItem).toHaveBeenCalledTimes(1)
      expect(member.gw.createCanvas).toHaveBeenCalledTimes(1)

      const outsider = harness({ assistant, documents, members: { C_PRIV: ['U_ALICE'] } })
      await expect(executeTool(inDmOfP, 'updateCanvas', { canvasId: 'F_PRIV', edits }, outsider.deps)).rejects.toThrow(
        NOT_POSTED
      )
      await expect(
        executeTool(inDmOfP, 'createCanvas', { title: 'Plan', markdown: '# x', channel: 'C_PRIV' }, outsider.deps)
      ).rejects.toThrow(NOT_POSTED)
      for (const canvasId of ['F_PARTIAL', 'F_MISSING']) {
        await expect(
          executeTool(inDmOfP, 'updateCanvas', { canvasId, edits }, outsider.deps),
          canvasId
        ).rejects.toThrow(/could not be confirmed/)
      }
      expect(outsider.gw.updateCanvas).not.toHaveBeenCalled()
      expect(outsider.gw.createCanvas).not.toHaveBeenCalled()
    })

    it(`leaves the agent-to-agent forms and the parent-session reply alone (${mode})`, async () => {
      const { deps, draftPost } = harness({ assistant })
      await executeTool(inDmOfP, 'sendMessage', { action: 'callAgent', toAgent: 'peer-1', message: 'hi' }, deps)
      await executeTool(
        inDmOfP,
        'sendMessage',
        { action: 'replyToSession', messageId: 'msg-parent-1', message: 'done' },
        deps
      )
      expect(deps.messageAgent).toHaveBeenCalledTimes(1)
      expect(deps.replyToSession).toHaveBeenCalledTimes(1)
      expect(draftPost).not.toHaveBeenCalled()
    })
  }
})

describe('a conversation shared with another organization', () => {
  for (const assistant of [false, true]) {
    const mode = assistant ? 'in assistant mode' : 'outside assistant mode'

    it(`drafts a post into it from elsewhere for approval and refuses any other write there (${mode})`, async () => {
      const { deps, gw, draftPost } = harness({ assistant })
      expect(
        await executeTool(
          inDmOfP,
          'sendMessage',
          { action: 'postMessage', channel: 'C_SHARED', message: 'hello' },
          deps
        )
      ).toEqual(drafted.result)
      expect(draftPost.mock.calls.map((call) => (call as unknown[])[1])).toEqual([
        { platform: 'slack', integrationId: 'int-slack', channel: 'C_SHARED', text: 'hello', directMessage: false }
      ])
      await expect(
        executeTool(inDmOfP, 'addReaction', { channel: 'C_SHARED', messageTs: '1.1', emoji: 'eyes' }, deps)
      ).rejects.toThrow(/shared with another organization/)
      expect(gw.postMessage).not.toHaveBeenCalled()
      expect(gw.addReaction).not.toHaveBeenCalled()
    })

    it(`refuses the post where no draft can be made, and a file in any case (${mode})`, async () => {
      const undraftable = harness({ assistant, draft: false })
      await expect(
        executeTool(
          inDmOfP,
          'sendMessage',
          { action: 'postMessage', channel: 'C_SHARED', message: 'hello' },
          undraftable.deps
        )
      ).rejects.toThrow(/shared with another organization/)
      const withFile = harness({ assistant })
      withFile.gw.uploadFile = vi.fn(async () => ({ ok: true as const }))
      const deps = {
        ...withFile.deps,
        resolveAttachment: vi.fn(async () => ({ bytes: Buffer.from('x'), name: 'a.png', mimeType: 'image/png' }))
      }
      await expect(
        executeTool(
          inDmOfP,
          'sendMessage',
          { action: 'postMessage', channel: 'C_SHARED', attachment: 'a.png', message: 'see' },
          deps
        )
      ).rejects.toThrow(/a file cannot be sent for approval/)
      expect(withFile.gw.uploadFile).not.toHaveBeenCalled()
      expect(undraftable.gw.postMessage).not.toHaveBeenCalled()
    })
  }

  for (const assistant of [false, true]) {
    const mode = assistant ? 'in assistant mode' : 'outside assistant mode'

    it(`takes every write inside it as the current conversation, with nothing drafted (${mode})`, async () => {
      const { deps, gw, asks, draftPost } = harness({ assistant })
      asks(said(P, 'C_SHARED'))
      await executeTool(inShared, 'sendMessage', { action: 'postMessage', channel: 'C_SHARED', message: 'hi' }, deps)
      await executeTool(inShared, 'addReaction', { messageTs: '1.1', emoji: 'eyes' }, deps)
      await executeTool(inShared, 'scheduleMessage', { message: 'later', postAt: later() }, deps)
      expect(gw.postMessage).toHaveBeenCalledWith('C_SHARED', 'hi', undefined, expect.anything())
      expect(gw.addReaction).toHaveBeenCalledWith('C_SHARED', '1.1', 'eyes')
      expect(gw.scheduleMessage).toHaveBeenCalledWith('C_SHARED', 'later', expect.any(Number))
      // A file reaches its own handler, which this harness does not serve; the write rule no longer refuses it.
      const shared = await executeTool(inShared, 'shareFile', { path: 'chart.png' }, deps).catch((err: Error) => err)
      expect(String(shared)).not.toMatch(/another organization/)
      expect(draftPost).not.toHaveBeenCalled()
    })
  }
})

describe('a turn no person is behind', () => {
  it('writes to its own conversation, which is an anchored hook or schedule target', async () => {
    for (const assistant of [false, true]) {
      const { deps, gw, nobody } = harness({ assistant })
      nobody()
      const anchored = ctxAt('slack', 'C_DEPLOY')
      await executeTool(
        anchored,
        'sendMessage',
        { action: 'postMessage', channel: 'C_DEPLOY', message: 'nightly report' },
        deps
      )
      await executeTool(anchored, 'scheduleMessage', { message: 'reminder', postAt: later() }, deps)
      expect(gw.postMessage).toHaveBeenCalledTimes(1)
      expect(gw.scheduleMessage).toHaveBeenCalledWith('C_DEPLOY', 'reminder', expect.any(Number))
    }
  })

  it('drafts a post anywhere else in assistant mode, and refuses every other write', async () => {
    const { deps, gw, draftPost, nobody } = harness({ assistant: true })
    nobody()
    expect(
      await executeTool(inDmOfP, 'sendMessage', { action: 'postMessage', channel: 'C_DEPLOY', message: 'status' }, deps)
    ).toEqual(drafted.result)
    await executeTool(inDmOfP, 'sendMessage', { action: 'postMessage', toUser: 'U_Q', message: 'status' }, deps)
    expect(draftPost).toHaveBeenCalledTimes(2)
    await expect(
      executeTool(inDmOfP, 'addReaction', { channel: 'C_DEPLOY', messageTs: '1.1', emoji: 'eyes' }, deps)
    ).rejects.toThrow(/no person started this run/)
    await expect(executeTool(inDmOfP, 'createConversation', { name: 'room' }, deps)).rejects.toThrow(
      /no person started this run/
    )
    expect(gw.postMessage).not.toHaveBeenCalled()
  })

  it('refuses a post anywhere else outside assistant mode', async () => {
    const { deps, gw, draftPost, nobody } = harness()
    nobody()
    for (const args of [
      { action: 'postMessage', channel: 'C_DEPLOY', message: 'status' },
      { action: 'postMessage', toUser: 'U_Q', message: 'status' }
    ]) {
      await expect(executeTool(inDmOfP, 'sendMessage', args, deps)).rejects.toThrow(/no person started this run/)
    }
    expect(gw.postMessage).not.toHaveBeenCalled()
    expect(draftPost).not.toHaveBeenCalled()
  })
})

describe('assistant mode no longer drafts an internal post or bars a 1:1 conversation that read a private place', () => {
  let store: LocalStore | undefined
  afterEach(async () => {
    await store?.close()
    store = undefined
  })

  it('posts to an internal conversation directly', async () => {
    const { deps, gw, draftPost } = harness({ assistant: true })
    await executeTool(inDmOfP, 'sendMessage', { action: 'postMessage', channel: 'C_DEPLOY', message: 'shipped' }, deps)
    await executeTool(inDmOfP, 'addReaction', { channel: 'C_DEPLOY', messageTs: '1.1', emoji: 'eyes' }, deps)
    expect(gw.postMessage).toHaveBeenCalledTimes(1)
    expect(gw.addReaction).toHaveBeenCalledTimes(1)
    expect(draftPost).not.toHaveBeenCalled()
  })

  it('lets a DM that read a private channel post elsewhere, take a follow-up and send to another agent', async () => {
    store = await openTestStore()
    const ledger = store.assistantItems
    const { deps: base, gw, draftPost } = harness({ assistant: true })
    const deps: OpsDeps = {
      ...base,
      assistantItems: {
        ledgerFor: () => ledger,
        askerFor: async () => `slack:T1:${P}`,
        take: async (ctx, input) =>
          await ledger.create({
            agentId: ctx.agentId,
            title: input.title,
            doneWhen: input.doneWhen,
            origin: { platform: ctx.platform, channel: ctx.channel, transportScope: ctx.transportScope ?? null },
            taskKey: 'slack:D_P:subsession:patrol-1:agent',
            asker: input.asker
          })
      }
    }
    await executeTool(inDmOfP, 'getChannelHistory', { channel: 'C_PRIV' }, deps)
    expect(gw.getChannelHistory).toHaveBeenCalledWith('C_PRIV', {})
    await executeTool(
      inDmOfP,
      'sendMessage',
      { action: 'postMessage', channel: 'C_DEPLOY', message: 'for the team' },
      deps
    )
    await executeTool(
      inDmOfP,
      'sendMessage',
      { action: 'postMessage', channel: 'C_PRIV', message: 'for leadership' },
      deps
    )
    const taken = (await executeTool(
      { ...inDmOfP, tools: [...inDmOfP.tools, FOLLOW_UP_TOOL] },
      'followUp',
      { title: 'Ship it', doneWhen: 'shipped' },
      deps
    )) as { taskId: string }
    await executeTool(inDmOfP, 'sendMessage', { action: 'callAgent', toAgent: 'peer-1', message: 'look into it' }, deps)
    await executeTool(inDmOfP, 'sendMessage', { action: 'delegateTask', message: 'work on it' }, deps)
    expect(gw.postMessage).toHaveBeenCalledTimes(2)
    expect(deps.messageAgent).toHaveBeenCalledTimes(2)
    expect(draftPost).not.toHaveBeenCalled()
    expect((await ledger.byTaskKey(AGENT, taken.taskId))?.title).toBe('Ship it')
  })
})

describe('a person the product can identify is judged as the chat account they linked in the target bot’s workspace', () => {
  const NOT_SHARED = "I can't share that here."
  const continued = ctxAt('slack', 'C_DEPLOY')
  const post = (channel: string, message = 'hello') => ({ action: 'postMessage', platform: 'slack', channel, message })

  it('posts from the Playground to a public channel the agent was never in, and a private channel they are in', async () => {
    const { deps, gw, asks } = harness()
    asks(typed('user-p'))
    await executeTool(playground, 'sendMessage', post('C_NEW'), deps)
    await executeTool(playground, 'sendMessage', post('C_PRIV', 'for the team'), deps)
    await executeTool(playground, 'sendMessage', post('D_P', 'note to self'), deps)
    expect(gw.postMessage).toHaveBeenCalledWith('C_NEW', 'hello', undefined, expect.anything())
    expect(gw.postMessage).toHaveBeenCalledWith('C_PRIV', 'for the team', undefined, expect.anything())
    expect(gw.postMessage).toHaveBeenCalledWith('D_P', 'note to self', undefined, expect.anything())
  })

  it("refuses a private channel they are not in and someone else's DM, though the console shows the session", async () => {
    const { deps, gw, asks } = harness({ members: { C_PRIV: ['U_ALICE'] } })
    asks(typed('user-p'))
    for (const channel of ['C_PRIV', 'D_Q']) {
      await expect(executeTool(playground, 'sendMessage', post(channel), deps), channel).rejects.toThrow(NOT_POSTED)
    }
    expect(gw.postMessage).not.toHaveBeenCalled()
  })

  it('reads and writes in a console continuation as that account', async () => {
    const { deps, gw, asks } = harness()
    asks(typed('user-p'))
    await executeTool(continued, 'getChannelHistory', { channel: 'C_NEW' }, deps)
    await executeTool(continued, 'getChannelHistory', { channel: 'C_PRIV' }, deps)
    await executeTool(continued, 'addReaction', { channel: 'C_NEW', messageTs: '1.1', emoji: 'eyes' }, deps)
    await executeTool(continued, 'createConversation', { name: 'launch' }, deps)
    expect(gw.getChannelHistory).toHaveBeenCalledTimes(2)
    expect(gw.addReaction).toHaveBeenCalledWith('C_NEW', '1.1', 'eyes')
    expect(gw.createConversation).toHaveBeenCalledTimes(1)
    await expect(executeTool(continued, 'getChannelHistory', { channel: 'D_Q' }, deps)).rejects.toThrow(NOT_SHARED)
  })

  it('falls back to what the console shows when they linked no account in that workspace', async () => {
    // Unlinked, or linked only in another workspace: the console shows them the agent's session in C_PRIV alone.
    const unlinked: Record<string, Record<string, string>>[] = [{}, { 'int-slack-other': { 'user-p': P } }]
    for (const linked of unlinked) {
      const { deps, gw, asks } = harness({ linked })
      asks(typed('user-p'))
      await executeTool(playground, 'sendMessage', post('C_PRIV', 'for the team'), deps)
      for (const channel of ['C_NEW', 'C_DEPLOY', 'D_P']) {
        await expect(executeTool(playground, 'sendMessage', post(channel), deps), channel).rejects.toThrow(NOT_POSTED)
      }
      await expect(executeTool(continued, 'getChannelHistory', { channel: 'C_NEW' }, deps)).rejects.toThrow(NOT_SHARED)
      await expect(executeTool(continued, 'createConversation', { name: 'launch' }, deps)).rejects.toThrow(
        /full members of this workspace/
      )
      expect(gw.postMessage).toHaveBeenCalledTimes(1)
    }
  })

  it('refuses when the Control Plane cannot say which account they linked', async () => {
    const { deps, gw, asks } = harness({ linkUnknown: true })
    asks(typed('user-p'))
    for (const channel of ['C_PRIV', 'C_NEW']) {
      await expect(executeTool(playground, 'sendMessage', post(channel), deps), channel).rejects.toThrow(NOT_POSTED)
    }
    await expect(executeTool(continued, 'getChannelHistory', { channel: 'C_PRIV' }, deps)).rejects.toThrow(NOT_SHARED)
    await expect(executeTool(continued, 'createConversation', { name: 'launch' }, deps)).rejects.toThrow(
      /full members of this workspace/
    )
    expect(gw.postMessage).not.toHaveBeenCalled()
    expect(gw.getChannelHistory).not.toHaveBeenCalled()
    expect(gw.createConversation).not.toHaveBeenCalled()
  })

  it('posts for a Slack member into a Feishu group the agent was never in, as the account they linked there', async () => {
    const { deps, lark } = harness({ linked: { 'int-feishu': { 'user-p': 'on_p' } } })
    const toLark = (channel: string) => ({ action: 'postMessage', platform: 'feishu', channel, message: 'hello' })
    await executeTool(inDmOfP, 'sendMessage', toLark('oc_group'), deps)
    expect(lark.postMessage).toHaveBeenCalledWith('oc_group', 'hello', undefined, expect.anything())
    await expect(executeTool(inDmOfP, 'sendMessage', toLark('oc_other'), deps)).rejects.toThrow(NOT_POSTED)
    expect(lark.postMessage).toHaveBeenCalledTimes(1)
  })

  it('falls back to the console for a target that cannot be linked, and refuses someone it cannot identify', async () => {
    const { deps, gw, discord, asks } = harness()
    // Discord accounts cannot be linked, and the agent has no session in that channel.
    await expect(
      executeTool(
        inDmOfP,
        'sendMessage',
        { action: 'postMessage', platform: 'discord', channel: 'dc-1', message: 'hi' },
        deps
      )
    ).rejects.toThrow(NOT_POSTED)
    expect(discord.postMessage).not.toHaveBeenCalled()
    // A Telegram member is no console user, so Slack takes nothing from them.
    const inTelegram = ctxAt('telegram', '-1001', { integrationId: 'int-tg', transportScope: 'scope-telegram' })
    const heard = said('42', '-1001')
    asks({ msg: { ...heard.msg, platform: 'telegram' }, integrationId: 'int-tg' })
    for (const channel of ['C_DEPLOY', 'C_NEW']) {
      await expect(executeTool(inTelegram, 'sendMessage', post(channel), deps), channel).rejects.toThrow(NOT_POSTED)
    }
    expect(gw.postMessage).not.toHaveBeenCalled()
  })
})

describe('a channel named by its name resolves among the channels the bot lists, then the same rules decide', () => {
  const NOT_SHARED = "I can't share that here."

  /** The harness with the Slack bot's own name lookup over its public channel and the private ROOM it was invited to. */
  function byName(opts: Parameters<typeof harness>[0] = {}) {
    const h = harness(opts)
    const list = vi.fn(async () => ({ channels: [{ id: 'C_DEPLOY', name: 'deploys' }] }))
    const conn = new SlackConnection(
      { group: { appToken: 'xapp-1', botToken: 'xoxb-a', integrations: [] }, onMessage: () => {} } as never,
      () =>
        ({
          message() {},
          event() {},
          action() {},
          shortcut() {},
          view() {},
          client: {
            conversations: { list },
            users: { conversations: async () => ({ channels: [{ id: ROOM, name: 'project-room', is_private: true }] }) }
          },
          start: async () => {},
          stop: async () => {}
        }) as never
    )
    h.gw.resolveChannelName = (channel) => conn.resolveChannelName(channel)
    // Slack knows a conversation by its id alone; a name it is handed is `channel_not_found`.
    const info = h.gw.getChannelInfo.getMockImplementation()!
    h.gw.getChannelInfo.mockImplementation(async (id: string) => {
      if (!/^[A-Z]/.test(id))
        throw Object.assign(new Error('channel_not_found'), { data: { error: 'channel_not_found' } })
      return await info(id)
    })
    return { ...h, list }
  }

  const refusal = (call: Promise<unknown>) =>
    call.then(
      () => 'allowed',
      (err: Error) => err.message
    )

  it('reads and posts in a private channel the bot is in, with no session there, for a member', async () => {
    for (const channel of ['project-room', '#project-room']) {
      const { deps, gw } = byName({ members: { [ROOM]: [P, 'U_ALICE'] } })
      const read = (await executeTool(inDmOfP, 'getChannelHistory', { channel }, deps)) as Record<string, unknown>
      expect(gw.getChannelHistory).toHaveBeenCalledWith(ROOM, {})
      expect(read).toMatchObject({ channel: ROOM, privateSource: expect.stringContaining('private channel') })
      await executeTool(inDmOfP, 'getThreadHistory', { channel, thread: '7.7' }, deps)
      expect(gw.getThreadReplies).toHaveBeenCalledWith(ROOM, '7.7', expect.any(Number), expect.anything())
      await executeTool(inDmOfP, 'sendMessage', { action: 'postMessage', channel, message: 'for the team' }, deps)
      expect(gw.postMessage).toHaveBeenCalledWith(ROOM, 'for the team', undefined, expect.anything())
      await executeTool(inDmOfP, 'scheduleMessage', { channel, message: 'later', postAt: later() }, deps)
      expect(gw.scheduleMessage).toHaveBeenCalledWith(ROOM, 'later', expect.any(Number))
    }
  })

  it('refuses a non-member by name exactly as by id', async () => {
    const { deps, gw } = byName({ members: { [ROOM]: ['U_ALICE'] } })
    const read = (channel: string) => refusal(executeTool(inDmOfP, 'getChannelHistory', { channel }, deps))
    const post = (channel: string) =>
      refusal(executeTool(inDmOfP, 'sendMessage', { action: 'postMessage', channel, message: 'hi' }, deps))
    expect(await read('project-room')).toBe(await read(ROOM))
    expect(await read('project-room')).toContain(NOT_SHARED)
    expect(await post('#project-room')).toBe(await post(ROOM))
    expect(await post('#project-room')).toContain(NOT_POSTED)
    expect(gw.getChannelHistory).not.toHaveBeenCalled()
    expect(gw.postMessage).not.toHaveBeenCalled()
  })

  it('refuses a name the bot cannot see with the same opaque answer', async () => {
    const { deps, gw } = byName()
    await expect(executeTool(inDmOfP, 'getChannelHistory', { channel: 'secret-room' }, deps)).rejects.toThrow(
      NOT_SHARED
    )
    await expect(
      executeTool(inDmOfP, 'sendMessage', { action: 'postMessage', channel: '#secret-room', message: 'hi' }, deps)
    ).rejects.toThrow(NOT_POSTED)
    expect(gw.getChannelHistory).not.toHaveBeenCalled()
    expect(gw.postMessage).not.toHaveBeenCalled()
  })

  it('never looks a channel id up by name', async () => {
    const { deps, list } = byName()
    await executeTool(inDmOfP, 'sendMessage', { action: 'postMessage', channel: 'C_DEPLOY', message: 'shipped' }, deps)
    await executeTool(inDmOfP, 'getChannelHistory', { channel: 'C_PRIV' }, deps)
    expect(list).not.toHaveBeenCalled()
  })
})
