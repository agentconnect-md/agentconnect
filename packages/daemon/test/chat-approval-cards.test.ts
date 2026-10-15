// Telegram and Discord carry the in-conversation permission card Slack has: posted where the request came from, answered by anyone there, refused privately.
import { DatabaseSync } from 'node:sqlite'
import { MessageFlags } from 'discord.js'
import { describe, expect, it, vi } from 'vitest'
import type { CreateElicitationRequest, RequestPermissionRequest } from '@agentclientprotocol/sdk'
import { FakeClock } from '@agentconnect.md/connection'
import { agentHostKey } from '../src/acp/host-key.js'
import { approvalRefusalText, CHAT_LINK_HINT, settingsRefusalText } from '../src/agents/chat-actions.js'
import { Daemon } from '../src/daemon.js'
import { pendingTurnKey, type Pending } from '../src/daemon/turn-types.js'
import { DiscordConnection } from '../src/discord/connection.js'
import { WorkBoundary } from '../src/messages/message-boundary.js'
import { PermissionCoordinator, type PermissionHost } from '../src/permissions/coordinator.js'
import type { SubsessionApprovalRoute } from '../src/permissions/subsession-approval.js'
import { TerminalOutputFolder } from '../src/session/terminal-output-folder.js'
import { subsessionCoordinate } from '../src/session/subsession-coordinate.js'
import { TelegramConnection } from '../src/telegram/connection.js'
import { TELEGRAM_CALLBACK_ANSWER_LIMIT } from '../src/telegram/render.js'
import { LocalStore, sessionKey } from '../src/store/local-store.js'
import { SqliteAsyncDatabase } from '../src/store/sqlite-async-database.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'

type Platform = 'telegram' | 'discord'
type Core = Record<string, unknown>

const AGENT = 'agent-1'
const INT = 'int-1'
const CHAT = 'C1'
const ADA = { userId: '42', name: 'Ada Example', isBot: false }

/** Where each platform's turn lives: Telegram's reply chain rooted at message 50, a Discord thread that is a channel of its own. */
const THREAD: Record<Platform, string> = { telegram: 'tg:50', discord: 'TH1' }

