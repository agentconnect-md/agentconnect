// Feishu/Lark and Google Chat carry the in-conversation permission card too, and synced Feishu/Lark takes chat actions only from editors, matched by union_id.
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import type { CreateElicitationRequest, RequestPermissionRequest } from '@agentclientprotocol/sdk/unstable'
import {
  APPROVAL_DM_ROUTE_V1_FEATURE,
  CHAT_ACTOR_V1_FEATURE,
  GOOGLE_CHAT_ELICIT_FUNCTION,
  WireFeishuCardActionValue
} from '@agentconnect.md/protocol'
import { FakeClock } from '@agentconnect.md/connection'
import { agentHostKey } from '../src/acp/host-key.js'
import { senderActor } from '../src/commands/handlers.js'
import { Daemon } from '../src/daemon.js'
import { pendingTurnKey, type Pending } from '../src/daemon/turn-types.js'
import { FeishuConnection } from '../src/feishu/connection.js'
import { feishuEventToMessageLike, normalizeFeishuMessage } from '../src/feishu/normalize.js'
import { WorkBoundary } from '../src/messages/message-boundary.js'
import { PermissionCoordinator, type PermissionHost } from '../src/permissions/coordinator.js'
import { TURN_NOTICE_TEXT } from '../src/platforms/approval-card.js'
import { parseFeishuApproval } from '../src/platforms/feishu/approval-card.js'
import { parseFeishuElicit } from '../src/platforms/feishu/elicit-card.js'
import type { SubsessionApprovalRoute } from '../src/permissions/subsession-approval.js'
import { applyGoogleChatAction, type GoogleChatTurnState } from '../src/platforms/googlechat/turn-output.js'
import { applyQQAction, type QQTurnState } from '../src/platforms/qq/turn-output.js'
import { SlackConnection } from '../src/slack/connection.js'
import { TerminalOutputFolder } from '../src/session/terminal-output-folder.js'
import { subsessionCoordinate } from '../src/session/subsession-coordinate.js'
import { LocalStore, sessionKey } from '../src/store/local-store.js'
import { SqliteAsyncDatabase } from '../src/store/sqlite-async-database.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'

type Platform = 'feishu' | 'googlechat'
type Core = Record<string, unknown>

