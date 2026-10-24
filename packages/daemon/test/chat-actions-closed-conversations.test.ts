/**
 * "What people can do in chat" never opens what a conversation keeps closed: one switched off,
 * admitted per message by a Decision, or routed gets no approval card and takes no click, and one
 * shared with another organization sends the approval to the internal member who asked instead.
 */
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import type { CreateElicitationRequest, RequestPermissionRequest } from '@agentclientprotocol/sdk/unstable'
import { chatSurfaceOf } from '../src/agents/chat-actions.js'
import { Daemon } from '../src/daemon.js'
import { WorkBoundary } from '../src/messages/message-boundary.js'
import { TerminalOutputFolder } from '../src/session/terminal-output-folder.js'
import { SlackConnection } from '../src/slack/connection.js'
import { elicitOptionToken } from '../src/slack/render.js'
import { LocalStore } from '../src/store/local-store.js'
import { SqliteAsyncDatabase } from '../src/store/sqlite-async-database.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'

const AGENT = 'agent-1'
const INT = 'int-1'
const EDITOR = { integrationId: INT, teamId: 'T1', userId: 'U-EDITOR', consoleUserId: 'cu-editor', displayName: 'Ed' }

type Core = Record<string, unknown>

const permission = {
  sessionId: 's1',
  options: [
    { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
    { optionId: 'deny', name: 'Deny', kind: 'reject_once' }
  ],
  toolCall: { toolCallId: 'tc-1', title: 'Write example.txt' }
} as unknown as RequestPermissionRequest

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

/** A Slack integration whose routing envelope is `core` over the defaults. */
const slackIntegration = (core: Core = {}): { id: string; platform: string; core: Core } => ({
  id: INT,
  platform: 'slack',
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
  ['switched off', { mutedChannels: ['C1'] }],
  ['gated without a rule for it', { gated: true }],
  ['admitted per message by a Decision', { bindRules: [{ channel: 'C1', match: { kind: 'decision' } }] }],
  [
    'routed',
    {
      decisions: {
        bindings: [{ channel: 'C1', consumer: { type: 'shared_bot_routing' }, enabled: true }],
        definitions: []
      }
    }
  ]
]

/** A daemon holding one live Slack turn in C1, asked by `asker`, with every post and notice captured. */
async function world(opts: { level: 'talk' | 'approve' | 'settings'; core?: Core; asker?: string; shared?: boolean }) {
  const daemon: any = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
  daemon.cfg = { ...(daemon.cfg ?? {}), webAppUrl: 'https://console.example.test' }
  const store = await LocalStore.open({ database: SqliteAsyncDatabase.adopt(new DatabaseSync(':memory:')) })
  daemon.store = store
  const asker = opts.asker ?? 'U-ASKER'
  const integration = slackIntegration(opts.core)
  daemon.agents.set(AGENT, { id: AGENT, name: 'Butler', chatActions: opts.level, integrations: [integration] })
  const conn = Object.create(SlackConnection.prototype)
  let ts = 0
  conn.postBlocks = vi.fn(async () => `ts-${++ts}`)
  conn.updateBlocks = vi.fn(async () => true)
  conn.postEphemeral = vi.fn(async () => true)
  conn.workspaceId = () => 'T1'
  conn.openDirectMessage = vi.fn(async (user: string) => `D-${user}`)
  conn.isFullMember = vi.fn(async (user: string) => user !== 'U-GUEST')
  daemon.connByIntegration.set(INT, conn)
  const cp = vi.fn(async (payload: { requestId: string; verify?: unknown }) =>
    payload.verify
      ? { requestId: payload.requestId, allowed: true, displayName: 'Ed' }
      : { requestId: payload.requestId, target: EDITOR }
  )
  daemon.cpClient = { supportsServerFeature: () => true, approvalRoute: cp }
  const applied: any[] = []
  daemon.enqueueApply = (_p: unknown, action: unknown) => void applied.push(action)
  const pending = {
    plan: {
      platform: 'slack',
      agentId: AGENT,
      agentName: 'Butler',
      integrationId: INT,
      sessionKey: 'slack:C1:100.1:agent-1',
      requesterId: asker,
      channel: 'C1',
      thread: '100.1',
      transcriptChannel: 'C1',
      statusThread: '100.1',
      sessionThread: '100.1',
      isDm: false,
      approvalSurfaceSuppressed: false
    },
    entry: {
      msg: {
        source: 'user',
        text: 'please write it',
        sender: { id: asker, isBot: false },
        ...(opts.shared ? { externallyShared: true } : {})
      }
    },
    conn,
    hostKey: AGENT,
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
  }
  daemon.pending.set(JSON.stringify([AGENT, 's1']), pending)
  /** Where each post went, by channel. */
  const postedTo = (): string[] => conn.postBlocks.mock.calls.map((call: unknown[]) => call[0] as string)
  const notices = (): string[] => applied.filter((a) => a.kind === 'notice').map((a) => a.text as string)
  const permissions = daemon.permissions
  const onlyRequest = (): string => [...permissions.pendingApprovals.keys(), ...permissions.pendingElicits.keys()][0]
  return { daemon, store, conn, cp, integration, permissions, postedTo, notices, onlyRequest }
}

describe('chatSurfaceOf', () => {
  it('opens an ordinary conversation, and closes or externalizes the rest', () => {
    expect(chatSurfaceOf(slackIntegration() as never, 'C1')).toBe('open')
    for (const [, core] of CLOSED) expect(chatSurfaceOf(slackIntegration(core) as never, 'C1')).toBe('closed')
    expect(chatSurfaceOf(slackIntegration({ externalChannels: ['C1'] }) as never, 'C1')).toBe('external')
    expect(chatSurfaceOf(slackIntegration() as never, 'C1', true)).toBe('external')
    // Unknown fails closed, and closed outranks external.
    expect(chatSurfaceOf(undefined, 'C1')).toBe('closed')
    expect(chatSurfaceOf(slackIntegration({ mutedChannels: ['C1'], externalChannels: ['C1'] }) as never, 'C1')).toBe(
      'closed'
    )
  })
})

describe('a closed conversation gets no approval card at any level', () => {
  it.each(
    CLOSED.flatMap(([how, core]) => (['approve', 'settings'] as const).map((level) => [how, level, core] as const))
  )('one %s, at %s: the notice and the editor path, and a click there decides nothing', async (_how, level, core) => {
    const w = await world({ level, core })
    const decided = vi.fn()
    void w.permissions.onAcpPermission(AGENT, 's1', permission).then(decided)
    await vi.waitFor(() => expect(w.postedTo()).toEqual(['D-U-EDITOR']))
    // No card in the conversation: exactly what an agent where people may only talk gets.
    expect(w.notices()).toEqual([expect.stringContaining('Ask an Agent editor')])
    expect(w.cp).toHaveBeenCalledTimes(1)
    const id = w.onlyRequest()
    expect(w.permissions.pendingApprovals.get(id).chat).toBeUndefined()

    await w.permissions.handlePermissionChoice({ requestId: id, optionId: 'allow', actor: { userId: 'U-ANY' } })
    expect(w.permissions.pendingApprovals.has(id)).toBe(true)
    expect(decided).not.toHaveBeenCalled()
    expect((await w.store.listPermissionRequests(AGENT))[0]).toMatchObject({ status: 'pending' })
    await w.store.close()
  })

  it.each(CLOSED)('posts no MCP approval card in one %s', async (_how, core) => {
    const w = await world({ level: 'approve', core })
    void w.permissions.onAcpElicit(AGENT, 's1', mcpApproval)
    await vi.waitFor(() => expect(w.postedTo()).toEqual(['D-U-EDITOR']))
    expect(w.permissions.pendingElicits.size).toBe(0)
    expect(w.permissions.pendingApprovals.size).toBe(1)
    await w.store.close()
  })

  it('refuses a click on a card posted while the conversation was open, once it closes', async () => {
    const w = await world({ level: 'approve' })
    const decided = vi.fn()
    void w.permissions.onAcpPermission(AGENT, 's1', permission).then(decided)
    await vi.waitFor(() => expect(w.postedTo()).toEqual(['C1']))
    const id = w.onlyRequest()
    // A Decision now admits each message here.
    w.integration.core.bindRules = [{ channel: 'C1', match: { kind: 'decision' } }]
    await w.permissions.handlePermissionChoice({ requestId: id, optionId: 'allow', actor: { userId: 'U-ANY' } })
    expect(w.permissions.pendingApprovals.has(id)).toBe(true)
    expect(decided).not.toHaveBeenCalled()
    // Only the clicker is told, and the card stays as everyone else sees it.
    expect(w.conn.updateBlocks).not.toHaveBeenCalled()
    expect(w.conn.postEphemeral).toHaveBeenCalledWith(
      'C1',
      'U-ANY',
      expect.stringContaining('Only an Agent editor can answer this request'),
      '100.1'
    )
    await w.store.close()
  })

  it('refuses an MCP approval card click once its conversation is switched off', async () => {
    const w = await world({ level: 'approve' })
    const decided = vi.fn()
    void w.permissions.onAcpElicit(AGENT, 's1', mcpApproval).then(decided)
    await vi.waitFor(() => expect(w.postedTo()).toEqual(['C1']))
    const id = w.onlyRequest()
    w.integration.core.mutedChannels = ['C1']
    await w.permissions.handleElicitChoice({ requestId: id, value: elicitOptionToken(0), actor: { userId: 'U-ANY' } })
    expect(w.permissions.pendingElicits.has(id)).toBe(true)
    expect(decided).not.toHaveBeenCalled()
    await w.store.close()
  })
})

describe('a bot never answers', () => {
  it('leaves a card a bot clicked live for the people in the conversation', async () => {
    const w = await world({ level: 'approve' })
    const decided = w.permissions.onAcpPermission(AGENT, 's1', permission)
    await vi.waitFor(() => expect(w.postedTo()).toEqual(['C1']))
    const id = w.onlyRequest()
    await w.permissions.handlePermissionChoice({
      requestId: id,
      optionId: 'allow',
      actor: { userId: 'B1', isBot: true }
    })
    expect(w.permissions.pendingApprovals.has(id)).toBe(true)
    expect(w.conn.updateBlocks).not.toHaveBeenCalled()
    // An ordinary open conversation is unchanged: a person there decides.
    await w.permissions.handlePermissionChoice({ requestId: id, optionId: 'allow', actor: { userId: 'U-ANY' } })
    await expect(decided).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } })
    await w.store.close()
  })
})