const permission = (count = 3): RequestPermissionRequest =>
  ({
    sessionId: 's1',
    options: [
      { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
      { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
      ...Array.from({ length: Math.max(0, count - 3) }, (_, i) => ({
        optionId: `extra-${i}`,
        name: `Extra ${i}`,
        kind: 'allow_once'
      }))
    ].slice(0, count),
    toolCall: { toolCallId: 'tc-1', title: 'Write example.txt' }
  }) as unknown as RequestPermissionRequest

const mcpApproval = {
  sessionId: 's1',
  toolCallId: 'call-1',
  mode: 'form',
  message: 'Allow the example MCP server to run this tool?',
  requestedSchema: {
    type: 'object',
    properties: { persist: { type: 'string', enum: ['once', 'session'] } },
    required: ['persist']
  },
  _meta: { codex_approval_kind: 'mcp_tool_call', persist: 'session' }
} as unknown as CreateElicitationRequest

const integration = (platform: Platform, core: Core = {}): { id: string; platform: Platform; core: Core } => ({
  id: INT,
  platform,
  core: {
    mode: 'direct',
    bindRules: [],
    mutedChannels: [],
    gated: false,
    sessionModes: [],
    externalChannels: [],
    decisions: { bindings: [], definitions: [] },
    ...core
  }
})

/** The ways a conversation stays closed. */
const CLOSED: Array<[string, Core]> = [
  ['switched off', { mutedChannels: [CHAT] }],
  ['admitted per message by a Decision', { bindRules: [{ channel: CHAT, match: { kind: 'decision' } }] }]
]

type TelegramPost = {
  channel: string
  text: string
  buttons: { text: string; callbackData: string }[]
  anchor: Record<string, unknown>
}

/** A fake platform connection recording every card, notice and rewrite in one shape. */
function fakeConn(platform: Platform) {
  let n = 100
  if (platform === 'telegram') {
    const conn = Object.create(TelegramConnection.prototype)
    conn.postCard = vi.fn(async () => String(++n))
    conn.postChrome = vi.fn(async () => String(++n))
    conn.editCard = vi.fn(async () => {})
    conn.updateMessage = vi.fn(async () => {})
    conn.answerCallback = vi.fn(async () => {})
    const posts = () =>
      [
        ...conn.postCard.mock.calls.map((c: unknown[]) => ({
          channel: c[0] as string,
          text: c[1] as string,
          buttons: (c[2] as { text: string; callbackData: string }[][]).flat(),
          anchor: c[3] as Record<string, unknown>
        })),
        ...conn.postChrome.mock.calls.map((c: unknown[]) => ({
          channel: c[0] as string,
          text: c[1] as string,
          buttons: [] as { text: string; callbackData: string }[],
          anchor: c[2] as Record<string, unknown>
        }))
      ].map((p: TelegramPost) => ({
        ...p,
        labels: p.buttons.map((b) => b.text),
        ids: p.buttons.map((b) => b.callbackData)
      }))
    const rewrites = () => [
      ...conn.editCard.mock.calls.map((c: unknown[]) => ({
        channel: c[0] as string,
        ts: String(c[1]),
        text: c[2] as string,
        live: (c[3] as unknown[]).length > 0
      })),
      ...conn.updateMessage.mock.calls.map((c: unknown[]) => ({
        channel: c[0] as string,
        ts: String(c[1]),
        text: c[2] as string,
        live: false
      }))
    ]
    return { conn, posts, rewrites }
  }
  const conn = Object.create(DiscordConnection.prototype)
  conn.postChrome = vi.fn(async () => String(++n))
  conn.updateMessage = vi.fn(async () => {})
  type Row = { components: { label: string; custom_id: string }[] }
  const posts = () =>
    conn.postChrome.mock.calls.map((c: unknown[]) => {
      const buttons = ((c[2] as { keyboard?: Row[] }).keyboard ?? []).flatMap((row) => row.components)
      return {
        channel: c[0] as string,
        text: c[1] as string,
        labels: buttons.map((b) => b.label),
        ids: buttons.map((b) => b.custom_id),
        anchor: {}
      }
    })
  const rewrites = () =>
    conn.updateMessage.mock.calls.map((c: unknown[]) => ({
      channel: c[0] as string,
      ts: c[1] as string,
      text: c[2] as string,
      live: (((c[3] as { keyboard?: unknown[] } | undefined)?.keyboard ?? []) as unknown[]).length > 0
    }))
  return { conn, posts, rewrites }
}

/** A daemon holding one live turn on `platform` in an open conversation, with every post and notice captured. */
async function world(platform: Platform, opts: { level: 'talk' | 'approve' | 'settings'; core?: Core }) {
  const daemon: any = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
  daemon.cfg = { ...(daemon.cfg ?? {}), webAppUrl: 'https://console.example.test' }
  const store = await LocalStore.open({ database: SqliteAsyncDatabase.adopt(new DatabaseSync(':memory:')) })
  daemon.store = store
  const int = integration(platform, opts.core)
  const agent = { id: AGENT, name: 'Butler', chatActions: opts.level, integrations: [int] }
  daemon.agents.set(AGENT, agent)
  const fake = fakeConn(platform)
  if (platform === 'telegram') daemon.tgConnByIntegration.set(INT, fake.conn)
  else daemon.dcConnByIntegration.set(INT, fake.conn)
  const applied: any[] = []
  daemon.enqueueApply = (_p: unknown, action: unknown) => void applied.push(action)
  const pending = {
    plan: {
      platform,
      agentId: AGENT,
      agentName: 'Butler',
      integrationId: INT,
      sessionKey: `${platform}:${CHAT}:${THREAD[platform]}:${AGENT}`,
      requesterId: 'U-ASKER',
      channel: CHAT,
      thread: THREAD[platform],
      transcriptChannel: CHAT,
      statusThread: THREAD[platform],
      sessionThread: THREAD[platform],
      isDm: false,
      approvalSurfaceSuppressed: false
    },
    entry: { msg: { source: 'user', text: 'please write it', sender: { id: 'U-ASKER', isBot: false } } },
    conn: fake.conn,
    hostKey: AGENT,
    outwardSessionId: 'sid-1',
    // Telegram anchors a turn's posts to the message that started it.
    turnState: platform === 'telegram' ? { replyTo: 50 } : {},
    chrome: {},
    reply: { text: '', attemptText: '', attemptAnswerUpdates: [] },
    signals: { applyChain: Promise.resolve() },
    approval: { waitMs: 0, depth: 0 },
    builtinSystemToolCallIds: new Set<string>(),
    conv: { onUpdate: () => [], hasBuffered: () => false },
    rec: { onUpdate: () => [] },
    termOut: new TerminalOutputFolder(),
    workBoundary: new WorkBoundary()
  }
  daemon.pending.set(JSON.stringify([AGENT, 's1']), pending)
  const permissions = daemon.permissions
  const notices = (): string[] => applied.filter((a) => a.kind === 'notice').map((a) => a.text as string)
  const onlyRequest = (): string => [...permissions.pendingApprovals.keys(), ...permissions.pendingElicits.keys()][0]
  /** Click a permission card's option as the platform's ingress delivers it; what only the clicker was told. */
  const click = async (option: number, actor: { userId: string; name?: string; isBot?: boolean } = ADA) => {
    const requestId = onlyRequest()
    const ts = '101'
    if (platform === 'telegram') {
      fake.conn.answerCallback.mockClear()
      await daemon.handleTelegramCallback(
        { id: 'cb-1', data: `ac_pm:${requestId}:${option}`, channel: CHAT, messageId: Number(ts), ...actor },
        fake.conn
      )
      const [id, text, how] = fake.conn.answerCallback.mock.calls[0] as [
        string,
        string | undefined,
        { alert?: boolean }
      ]
      expect(id).toBe('cb-1')
      return how?.alert ? text : undefined
    }
    return await daemon.connectionReconcilerHost().handlePermissionPick({ requestId, option, ts, actor })
  }
  /** Tap an elicitation card's option as the platform's ingress delivers it; what only the tapper was told. */
  const tap = async (token: string, actor = ADA) => {
    const requestId = onlyRequest()
    if (platform === 'telegram') {
      fake.conn.answerCallback.mockClear()
      await daemon.handleTelegramCallback(
        { id: 'cb-2', data: `ac_el:${requestId}:${token}`, channel: CHAT, messageId: 101, ...actor },
        fake.conn
      )
      const [, text, how] = fake.conn.answerCallback.mock.calls[0] as [string, string | undefined, { alert?: boolean }]
      return how?.alert ? text : undefined
    }
    return await daemon.connectionReconcilerHost().handleElicitCardTap({ requestId, token, actor })
  }
  return { daemon, store, agent, int, permissions, notices, onlyRequest, click, tap, ...fake }
}

describe.each(['telegram', 'discord'] as const)('%s permission cards', (platform) => {
  it('posts the card where the request came from, offering the runtime’s own choices', async () => {
    const w = await world(platform, { level: 'approve' })
    void w.permissions.onAcpPermission(AGENT, 's1', permission())
    await vi.waitFor(() => expect(w.posts()).toHaveLength(1))
    const card = w.posts()[0]!
    const id = w.onlyRequest()
    expect(card.text).toContain('Permission requested')
    expect(card.text).toContain('Write example.txt')
    expect(card.labels).toEqual(['Always allow', 'Allow', 'Deny'])
    expect(card.ids).toEqual([`ac_pm:${id}:0`, `ac_pm:${id}:1`, `ac_pm:${id}:2`])
    // Telegram replies into the turn's reply chain; a Discord thread is where its card lands.
    if (platform === 'telegram') expect(card).toMatchObject({ channel: CHAT, anchor: { replyTo: 50 } })
    else expect(card.channel).toBe('TH1')
    expect(w.notices()).toEqual([])
    await w.store.close()
  })

  it('keeps the notice and the console where people may only talk to the agent', async () => {
    const w = await world(platform, { level: 'talk' })
    void w.permissions.onAcpPermission(AGENT, 's1', permission())
    await vi.waitFor(() => expect(w.notices()).toEqual([expect.stringContaining('Ask an Agent editor')]))
    expect(w.posts()).toEqual([])
    expect(w.permissions.pendingApprovals.get(w.onlyRequest()).chat).toBeUndefined()
    await w.store.close()
  })

  it.each(CLOSED)('posts no card in a conversation %s, only the notice', async (_how, core) => {
    const w = await world(platform, { level: 'settings', core })
    void w.permissions.onAcpPermission(AGENT, 's1', permission())
    await vi.waitFor(() => expect(w.notices()).toEqual([expect.stringContaining('Ask an Agent editor')]))
    expect(w.posts()).toEqual([])
    await w.store.close()
  })

  it('takes a participant’s click as the decision, and the card says who answered', async () => {
    const w = await world(platform, { level: 'approve' })
    const decided = w.permissions.onAcpPermission(AGENT, 's1', permission())
    await vi.waitFor(() => expect(w.posts()).toHaveLength(1))
    expect(await w.click(1)).toBeUndefined()
    await expect(decided).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } })
    await vi.waitFor(() => expect(w.rewrites()).toHaveLength(1))
    expect(w.rewrites()[0]).toMatchObject({ ts: '101', live: false })
    expect(w.rewrites()[0]!.text).toContain('✅ Allow — Ada Example')
    expect((await w.store.listPermissionRequests(AGENT))[0]).toMatchObject({
      status: 'allowed',
      resolvedBy: `${platform}:42`,
      resolvedByName: 'Ada Example'
    })
    await w.store.close()
  })

  it('never takes a bot’s click', async () => {
    const w = await world(platform, { level: 'approve' })
    const decided = vi.fn()
    void w.permissions.onAcpPermission(AGENT, 's1', permission()).then(decided)
    await vi.waitFor(() => expect(w.posts()).toHaveLength(1))
    expect(await w.click(1, { userId: '99', name: 'Some Bot', isBot: true })).toBeUndefined()
    expect(w.permissions.pendingApprovals.size).toBe(1)
    expect(w.rewrites()).toEqual([])
    expect(decided).not.toHaveBeenCalled()
    await w.store.close()
  })

  it.each([
    ['the level was lowered', (w: Awaited<ReturnType<typeof world>>) => void (w.agent.chatActions = 'talk')],
    [
      'the conversation was switched off',
      (w: Awaited<ReturnType<typeof world>>) => void (w.int.core.mutedChannels = [CHAT])
    ]
  ])('tells only the clicker when %s, and leaves the card as it is', async (_how, close) => {
    const w = await world(platform, { level: 'approve' })
    const decided = vi.fn()
    void w.permissions.onAcpPermission(AGENT, 's1', permission()).then(decided)
    await vi.waitFor(() => expect(w.posts()).toHaveLength(1))
    close(w)
    const told = await w.click(1)
    expect(told).toContain('Only an Agent editor can answer this request')
    expect(told).toContain('https://console.example.test/sessions/sid-1')
    expect(w.rewrites()).toEqual([])
    expect(w.permissions.pendingApprovals.size).toBe(1)
    expect(decided).not.toHaveBeenCalled()
    // Nothing went into the conversation itself.
    expect(w.notices()).toEqual([])
    await w.store.close()
  })

  it('rewrites the card when an Agent editor answers in the console', async () => {
    const w = await world(platform, { level: 'approve' })
    const decided = w.permissions.onAcpPermission(AGENT, 's1', permission())
    await vi.waitFor(() => expect(w.posts()).toHaveLength(1))
    await expect(
      w.permissions.decideEditorPermission({
        agentId: AGENT,
        requestId: w.onlyRequest(),
        decision: 'deny',
        decidedByName: 'Ed'
      })
    ).resolves.toEqual({ ok: true })
    await expect(decided).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'deny' } })
    await vi.waitFor(() => expect(w.rewrites()).toHaveLength(1))
    expect(w.rewrites()[0]!.text).toContain('🚫 Deny — Ed')
    expect(w.rewrites()[0]!.live).toBe(false)
    await w.store.close()
  })

  it('retires the card for everyone once approving in chat is turned off, leaving the request to editors', async () => {
    const w = await world(platform, { level: 'approve' })
    void w.permissions.onAcpPermission(AGENT, 's1', permission())
    await vi.waitFor(() => expect(w.posts()).toHaveLength(1))
    w.agent.chatActions = 'talk'
    w.permissions.disableChatPermissionSurfaces(AGENT)
    await vi.waitFor(() => expect(w.rewrites()).toHaveLength(1))
    expect(w.rewrites()[0]!.text).toContain('Approving in chat was turned off')
    expect(w.rewrites()[0]!.live).toBe(false)
    expect(w.permissions.pendingApprovals.size).toBe(1)
    await w.store.close()
  })

  it('never cuts the console link in a refusal: a surface that cannot fit it says where without it', async () => {
    const w = await world(platform, { level: 'approve' })
    w.daemon.cfg.webAppUrl = `https://console.example.test/${'a'.repeat(150)}`
    void w.permissions.onAcpPermission(AGENT, 's1', permission())
    await vi.waitFor(() => expect(w.posts()).toHaveLength(1))
    w.agent.chatActions = 'talk'
    const told = await w.click(1)
    if (platform === 'telegram')
      expect(told).toBe('Only an Agent editor can answer this request. They can answer it in the console.')
    else expect(told).toContain(`https://console.example.test/${'a'.repeat(150)}/sessions/sid-1`)
    await w.store.close()
  })

  it('declines a list longer than every surface shows, with the notice, and posts nothing', async () => {
    const w = await world(platform, { level: 'approve' })
    await expect(w.permissions.onAcpPermission(AGENT, 's1', permission(26))).resolves.toEqual({
      outcome: { outcome: 'cancelled' }
    })
    expect(w.notices()).toEqual([expect.stringContaining('more options than any surface here can show (26)')])
    expect(w.posts()).toEqual([])
    await w.store.close()
  })

  it('cards an MCP approval too, telling a refused tap privately and naming who answered', async () => {
    const w = await world(platform, { level: 'approve' })
    const decided = w.permissions.onAcpElicit(AGENT, 's1', mcpApproval)
    await vi.waitFor(() => expect(w.posts()).toHaveLength(1))
    expect(w.posts()[0]!.text).toContain('Allow the example MCP server')
    w.int.core.mutedChannels = [CHAT]
    expect(await w.tap('ac_o0')).toContain('Only an Agent editor can answer this request')
    expect(w.rewrites()).toEqual([])
    w.int.core.mutedChannels = []
    expect(await w.tap('ac_o0')).toBeUndefined()
    await expect(decided).resolves.toMatchObject({ action: 'accept', content: { persist: 'once' } })
    await vi.waitFor(() => expect(w.rewrites()).toHaveLength(1))
    expect(w.rewrites()[0]!.text).toContain('Ada Example')
    await w.store.close()
  })
})

