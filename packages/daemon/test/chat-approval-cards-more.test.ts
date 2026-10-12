// Feishu/Lark and Google Chat carry the in-conversation permission card too, and synced Feishu/Lark takes chat actions only from editors, matched by union_id.
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import type { CreateElicitationRequest, RequestPermissionRequest } from '@agentclientprotocol/sdk'
import { CHAT_ACTOR_V1_FEATURE, GOOGLE_CHAT_ELICIT_FUNCTION } from '@agentconnect.md/protocol'
import { FakeClock } from '@agentconnect.md/connection'
import { agentHostKey } from '../src/acp/host-key.js'
import { CHAT_LINK_HINT } from '../src/agents/chat-actions.js'
import { senderActor } from '../src/commands/handlers.js'
import { Daemon } from '../src/daemon.js'
import { pendingTurnKey, type Pending } from '../src/daemon/turn-types.js'
import { FeishuConnection } from '../src/feishu/connection.js'
import { feishuEventToMessageLike, normalizeFeishuMessage } from '../src/feishu/normalize.js'
import { WorkBoundary } from '../src/messages/message-boundary.js'
import { PermissionCoordinator, type PermissionHost } from '../src/permissions/coordinator.js'
import type { SubsessionApprovalRoute } from '../src/permissions/subsession-approval.js'
import { applyGoogleChatAction, type GoogleChatTurnState } from '../src/platforms/googlechat/turn-output.js'
import { TerminalOutputFolder } from '../src/session/terminal-output-folder.js'
import { subsessionCoordinate } from '../src/session/subsession-coordinate.js'
import { LocalStore, sessionKey } from '../src/store/local-store.js'
import { SqliteAsyncDatabase } from '../src/store/sqlite-async-database.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'

type Platform = 'feishu' | 'googlechat'
type Core = Record<string, unknown>

const AGENT = 'agent-1'
const INT = 'int-1'
const EVENTS_URL = 'https://events.example.test/googlechat'
const ADA = { userId: 'ou_ada', name: 'Ada Example', memberId: 'on_ada' }

/** Each platform's conversation and the thread the turn lives in. */
const PLACE: Record<Platform, { channel: string; thread: string }> = {
  feishu: { channel: 'oc_chat', thread: 'om_root' },
  googlechat: { channel: 'spaces/AAA', thread: 'spaces/AAA/threads/T1' }
}

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

/** A fake connection for `platform` recording every card and rewrite as text, and every private line. */
function fakeConn(platform: Platform) {
  let n = 100
  if (platform === 'feishu') {
    const conn = Object.create(FeishuConnection.prototype)
    conn.postElicitCard = vi.fn(async () => `om_card${++n}`)
    conn.updateElicitCard = vi.fn(async () => {})
    const cardText = (card: unknown) => JSON.stringify(card)
    return {
      conn,
      posts: () =>
        conn.postElicitCard.mock.calls.map((c: unknown[]) => ({
          channel: c[0] as string,
          thread: c[1] as string | undefined,
          text: cardText(c[2]),
          live: cardText(c[2]).includes('agentconnect_approval')
        })),
      rewrites: () =>
        conn.updateElicitCard.mock.calls.map((c: unknown[]) => ({
          ts: c[0] as string,
          text: cardText(c[1]),
          live: cardText(c[1]).includes('agentconnect_approval')
        })),
      privately: () => [] as Array<{ to: string; text: string }>
    }
  }
  const conn = {
    eventsUrl: EVENTS_URL,
    createMessage: vi.fn(async (input: { space: string }) => ({ name: `${input.space}/messages/m${++n}` })),
    patchCards: vi.fn(async () => {})
  }
  type Create = { space: string; thread?: string; cardsV2?: unknown[]; text?: string; privateViewer?: string }
  const calls = () => conn.createMessage.mock.calls.map((c) => c[0] as Create)
  return {
    conn,
    posts: () =>
      calls()
        .filter((c) => !c.privateViewer)
        .map((c) => ({
          channel: c.space,
          thread: c.thread,
          text: JSON.stringify(c.cardsV2 ?? c.text),
          live: JSON.stringify(c.cardsV2 ?? '').includes('"approval"')
        })),
    rewrites: () =>
      conn.patchCards.mock.calls.map((c: unknown[]) => ({
        ts: c[0] as string,
        text: JSON.stringify(c[1]),
        live: JSON.stringify(c[1]).includes('"approval"')
      })),
    privately: () =>
      calls()
        .filter((c) => c.privateViewer)
        .map((c) => ({ to: c.privateViewer!, text: c.text ?? '' }))
  }
}