// UUIDs, as the relay's card-target schema requires of the ids a Feishu callback names.
const AGENT = '11111111-1111-4111-8111-111111111111'
const INT = '22222222-2222-4222-8222-222222222222'
const OTHER_INT = '33333333-3333-4333-8333-333333333333'
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
  opts: {
    level: 'talk' | 'approve' | 'settings'
    core?: Core
    editors?: Set<string>
    linked?: Set<string>
    /** Whose message started the turn, by the union_id a Feishu message carries as its sender's id. */
    asker?: string
    /** The agent also has a Slack integration, through which the approval DM goes. */
    slackDm?: boolean
  }
) {
  const daemon: any = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
  daemon.cfg = { ...(daemon.cfg ?? {}), webAppUrl: 'https://console.example.test' }
  const store = await LocalStore.open({ database: SqliteAsyncDatabase.adopt(new DatabaseSync(':memory:')) })
  daemon.store = store
  const int = integration(platform, opts.core)
  const slack = { ...integration('feishu'), id: 'int-slack', platform: 'slack' }
  const agent = {
    id: AGENT,
    name: 'Butler',
    chatActions: opts.level,
    integrations: opts.slackDm ? [int, slack] : [int]
  }
  const slackConn = Object.create(SlackConnection.prototype)
  slackConn.openDirectMessage = vi.fn(async (user: string) => `D-${user}`)
  slackConn.postBlocks = vi.fn(async () => 'dm-1')
  slackConn.updateBlocks = vi.fn(async () => true)
  slackConn.workspaceId = () => 'T1'
  if (opts.slackDm) daemon.connByIntegration.set('int-slack', slackConn)
  daemon.agents.set(AGENT, agent)
  const fake = fakeConn(platform)
  if (platform === 'feishu') daemon.fsConnByIntegration.set(INT, fake.conn)
  else daemon.gcConnByIntegration.set(INT, fake.conn)
  // The control plane's verify: an editor's linked union_id is allowed, a linked member is refused, anyone else is unlinked.
  const asked: string[] = []
  const approvalRoute = vi.fn(async (payload: { requestId: string; verify?: { userId: string } }) => {
    // The route form: the editor a DM goes to, over the agent's Slack integration.
    if (!payload.verify)
      return {
        requestId: payload.requestId,
        target: { integrationId: 'int-slack', teamId: 'T1', userId: 'U-ED', consoleUserId: 'cu-ed', displayName: 'Ed' }
      }
    const userId = payload.verify.userId
    asked.push(userId)
    return opts.editors?.has(userId)
      ? { requestId: payload.requestId, allowed: true, displayName: 'Ed Itor' }
      : { requestId: payload.requestId, allowed: false, linked: opts.linked?.has(userId) === true }
  })
  const features = new Set([CHAT_ACTOR_V1_FEATURE, APPROVAL_DM_ROUTE_V1_FEATURE])
  daemon.cpClient = { supportsServerFeature: (f: string) => features.has(f), approvalRoute }
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
      requesterId: opts.asker ?? 'on_asker',
      channel,
      thread,
      transcriptChannel: channel,
      statusThread: thread,
      sessionThread: thread,
      isDm: false,
      approvalSurfaceSuppressed: false,
      suppressReplyConn: false
    },
    entry: {
      msg: {
        source: 'user',
        text: 'please write it',
        sender: { id: opts.asker ?? 'on_asker', isBot: false, ...(opts.asker ? { memberId: opts.asker } : {}) }
      }
    },
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
  // The editor path's notice is posted on the card surface now, so it is told apart from a card here.
  const isNotice = (post: { text: string }): boolean => post.text.includes(TURN_NOTICE_TEXT)
  const all = (): any[] => fake.posts()
  const noticePosts = () => all().filter(isNotice)
  const posts = () => all().filter((post: any) => !isNotice(post))
  const notices = (): string[] => [
    ...applied.filter((a) => a.kind === 'notice').map((a) => a.text as string),
    ...noticePosts().map((post: any) => post.text)
  ]
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
  return {
    daemon,
    store,
    agent,
    int,
    permissions,
    notices,
    onlyRequest,
    click,
    tap,
    toldPrivately,
    asked,
    slackConn,
    approvalRoute,
    ...fake,
    posts,
    noticePosts
  }
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

  it('rewrites the notice once an Agent editor decides, naming them', async () => {
    const w = await world(platform, { level: 'talk' })
    const decided = w.permissions.onAcpPermission(AGENT, 's1', permission())
    await vi.waitFor(() => expect(w.noticePosts()).toHaveLength(1))
    const id = w.onlyRequest()
    await w.permissions.decideEditorPermission({ agentId: AGENT, requestId: id, decision: 'deny', decidedByName: 'Ed' })
    await expect(decided).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'deny' } })
    await vi.waitFor(() => expect(w.rewrites()).toHaveLength(1))
    expect(w.rewrites()[0]!.ts).toMatch(/101$/)
    expect(w.rewrites()[0]!.text).toContain('🚫 Permission denied by Ed.')
    expect(w.rewrites()[0]!.live).toBe(false)
    await w.store.close()
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
  const NOT_EDITOR = 'Only an Agent editor can answer this request.'
  const UNLINKED =
    'Only an Agent editor can answer this request, from a chat account linked to their console account. If that is you, link this account under Sign-in methods in your console Profile and try again.'
  const UNAVAILABLE =
    "Who you are can't be checked right now, so this request can't be answered here. Try again in a moment."
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
    // Neither is sent to a console page that shows this conversation only to the same people.
    expect(await w.click(1, { userId: 'ou_member', memberId: 'on_member' })).toBe(NOT_EDITOR)
    expect(await w.click(1, { userId: 'ou_stranger', memberId: 'on_stranger' })).toBe(UNLINKED)
    expect(w.permissions.pendingApprovals.size).toBe(1)
    expect(w.rewrites()).toEqual([])
    await w.store.close()
  })

  it('refuses a click that carries no union_id without asking the control plane', async () => {
    const w = await synced()
    void w.permissions.onAcpPermission(AGENT, 's1', permission())
    await vi.waitFor(() => expect(w.posts()).toHaveLength(1))
    expect(await w.click(1, { userId: 'ou_editor', name: 'Ed' })).toBe(UNAVAILABLE)
    expect(w.asked).toEqual([])
    expect(w.permissions.pendingApprovals.size).toBe(1)
    await w.store.close()
  })

  it('DMs an editor beside the card unless the person who asked is one, matched by their union_id', async () => {
    const askedByMember = await world('feishu', {
      level: 'approve',
      core: { chatAuthority: 'editors' },
      editors: new Set(['on_editor']),
      asker: 'on_member',
      slackDm: true
    })
    void askedByMember.permissions.onAcpPermission(AGENT, 's1', permission())
    await vi.waitFor(() => expect(askedByMember.slackConn.postBlocks).toHaveBeenCalledTimes(1))
    expect(askedByMember.slackConn.postBlocks.mock.calls[0]![0]).toBe('D-U-ED')
    expect(askedByMember.asked).toEqual(['on_member'])
    await askedByMember.store.close()

    const askedByEditor = await world('feishu', {
      level: 'approve',
      core: { chatAuthority: 'editors' },
      editors: new Set(['on_editor']),
      asker: 'on_editor',
      slackDm: true
    })
    void askedByEditor.permissions.onAcpPermission(AGENT, 's1', permission())
    await vi.waitFor(() => expect(askedByEditor.asked).toEqual(['on_editor']))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(askedByEditor.slackConn.postBlocks).not.toHaveBeenCalled()
    await askedByEditor.store.close()

    // Without a Slack integration nobody is DMed: the request waits for an editor in the conversation or the console.
    const feishuOnly = await world('feishu', {
      level: 'approve',
      core: { chatAuthority: 'editors' },
      editors: new Set(['on_editor']),
      asker: 'on_member'
    })
    void feishuOnly.permissions.onAcpPermission(AGENT, 's1', permission())
    await vi.waitFor(() => expect(feishuOnly.asked).toEqual(['on_member']))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(feishuOnly.approvalRoute.mock.calls.filter((call) => !(call[0] as { verify?: unknown }).verify)).toEqual([])
    await feishuOnly.store.close()
  })

  it('DMs the Computer owner beside a computer-use card (computer-use.md §4.2)', async () => {
    const COMPUTER_ID = '00000000-0000-4000-8000-0000000000c1'
    const ask = (asker: string) =>
      world('feishu', { level: 'approve', editors: new Set(['on_editor']), asker, slackDm: true })
    const params = () =>
      ({
        ...permission(),
        toolCall: { toolCallId: `computer-approval-${Math.random()}`, title: 'Computer use on “Desk”: click at (1, 2)' }
      }) as RequestPermissionRequest
    const live = (w: Awaited<ReturnType<typeof world>>) => ({
      ...w.daemon.pending.get(JSON.stringify([AGENT, 's1'])),
      acpSessionId: 's1'
    })

    const w = await ask('on_member')
    void w.permissions.askComputerApproval(live(w), params(), { computerId: COMPUTER_ID, ownerUserId: 'cu-ed' })
    await vi.waitFor(() => expect(w.posts()).toHaveLength(1))
    await vi.waitFor(() => expect(w.slackConn.postBlocks).toHaveBeenCalledTimes(1))
    expect(w.slackConn.postBlocks.mock.calls[0]![0]).toBe('D-U-ED')
    expect(w.approvalRoute.mock.calls[0]![0]).toMatchObject({ consoleUserId: 'cu-ed' })
    // The owner's DM stands in for the editor DM, so no second one follows.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(w.slackConn.postBlocks).toHaveBeenCalledTimes(1)
    await w.store.close()

    // An asker who may answer in the conversation needs no editor DM, yet the Computer owner still gets one.
    const editor = await ask('on_editor')
    void editor.permissions.askComputerApproval(live(editor), params(), {
      computerId: COMPUTER_ID,
      ownerUserId: 'cu-ed'
    })
    await vi.waitFor(() => expect(editor.posts()).toHaveLength(1))
    await vi.waitFor(() => expect(editor.slackConn.postBlocks).toHaveBeenCalledTimes(1))
    expect(editor.slackConn.postBlocks.mock.calls[0]![0]).toBe('D-U-ED')
    expect(
      editor.approvalRoute.mock.calls.some(
        ([payload]) => (payload as { consoleUserId?: string }).consoleUserId === 'cu-ed'
      )
    ).toBe(true)
    await editor.store.close()

    // A plain request never DMs beside its card here.
    const plain = await ask('on_member')
    void plain.permissions.onAcpPermission(AGENT, 's1', permission())
    await vi.waitFor(() => expect(plain.posts()).toHaveLength(1))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(plain.slackConn.postBlocks).not.toHaveBeenCalled()
    await plain.store.close()
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
async function subsessionWorld(
  platform: Platform,
  over: { chatOn: boolean; database?: DatabaseSync; placeIntegration?: string }
) {
  const at = over.placeIntegration ?? INT
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
    place: { kind: 'chat', integrationId: at, ...PLACE[platform], external: false },
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
    chatCardsAt: (integrationId: string) => (integrationId === at && facet ? { facet, conn: fake.conn } : undefined),
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
    expect(card.text).toContain('task “Fix the flaky test” is asking for permission')
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

/** Every callback value a CardKit card's buttons carry, wherever they sit in it. */
function callbackValues(card: unknown): unknown[] {
  const out: unknown[] = []
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child)
      return
    }
    if (!node || typeof node !== 'object') return
    const o = node as Record<string, unknown>
    if (o.type === 'callback' && 'value' in o) out.push(o.value)
    for (const child of Object.values(o)) walk(child)
  }
  walk(card)
  return out
}

