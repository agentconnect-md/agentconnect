// The daemon's join confirmation (#2979): one card in the live turn's conversation, and a parked call's outcome back in its session.
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { FakeClock } from '@agentconnect.md/connection'
import { Daemon } from '../src/daemon.js'
import { WorkBoundary } from '../src/messages/message-boundary.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import type { JoinDelivery, JoinRequest } from '../src/mcp/ops/join-ask.js'
import { executeTool, type OpsDeps, type SessionContext } from '../src/mcp/ops.js'
import { judgePlaceWrite } from '../src/mcp/ops/place-gate.js'
import { JOIN_ANSWER_REFUSED, type JoinAnswer } from '../src/permissions/join-confirmation.js'
import { markNotJoined } from '../src/platforms/not-joined.js'
import { TerminalOutputFolder } from '../src/session/terminal-output-folder.js'
import { TelegramConnection } from '../src/telegram/connection.js'
import { LocalStore, sessionKey } from '../src/store/local-store.js'
import { SqliteAsyncDatabase } from '../src/store/sqlite-async-database.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import { WAIT } from './wait-support.js'

const AGENT = 'agent-1'
const INT = 'int-1'
const CHAT = '-100'
const THREAD = 'tg:50'

/** A daemon holding one live Telegram turn, asked by member 42, whose cards are recorded. */
async function world() {
  const daemon: any = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
  daemon.cfg = { ...(daemon.cfg ?? {}), webAppUrl: 'https://console.example.test' }
  const store = await LocalStore.open({ database: SqliteAsyncDatabase.adopt(new DatabaseSync(':memory:')) })
  daemon.store = store
  const int = {
    id: INT,
    platform: 'telegram',
    core: {
      mode: 'direct',
      bindRules: [],
      mutedChannels: [],
      gated: false,
      sessionModes: [],
      externalChannels: [],
      decisions: { bindings: [], definitions: [] }
    }
  }
  // People in chat may only talk to the agent: a join confirmation does not depend on that level.
  daemon.agents.set(AGENT, { id: AGENT, name: 'Butler', chatActions: 'talk', integrations: [int] })
  let n = 100
  const conn = Object.create(TelegramConnection.prototype)
  conn.postCard = vi.fn(async () => String(++n))
  conn.postChrome = vi.fn(async () => String(++n))
  conn.editCard = vi.fn(async () => {})
  conn.updateMessage = vi.fn(async () => {})
  conn.answerCallback = vi.fn(async () => {})
  daemon.tgConnByIntegration.set(INT, conn)
  const key = sessionKey('telegram', CHAT, THREAD, AGENT)
  daemon.pending.set(JSON.stringify([AGENT, 's1']), {
    plan: {
      platform: 'telegram',
      agentId: AGENT,
      agentName: 'Butler',
      integrationId: INT,
      sessionKey: key,
      requesterId: '42',
      channel: CHAT,
      thread: THREAD,
      transcriptChannel: CHAT,
      statusThread: THREAD,
      sessionThread: THREAD,
      isDm: false,
      approvalSurfaceSuppressed: false
    },
    entry: { msg: { source: 'user', text: 'post the notes in #general', sender: { id: '42', isBot: false } } },
    conn,
    hostKey: AGENT,
    acpSessionId: 's1',
    outwardSessionId: 'sid-1',
    turnState: { replyTo: 50 },
    chrome: {},
    reply: { text: '', attemptText: '', attemptAnswerUpdates: [] },
    signals: { applyChain: Promise.resolve() },
    approval: { waitMs: 0, depth: 0 },
    builtinSystemToolCallIds: new Set<string>(),
    conv: { onUpdate: () => [], hasBuffered: () => false },
    rec: { onUpdate: () => [] },
    termOut: new TerminalOutputFolder(),
    workBoundary: new WorkBoundary()
  })
  const ctx = { agentId: AGENT, platform: 'telegram', channel: CHAT, thread: THREAD } as SessionContext
  const ask: JoinRequest = {
    integrationId: 'int-slack',
    channel: 'C-GEN',
    name: 'general',
    purpose: 'post',
    askers: [{ kind: 'member', platform: 'telegram', integrationId: INT, userId: '42' }]
  }
  const tap = async (requestId: string, userId: string): Promise<string | undefined> => {
    conn.answerCallback.mockClear()
    await daemon.handleTelegramCallback(
      { id: 'cb-1', data: `ac_pm:${requestId}:0`, channel: CHAT, messageId: 101, userId, name: 'Ada Example' },
      conn
    )
    const [, text, how] = conn.answerCallback.mock.calls[0] as [string, string | undefined, { alert?: boolean }]
    return how?.alert ? text : undefined
  }
  return { daemon, store, conn, ctx, ask, tap }
}

