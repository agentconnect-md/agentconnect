/** A Teams approval card, for a permission request or an MCP approval with choices, in one person's own 1:1 chat: an external place's asker (assistant-mode.md §5.5), or the editor the control plane routes it to, alone or beside the channel's card (teams-integration.md §4.4). */
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import type { CreateElicitationRequest, RequestPermissionRequest } from '@agentclientprotocol/sdk/unstable'
import { Daemon } from '../src/daemon.js'
import { WorkBoundary } from '../src/messages/message-boundary.js'
import { MsTeamsConnection } from '../src/platforms/msteams/connection.js'
import { TerminalOutputFolder } from '../src/session/terminal-output-folder.js'
import { LocalStore } from '../src/store/local-store.js'
import { SqliteAsyncDatabase } from '../src/store/sqlite-async-database.js'

const AGENT = 'agent-1'
const INT = 'int-1'
const ZERO = '00000000-0000-0000-0000-000000000000'
const SHARED = '19:example-shared@thread.tacv2'
const ASKER = '11111111-1111-1111-1111-111111111111'
const GUEST = '22222222-2222-2222-2222-222222222222'
const EDITOR = '33333333-3333-3333-3333-333333333333'
const MEMBER_EDITOR = '44444444-4444-4444-4444-444444444444'

const permission = {
  sessionId: 's1',
  options: [
    { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
    { optionId: 'deny', name: 'Deny', kind: 'reject_once' }
  ],
  toolCall: { toolCallId: 'tc-1', title: 'Write example.txt' }
} as unknown as RequestPermissionRequest

/** An MCP-tool approval asked as a question: one single-select field, so a card offers its options and Deny. */
const question = {
  sessionId: 's1',
  toolCallId: 'call-e',
  mode: 'form',
  message: 'Which one?',
  requestedSchema: { type: 'object', properties: { pick: { type: 'string', enum: ['a', 'b'] } }, required: ['pick'] },
  _meta: { codex_approval_kind: 'mcp_tool_call' }
} as unknown as CreateElicitationRequest

/** An MCP-tool approval whose one field is a yes/no, which reduces to no choices a card could offer. */
const yesNo = {
  ...question,
  requestedSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }
} as unknown as CreateElicitationRequest

const SLACK_INT = 'int-slack'