describe('a refusal said within a limit', () => {
  const url = `https://console.example.test/${'a'.repeat(150)}/sessions/sid-1`

  it('keeps the link where it fits, and drops it whole where it does not', () => {
    expect(approvalRefusalText('closed', 'https://console.example.test/s', TELEGRAM_CALLBACK_ANSWER_LIMIT)).toBe(
      'Only an Agent editor can answer this request. They can answer it in the console: https://console.example.test/s'
    )
    expect(approvalRefusalText('closed', url, TELEGRAM_CALLBACK_ANSWER_LIMIT)).toBe(
      'Only an Agent editor can answer this request. They can answer it in the console.'
    )
    expect(settingsRefusalText(url, undefined, TELEGRAM_CALLBACK_ANSWER_LIMIT)).toBe(
      'Only an Agent editor can change runtime settings. They can change them in the console.'
    )
    // No limit, no change.
    expect(approvalRefusalText('closed', url)).toContain(url)
  })

  it('keeps a settings refusal’s link hint where it fits, else drops it too', () => {
    const roomy = settingsRefusalText(url, 'unlinked', 400)
    expect(roomy).not.toContain(url)
    expect(roomy).toContain(CHAT_LINK_HINT)
    expect(settingsRefusalText(url, 'unlinked', TELEGRAM_CALLBACK_ANSWER_LIMIT)).toBe(
      'Only an Agent editor can change runtime settings. They can change them in the console.'
    )
  })

  it.each(['not-editor', 'unlinked', 'unavailable'] as const)(
    'names no console link in a synced platform’s %s approval refusal, and fits a Telegram alert',
    (why) => {
      const told = approvalRefusalText(why, 'https://console.example.test/s', TELEGRAM_CALLBACK_ANSWER_LIMIT)
      expect(told).not.toContain('in the console')
      expect(told).not.toContain('console.example.test')
      expect(told).not.toContain(CHAT_LINK_HINT)
      expect(told.length).toBeLessThanOrEqual(TELEGRAM_CALLBACK_ANSWER_LIMIT)
    }
  )
})

