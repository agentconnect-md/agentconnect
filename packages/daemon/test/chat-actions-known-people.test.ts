/**
 * Where a platform's permissions are synced with the console, only the agent's editors take chat
 * actions: a person's linked identity is checked with the control plane, anyone else is told
 * privately who can answer, and an editor is DMed so a request never waits on an empty channel.
 */
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import type { CreateElicitationRequest, RequestPermissionRequest } from '@agentclientprotocol/sdk/unstable'
import { APPROVAL_DM_ROUTE_V1_FEATURE, CHAT_ACTOR_V1_FEATURE } from '@agentconnect.md/protocol'
import { FakeClock } from '@agentconnect.md/connection'
import { CHAT_ACTOR_ALLOW_TTL_MS, CHAT_ACTOR_DENY_TTL_MS, ChatActors } from '../src/agents/chat-actor.js'
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
/** The editor the control plane picks for a DM. */
const EDITOR = { integrationId: INT, teamId: 'T1', userId: 'U-EDITOR', consoleUserId: 'cu-editor', displayName: 'Ed' }
/** Members linked to an editor of the agent. */
const EDITORS = new Set(['U-EDITOR', 'U-EDITOR-2'])
/** A member linked to a console account that cannot edit the agent. */
const MEMBER = 'U-MEMBER'
/** A member linked to no console account. */
const STRANGER = 'U-STRANGER'

/** What a refused member is told where permissions are synced: no console link, since the console shows the conversation only to the same people. */
const NOT_EDITOR = 'Only an Agent editor can answer this request.'
const UNLINKED =
  'Only an Agent editor can answer this request, from a chat account linked to their console account. If that is you, link this account under Sign-in methods in your console Profile and try again.'
const UNAVAILABLE =
  "Who you are can't be checked right now, so this request can't be answered here. Try again in a moment."

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

type Core = Record<string, unknown>

/** A daemon holding one live Slack turn in C1, asked by `asker`, whose integration's chat authority is `authority`. */
async function world(
  opts: {
    level?: 'approve' | 'settings'
    authority?: 'editors' | 'participants'
    core?: Core
    asker?: string
    cpDown?: boolean
    features?: readonly string[]
  } = {}
) {
  const clock = new FakeClock(1_000_000)
  const daemon: any = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null, clock })
  daemon.cfg = { ...(daemon.cfg ?? {}), webAppUrl: 'https://console.example.test' }
  const store = await LocalStore.open({ database: SqliteAsyncDatabase.adopt(new DatabaseSync(':memory:')) })
  daemon.store = store
  const asker = opts.asker ?? 'U-ASKER'
  const integration = {
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
      chatAuthority: opts.authority ?? 'editors',
      ...opts.core
    }
  }
  daemon.agents.set(AGENT, {
    id: AGENT,
    name: 'Butler',
    chatActions: opts.level ?? 'approve',
    integrations: [integration]
  })
  const conn = Object.create(SlackConnection.prototype)
  let ts = 0
  conn.postBlocks = vi.fn(async () => `ts-${++ts}`)
  conn.updateBlocks = vi.fn(async () => true)
  conn.postEphemeral = vi.fn(async () => true)
  conn.memberName = vi.fn(async (user: string) => `Name of ${user}`)
  conn.workspaceId = () => 'T1'
  conn.openDirectMessage = vi.fn(async (user: string) => `D-${user}`)
  conn.isFullMember = vi.fn(async () => true)
  daemon.connByIntegration.set(INT, conn)
  type Ask = {
    requestId: string
    verify?: { userId: string; teamId?: string; consoleUserId?: string; integrationId: string }
  }
  /** Every "is this person an editor" question, by who was asked about. */
  const asked: string[] = []
  const cp = vi.fn(async (payload: Ask) => {
    const v = payload.verify
    if (v && v.consoleUserId === undefined) {
      asked.push(v.userId)
      if (opts.cpDown) throw new Error('control plane unreachable')
      return EDITORS.has(v.userId)
        ? { requestId: payload.requestId, allowed: true, displayName: 'Ed' }
        : { requestId: payload.requestId, allowed: false, linked: v.userId === MEMBER }
    }
    if (v) return { requestId: payload.requestId, allowed: v.userId === EDITOR.userId, displayName: 'Ed' }
    return { requestId: payload.requestId, target: EDITOR }
  })
  const features = new Set(opts.features ?? [APPROVAL_DM_ROUTE_V1_FEATURE, CHAT_ACTOR_V1_FEATURE])
  daemon.cpClient = { supportsServerFeature: (f: string) => features.has(f), approvalRoute: cp }
  daemon.enqueueApply = () => {}
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
    entry: { msg: { source: 'user', text: 'please write it', sender: { id: asker, isBot: false } } },
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
  const permissions = daemon.permissions
  /** Where each post went, by channel. */
  const postedTo = (): string[] => conn.postBlocks.mock.calls.map((call: unknown[]) => call[0] as string)
  /** What each person was told privately. */
  const toldTo = (user: string): string[] =>
    conn.postEphemeral.mock.calls.filter((call: unknown[]) => call[1] === user).map((call: unknown[]) => call[2])
  const onlyRequest = (): string => [...permissions.pendingApprovals.keys(), ...permissions.pendingElicits.keys()][0]
  const click = (requestId: string, userId: string) =>
    permissions.handlePermissionChoice({ requestId, optionId: 'allow', actor: { userId } })
  return { daemon, clock, store, conn, cp, asked, integration, permissions, postedTo, toldTo, onlyRequest, click }
}