describe('Feishu/Lark card callbacks name the integration a shared app’s relay routes them to', () => {
  const routed = { v: 1, agentId: AGENT, integrationId: INT }
  const twoFields = {
    sessionId: 's1',
    mode: 'form',
    message: 'Pick a branch and say why',
    requestedSchema: {
      type: 'object',
      properties: { branch: { type: 'string', enum: ['main', 'dev'] }, reason: { type: 'string' } },
      required: ['branch']
    }
  } as unknown as CreateElicitationRequest
  const postedValues = (conn: { postElicitCard: { mock: { calls: unknown[][] } } }): unknown[] =>
    callbackValues(conn.postElicitCard.mock.calls[0]![2])

  it('on the turn’s own permission card, every option still read as its request', async () => {
    const w = await world('feishu', { level: 'approve' })
    void w.permissions.onAcpPermission(AGENT, 's1', permission())
    await vi.waitFor(() => expect(w.posts()).toHaveLength(1))
    const values = postedValues(w.conn)
    expect(values).toHaveLength(3)
    values.forEach((value, option) => {
      expect(WireFeishuCardActionValue.parse(value).target).toEqual(routed)
      expect(parseFeishuApproval(value)).toEqual({ requestId: w.onlyRequest(), option })
    })
    await w.store.close()
  })

  it('on the elicitation cards, an MCP approval’s buttons and a form’s Confirm and Dismiss alike', async () => {
    for (const params of [mcpApproval, twoFields]) {
      const w = await world('feishu', { level: 'approve' })
      void w.permissions.onAcpElicit(AGENT, 's1', params)
      await vi.waitFor(() => expect(w.posts()).toHaveLength(1))
      const values = postedValues(w.conn)
      expect(values.length).toBeGreaterThan(1)
      for (const value of values) {
        expect(WireFeishuCardActionValue.parse(value).target).toEqual(routed)
        expect(parseFeishuElicit(value)).toMatchObject({ requestId: w.onlyRequest() })
      }
      await w.store.close()
    }
  })

  it('on a sub-session’s card, the integration it is posted through', async () => {
    const w = await subsessionWorld('feishu', { chatOn: true, placeIntegration: OTHER_INT })
    void w.coordinator.onAcpPermission(agentHostKey(AGENT), 'acp-sub', subParams())
    await vi.waitFor(() => expect(w.posts()).toHaveLength(1))
    const values = postedValues(w.conn)
    expect(values).toHaveLength(3)
    for (const value of values)
      expect(WireFeishuCardActionValue.parse(value).target).toEqual({ ...routed, integrationId: OTHER_INT })
    await w.store.close()
  })
})