describe('the approval-card facet', () => {
  it('is registered on every platform with interactive buttons, and on no surface core renders for', () => {
    const daemon: any = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
    const facet = (platform: string) => daemon.turnSurfaces.exact(platform)?.approvalCards?.platform
    const carded = ['slack', 'telegram', 'discord', 'feishu', 'googlechat']
    expect(carded.map(facet)).toEqual(carded)
    // QQ's message buttons need a provider grant a bot cannot count on, so it keeps the console.
    for (const platform of ['webchat', 'hook', 'dream', 'qq']) expect(facet(platform)).toBeUndefined()
  })

  it('routes a sub-session’s request to its Telegram or Discord conversation', async () => {
    for (const platform of ['telegram', 'discord'] as const) {
      const daemon: any = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
      const store = await LocalStore.open({ database: SqliteAsyncDatabase.adopt(new DatabaseSync(':memory:')) })
      daemon.store = store
      daemon.agents.set(AGENT, {
        id: AGENT,
        name: 'Butler',
        chatActions: 'approve',
        assistantMode: { enabled: true },
        integrations: [integration(platform)]
      })
      const parentKey = sessionKey(platform, CHAT, THREAD[platform], AGENT)
      await store.upsertSession({
        key: parentKey,
        agentId: AGENT,
        platform,
        channel: CHAT,
        thread: THREAD[platform],
        acpSessionId: 'acp-parent',
        sessionId: 'sid-parent',
        state: 'idle',
        lastDeliveredTs: null,
        updatedAt: Date.now()
      })
      const childKey = sessionKey(platform, CHAT, subsessionCoordinate('500.5'), AGENT)
      await store.assistantSubsessions.open({
        agentId: AGENT,
        childSessionKey: childKey,
        parentSessionId: 'sid-parent',
        parentSessionKey: parentKey
      })
      const route = await daemon.subsessionApprovalRoute({
        plan: { agentId: AGENT, sessionKey: childKey },
        entry: { msg: { text: 'fix it' } }
      })
      expect(route.place).toEqual({
        kind: 'chat',
        integrationId: INT,
        channel: CHAT,
        thread: THREAD[platform],
        external: false
      })
      await store.close()
    }
  })
})