/** A daemon holding one live turn on `platform`, with every post, notice and control-plane question captured. */
async function world(
  platform: Platform,
  opts: { level: 'talk' | 'approve' | 'settings'; core?: Core; editors?: Set<string>; linked?: Set<string> }
) {
  const daemon: any = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
  daemon.cfg = { ...(daemon.cfg ?? {}), webAppUrl: 'https://console.example.test' }
  const store = await LocalStore.open({ database: SqliteAsyncDatabase.adopt(new DatabaseSync(':memory:')) })
  daemon.store = store
  const int = integration(platform, opts.core)
  const agent = { id: AGENT, name: 'Butler', chatActions: opts.level, integrations: [int] }
  daemon.agents.set(AGENT, agent)
  const fake = fakeConn(platform)
  if (platform === 'feishu') daemon.fsConnByIntegration.set(INT, fake.conn)
  else daemon.gcConnByIntegration.set(INT, fake.conn)
  // The control plane's verify: an editor's linked union_id is allowed, a linked member is refused, anyone else is unlinked.
  const asked: string[] = []
  const approvalRoute = vi.fn(async (payload: { requestId: string; verify?: { userId: string } }) => {
    const userId = payload.verify?.userId ?? ''
    asked.push(userId)
    return opts.editors?.has(userId)
      ? { requestId: payload.requestId, allowed: true, displayName: 'Ed Itor' }
      : { requestId: payload.requestId, allowed: false, linked: opts.linked?.has(userId) === true }
  })
  daemon.cpClient = { supportsServerFeature: (f: string) => f === CHAT_ACTOR_V1_FEATURE, approvalRoute }
  const applied: any[] = []
  daemon.enqueueApply = (_p: unknown, action: unknown) => void applied.push(action)
  const { channel, thread } = PLACE[platform]
  const pending = {
    plan: {
      platform,
      agentId: AGENT,
      agentName: 'Butler',
      integrationId: INT,
      sessionKey: `${platform}:${channel}:${thread}:${AGENT}`,
      requesterId: 'on_asker',
      channel,
      thread,
      transcriptChannel: channel,
      statusThread: thread,
      sessionThread: thread,
      isDm: false,
      approvalSurfaceSuppressed: false,
      suppressReplyConn: false
    },
    entry: { msg: { source: 'user', text: 'please write it', sender: { id: 'on_asker', isBot: false } } },
    // Feishu answers through its reply connection, Google Chat through the egress it leased.
    ...(platform === 'feishu' ? { conn: fake.conn } : { egress: fake.conn }),
    hostKey: AGENT,
    outwardSessionId: 'sid-1',
    turnState:
      platform === 'googlechat' ? { conn: fake.conn, space: channel, thread, deliveryId: 'd-1', block: 0 } : {},
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
  /** Click a permission card's option as the platform's ingress delivers it; what only the clicker was told by the click's own answer. */
  const click = async (
    option: number,
    actor: { userId: string; name?: string; memberId?: string; isBot?: boolean } = ADA
  ) => {
    const requestId = onlyRequest()
    if (platform === 'feishu')
      return await daemon
        .connectionReconcilerHost()
        .handlePermissionPick({ requestId, option, ts: 'om_card101', actor })
    const ack = await daemon.handleRelayGoogleChatAction(
      { msgId: `m-${option}`, agentId: AGENT, integrationId: INT, userId: actor.userId },
      {
        function: GOOGLE_CHAT_ELICIT_FUNCTION,
        parameters: { approval: requestId, option: String(option) },
        formInputs: {},
        message: `${channel}/messages/m101`,
        ...(actor.name ? { userName: actor.name } : {})
      }
    )
    expect(ack).toMatchObject({ accepted: true })
    return undefined
  }
  /** Tap an elicitation card's option as the ingress delivers it; what only the tapper was told by the tap's own answer. */
  const tap = async (token: string, actor = ADA) => {
    const requestId = onlyRequest()
    if (platform === 'feishu')
      return await daemon.connectionReconcilerHost().handleElicitCardTap({ requestId, token, actor })
    await daemon.handleRelayGoogleChatAction(
      { msgId: `t-${token}`, agentId: AGENT, integrationId: INT, userId: actor.userId },
      {
        function: GOOGLE_CHAT_ELICIT_FUNCTION,
        parameters: { request: requestId, token },
        formInputs: {},
        message: `${channel}/messages/m101`,
        userName: actor.name
      }
    )
    return undefined
  }
  /** What the clicker was told privately: Feishu's click answer (its toast), Google Chat's private message. */
  const toldPrivately = async (told: string | undefined): Promise<string | undefined> => {
    if (platform === 'feishu') return told
    await vi.waitFor(() => expect(fake.privately()).toHaveLength(1))
    expect(fake.privately()[0]!.to).toBe(ADA.userId)
    return fake.privately()[0]!.text
  }
  return { daemon, store, agent, int, permissions, notices, onlyRequest, click, tap, toldPrivately, asked, ...fake }
}

describe.each(['feishu', 'googlechat'] as const)('%s permission cards', (platform) => {
  it('posts the card where the request came from, offering the runtime’s own choices', async () => {
    const w = await world(platform, { level: 'approve' })
    void w.permissions.onAcpPermission(AGENT, 's1', permission())
    await vi.waitFor(() => expect(w.posts()).toHaveLength(1))
    const card = w.posts()[0]!
    const id = w.onlyRequest()
    expect(card).toMatchObject({ channel: PLACE[platform].channel, thread: PLACE[platform].thread, live: true })
    for (const words of ['Permission requested', 'Write example.txt', 'Always allow', 'Allow', 'Deny', id])
      expect(card.text).toContain(words)
    if (platform === 'googlechat') expect(card.text).toContain(EVENTS_URL)
    expect(w.notices()).toEqual([])
    await w.store.close()
  })

  it('leaves the notice and the console where people may only talk, or the conversation is closed', async () => {
    for (const opts of [
      { level: 'talk' as const },
      { level: 'settings' as const, core: { mutedChannels: [PLACE[platform].channel] } }
    ]) {
      const w = await world(platform, opts)
      void w.permissions.onAcpPermission(AGENT, 's1', permission())
      await vi.waitFor(() => expect(w.notices()).toEqual([expect.stringContaining('Ask an Agent editor')]))
      expect(w.posts()).toEqual([])
      await w.store.close()
    }
  })

  it('takes a participant’s click as the decision, and the card says who answered', async () => {
    const w = await world(platform, { level: 'approve' })
    const decided = w.permissions.onAcpPermission(AGENT, 's1', permission())
    await vi.waitFor(() => expect(w.posts()).toHaveLength(1))
    expect(await w.click(1)).toBeUndefined()
    await expect(decided).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } })
    await vi.waitFor(() => expect(w.rewrites()).toHaveLength(1))
    expect(w.rewrites()[0]!.live).toBe(false)
    expect(w.rewrites()[0]!.text).toContain('✅ Allow — Ada Example')
    expect((await w.store.listPermissionRequests(AGENT))[0]).toMatchObject({
      status: 'allowed',
      resolvedBy: `${platform}:${ADA.userId}`,
      resolvedByName: 'Ada Example'
    })
    await w.store.close()
  })

  it('never takes a bot’s click', async () => {
    const w = await world(platform, { level: 'approve' })
    const decided = vi.fn()
    void w.permissions.onAcpPermission(AGENT, 's1', permission()).then(decided)
    await vi.waitFor(() => expect(w.posts()).toHaveLength(1))
    await w.permissions.handlePermissionChoice({
      requestId: w.onlyRequest(),
      option: 1,
      actor: { userId: 'bot-1', isBot: true }
    })
    expect(w.permissions.pendingApprovals.size).toBe(1)
    expect(w.rewrites()).toEqual([])
    expect(decided).not.toHaveBeenCalled()
    await w.store.close()
  })

  it('tells a refused clicker privately and leaves the card as it is', async () => {
    const w = await world(platform, { level: 'approve' })
    void w.permissions.onAcpPermission(AGENT, 's1', permission())
    await vi.waitFor(() => expect(w.posts()).toHaveLength(1))
    w.int.core.mutedChannels = [PLACE[platform].channel]
    const told = await w.toldPrivately(await w.click(1))
    expect(told).toContain('Only an Agent editor can answer this request')
    expect(w.rewrites()).toEqual([])
    expect(w.permissions.pendingApprovals.size).toBe(1)
    expect(w.notices()).toEqual([])
    await w.store.close()
  })

  it('rewrites the card when an Agent editor answers in the console, and retires it when approving in chat is turned off', async () => {
    const w = await world(platform, { level: 'approve' })
    const decided = w.permissions.onAcpPermission(AGENT, 's1', permission())
    await vi.waitFor(() => expect(w.posts()).toHaveLength(1))
    w.agent.chatActions = 'talk'
    w.permissions.disableChatPermissionSurfaces(AGENT)
    await vi.waitFor(() => expect(w.rewrites()).toHaveLength(1))
    expect(w.rewrites()[0]!.text).toContain('Approving in chat was turned off')
    expect(w.rewrites()[0]!.live).toBe(false)
    await w.permissions.decideEditorPermission({
      agentId: AGENT,
      requestId: w.onlyRequest(),
      decision: 'deny',
      decidedByName: 'Ed'
    })
    await expect(decided).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'deny' } })
    await vi.waitFor(() => expect(w.rewrites()).toHaveLength(2))
    expect(w.rewrites()[1]!.text).toContain('🚫 Deny — Ed')
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
    w.int.core.mutedChannels = [PLACE[platform].channel]
    expect(await w.toldPrivately(await w.tap('ac_o0'))).toContain('Only an Agent editor can answer this request')
    w.int.core.mutedChannels = []
    expect(await w.tap('ac_o0')).toBeUndefined()
    await expect(decided).resolves.toMatchObject({ action: 'accept', content: { persist: 'once' } })
    await vi.waitFor(() => expect(w.rewrites()).toHaveLength(1))
    expect(w.rewrites()[0]!.text).toContain('Ada Example')
    await w.store.close()
  })
})