/** A daemon holding one live Teams turn in a shared channel, asked by `asker`, with every card captured; `slack` also connects a Slack integration, `editorsOnly` makes it an internal channel only editors answer in. */
async function world(asker = ASKER, slack = false, editorsOnly = false) {
  const daemon: any = new Daemon({ sandboxMechanism: null })
  daemon.cfg = { ...(daemon.cfg ?? {}), webAppUrl: 'https://console.example.test' }
  const store = await LocalStore.open({ database: SqliteAsyncDatabase.adopt(new DatabaseSync(':memory:')) })
  daemon.store = store
  const integration = {
    id: INT,
    platform: 'msteams',
    core: {
      mode: 'direct',
      bindRules: [],
      mutedChannels: [],
      gated: false,
      sessionModes: [],
      externalChannels: [],
      decisions: { bindings: [], definitions: [] },
      ...(editorsOnly ? { chatAuthority: 'editors' } : {})
    },
    config: { appId: ZERO, tenantId: ZERO, clientSecret: 'client-secret-example' }
  }
  const slackIntegration = { ...integration, id: SLACK_INT, platform: 'slack', config: {} }
  daemon.agents.set(AGENT, {
    id: AGENT,
    name: 'Butler',
    chatActions: 'approve',
    integrations: slack ? [integration, slackIntegration] : [integration]
  })
  if (slack) daemon.connByIntegration.set(SLACK_INT, { openDirectMessage: vi.fn(async () => 'D-example') })
  const conn = Object.create(MsTeamsConnection.prototype)
  let posted = 0
  conn.isFullMember = vi.fn(async (user: string) => user !== GUEST)
  conn.openDirectMessage = vi.fn(async (user: string) => `a:${user}`)
  conn.targetFor = (channel: string) => ({ serviceUrl: 'https://smba.example.test/', conversationId: channel })
  // The editor path's notice is a card in the conversation too; it is kept apart from the approval cards here.
  const notices: string[] = []
  const cardPosts = vi.fn(async (_target: unknown, _card: unknown, _summary?: string) => `activity-${++posted}`)
  const cardReplaces = vi.fn(async (_id: string, _card: unknown, _at: unknown) => {})
  conn.postCard = vi.fn(async (target: unknown, card: unknown, summary?: string) => {
    if (summary !== 'Permission requested') return await cardPosts(target, card, summary)
    notices.push(JSON.stringify(card))
    return `notice-${notices.length}`
  })
  conn.replaceCard = vi.fn(async (id: string, card: unknown, at: unknown) =>
    id.startsWith('notice-') ? undefined : await cardReplaces(id, card, at)
  )
  daemon.msTeamsConnByIntegration.set(INT, conn)
  const cp = vi.fn(async (payload: { requestId: string; verify?: unknown }): Promise<Record<string, unknown>> => ({
    requestId: payload.requestId
  }))
  daemon.cpClient = { supportsServerFeature: () => true, approvalRoute: cp }
  const applied: any[] = []
  daemon.enqueueApply = (_p: unknown, action: unknown) => void applied.push(action)
  daemon.pending.set(JSON.stringify([AGENT, 's1']), {
    plan: {
      platform: 'msteams',
      agentId: AGENT,
      agentName: 'Butler',
      integrationId: INT,
      sessionKey: `msteams:${SHARED}:1700000000000:agent-1`,
      requesterId: asker,
      channel: SHARED,
      thread: '1700000000000',
      transcriptChannel: SHARED,
      statusThread: '1700000000000',
      sessionThread: '1700000000000',
      isDm: false,
      approvalSurfaceSuppressed: false
    },
    entry: {
      msg: {
        source: 'user',
        text: 'please write it',
        sender: { id: asker, isBot: false },
        externallyShared: !editorsOnly
      }
    },
    conn,
    turnState: { conn, target: conn.targetFor(SHARED) },
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
  })
  const permissions = daemon.permissions
  const postedTo = (): string[] =>
    cardPosts.mock.calls.map((call) => (call[0] as { conversationId: string }).conversationId)
  const onlyRequest = (): string => [...permissions.pendingApprovals.keys()][0]
  return { daemon, store, conn, cp, permissions, postedTo, onlyRequest, applied, notices, cardPosts, cardReplaces }
}