/** A coordinator holding one background sub-session's turn, whose parent conversation is on `platform`. */
async function subsessionWorld(platform: Platform, over: { chatOn: boolean; database?: DatabaseSync }) {
  const store = await LocalStore.open({
    database: SqliteAsyncDatabase.adopt(over.database ?? new DatabaseSync(':memory:'))
  })
  const owner = agentHostKey(AGENT)
  const fake = fakeConn(platform)
  const surfaces = (new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null }) as any).turnSurfaces
  const facet = surfaces.exact(platform)?.approvalCards
  const thread = subsessionCoordinate('500.5')
  const p = {
    plan: {
      sessionKey: sessionKey(platform, CHAT, thread, AGENT),
      agentId: AGENT,
      agentName: 'Butler',
      platform,
      channel: CHAT,
      integrationId: INT,
      requesterId: AGENT,
      sessionThread: thread,
      statusThread: thread,
      approvalSurfaceSuppressed: false
    },
    approval: { waitMs: 0, depth: 0 },
    acpSessionId: 'acp-sub',
    hostKey: owner,
    outwardSessionId: 'sid-sub',
    builtinSystemToolCallIds: new Set<string>(),
    entry: { msg: { text: 'fix it' } }
  } as unknown as Pending
  const pending = new Map<string, Pending>([[pendingTurnKey(owner, 'acp-sub'), p]])
  const route: SubsessionApprovalRoute = {
    parentSessionId: 'sid-parent',
    title: 'Fix the flaky test',
    place: {
      kind: 'chat',
      integrationId: INT,
      channel: CHAT,
      thread: platform === 'telegram' ? 'tg:55' : 'TH9',
      external: false
    },
    waitHours: 12
  }
  const host = {
    log: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) as never,
    clock: () => new FakeClock(1_000_000),
    cancelTurn: vi.fn(async () => {}),
    store: () => store,
    agents: () =>
      new Map([[AGENT, { id: AGENT, name: 'Butler', chatActions: over.chatOn ? 'approve' : 'talk' } as never]]),
    pending: () => pending,
    evalHooks: () => ({ emit: vi.fn() }) as never,
    memoryExtraction: () => undefined,
    enqueueApply: vi.fn(),
    postCardSerialized: vi.fn(async () => undefined),
    elicitCardFacet: () => undefined,
    approvalCardFacet: () => facet,
    chatCardsAt: (integrationId: string) => (integrationId === INT && facet ? { facet, conn: fake.conn } : undefined),
    httpSlackSessionTarget: () => undefined,
    maskAgentSecrets: (_agentId: string, payload: unknown) => payload,
    logSessionAction: vi.fn(),
    emitApprovalActivity: vi.fn(),
    approvalGateOpened: () => false,
    approvalGateClosed: vi.fn(),
    cpApprovalRoute: () => undefined,
    orgForAgent: () => 'org-1',
    sessionLink: (sessionId: string) => `https://console.example.test/sessions/${sessionId}`,
    slackConnFor: () => undefined,
    approvalDmIntegrations: () => [],
    slackDmSessionTarget: () => 'target',
    subsessionApprovalRoute: vi.fn(async () => route),
    chatSurface: () => 'open',
    chatEditorsOnly: () => false,
    chatActor: async () => 'allowed'
  } as unknown as PermissionHost
  const coordinator = new PermissionCoordinator(host)
  const requestId = async (): Promise<string> => {
    await vi.waitFor(() => expect(coordinator.pendingSubsessionApprovals(AGENT)).toHaveLength(1))
    return coordinator.pendingSubsessionApprovals(AGENT)[0]!.requestId
  }
  return { store, coordinator, requestId, ...fake }
}