describe('QQ notices', () => {
  it('gets the approval notice through its egress, though it has no card', async () => {
    const daemon: any = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
    const store = await LocalStore.open({ database: SqliteAsyncDatabase.adopt(new DatabaseSync(':memory:')) })
    daemon.store = store
    daemon.agents.set(AGENT, {
      id: AGENT,
      name: 'Butler',
      chatActions: 'approve',
      integrations: [{ ...integration('feishu'), platform: 'qq' }]
    })
    const applied: any[] = []
    daemon.enqueueApply = (_p: unknown, action: unknown) => void applied.push(action)
    const egress = { sendText: vi.fn(), sendCard: vi.fn(async () => 'q-1') }
    daemon.pending.set(JSON.stringify([AGENT, 's1']), {
      plan: {
        platform: 'qq',
        agentId: AGENT,
        agentName: 'Butler',
        integrationId: INT,
        sessionKey: `qq:group-1:t-1:${AGENT}`,
        requesterId: 'qq-user',
        channel: 'group-1',
        thread: 't-1',
        transcriptChannel: 'group-1',
        statusThread: 't-1',
        sessionThread: 't-1',
        isDm: false,
        approvalSurfaceSuppressed: false,
        suppressReplyConn: false
      },
      entry: { msg: { source: 'user', text: 'please write it', sender: { id: 'qq-user', isBot: false } } },
      egress,
      hostKey: AGENT,
      outwardSessionId: 'sid-1',
      chrome: {},
      signals: { applyChain: Promise.resolve() },
      approval: { waitMs: 0, depth: 0 },
      builtinSystemToolCallIds: new Set<string>(),
      conv: { onUpdate: () => [], hasBuffered: () => false }
    })
    void daemon.permissions.onAcpPermission(AGENT, 's1', permission())
    await vi.waitFor(() =>
      expect(applied.filter((a) => a.kind === 'notice').map((a) => a.text)).toEqual([
        expect.stringContaining('Ask an Agent editor')
      ])
    )
    await store.close()
  })

  it('sends a core notice as one message on the turn’s reply anchor, and nothing without one', async () => {
    const sendCard = vi.fn(async () => 'q-1')
    const state = {
      conn: { sendText: vi.fn(), sendCard },
      channel: 'group-1',
      replyId: 'msg-1'
    } as unknown as QQTurnState
    const record = vi.fn(async () => {})
    await applyQQAction(state, { kind: 'notice', text: '🔒 Permission requested.' }, record)
    expect(sendCard).toHaveBeenCalledWith('group-1', 'msg-1', '🔒 Permission requested.')
    expect(record).not.toHaveBeenCalled()
    await applyQQAction({ ...state, replyId: undefined } as QQTurnState, { kind: 'notice', text: 'x' }, record)
    expect(sendCard).toHaveBeenCalledTimes(1)
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