describe('the daemon’s join confirmation', () => {
  it('cards the live turn’s conversation once for parallel calls, and only its asker answers', async () => {
    const w = await world()
    const offeredFirst = vi.fn()
    const offeredSecond = vi.fn()
    const first = w.daemon.confirmJoin(w.ctx, w.ask, offeredFirst)
    const second = w.daemon.confirmJoin(w.ctx, w.ask, offeredSecond)
    await vi.waitFor(() => expect(w.conn.postCard).toHaveBeenCalledTimes(1), WAIT)
    // Both parked calls hear the one offer, and the turn's thread, so both can return before the answer.
    await vi.waitFor(() => expect(offeredSecond).toHaveBeenCalledTimes(1), WAIT)
    expect(offeredFirst).toHaveBeenCalledTimes(1)
    expect([offeredFirst.mock.calls[0]![1], offeredSecond.mock.calls[0]![1]]).toEqual([THREAD, THREAD])
    const [channel, text, buttons, anchor] = w.conn.postCard.mock.calls[0] as [string, string, unknown[][], object]
    expect(channel).toBe(CHAT)
    expect(anchor).toMatchObject({ replyTo: 50 })
    expect(text).toContain('Let Butler join #general to post there?')
    expect(buttons.flat()).toEqual([
      expect.objectContaining({ text: 'Join' }),
      expect.objectContaining({ text: 'Don’t join' })
    ])
    const requestId = (await w.store.listPermissionRequests(AGENT))[0]!.id

    expect(await w.tap(requestId, '7')).toBe(JOIN_ANSWER_REFUSED)
    expect(w.conn.editCard).not.toHaveBeenCalled()
    expect(await w.tap(requestId, '42')).toBeUndefined()
    await expect(first).resolves.toMatchObject({ outcome: 'join' })
    await expect(second).resolves.toMatchObject({ outcome: 'join' })
    await vi.waitFor(() => expect(w.conn.editCard).toHaveBeenCalledTimes(1), WAIT)
    expect(String(w.conn.editCard.mock.calls[0]![2])).toContain('Joined #general — Ada Example')
    await w.store.close()
  })

  it('takes a console asker’s answer from the chat account they linked on the card’s bot', async () => {
    const w = await world()
    w.daemon.placeMembers.linkedMember = async (_agentId: string, integrationId: string) =>
      integrationId === INT ? '42' : null
    const asked = w.daemon.confirmJoin(w.ctx, { ...w.ask, askers: [{ kind: 'console', userId: 'cu-ada' }] }, vi.fn())
    await vi.waitFor(() => expect(w.conn.postCard).toHaveBeenCalledTimes(1), WAIT)
    const requestId = (await w.store.listPermissionRequests(AGENT))[0]!.id
    expect(await w.tap(requestId, '7')).toBe(JOIN_ANSWER_REFUSED)
    expect(await w.tap(requestId, '42')).toBeUndefined()
    await expect(asked).resolves.toMatchObject({ outcome: 'join' })
    await w.store.close()
  })

  it('asks nothing without a live turn', async () => {
    const w = await world()
    w.daemon.pending.clear()
    await expect(w.daemon.confirmJoin(w.ctx, w.ask, vi.fn())).resolves.toMatchObject({ outcome: 'unavailable' })
    expect(w.conn.postCard).not.toHaveBeenCalled()
    await w.store.close()
  })

  it('hands a parked call’s late outcome to its session as a new message, in the thread that is the session', async () => {
    const w = await world()
    const key = sessionKey('telegram', CHAT, THREAD, AGENT)
    await w.store.upsertSession({
      key,
      agentId: AGENT,
      platform: 'telegram',
      channel: CHAT,
      thread: THREAD,
      acpSessionId: 's1',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: Date.now()
    })
    const dispatch = vi.fn(async () => {})
    w.daemon.dispatch = dispatch
    const call = {
      tool: 'getChannelHistory',
      name: 'general',
      purpose: 'read' as const,
      to: 'Ada Example',
      thread: THREAD
    }
    await w.daemon.deliverJoinOutcome(w.ctx, { ...call, result: { messages: [{ text: 'hello' }] } })
    await w.daemon.deliverJoinOutcome(w.ctx, { ...call, error: 'getChannelHistory: the bot did not join #general.' })
    expect(dispatch).toHaveBeenCalledTimes(2)
    const [agentId, joined] = dispatch.mock.calls[0] as unknown as [string, NormalizedMessage]
    expect(agentId).toBe(AGENT)
    // A per-thread session's thread is where the asking turn replied, as before.
    expect(joined).toMatchObject({ channel: CHAT, thread: THREAD, source: 'agent' })
    expect(joined.sessionThread).toBeUndefined()
    expect(joined.text).toContain('ran once the bot joined')
    expect(joined.text).toContain('"text": "hello"')
    const [, refused] = dispatch.mock.calls[1] as unknown as [string, { text: string }]
    expect(refused.text).toContain('did nothing. getChannelHistory: the bot did not join #general.')
    await w.store.close()
  })
})