describe('where permissions are synced, only an Agent editor answers in chat', () => {
  it('posts the card and DMs an editor, refuses anyone else privately, and takes an editor’s click', async () => {
    const w = await world()
    const decided = vi.fn()
    void w.permissions.onAcpPermission(AGENT, 's1', permission).then(decided)
    // The person who asked is not an editor, so an editor hears about it in a DM as well.
    await vi.waitFor(() => expect(w.postedTo()).toEqual(['C1', 'D-U-EDITOR']))
    const id = w.onlyRequest()

    await w.click(id, MEMBER)
    await w.click(id, STRANGER)
    expect(w.toldTo(MEMBER)).toEqual([NOT_EDITOR])
    // Someone linked to no console account learns how to link one instead.
    expect(w.toldTo(STRANGER)).toEqual([UNLINKED])
    // The card stays as everyone else sees it, and nothing was decided.
    expect(w.conn.updateBlocks).not.toHaveBeenCalled()
    expect(decided).not.toHaveBeenCalled()
    expect((await w.store.listPermissionRequests(AGENT))[0]).toMatchObject({ status: 'pending' })

    await w.click(id, 'U-EDITOR-2')
    await vi.waitFor(() =>
      expect(decided).toHaveBeenCalledWith({ outcome: { outcome: 'selected', optionId: 'allow' } })
    )
    expect((await w.store.listPermissionRequests(AGENT))[0]).toMatchObject({
      status: 'allowed',
      resolvedBy: 'slack:T1:U-EDITOR-2'
    })
    // The first answer decides: the card and the DM both say so.
    const rewritten = w.conn.updateBlocks.mock.calls.map((call: unknown[]) => call[0])
    expect(rewritten.sort()).toEqual(['C1', 'D-U-EDITOR'])
    await w.store.close()
  })

  it('lets the DMed editor answer from the card in the conversation too', async () => {
    const w = await world()
    const decided = w.permissions.onAcpPermission(AGENT, 's1', permission)
    await vi.waitFor(() => expect(w.postedTo()).toEqual(['C1', 'D-U-EDITOR']))
    await w.click(w.onlyRequest(), 'U-EDITOR')
    await expect(decided).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } })
    expect((await w.store.listPermissionRequests(AGENT))[0]).toMatchObject({ resolvedBy: 'slack:T1:U-EDITOR' })
    await w.store.close()
  })

  it('DMs no one when the person who asked is an editor, and takes their click', async () => {
    const w = await world({ asker: 'U-EDITOR-2' })
    const decided = w.permissions.onAcpPermission(AGENT, 's1', permission)
    await vi.waitFor(() => expect(w.asked).toEqual(['U-EDITOR-2']))
    expect(w.postedTo()).toEqual(['C1'])
    await w.click(w.onlyRequest(), 'U-EDITOR-2')
    await expect(decided).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } })
    // Their verdict was remembered from when the card went up.
    expect(w.asked).toEqual(['U-EDITOR-2'])
    await w.store.close()
  })

  it.each([
    ['cannot be reached', { cpDown: true }],
    ['cannot answer the question', { features: [APPROVAL_DM_ROUTE_V1_FEATURE] }]
  ] as const)('refuses every click when the control plane %s, and asks again next time', async (_how, over) => {
    const w = await world({ ...over, asker: 'U-EDITOR-2' })
    const decided = vi.fn()
    void w.permissions.onAcpPermission(AGENT, 's1', permission).then(decided)
    await vi.waitFor(() => expect(w.postedTo()[0]).toBe('C1'))
    const id = w.onlyRequest()
    const before = w.asked.length
    await w.click(id, 'U-EDITOR-2')
    await w.click(id, 'U-EDITOR-2')
    expect(decided).not.toHaveBeenCalled()
    expect(w.toldTo('U-EDITOR-2')).toEqual([UNAVAILABLE, UNAVAILABLE])
    // An unanswered question is never remembered.
    expect(w.asked.length - before).toBe('cpDown' in over ? 2 : 0)
    await w.store.close()
  })

  it('remembers a refusal briefly, and asks again once it lapses or the agent changes', async () => {
    const w = await world()
    void w.permissions.onAcpPermission(AGENT, 's1', permission)
    await vi.waitFor(() => expect(w.postedTo()).toEqual(['C1', 'D-U-EDITOR']))
    const id = w.onlyRequest()
    await w.click(id, MEMBER)
    await w.click(id, MEMBER)
    expect(w.asked.filter((u) => u === MEMBER)).toHaveLength(1)
    w.clock.advance(CHAT_ACTOR_DENY_TTL_MS)
    await w.click(id, MEMBER)
    expect(w.asked.filter((u) => u === MEMBER)).toHaveLength(2)
    w.daemon.chatActors.forgetAgent(AGENT)
    await w.click(id, MEMBER)
    expect(w.asked.filter((u) => u === MEMBER)).toHaveLength(3)
    await w.permissions.releaseApprovals(AGENT, 's1')
    await w.store.close()
  })

  it('takes the same check on an MCP approval card', async () => {
    const w = await world()
    const decided = vi.fn()
    void w.permissions.onAcpElicit(AGENT, 's1', mcpApproval).then(decided)
    await vi.waitFor(() => expect(w.postedTo()).toEqual(['C1']))
    const id = w.onlyRequest()
    const tap = (userId: string) =>
      w.permissions.handleElicitChoice({ requestId: id, value: elicitOptionToken(0), actor: { userId } })
    await tap(STRANGER)
    await tap(MEMBER)
    expect(w.toldTo(STRANGER)).toEqual([UNLINKED])
    expect(w.toldTo(MEMBER)).toEqual([NOT_EDITOR])
    expect(decided).not.toHaveBeenCalled()
    expect(w.permissions.pendingElicits.has(id)).toBe(true)
    await tap('U-EDITOR-2')
    await vi.waitFor(() => expect(decided).toHaveBeenCalledWith(expect.objectContaining({ action: 'accept' })))
    await w.store.close()
  })

  it('still points a click to the console once approving in chat is turned off', async () => {
    const w = await world()
    void w.permissions.onAcpPermission(AGENT, 's1', permission)
    await vi.waitFor(() => expect(w.postedTo()).toEqual(['C1', 'D-U-EDITOR']))
    w.daemon.agents.get(AGENT).chatActions = 'talk'
    await w.click(w.onlyRequest(), MEMBER)
    expect(w.toldTo(MEMBER)).toEqual([
      'Only an Agent editor can answer this request. They can answer it in the console: https://console.example.test/sessions/sid-1?source=slack'
    ])
    await w.permissions.releaseApprovals(AGENT, 's1')
    await w.store.close()
  })

  it('sends a conversation shared with another organization to the editor path, not the asker’s DM', async () => {
    const w = await world({ core: { externalChannels: ['C1'] } })
    void w.permissions.onAcpPermission(AGENT, 's1', permission)
    await vi.waitFor(() => expect(w.postedTo()).toEqual(['D-U-EDITOR']))
    expect(w.conn.isFullMember).not.toHaveBeenCalled()
    await w.permissions.releaseApprovals(AGENT, 's1')
    await w.store.close()
  })

  it('refuses an asker’s DM card posted before the sync was switched on, unless they are an editor', async () => {
    const w = await world({ authority: 'participants', core: { externalChannels: ['C1'] } })
    const decided = vi.fn()
    void w.permissions.onAcpPermission(AGENT, 's1', permission).then(decided)
    await vi.waitFor(() => expect(w.postedTo()).toEqual(['D-U-ASKER']))
    w.integration.core.chatAuthority = 'editors'
    await w.click(w.onlyRequest(), 'U-ASKER')
    expect(decided).not.toHaveBeenCalled()
    expect(w.permissions.pendingApprovals.size).toBe(1)
    await w.store.close()
  })
})