describe('an approval in a Teams channel shared with another organization', () => {
  it('goes to the asker’s own 1:1 chat as a card, where only they decide', async () => {
    const w = await world()
    const decided = vi.fn()
    void w.permissions.onAcpPermission(AGENT, 's1', permission).then(decided)
    await vi.waitFor(() => expect(w.postedTo()).toEqual([`a:${ASKER}`]))
    expect(w.conn.openDirectMessage).toHaveBeenCalledWith(ASKER)
    // No card in the shared channel, and no editor chain while the asker's card is live.
    expect(w.cp).not.toHaveBeenCalled()
    const id = w.onlyRequest()

    await w.permissions.handlePermissionChoice({ requestId: id, optionId: 'allow', actor: { userId: GUEST } })
    expect(decided).not.toHaveBeenCalled()
    await w.permissions.handlePermissionChoice({ requestId: id, optionId: 'allow', actor: { userId: ASKER } })
    await vi.waitFor(() =>
      expect(decided).toHaveBeenCalledWith({ outcome: { outcome: 'selected', optionId: 'allow' } })
    )
    expect((await w.store.listPermissionRequests(AGENT))[0]).toMatchObject({ status: 'allowed' })
    // The card says how it ended.
    await vi.waitFor(() => expect(w.cardReplaces).toHaveBeenCalled())
    await w.store.close()
  })

  it('sends an MCP approval with choices to the asker’s own 1:1 chat, where only they decide', async () => {
    const w = await world()
    const decided = vi.fn()
    void w.permissions.onAcpElicit(AGENT, 's1', question).then(decided)
    await vi.waitFor(() => expect(w.postedTo()).toEqual([`a:${ASKER}`]))
    expect(JSON.stringify(w.cardPosts.mock.calls[0]![1])).toContain('Which one?')
    expect(w.cp).not.toHaveBeenCalled()
    const id = w.onlyRequest()

    expect(
      await w.permissions.handlePermissionChoice({ requestId: id, option: 0, actor: { userId: GUEST } })
    ).toBeTruthy()
    expect(decided).not.toHaveBeenCalled()
    await w.permissions.handlePermissionChoice({ requestId: id, option: 0, actor: { userId: ASKER } })
    await vi.waitFor(() => expect(decided).toHaveBeenCalledWith({ action: 'accept', content: { pick: 'a' } }))
    expect((await w.store.listPermissionRequests(AGENT))[0]).toMatchObject({ status: 'allowed' })
    await vi.waitFor(() => expect(w.cardReplaces).toHaveBeenCalled())
    await w.store.close()
  })

  it('retires the asker’s MCP approval card when approving in chat is turned off', async () => {
    const w = await world()
    void w.permissions.onAcpElicit(AGENT, 's1', question)
    await vi.waitFor(() => expect(w.postedTo()).toEqual([`a:${ASKER}`]))
    await vi.waitFor(async () =>
      expect((await w.store.listPermissionRequests(AGENT))[0]).toMatchObject({ notifyTs: 'activity-1' })
    )
    w.permissions.disableChatPermissionSurfaces(AGENT)
    expect(w.cardReplaces.mock.calls.map((call) => call[0])).toEqual(['activity-1'])
    expect(JSON.stringify(w.cardReplaces.mock.calls[0]![1])).toContain('turned off')
    await w.store.close()
  })

  it('sends the asker no card for an MCP approval that reduces to no choices', async () => {
    const w = await world()
    void w.permissions.onAcpElicit(AGENT, 's1', yesNo)
    await vi.waitFor(() => expect(w.permissions.pendingApprovals.size).toBe(1))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(w.conn.openDirectMessage).not.toHaveBeenCalled()
    expect(w.postedTo()).toEqual([])
    await w.store.close()
  })

  it('opens no chat for an asker who is not a full member, leaving the notice in the channel', async () => {
    const w = await world(GUEST)
    void w.permissions.onAcpPermission(AGENT, 's1', permission)
    await vi.waitFor(() => expect(w.notices).toEqual([expect.stringContaining('Ask an Agent editor')]))
    await vi.waitFor(() => expect(w.conn.isFullMember).toHaveBeenCalledWith(GUEST))
    expect(w.conn.openDirectMessage).not.toHaveBeenCalled()
    expect(w.postedTo()).toEqual([])
    await w.store.close()
  })
})