/** A Slack session the follow-up turn of a join runs in, judged by the daemon's own asker resolution. */
async function followUp(w: Awaited<ReturnType<typeof world>>, delivered: JoinDelivery) {
  const ctx = {
    agentId: AGENT,
    platform: 'slack',
    integrationId: 'int-s',
    isDm: false,
    channel: 'C-HERE',
    thread: '100.1',
    deliveryThread: '100.1',
    tools: [],
    integrations: [{ id: 'int-s', platform: 'slack' }]
  } as SessionContext
  const key = sessionKey('slack', 'C-HERE', '100.1', AGENT)
  await w.store.upsertSession({
    key,
    agentId: AGENT,
    platform: 'slack',
    channel: 'C-HERE',
    thread: '100.1',
    acpSessionId: 's2',
    state: 'idle',
    lastDeliveredTs: null,
    updatedAt: Date.now()
  })
  const dispatch = vi.fn(async () => {})
  w.daemon.dispatch = dispatch
  await w.daemon.deliverJoinOutcome(ctx, delivered)
  const [, msg] = dispatch.mock.calls[0] as unknown as [string, { msgId: string }]
  // The wake runs as the session's live turn, the way the bridge's turn gate sees it.
  w.daemon.activeGateEntries.set(key, { msg, integrationId: 'int-s' })
  const gw = {
    getChannelInfo: vi.fn(async (id: string) => ({
      id,
      name: id === 'C-SECOND' ? 'second' : 'other',
      isPrivate: false
    })),
    getChannelHistory: vi.fn(async (channel: string) => {
      throw markNotJoined(new Error('An API error occurred: not_in_channel'), channel)
    }),
    joinChannel: vi.fn(async () => {}),
    postMessage: vi.fn(async () => 'ts-1'),
    listMembers: vi.fn(async () => []),
    listChannels: vi.fn(async () => []),
    getUserProfile: vi.fn(async (u: string) => ({ id: u })),
    downloadFile: vi.fn(async () => null)
  }
  const confirmJoin = vi.fn(async (): Promise<JoinAnswer> => ({ outcome: 'declined' }))
  const deps = {
    gatewayFor: () => gw,
    readAskers: (c: SessionContext) => w.daemon.readAskersFor(c),
    readLookups: () => ({
      member: async () => true,
      fullMember: async () => true,
      console: async (_asker: unknown, sessionIds: readonly string[]) => ({
        asker: 'linked',
        visible: new Set(sessionIds)
      }),
      linked: async () => null
    }),
    placeStore: {
      listSessions: async () => [],
      latestSession: async (_agentId: string, channel: string) => ({
        key: `k-${channel}`,
        agentId: AGENT,
        platform: 'slack',
        channel,
        thread: 't',
        acpSessionId: null,
        sessionId: `out-${channel}`,
        state: 'idle',
        lastDeliveredTs: null,
        updatedAt: 0
      }),
      transcriptPageForAgent: async () => ({ rows: [], hasMore: false }),
      getDisplayNames: async () => new Map()
    },
    confirmJoin
  } as unknown as OpsDeps
  return { ctx, deps, confirmJoin }
}