describe('where permissions are not synced', () => {
  it('lets anyone in the conversation answer, as before, and asks the control plane nothing', async () => {
    const w = await world({ authority: 'participants' })
    const decided = w.permissions.onAcpPermission(AGENT, 's1', permission)
    await vi.waitFor(() => expect(w.postedTo()).toEqual(['C1']))
    await w.click(w.onlyRequest(), STRANGER)
    await expect(decided).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } })
    expect(w.cp).not.toHaveBeenCalled()
    await w.store.close()
  })
})

describe('ChatActors', () => {
  it('keeps an editor for two minutes and a refusal for thirty seconds, and never an unanswered question', async () => {
    let now = 0
    const answers: Array<{ allowed: boolean; linked?: boolean } | undefined> = [
      { allowed: true },
      { allowed: false, linked: false },
      undefined,
      { allowed: false }
    ]
    const ask = vi.fn(async () => answers.shift())
    const actors = new ChatActors({ ask, now: () => now })
    await expect(actors.judge('a', 'i', 'U1')).resolves.toBe('allowed')
    now = CHAT_ACTOR_ALLOW_TTL_MS - 1
    await expect(actors.judge('a', 'i', 'U1')).resolves.toBe('allowed')
    await expect(actors.judge('a', 'i', 'U2')).resolves.toBe('unlinked')
    now += CHAT_ACTOR_DENY_TTL_MS
    await expect(actors.judge('a', 'i', 'U2')).resolves.toBe('unavailable')
    await expect(actors.judge('a', 'i', 'U2')).resolves.toBe('not-editor')
    expect(ask).toHaveBeenCalledTimes(4)
  })
})