describe('synced Feishu/Lark takes chat actions only from the agent’s editors, by union_id', () => {
  const synced = (level: 'approve' | 'settings' = 'approve') =>
    world('feishu', {
      level,
      core: { chatAuthority: 'editors' },
      editors: new Set(['on_editor']),
      linked: new Set(['on_member'])
    })

  it('takes an editor’s click, matched by the union_id the click carried', async () => {
    const w = await synced()
    const decided = w.permissions.onAcpPermission(AGENT, 's1', permission())
    await vi.waitFor(() => expect(w.posts()).toHaveLength(1))
    expect(await w.click(1, { userId: 'ou_editor', name: 'Ed', memberId: 'on_editor' })).toBeUndefined()
    await expect(decided).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } })
    expect(w.asked).toEqual(['on_editor'])
    await w.store.close()
  })

  it('refuses anyone else privately, telling an unlinked person how to link', async () => {
    const w = await synced()
    void w.permissions.onAcpPermission(AGENT, 's1', permission())
    await vi.waitFor(() => expect(w.posts()).toHaveLength(1))
    const member = await w.click(1, { userId: 'ou_member', memberId: 'on_member' })
    expect(member).toContain('Only an Agent editor can answer this request')
    expect(member).not.toContain(CHAT_LINK_HINT)
    expect(await w.click(1, { userId: 'ou_stranger', memberId: 'on_stranger' })).toContain(CHAT_LINK_HINT)
    expect(w.permissions.pendingApprovals.size).toBe(1)
    expect(w.rewrites()).toEqual([])
    await w.store.close()
  })

  it('refuses a click that carries no union_id without asking the control plane', async () => {
    const w = await synced()
    void w.permissions.onAcpPermission(AGENT, 's1', permission())
    await vi.waitFor(() => expect(w.posts()).toHaveLength(1))
    expect(await w.click(1, { userId: 'ou_editor', name: 'Ed' })).toContain(
      'Only an Agent editor can answer this request'
    )
    expect(w.asked).toEqual([])
    expect(w.permissions.pendingApprovals.size).toBe(1)
    await w.store.close()
  })

  it('judges a typed settings command by the union_id its message carried', async () => {
    const w = await synced('settings')
    const typed = (unionId: string) =>
      senderActor(
        normalizeFeishuMessage(
          feishuEventToMessageLike({
            sender: { sender_id: { open_id: `ou_${unionId}`, union_id: unionId }, sender_type: 'user' },
            message: {
              message_id: 'om_1',
              chat_id: 'oc_chat',
              chat_type: 'group',
              message_type: 'text',
              content: '{"text":"/model"}'
            }
          }),
          { traceId: 't' }
        )
      )
    expect(typed('on_editor')).toMatchObject({ memberId: 'on_editor' })
    await expect(w.daemon.chatActor(AGENT, INT, typed('on_editor'))).resolves.toBe('allowed')
    await expect(w.daemon.chatActor(AGENT, INT, typed('on_member'))).resolves.toBe('not-editor')
    await expect(w.daemon.chatActor(AGENT, INT, typed('on_stranger'))).resolves.toBe('unlinked')
    expect(w.asked).toEqual(['on_editor', 'on_member', 'on_stranger'])
    await w.store.close()
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
      sessionKey: sessionKey(platform, PLACE[platform].channel, thread, AGENT),
      agentId: AGENT,
      agentName: 'Butler',
      platform,
      channel: PLACE[platform].channel,
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
    place: { kind: 'chat', integrationId: INT, ...PLACE[platform], external: false },
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

describe.each(['feishu', 'googlechat'] as const)('a sub-session’s request in its %s conversation', (platform) => {
  const owner = agentHostKey(AGENT)

  it('cards the conversation, names the sub-session, and settles on a click there', async () => {
    const w = await subsessionWorld(platform, { chatOn: true })
    const decided = w.coordinator.onAcpPermission(owner, 'acp-sub', subParams())
    const id = await w.requestId()
    await vi.waitFor(() => expect(w.posts()).toHaveLength(1))
    const card = w.posts()[0]!
    expect(card).toMatchObject({ channel: PLACE[platform].channel, thread: PLACE[platform].thread, live: true })
    expect(card.text).toContain('background sub-session “Fix the flaky test” is asking for permission')
    expect(card.text).toContain('https://console.example.test/sessions/sid-sub')
    await vi.waitFor(() => expect(w.coordinator.dmNotifiedVia(id, AGENT, INT)).toBe(true))
    await w.coordinator.handlePermissionChoice({ requestId: id, option: 0, actor: ADA })
    await expect(decided).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'always' } })
    await vi.waitFor(() => expect(w.rewrites()).toHaveLength(1))
    expect(w.rewrites()[0]!.text).toContain('✅ Always allow — Ada Example')
    expect(w.rewrites()[0]!.live).toBe(false)
    await w.store.close()
  })

  it('leaves a notice where nobody there may answer, rewritten once the request settles', async () => {
    const w = await subsessionWorld(platform, { chatOn: false })
    void w.coordinator.onAcpPermission(owner, 'acp-sub', subParams())
    const id = await w.requestId()
    await vi.waitFor(() => expect(w.posts()).toHaveLength(1))
    expect(w.posts()[0]!.text).toContain('is waiting for permission. Ask an Agent editor')
    expect(w.posts()[0]!.live).toBe(false)
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
    const restarted = await subsessionWorld(platform, { chatOn: true, database })
    await restarted.coordinator.retireOrphanedCards(INT)
    await restarted.coordinator.retireOrphanedCards(INT)
    expect(restarted.rewrites()).toHaveLength(1)
    expect(restarted.rewrites()[0]!.text).toContain('⏳ expired')
    expect(restarted.rewrites()[0]!.live).toBe(false)
    await restarted.store.close()
  })
})