describe('the turn a join’s result starts', () => {
  const ADA_CONSOLE = { kind: 'console' as const, userId: 'cu-ada' }
  const call = { tool: 'getChannelHistory', name: 'general', purpose: 'read' as const, to: 'Ada Example' }
  const other = { kind: 'conversation' as const, platform: 'slack', integrationId: 'int-s', channel: 'C-OTHER' }

  it('reads and writes as the person who answered Join, so the request can go on elsewhere', async () => {
    const w = await world()
    const f = await followUp(w, { ...call, by: ADA_CONSOLE, result: { messages: [] } })
    await expect(w.daemon.readAskersFor(f.ctx)).resolves.toEqual({ people: [ADA_CONSOLE], nobody: false })
    // "Read #general and post a summary to #other": the post is that person's to make.
    await expect(judgePlaceWrite(f.ctx, 'sendMessage', other, f.deps, true)).resolves.toBe('post')
    // A second channel the bot is not in asks that person again.
    await expect(executeTool(f.ctx, 'getChannelHistory', { channel: 'C-SECOND' }, f.deps)).rejects.toThrow(
      /did not join #second: the person asked chose not to let it/
    )
    expect(f.confirmJoin).toHaveBeenCalledWith(
      f.ctx,
      expect.objectContaining({ channel: 'C-SECOND', askers: [ADA_CONSOLE] }),
      expect.any(Function)
    )
    await w.store.close()
  })

  it('speaks for no one when nothing was done, so it neither writes elsewhere nor asks', async () => {
    const w = await world()
    const f = await followUp(w, { ...call, error: 'getChannelHistory: the bot did not join #general.' })
    await expect(w.daemon.readAskersFor(f.ctx)).resolves.toMatchObject({ people: [], nobody: true })
    await expect(judgePlaceWrite(f.ctx, 'sendMessage', other, f.deps, true)).rejects.toThrow(
      /no person started this run/
    )
    await expect(executeTool(f.ctx, 'getChannelHistory', { channel: 'C-SECOND' }, f.deps)).rejects.toThrow(
      /the bot is not in #second; invite it, or ask from a conversation/
    )
    expect(f.confirmJoin).not.toHaveBeenCalled()
    await w.store.close()
  })
})

const DM = 'D-ADA'
/** The person's message the asking turn replied under. */
const ASKED_UNDER = '1700.0001'
/** The DM's one long session. */
const APPEND = 'append:1000'
const ADA_SLACK = { kind: 'member' as const, platform: 'slack', integrationId: 'int-s', userId: 'U-ada' }