describe('an approval on the editor path of a Teams turn', () => {
  /** The control plane routes the request to EDITOR, and its verify answers `allowed` for their account. */
  function routeToEditor(w: Awaited<ReturnType<typeof world>>, allowed = true) {
    w.cp.mockImplementation(async (payload: { requestId: string; verify?: unknown }) =>
      payload.verify
        ? { requestId: payload.requestId, allowed, displayName: 'Edie' }
        : {
            requestId: payload.requestId,
            target: {
              integrationId: INT,
              teamId: 'global',
              userId: EDITOR,
              consoleUserId: 'user-editor',
              displayName: 'Edie'
            }
          }
    )
  }
  const cardText = (card: unknown): string => JSON.stringify(card)

  it('goes to the routed editor’s own 1:1 chat as a card, which only they decide', async () => {
    const w = await world(GUEST)
    routeToEditor(w)
    const decided = vi.fn()
    void w.permissions.onAcpPermission(AGENT, 's1', permission).then(decided)
    await vi.waitFor(() => expect(w.postedTo()).toEqual([`a:${EDITOR}`]))
    expect(w.cp.mock.calls[0]![0]).toMatchObject({ integrationIds: [INT], requesterId: GUEST, sessionId: 'sid-1' })
    expect(w.conn.openDirectMessage).toHaveBeenCalledWith(EDITOR)
    // The card says which agent asks and links its session.
    const card = cardText(w.cardPosts.mock.calls[0]![1])
    expect(card).toContain('Butler is waiting on an approval')
    expect(card).toContain('Open session')
    const id = w.onlyRequest()

    await w.permissions.handlePermissionChoice({ requestId: id, optionId: 'allow', actor: { userId: GUEST } })
    expect(decided).not.toHaveBeenCalled()
    await w.permissions.handlePermissionChoice({ requestId: id, optionId: 'allow', actor: { userId: EDITOR } })
    await vi.waitFor(() =>
      expect(decided).toHaveBeenCalledWith({ outcome: { outcome: 'selected', optionId: 'allow' } })
    )
    // The click was rechecked against the control plane for the routed console user.
    expect(w.cp).toHaveBeenCalledWith(
      expect.objectContaining({
        verify: { integrationId: INT, teamId: 'global', userId: EDITOR, consoleUserId: 'user-editor' }
      }),
      undefined
    )
    expect((await w.store.listPermissionRequests(AGENT))[0]).toMatchObject({ status: 'allowed' })
    await vi.waitFor(() => expect(w.cardReplaces).toHaveBeenCalled())
    expect(cardText(w.cardReplaces.mock.calls.at(-1)![1])).toContain('Butler is waiting on an approval')
    await w.store.close()
  })

  it('retires the card without deciding when the editor is no longer authorized', async () => {
    const w = await world(GUEST)
    routeToEditor(w, false)
    const decided = vi.fn()
    void w.permissions.onAcpPermission(AGENT, 's1', permission).then(decided)
    await vi.waitFor(() => expect(w.postedTo()).toEqual([`a:${EDITOR}`]))
    await w.permissions.handlePermissionChoice({
      requestId: w.onlyRequest(),
      optionId: 'allow',
      actor: { userId: EDITOR }
    })
    await vi.waitFor(() => expect(w.cardReplaces).toHaveBeenCalled())
    expect(cardText(w.cardReplaces.mock.calls[0]![1])).toContain('No longer authorized')
    expect(decided).not.toHaveBeenCalled()
    expect((await w.store.listPermissionRequests(AGENT))[0]).toMatchObject({ status: 'pending' })
    await w.store.close()
  })

  const row = async (w: Awaited<ReturnType<typeof world>>) =>
    (await w.store.listPermissionRequests(AGENT))[0] as unknown as Record<string, unknown>

  it('sends an MCP approval to the routed editor’s own chat as a card of its choices, which only they decide', async () => {
    const w = await world(GUEST)
    routeToEditor(w)
    const decided = vi.fn()
    void w.permissions.onAcpElicit(AGENT, 's1', question).then(decided)
    await vi.waitFor(() => expect(w.postedTo()).toEqual([`a:${EDITOR}`]))
    const card = cardText(w.cardPosts.mock.calls[0]![1])
    expect(card).toContain('Butler is waiting on an approval')
    expect(card).toContain('Which one?')
    expect(card).toContain('"Deny"')
    // Its handle is on the row, so a restart's sweep retires it.
    await vi.waitFor(async () =>
      expect(await row(w)).toMatchObject({ notifyIntegrationId: INT, notifyTs: 'activity-1' })
    )
    const id = w.onlyRequest()

    await w.permissions.handlePermissionChoice({ requestId: id, option: 1, ts: 'activity-1', actor: { userId: GUEST } })
    expect(decided).not.toHaveBeenCalled()
    await w.permissions.handlePermissionChoice({
      requestId: id,
      option: 1,
      ts: 'activity-1',
      actor: { userId: EDITOR }
    })
    await vi.waitFor(() => expect(decided).toHaveBeenCalledWith({ action: 'accept', content: { pick: 'b' } }))
    expect(await row(w)).toMatchObject({ status: 'allowed', notifyTs: null })
    await vi.waitFor(() => expect(w.cardReplaces).toHaveBeenCalled())
    expect(cardText(w.cardReplaces.mock.calls.at(-1)![1])).toContain('b — Edie')
    await w.store.close()
  })

  it('declines an MCP approval from its card’s Deny', async () => {
    const w = await world(GUEST)
    routeToEditor(w)
    const decided = vi.fn()
    void w.permissions.onAcpElicit(AGENT, 's1', question).then(decided)
    await vi.waitFor(() => expect(w.postedTo()).toEqual([`a:${EDITOR}`]))
    await w.permissions.handlePermissionChoice({ requestId: w.onlyRequest(), option: 2, actor: { userId: EDITOR } })
    await vi.waitFor(() => expect(decided).toHaveBeenCalledWith({ action: 'decline' }))
    expect(await row(w)).toMatchObject({ status: 'denied' })
    await w.store.close()
  })

  it('retires an MCP approval’s card without deciding when the editor is no longer authorized', async () => {
    const w = await world(GUEST)
    routeToEditor(w, false)
    const decided = vi.fn()
    void w.permissions.onAcpElicit(AGENT, 's1', question).then(decided)
    await vi.waitFor(() => expect(w.postedTo()).toEqual([`a:${EDITOR}`]))
    await w.permissions.handlePermissionChoice({ requestId: w.onlyRequest(), option: 0, actor: { userId: EDITOR } })
    await vi.waitFor(() => expect(w.cardReplaces).toHaveBeenCalled())
    expect(cardText(w.cardReplaces.mock.calls[0]![1])).toContain('No longer authorized')
    expect(decided).not.toHaveBeenCalled()
    expect(await row(w)).toMatchObject({ status: 'pending' })
    await w.store.close()
  })

  it('retires an MCP approval’s card after a restart settled its request', async () => {
    const w = await world(GUEST)
    routeToEditor(w)
    void w.permissions.onAcpElicit(AGENT, 's1', question)
    await vi.waitFor(async () => expect(await row(w)).toMatchObject({ notifyTs: 'activity-1' }))
    // As if the process died: the row settles with no live entry to rewrite the card.
    const id = w.onlyRequest()
    w.permissions.pendingApprovals.delete(id)
    await w.store.resolvePermissionRequest(AGENT, id, 'expired', Date.now())
    await w.permissions.retireOrphanedCards(INT)
    expect(w.cardReplaces.mock.calls.map((call) => call[0])).toEqual(['activity-1'])
    expect(await row(w)).toMatchObject({ notifyTs: null })
    await w.store.close()
  })

  it('sends no card for an MCP approval that reduces to no choices', async () => {
    const w = await world(GUEST)
    routeToEditor(w)
    void w.permissions.onAcpElicit(AGENT, 's1', yesNo)
    await vi.waitFor(() => expect(w.permissions.pendingApprovals.size).toBe(1))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(w.postedTo()).toEqual([])
    expect(w.cp).not.toHaveBeenCalled()
    await w.store.close()
  })

  it('keeps the editor’s card when approving in chat is turned off', async () => {
    const w = await world(GUEST)
    routeToEditor(w)
    void w.permissions.onAcpPermission(AGENT, 's1', permission)
    await vi.waitFor(() => expect(w.postedTo()).toEqual([`a:${EDITOR}`]))
    w.permissions.disableChatPermissionSurfaces(AGENT)
    expect(w.cardReplaces).not.toHaveBeenCalled()
    await w.store.close()
  })
})