const subParams = (): RequestPermissionRequest =>
  ({ ...permission(), sessionId: 'acp-sub' }) as RequestPermissionRequest

describe.each(['telegram', 'discord'] as const)('a sub-session’s request in its %s conversation', (platform) => {
  const owner = agentHostKey(AGENT)

  it('cards the conversation, names the sub-session, and settles on a click there', async () => {
    const w = await subsessionWorld(platform, { chatOn: true })
    const decided = w.coordinator.onAcpPermission(owner, 'acp-sub', subParams())
    const id = await w.requestId()
    await vi.waitFor(() => expect(w.posts()).toHaveLength(1))
    const card = w.posts()[0]!
    expect(card.text).toContain('background work “Fix the flaky test” is asking for permission')
    expect(card.text).toContain('https://console.example.test/sessions/sid-sub')
    expect(card.labels).toEqual(['Always allow', 'Allow', 'Deny'])
    if (platform === 'telegram') expect(card).toMatchObject({ channel: CHAT, anchor: { replyTo: 55 } })
    else expect(card.channel).toBe('TH9')
    await vi.waitFor(() => expect(w.coordinator.dmNotifiedVia(id, AGENT, INT)).toBe(true))

    expect(await w.coordinator.handlePermissionChoice({ requestId: id, option: 0, actor: ADA })).toBeUndefined()
    await expect(decided).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'always' } })
    await vi.waitFor(() => expect(w.rewrites()).toHaveLength(1))
    const settled = w.rewrites()[0]!
    expect(settled.text).toContain('background work “Fix the flaky test”')
    expect(settled.text).toContain('✅ Always allow — Ada Example')
    expect(settled.live).toBe(false)
    await w.store.close()
  })

  it('leaves a notice where nobody there may answer, rewritten once the request settles', async () => {
    const w = await subsessionWorld(platform, { chatOn: false })
    void w.coordinator.onAcpPermission(owner, 'acp-sub', subParams())
    const id = await w.requestId()
    await vi.waitFor(() => expect(w.posts()).toHaveLength(1))
    expect(w.posts()[0]!.text).toContain('is waiting for permission. Ask an Agent editor')
    expect(w.posts()[0]!.labels).toEqual([])
    await vi.waitFor(async () =>
      expect((await w.store.listPermissionRequests(AGENT))[0]).toMatchObject({ noticeTs: expect.any(String) })
    )
    await w.coordinator.decideEditorPermission({
      agentId: AGENT,
      requestId: id,
      decision: 'allow',
      decidedByName: 'Ed'
    })
    await vi.waitFor(() => expect(w.rewrites()).toHaveLength(1))
    expect(w.rewrites()[0]!.text).toContain('got permission from Ed')
    await w.store.close()
  })

  it('retires the card a restart left behind once the integration reconnects', async () => {
    const database = new DatabaseSync(':memory:')
    const w = await subsessionWorld(platform, { chatOn: true, database })
    void w.coordinator.onAcpPermission(owner, 'acp-sub', subParams())
    const id = await w.requestId()
    await vi.waitFor(() => expect(w.coordinator.dmNotifiedVia(id, AGENT, INT)).toBe(true))

    // The next process expires every request no resolver holds, and its reconnect sweep rewrites the card once.
    const restarted = await subsessionWorld(platform, { chatOn: true, database })
    await restarted.coordinator.retireOrphanedCards(INT)
    await restarted.coordinator.retireOrphanedCards(INT)
    expect(restarted.rewrites()).toHaveLength(1)
    expect(restarted.rewrites()[0]!).toMatchObject({ ts: '101', live: false })
    expect(restarted.rewrites()[0]!.text).toContain('⏳ expired')
    await restarted.store.close()
  })
})