/** A daemon holding one live turn in a person's Slack DM with the bot: one long session, each turn replying under its message. */
async function slackDm(over: { database?: DatabaseSync; thread?: string | null } = {}) {
  const database = over.database ?? new DatabaseSync(':memory:')
  const daemon: any = new Daemon({
    slackAppFactory: fakeSlackAppFactory(),
    sandboxMechanism: null,
    clock: new FakeClock(1_000_000)
  })
  daemon.cfg = { ...(daemon.cfg ?? {}), webAppUrl: 'https://console.example.test' }
  const store = await LocalStore.open({ database: SqliteAsyncDatabase.adopt(database) })
  daemon.store = store
  const int = {
    id: 'int-s',
    platform: 'slack',
    core: {
      mode: 'direct',
      bindRules: [],
      mutedChannels: [],
      gated: false,
      sessionModes: [],
      externalChannels: [],
      decisions: { bindings: [], definitions: [] }
    }
  }
  daemon.agents.set(AGENT, { id: AGENT, name: 'Butler', chatActions: 'talk', integrations: [int] })
  let n = 0
  const conn = {
    postBlocks: vi.fn(async (..._args: unknown[]) => `300.${++n}`),
    updateBlocks: vi.fn(async (..._args: unknown[]) => undefined),
    postEphemeral: vi.fn(async (..._args: unknown[]) => true),
    memberName: vi.fn(async () => 'Ada Example'),
    workspaceId: () => 'T1'
  }
  daemon.connByIntegration.set('int-s', conn)
  const key = sessionKey('slack', DM, APPEND, AGENT)
  await store.upsertSession({
    key,
    agentId: AGENT,
    platform: 'slack',
    channel: DM,
    thread: APPEND,
    acpSessionId: 's1',
    state: 'idle',
    lastDeliveredTs: null,
    updatedAt: Date.now()
  })
  await store.setSessionClassification(key, { conversationKind: 'dm' })
  const thread = over.thread === null ? undefined : (over.thread ?? ASKED_UNDER)
  daemon.pending.set(JSON.stringify([AGENT, 's1']), {
    plan: {
      platform: 'slack',
      agentId: AGENT,
      agentName: 'Butler',
      integrationId: 'int-s',
      sessionKey: key,
      requesterId: 'U-ada',
      channel: DM,
      ...(thread !== undefined ? { thread } : {}),
      transcriptChannel: DM,
      statusThread: thread ?? 'm-1',
      sessionThread: APPEND,
      isDm: true,
      approvalSurfaceSuppressed: false
    },
    entry: { msg: { source: 'user', text: 'post the notes in #general', sender: { id: 'U-ada', isBot: false } } },
    conn,
    hostKey: AGENT,
    acpSessionId: 's1',
    outwardSessionId: 'sid-1',
    chrome: {},
    reply: { text: '', attemptText: '', attemptAnswerUpdates: [] },
    signals: { applyChain: Promise.resolve() },
    approval: { waitMs: 0, depth: 0 },
    builtinSystemToolCallIds: new Set<string>(),
    conv: { onUpdate: () => [], hasBuffered: () => false },
    rec: { onUpdate: () => [] },
    termOut: new TerminalOutputFolder(),
    workBoundary: new WorkBoundary()
  })
  const ctx = {
    agentId: AGENT,
    platform: 'slack',
    integrationId: 'int-s',
    isDm: true,
    channel: DM,
    thread: APPEND,
    deliveryThread: thread ?? APPEND,
    tools: [],
    integrations: [{ id: 'int-s', platform: 'slack' }]
  } as SessionContext
  const dispatch = vi.fn(async () => {})
  daemon.dispatch = dispatch
  const joined = new Set<string>()
  const gw = {
    getChannelInfo: vi.fn(async (id: string) => ({ id, name: 'general', isPrivate: false })),
    getChannelHistory: vi.fn(async (channel: string) => {
      if (!joined.has(channel)) throw markNotJoined(new Error('An API error occurred: not_in_channel'), channel)
      return { messages: [{ sender: 'U1', ts: '1.0', text: 'hello', isBot: false }], hasMore: false }
    }),
    joinChannel: vi.fn(async (channel: string) => void joined.add(channel)),
    postMessage: vi.fn(async () => 'ts-1'),
    listMembers: vi.fn(async () => []),
    listChannels: vi.fn(async () => []),
    getUserProfile: vi.fn(async (u: string) => ({ id: u })),
    downloadFile: vi.fn(async () => null)
  }
  // The two join ports as the daemon's tool host wires them.
  const deps = {
    gatewayFor: () => gw,
    readAskers: async () => ({ people: [ADA_SLACK], nobody: false }),
    readLookups: () => ({
      member: async () => true,
      fullMember: async () => true,
      console: async (_asker: unknown, sessionIds: readonly string[]) => ({
        asker: 'linked',
        visible: new Set(sessionIds)
      }),
      linked: async () => null
    }),
    placeStore: {
      listSessions: async () => [],
      latestSession: async () => undefined,
      transcriptPageForAgent: async () => ({ rows: [], hasMore: false }),
      getDisplayNames: async () => new Map()
    },
    confirmJoin: (c: SessionContext, a: JoinRequest, o: (to: string | null) => void) => daemon.confirmJoin(c, a, o),
    deliverJoinOutcome: (c: SessionContext, o: JoinDelivery) => void daemon.deliverJoinOutcome(c, o)
  } as unknown as OpsDeps
  const requestId = async (): Promise<string> => {
    await vi.waitFor(async () => expect(await store.listPermissionRequests(AGENT)).toHaveLength(1), WAIT)
    return (await store.listPermissionRequests(AGENT))[0]!.id
  }
  /** The one message a join notice dispatched. */
  const notice = async (): Promise<NormalizedMessage> => {
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1), WAIT)
    return (dispatch.mock.calls[0] as unknown as [string, NormalizedMessage])[1]
  }
  return { daemon, store, database, conn, ctx, deps, requestId, notice }
}