describe('an approval on the editor path of an agent on both Slack and Teams', () => {
  const routedTo = (w: Awaited<ReturnType<typeof world>>) =>
    w.cp.mock.calls.map((call) => (call[0] as { integrationIds?: string[] }).integrationIds)

  it('offers Slack before Teams for a permission request', async () => {
    const w = await world(GUEST, true)
    void w.permissions.onAcpPermission(AGENT, 's1', permission)
    await vi.waitFor(() => expect(routedTo(w)).toEqual([[SLACK_INT, INT]]))
    await w.store.close()
  })

  it('offers Slack before Teams for an MCP approval with choices', async () => {
    const w = await world(GUEST, true)
    void w.permissions.onAcpElicit(AGENT, 's1', question)
    await vi.waitFor(() => expect(routedTo(w)).toEqual([[SLACK_INT, INT]]))
    await w.store.close()
  })

  it('offers only Slack for an MCP approval no Teams card answers', async () => {
    const w = await world(GUEST, true)
    void w.permissions.onAcpElicit(AGENT, 's1', yesNo)
    await vi.waitFor(() => expect(routedTo(w)).toEqual([[SLACK_INT]]))
    await w.store.close()
  })
})

describe('an approval card in a Teams channel only editors may answer', () => {
  /** The control plane routes to EDITOR, verifies them on their card, and counts EDITOR and MEMBER_EDITOR as editors in the channel. */
  function editorsWorld(asker = ASKER, slack = false) {
    return world(asker, slack, true).then((w) => {
      w.cp.mockImplementation(
        async (payload: { requestId: string; verify?: unknown }): Promise<Record<string, unknown>> => {
          const verify = payload.verify as { userId: string; consoleUserId?: string } | undefined
          if (verify?.consoleUserId) return { requestId: payload.requestId, allowed: true, displayName: 'Edie' }
          if (verify) {
            const editor = verify.userId === EDITOR || verify.userId === MEMBER_EDITOR
            return { requestId: payload.requestId, allowed: editor, linked: true }
          }
          return {
            requestId: payload.requestId,
            target: { integrationId: INT, teamId: 'global', userId: EDITOR, consoleUserId: 'user-editor' }
          }
        }
      )
      return w
    })
  }
  const besideRow = async (w: Awaited<ReturnType<typeof world>>) =>
    (await w.store.listPermissionRequests(AGENT))[0] as unknown as Record<string, unknown>
  const replaced = (w: Awaited<ReturnType<typeof world>>): string[] => w.cardReplaces.mock.calls.map((call) => call[0])

  it('also sends the routed editor the card in their own chat, which decides it there', async () => {
    const w = await editorsWorld()
    const decided = vi.fn()
    void w.permissions.onAcpPermission(AGENT, 's1', permission).then(decided)
    await vi.waitFor(() => expect(w.postedTo()).toHaveLength(2))
    expect(w.postedTo()[1]).toBe(`a:${EDITOR}`)
    // Its handle is the row's beside one, so a restart's sweep retires it.
    await vi.waitFor(async () =>
      expect(await besideRow(w)).toMatchObject({ besideIntegrationId: INT, besideTs: 'activity-2' })
    )
    await w.permissions.handlePermissionChoice({
      requestId: w.onlyRequest(),
      optionId: 'allow',
      ts: 'activity-2',
      actor: { userId: EDITOR }
    })
    await vi.waitFor(() =>
      expect(decided).toHaveBeenCalledWith({ outcome: { outcome: 'selected', optionId: 'allow' } })
    )
    // Both cards say how it ended, and the beside handle is gone.
    await vi.waitFor(() => expect(replaced(w).sort()).toEqual(['activity-1', 'activity-2']))
    await vi.waitFor(async () => expect(await besideRow(w)).toMatchObject({ status: 'allowed', besideTs: null }))
    await w.store.close()
  })

  it('settles the editor’s card too when an editor in the channel answers first', async () => {
    const w = await editorsWorld()
    const decided = vi.fn()
    void w.permissions.onAcpPermission(AGENT, 's1', permission).then(decided)
    await vi.waitFor(() => expect(w.postedTo()).toHaveLength(2))
    const id = w.onlyRequest()
    // A non-editor in the channel is refused; the cards stay live.
    await w.permissions.handlePermissionChoice({
      requestId: id,
      optionId: 'allow',
      ts: 'activity-1',
      actor: { userId: ASKER }
    })
    expect(decided).not.toHaveBeenCalled()
    await w.permissions.handlePermissionChoice({
      requestId: id,
      optionId: 'deny',
      ts: 'activity-1',
      actor: { userId: MEMBER_EDITOR }
    })
    await vi.waitFor(() => expect(decided).toHaveBeenCalledWith({ outcome: { outcome: 'selected', optionId: 'deny' } }))
    await vi.waitFor(() => expect(replaced(w).sort()).toEqual(['activity-1', 'activity-2']))
    await w.store.close()
  })

  it('retires only the editor’s card when they are no longer authorized', async () => {
    const w = await editorsWorld()
    w.cp.mockImplementation(
      async (payload: { requestId: string; verify?: unknown }): Promise<Record<string, unknown>> =>
        (payload.verify as { consoleUserId?: string } | undefined)?.consoleUserId
          ? { requestId: payload.requestId, allowed: false }
          : payload.verify
            ? { requestId: payload.requestId, allowed: false, linked: true }
            : {
                requestId: payload.requestId,
                target: { integrationId: INT, teamId: 'global', userId: EDITOR, consoleUserId: 'user-editor' }
              }
    )
    const decided = vi.fn()
    void w.permissions.onAcpPermission(AGENT, 's1', permission).then(decided)
    await vi.waitFor(() => expect(w.postedTo()).toHaveLength(2))
    await w.permissions.handlePermissionChoice({
      requestId: w.onlyRequest(),
      optionId: 'allow',
      ts: 'activity-2',
      actor: { userId: EDITOR }
    })
    await vi.waitFor(() => expect(replaced(w)).toEqual(['activity-2']))
    expect(JSON.stringify(w.cardReplaces.mock.calls[0]![1])).toContain('No longer authorized')
    expect(decided).not.toHaveBeenCalled()
    await w.store.close()
  })

  it('sends no second card when the person who asked is an editor', async () => {
    const w = await editorsWorld(MEMBER_EDITOR)
    void w.permissions.onAcpPermission(AGENT, 's1', permission)
    await vi.waitFor(() => expect(w.postedTo()).toHaveLength(1))
    await vi.waitFor(() =>
      expect(w.cp).toHaveBeenCalledWith(expect.objectContaining({ verify: expect.anything() }), undefined)
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(w.postedTo()).toHaveLength(1)
    expect(w.cp.mock.calls.some((call) => !(call[0] as { verify?: unknown }).verify)).toBe(false)
    await w.store.close()
  })

  it('offers Slack before Teams for the editor beside the card', async () => {
    const w = await editorsWorld(ASKER, true)
    void w.permissions.onAcpPermission(AGENT, 's1', permission)
    await vi.waitFor(() =>
      expect(
        w.cp.mock.calls
          .map((call) => call[0] as { verify?: unknown; integrationIds?: string[] })
          .filter((payload) => !payload.verify)
          .map((payload) => payload.integrationIds)
      ).toEqual([[SLACK_INT, INT]])
    )
    await w.store.close()
  })

  it('retires the editor’s card after a restart settled its request', async () => {
    const w = await editorsWorld()
    void w.permissions.onAcpPermission(AGENT, 's1', permission)
    await vi.waitFor(async () => expect(await besideRow(w)).toMatchObject({ besideTs: 'activity-2' }))
    // As if the process died: the row settles with no live entry to rewrite the card.
    const id = w.onlyRequest()
    w.permissions.pendingApprovals.delete(id)
    await w.store.resolvePermissionRequest(AGENT, id, 'expired', Date.now())
    await w.permissions.retireOrphanedCards(INT)
    expect(replaced(w)).toEqual(['activity-2'])
    expect(await besideRow(w)).toMatchObject({ besideTs: null })
    await w.store.close()
  })
})

describe('a Codex MCP approval on a Teams card', () => {
  /** The MCP call the turn saw before its approval was asked. */
  const mcpCall = (toolCallId: string) => ({
    sessionUpdate: 'tool_call',
    toolCallId,
    kind: 'execute',
    title: 'mcp.get-time.get_current_time',
    rawInput: { server: 'get-time', tool: 'get_current_time', arguments: { timezone: 'UTC' } }
  })

  it('names the server and tool of a request that carries only its id and kind', async () => {
    const w = await world()
    w.daemon.onAcpUpdate(AGENT, 's1', mcpCall('call-m'))
    const asked = { ...permission, toolCall: { toolCallId: 'call-m', kind: 'execute', status: 'pending' } }
    void w.permissions.onAcpPermission(AGENT, 's1', asked)
    await vi.waitFor(() => expect(w.postedTo()).toEqual([`a:${ASKER}`]))
    const card = JSON.stringify(w.cardPosts.mock.calls[0]![1])
    expect(card).toContain('Permission requested — get-time · get_current_time')
    expect(card).not.toContain('— execute')
    expect((await w.store.listPermissionRequests(AGENT))[0]).toMatchObject({
      command: 'get-time · get_current_time: timezone=UTC'
    })
    await w.store.close()
  })

  it('names the server and tool of an MCP approval with choices', async () => {
    const w = await world()
    w.daemon.onAcpUpdate(AGENT, 's1', mcpCall('call-e'))
    void w.permissions.onAcpElicit(AGENT, 's1', question)
    await vi.waitFor(() => expect(w.postedTo()).toEqual([`a:${ASKER}`]))
    expect(JSON.stringify(w.cardPosts.mock.calls[0]![1])).toContain('get-time · get_current_time')
    await w.store.close()
  })
})