describe('Discord interactions on approval cards', () => {
  /** A Discord connection whose card handlers answer with `refusal`, and a clicked button. */
  function clicked(customId: string, refusal: string | undefined) {
    const onApprovalChoice = vi.fn(async () => refusal)
    const onElicitChoice = vi.fn(async () => refusal)
    const conn: any = new DiscordConnection({
      group: { botToken: 'token', integrations: [] },
      onMessage: () => {},
      newTraceId: () => 'trace',
      onApprovalChoice,
      onElicitChoice
    })
    const interaction = {
      customId,
      user: { id: '42', bot: false, globalName: 'Ada Example', username: 'ada' },
      message: { id: 'm7' },
      deferUpdate: vi.fn(async () => {}),
      followUp: vi.fn(async () => {})
    }
    return { conn, interaction, onApprovalChoice, onElicitChoice }
  }

  it('answers a refused permission click ephemerally, to the clicker alone', async () => {
    const c = clicked('ac_pm:abc-1:2', 'Only an Agent editor can answer this request.')
    await c.conn.onApprovalInteraction(c.interaction, { requestId: 'abc-1', option: 2 })
    expect(c.onApprovalChoice).toHaveBeenCalledWith({
      requestId: 'abc-1',
      option: 2,
      ts: 'm7',
      actor: { userId: '42', isBot: false, name: 'Ada Example' }
    })
    expect(c.interaction.deferUpdate).toHaveBeenCalledOnce()
    expect(c.interaction.followUp).toHaveBeenCalledWith({
      content: 'Only an Agent editor can answer this request.',
      flags: MessageFlags.Ephemeral
    })
  })

  it('says nothing more for a click that was taken', async () => {
    const c = clicked('ac_pm:abc-1:0', undefined)
    await c.conn.onApprovalInteraction(c.interaction, { requestId: 'abc-1', option: 0 })
    expect(c.interaction.deferUpdate).toHaveBeenCalledOnce()
    expect(c.interaction.followUp).not.toHaveBeenCalled()
  })

  it('answers a refused elicitation-card tap ephemerally too', async () => {
    const c = clicked('ac_el:abc-1:ac_o0', 'refused')
    await c.conn.onElicitInteraction(c.interaction, { requestId: 'abc-1', token: 'ac_o0' })
    expect(c.interaction.followUp).toHaveBeenCalledWith({ content: 'refused', flags: MessageFlags.Ephemeral })
  })
})