describe('the turn a join’s answer starts in a single-session DM', () => {
  it.each([
    ['Join', 'join', 'ran once the bot joined'],
    ['Don’t join', 'dont-join', 'did nothing']
  ])('replies under the message that asked, after %s', async (_label, optionId, said) => {
    const w = await slackDm()
    await expect(executeTool(w.ctx, 'getChannelHistory', { channel: 'C-GEN' }, w.deps)).resolves.toMatchObject({
      joinRequested: true
    })
    const id = await w.requestId()
    // The card is in the asking turn's thread, where its reply went.
    await vi.waitFor(() => expect(w.conn.postBlocks).toHaveBeenCalledTimes(1), WAIT)
    const [channel, , , thread] = w.conn.postBlocks.mock.calls[0]!
    expect([channel, thread]).toEqual([DM, ASKED_UNDER])

    await w.daemon.permissions.handlePermissionChoice({ requestId: id, optionId, actor: { userId: 'U-ada' } })
    const msg = await w.notice()
    expect(msg.text).toContain(said)
    // It replies in that thread, and its turn is still the DM's one session.
    expect(msg).toMatchObject({ channel: DM, thread: ASKED_UNDER, sessionThread: APPEND, isDm: true })
    await w.store.close()
  })

  it('stays at the top level when the asking turn had no thread', async () => {
    const w = await slackDm({ thread: null })
    await executeTool(w.ctx, 'getChannelHistory', { channel: 'C-GEN' }, w.deps)
    const id = await w.requestId()
    await vi.waitFor(() => expect(w.conn.postBlocks).toHaveBeenCalledTimes(1), WAIT)
    await w.daemon.permissions.handlePermissionChoice({ requestId: id, optionId: 'join', actor: { userId: 'U-ada' } })
    const msg = await w.notice()
    expect(msg.thread).toBeUndefined()
    expect(msg.sessionThread).toBe(APPEND)
    await w.store.close()
  })

  it('tells the thread that asked when a restart expired its card, read back from the store', async () => {
    const first = await slackDm()
    const ask: JoinRequest = {
      integrationId: 'int-s',
      channel: 'C-GEN',
      name: 'general',
      purpose: 'post',
      tool: 'sendMessage',
      askers: [ADA_SLACK]
    }
    void first.daemon.confirmJoin(first.ctx, ask, vi.fn())
    const id = await first.requestId()
    const handle = () =>
      first.database.prepare('SELECT notifyChannel, notifyTs FROM permission_requests WHERE id = ?').get(id)
    await vi.waitFor(() => expect(handle()).toEqual({ notifyChannel: DM, notifyTs: '300.1' }), WAIT)

    // The process dies; the next one opens the store, and its integration's reconnect sweeps the card.
    const restarted = await slackDm({ database: first.database })
    await restarted.daemon.permissions.retireOrphanedCards('int-s')
    const msg = await restarted.notice()
    expect(msg.text).toContain('sendMessage: the bot did not join #general: nobody answered')
    expect(msg).toMatchObject({ channel: DM, thread: ASKED_UNDER, sessionThread: APPEND })
    await restarted.store.close()
  })
})

describe('a join card a restart left pending', () => {
  it('tells its session nothing was read, in the timeout’s words, and skips a session that is gone', async () => {
    const w = await world()
    await w.store.upsertSession({
      key: sessionKey('telegram', CHAT, THREAD, AGENT),
      agentId: AGENT,
      platform: 'telegram',
      channel: CHAT,
      thread: THREAD,
      acpSessionId: 's1',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: Date.now()
    })
    const dispatch = vi.fn(async () => {})
    w.daemon.dispatch = dispatch
    const stored = { tool: 'getChannelHistory', name: 'general', purpose: 'read' as const }
    await w.daemon.joinCardExpired(AGENT, 'gone', stored)
    expect(dispatch).not.toHaveBeenCalled()
    await w.daemon.joinCardExpired(AGENT, 's1', stored)
    expect(dispatch).toHaveBeenCalledTimes(1)
    const [, msg] = dispatch.mock.calls[0] as unknown as [string, NormalizedMessage]
    // A row that recorded no thread, as an older daemon wrote it, replies where the session is.
    expect(msg).toMatchObject({ channel: CHAT, thread: THREAD })
    expect(msg.text).toContain(
      'getChannelHistory: the bot did not join #general: nobody answered whether it may within 10 minutes. Nothing was read'
    )
    // A call that did nothing speaks for no one.
    expect(w.daemon.joinWakeOpeners.has(msg.msgId)).toBe(false)
    await w.store.close()
  })
})