describe('a conversation shared with another organization', () => {
  it.each([
    ['listed external by the platform', { core: { externalChannels: ['C1'] } }],
    ['whose message says it is shared', { shared: true }]
  ] as const)('one %s sends the approval to the asker’s own DM, where only they decide', async (_how, over) => {
    const w = await world({ level: 'approve', ...over })
    const decided = vi.fn()
    void w.permissions.onAcpPermission(AGENT, 's1', permission).then(decided)
    await vi.waitFor(() => expect(w.postedTo()).toEqual(['D-U-ASKER']))
    // No card in the shared conversation, and no editor chain for this one.
    expect(w.cp).not.toHaveBeenCalled()
    const dmCard = JSON.stringify(w.conn.postBlocks.mock.calls[0][1])
    expect(dmCard).toContain('please write it')
    const id = w.onlyRequest()

    await w.permissions.handlePermissionChoice({ requestId: id, optionId: 'allow', actor: { userId: 'U-OTHER' } })
    expect(decided).not.toHaveBeenCalled()
    await w.permissions.handlePermissionChoice({ requestId: id, optionId: 'allow', actor: { userId: 'U-ASKER' } })
    await vi.waitFor(() =>
      expect(decided).toHaveBeenCalledWith({ outcome: { outcome: 'selected', optionId: 'allow' } })
    )
    expect((await w.store.listPermissionRequests(AGENT))[0]).toMatchObject({
      status: 'allowed',
      resolvedBy: 'slack:T1:U-ASKER'
    })
    await w.store.close()
  })

  it('sends the approval to the asker’s DM once a guest who joined is detected, for an agent outside assistant mode', async () => {
    const w = await world({ level: 'approve', core: { mode: 'shared' } })
    w.daemon.cpClient.emitIntegrationChannels = vi.fn()
    w.conn.joinedMemberReason = vi.fn(async () => 'guestMember')
    const joined = await w.daemon.handleRelaySlackAction({
      agentId: AGENT,
      integrationId: INT,
      sessionKey: 'slack:C1',
      msgId: 'm-join',
      botId: 'bot-1',
      userId: 'U-GUEST',
      payload: { kind: 'member-joined', channelId: 'C1', userId: 'U-GUEST' }
    })
    expect(joined).toEqual({ msgId: 'm-join', accepted: true })
    expect(w.daemon.cpClient.emitIntegrationChannels).toHaveBeenCalledWith({
      integrationId: INT,
      channels: [{ id: 'C1', externalReason: 'guestMember' }],
      authoritative: false
    })
    void w.permissions.onAcpPermission(AGENT, 's1', permission)
    await vi.waitFor(() => expect(w.postedTo()).toEqual(['D-U-ASKER']))
    // The guest cannot answer it: only the asker decides.
    const id = w.onlyRequest()
    await w.permissions.handlePermissionChoice({ requestId: id, optionId: 'allow', actor: { userId: 'U-GUEST' } })
    expect(w.permissions.pendingApprovals.has(id)).toBe(true)
    await w.store.close()
  })

  it('sends an MCP approval to the asker’s DM the same way', async () => {
    const w = await world({ level: 'settings', core: { externalChannels: ['C1'] } })
    const decided = w.permissions.onAcpElicit(AGENT, 's1', mcpApproval)
    await vi.waitFor(() => expect(w.postedTo()).toEqual(['D-U-ASKER']))
    const id = w.onlyRequest()
    await w.permissions.handleElicitChoice({ requestId: id, value: elicitOptionToken(0), actor: { userId: 'U-ASKER' } })
    await expect(decided).resolves.toMatchObject({ action: 'accept' })
    await w.store.close()
  })

  it('takes the editor path when the asker is not a full member', async () => {
    const w = await world({ level: 'approve', asker: 'U-GUEST', core: { externalChannels: ['C1'] } })
    void w.permissions.onAcpPermission(AGENT, 's1', permission)
    await vi.waitFor(() => expect(w.postedTo()).toEqual(['D-U-EDITOR']))
    expect(w.cp).toHaveBeenCalledTimes(1)
    const id = w.onlyRequest()
    await w.permissions.handlePermissionChoice({ requestId: id, optionId: 'allow', actor: { userId: 'U-GUEST' } })
    expect(w.permissions.pendingApprovals.has(id)).toBe(true)
    await w.store.close()
  })

  it('falls back to the editor path when the asker’s DM does not land', async () => {
    const w = await world({ level: 'approve', core: { externalChannels: ['C1'] } })
    w.conn.postBlocks.mockImplementationOnce(async () => undefined)
    void w.permissions.onAcpPermission(AGENT, 's1', permission)
    await vi.waitFor(() => expect(w.postedTo()).toEqual(['D-U-ASKER', 'D-U-EDITOR']))
    expect(w.cp).toHaveBeenCalledTimes(1)
    await w.store.close()
  })

  it('keeps the editor path when people may only talk to the agent', async () => {
    const w = await world({ level: 'talk', core: { externalChannels: ['C1'] } })
    void w.permissions.onAcpPermission(AGENT, 's1', permission)
    await vi.waitFor(() => expect(w.postedTo()).toEqual(['D-U-EDITOR']))
    expect(w.conn.isFullMember).not.toHaveBeenCalled()
    await w.store.close()
  })

  it('refuses the asker’s click once the conversation closes', async () => {
    const w = await world({ level: 'approve', core: { externalChannels: ['C1'] } })
    const decided = vi.fn()
    void w.permissions.onAcpPermission(AGENT, 's1', permission).then(decided)
    await vi.waitFor(() => expect(w.postedTo()).toEqual(['D-U-ASKER']))
    const id = w.onlyRequest()
    w.integration.core.mutedChannels = ['C1']
    await w.permissions.handlePermissionChoice({ requestId: id, optionId: 'allow', actor: { userId: 'U-ASKER' } })
    expect(w.permissions.pendingApprovals.has(id)).toBe(true)
    expect(decided).not.toHaveBeenCalled()
    await w.store.close()
  })
})
