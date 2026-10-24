/** A Teams approval card in one person's own 1:1 chat: an external place's asker (assistant-mode.md §5.5), or the editor the control plane routes it to (teams-integration.md §4.4). */
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import type { RequestPermissionRequest } from '@agentclientprotocol/sdk/unstable'
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

const permission = {
  sessionId: 's1',
  options: [
    { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
    { optionId: 'deny', name: 'Deny', kind: 'reject_once' }
  ],
  toolCall: { toolCallId: 'tc-1', title: 'Write example.txt' }
} as unknown as RequestPermissionRequest

/** A daemon holding one live Teams turn in a shared channel, asked by `asker`, with every card captured. */
async function world(asker = ASKER) {
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
      decisions: { bindings: [], definitions: [] }
    },
    config: { appId: ZERO, tenantId: ZERO, clientSecret: 'client-secret-example' }
  }
  daemon.agents.set(AGENT, { id: AGENT, name: 'Butler', chatActions: 'approve', integrations: [integration] })
  const conn = Object.create(MsTeamsConnection.prototype)
  let posted = 0
  conn.isFullMember = vi.fn(async (user: string) => user !== GUEST)
  conn.openDirectMessage = vi.fn(async (user: string) => `a:${user}`)
  conn.targetFor = (channel: string) => ({ serviceUrl: 'https://smba.example.test/', conversationId: channel })
  conn.postCard = vi.fn(async () => `activity-${++posted}`)
  conn.replaceCard = vi.fn(async () => {})
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
      msg: { source: 'user', text: 'please write it', sender: { id: asker, isBot: false }, externallyShared: true }
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
  })
  const permissions = daemon.permissions
  const postedTo = (): string[] =>
    conn.postCard.mock.calls.map((call: [{ conversationId: string }]) => call[0].conversationId)
  const onlyRequest = (): string => [...permissions.pendingApprovals.keys()][0]
  return { store, conn, cp, permissions, postedTo, onlyRequest, applied }
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
    await vi.waitFor(() => expect(w.conn.replaceCard).toHaveBeenCalled())
    await w.store.close()
  })

  it('opens no chat for an asker who is not a full member, leaving the notice in the channel', async () => {
    const w = await world(GUEST)
    void w.permissions.onAcpPermission(AGENT, 's1', permission)
    await vi.waitFor(() => expect(w.applied.some((a) => a.kind === 'notice')).toBe(true))
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
    const card = cardText(w.conn.postCard.mock.calls[0]![1])
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
    await vi.waitFor(() => expect(w.conn.replaceCard).toHaveBeenCalled())
    expect(cardText(w.conn.replaceCard.mock.calls.at(-1)![1])).toContain('Butler is waiting on an approval')
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
    await vi.waitFor(() => expect(w.conn.replaceCard).toHaveBeenCalled())
    expect(cardText(w.conn.replaceCard.mock.calls[0]![1])).toContain('No longer authorized')
    expect(decided).not.toHaveBeenCalled()
    expect((await w.store.listPermissionRequests(AGENT))[0]).toMatchObject({ status: 'pending' })
    await w.store.close()
  })

  it('keeps the editor’s card when approving in chat is turned off', async () => {
    const w = await world(GUEST)
    routeToEditor(w)
    void w.permissions.onAcpPermission(AGENT, 's1', permission)
    await vi.waitFor(() => expect(w.postedTo()).toEqual([`a:${EDITOR}`]))
    w.permissions.disableChatPermissionSurfaces(AGENT)
    expect(w.conn.replaceCard).not.toHaveBeenCalled()
    await w.store.close()
  })
})