describe('Feishu/Lark card actions', () => {
  /** A real Feishu connection whose card handlers answer with `refusal`. */
  function connection(refusal: string | undefined) {
    const onApprovalChoice = vi.fn(async () => refusal)
    const onElicitChoice = vi.fn(async () => refusal)
    const conn = new FeishuConnection(
      {
        group: { appId: 'cli_example', appSecret: 'secret', mode: 'direct', region: 'feishu', integrations: [] },
        onMessage: () => {},
        onApprovalChoice,
        onElicitChoice,
        newTraceId: () => 'trace',
        sendIntervalMs: 0
      },
      (() => ({})) as never
    )
    return { conn, onApprovalChoice, onElicitChoice }
  }
  const event = (value: Record<string, string>) => ({
    context: { open_message_id: 'om_card', open_chat_id: 'oc_chat' },
    operator: { open_id: 'ou_ada', union_id: 'on_ada', name: 'Ada Example' },
    action: { tag: 'button', value }
  })

  it('answers a refused click in the toast only the clicker sees, carrying their union_id', async () => {
    const c = connection('Only an Agent editor can answer this request.')
    await expect(
      c.conn.handleCardAction(event({ action: 'agentconnect_approval', request: 'req-1', option: '2' }))
    ).resolves.toEqual({ toast: { type: 'warning', content: 'Only an Agent editor can answer this request.' } })
    expect(c.onApprovalChoice).toHaveBeenCalledWith({
      requestId: 'req-1',
      option: 2,
      ts: 'om_card',
      actor: { userId: 'ou_ada', memberId: 'on_ada', name: 'Ada Example' }
    })
  })

  it('answers a refused elicitation tap the same way, and a taken click with nothing', async () => {
    const refused = connection('refused')
    await expect(
      refused.conn.handleCardAction(event({ action: 'agentconnect_elicit', request: 'req-1', token: 'ac_o0' }))
    ).resolves.toEqual({ toast: { type: 'warning', content: 'refused' } })
    const taken = connection(undefined)
    await expect(
      taken.conn.handleCardAction(event({ action: 'agentconnect_approval', request: 'req-1', option: '0' }))
    ).resolves.toBeUndefined()
  })
})

describe('Google Chat notices', () => {
  it('posts a core notice as its own message in the turn’s thread', async () => {
    const createMessage = vi.fn(async () => ({ name: 'spaces/AAA/messages/n1' }))
    const state = {
      conn: { createMessage, patchMessage: vi.fn() },
      space: 'spaces/AAA',
      thread: 'spaces/AAA/threads/T1',
      deliveryId: 'd-1',
      block: 0
    } as unknown as GoogleChatTurnState
    const host = { warn: vi.fn(), recordReplySegment: vi.fn(), appendTranscript: vi.fn(), nowUs: () => 0 }
    await applyGoogleChatAction(host as never, {} as never, state, { kind: 'notice', text: '🔒 Permission requested.' })
    expect(createMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        space: 'spaces/AAA',
        thread: 'spaces/AAA/threads/T1',
        text: '🔒 Permission requested.'
      })
    )
  })
})
