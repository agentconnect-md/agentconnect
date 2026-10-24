// A background sub-session's runtime permission request reaches the conversation it belongs to (assistant-mode.md §5.6).
import { SESSION_MESSAGE_HEADER } from '../src/collab/session-message.js'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import type { CreateElicitationRequest, RequestPermissionRequest } from '@agentclientprotocol/sdk/unstable'
import { APPROVAL_DM_ROUTE_V1_FEATURE, ASSISTANT_RESPONSIBLE_ROUTE_V1_FEATURE } from '@agentconnect.md/protocol'
import { FakeClock } from '@agentconnect.md/connection'
import { agentHostKey } from '../src/acp/host-key.js'
import type { ChatSurface } from '../src/agents/chat-actions.js'
import { REPORT_ANSWER_LANGUAGE } from '../src/collab/coordinator.js'
import { listAgentPermissionRequests } from '../src/cp/config-apply-handlers.js'
import { Daemon } from '../src/daemon.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import { PermissionCoordinator, type PermissionHost } from '../src/permissions/coordinator.js'
import {
  subsessionLabel,
  type SubsessionApprovalRoute,
  type SubsessionApprover
} from '../src/permissions/subsession-approval.js'
import { checkCoordinate, subsessionCoordinate, taskCoordinate } from '../src/session/subsession-coordinate.js'
import type { SlackConnection } from '../src/slack/connection.js'
import { buildSubsessionApprovalNotice } from '../src/slack/render.js'
import { LocalStore, SCHEMA_VERSION, sessionKey } from '../src/store/local-store.js'
import { SqliteAsyncDatabase } from '../src/store/sqlite-async-database.js'
import { pendingTurnKey, type Pending } from '../src/daemon/turn-types.js'
import { slackApprovalCards } from '../src/platforms/slack/approval-card.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import { WAIT } from './wait-support.js'

/** What the model received for a delivered message: its prompt when the console shows less (§9.5), else its text. */
const modelText = (msg: { text: string; turnBody?: { prompt?: string } }): string => msg.turnBody?.prompt ?? msg.text

const AGENT = 'bot-a'
const OWNER = agentHostKey(AGENT)
const ACP = 'acp-sub-1'
const HOUR = 3_600_000
const EDITOR = { integrationId: 'int-1', teamId: 'T1', userId: 'U-ed', consoleUserId: 'cu-ed', displayName: 'Ada' }

function fakeSlack(dm = 'D-ed') {
  let n = 0
  return {
    openDirectMessage: vi.fn(async () => dm),
    postBlocks: vi.fn(async () => `200.${++n}`),
    updateBlocks: vi.fn(async () => undefined),
    postEphemeral: vi.fn(async () => true),
    workspaceUrl: 'https://w.slack.example.test',
    workspaceId: () => 'T1',
    memberName: vi.fn(async () => 'Ada Example' as string | undefined)
  }
}
type FakeSlack = ReturnType<typeof fakeSlack>

const params = (sessionId = ACP): RequestPermissionRequest =>
  ({
    sessionId,
    toolCall: { toolCallId: 'call-1', title: 'Write src/app.ts' },
    options: [
      { optionId: 'o-always', name: 'Always allow', kind: 'allow_always' },
      { optionId: 'o-allow', name: 'Allow', kind: 'allow_once' },
      { optionId: 'o-deny', name: 'Deny', kind: 'reject_once' }
    ]
  }) as unknown as RequestPermissionRequest

const approvalElicitation = (): CreateElicitationRequest =>
  ({
    sessionId: ACP,
    toolCallId: 'call-e',
    mode: 'form',
    message: 'Allow the tool?',
    requestedSchema: { type: 'object', properties: { pick: { type: 'string', enum: ['once'] } }, required: ['pick'] },
    _meta: { codex_approval_kind: 'mcp_tool_call' }
  }) as unknown as CreateElicitationRequest

const slackPlace = (over: Partial<Extract<SubsessionApprovalRoute['place'], { kind: 'chat' }>> = {}) => ({
  kind: 'chat' as const,
  integrationId: 'int-1',
  channel: 'C1',
  thread: '100.1',
  external: false,
  ...over
})

const routeTo = (place: SubsessionApprovalRoute['place'], waitHours = 12): SubsessionApprovalRoute => ({
  parentSessionId: 'sid-parent',
  title: 'Fix the flaky test',
  place,
  waitHours
})

async function world(
  over: {
    thread?: string
    route?: SubsessionApprovalRoute | undefined
    approver?: SubsessionApprover
    chatOn?: boolean
    surface?: ChatSurface
    database?: DatabaseSync
    /** Only the agent's editors may answer in chat: these members are its linked editors. */
    editors?: string[]
  } = {}
) {
  const store = await LocalStore.open({
    database: SqliteAsyncDatabase.adopt(over.database ?? new DatabaseSync(':memory:'))
  })
  const clock = new FakeClock(1_000_000)
  const place = fakeSlack()
  const other = fakeSlack('D-other')
  const cp = vi.fn(async (payload: { requestId: string; verify?: unknown }) =>
    payload.verify
      ? { requestId: payload.requestId, allowed: true, displayName: 'Ada' }
      : { requestId: payload.requestId, target: EDITOR }
  )
  const thread = over.thread ?? subsessionCoordinate('500.5')
  const pending = new Map<string, Pending>()
  const p = {
    plan: {
      sessionKey: sessionKey('slack', 'C1', thread, AGENT),
      agentId: AGENT,
      agentName: 'Butler',
      platform: 'slack',
      channel: 'C1',
      integrationId: 'int-1',
      requesterId: AGENT,
      sessionThread: thread,
      statusThread: thread,
      approvalSurfaceSuppressed: false
    },
    approval: { waitMs: 0, depth: 0 },
    acpSessionId: ACP,
    hostKey: OWNER,
    outwardSessionId: 'sid-sub',
    builtinSystemToolCallIds: new Set<string>(),
    entry: { msg: { text: 'From your own main conversation, as a background sub-session: fix it' } }
  } as unknown as Pending
  pending.set(pendingTurnKey(OWNER, ACP), p)
  const subsessionApprovalRoute = vi.fn(async () => ('route' in over ? over.route : routeTo(slackPlace())))
  const assistantApprover = vi.fn(async () => over.approver)
  const cancelTurn = vi.fn(async () => {})
  const conns: Record<string, FakeSlack> = { 'int-1': place, 'int-2': other }
  const host: PermissionHost = {
    log: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) as never,
    clock: () => clock,
    cancelTurn,
    store: () => store,
    agents: () =>
      new Map([
        [AGENT, { id: AGENT, name: 'Butler', chatActions: over.chatOn === true ? 'approve' : 'talk' } as never]
      ]),
    pending: () => pending,
    evalHooks: () => ({ emit: vi.fn() }) as never,
    memoryExtraction: () => undefined,
    enqueueApply: vi.fn(),
    postCardSerialized: vi.fn(async () => undefined),
    elicitCardFacet: () => undefined,
    httpSlackSessionTarget: () => undefined,
    maskAgentSecrets: (_agentId, payload) => payload,
    logSessionAction: vi.fn(),
    emitApprovalActivity: vi.fn(),
    approvalGateOpened: () => false,
    approvalGateClosed: vi.fn(),
    cpApprovalRoute: () => ({ approvalRoute: cp as never }),
    orgForAgent: () => 'org-1',
    sessionLink: (sessionId) => `https://console.example.test/sessions/${sessionId}`,
    slackConnFor: (integrationId) => conns[integrationId] as unknown as SlackConnection | undefined,
    approvalCardFacet: () => slackApprovalCards,
    chatCardsAt: (integrationId) => {
      const conn = conns[integrationId]
      return conn ? { facet: slackApprovalCards, conn } : undefined
    },
    approvalDmIntegrations: () => ['int-1'],
    slackDmSessionTarget: (_p, integrationId) => `target:${integrationId}`,
    subsessionApprovalRoute,
    assistantApprover,
    chatSurface: () => over.surface ?? 'open',
    chatEditorsOnly: () => over.editors !== undefined,
    chatActor: async (_agentId, _integrationId, actor) =>
      !over.editors || over.editors.includes(actor?.userId ?? '') ? 'allowed' : 'not-editor'
  }
  const coordinator = new PermissionCoordinator(host)
  /** The one request the sub-session has waiting, once it is listed. */
  const requestId = async (): Promise<string> => {
    await vi.waitFor(() => expect(coordinator.pendingSubsessionApprovals(AGENT)).toHaveLength(1))
    return coordinator.pendingSubsessionApprovals(AGENT)[0]!.requestId
  }
  return { store, clock, place, other, cp, p, host, coordinator, cancelTurn, subsessionApprovalRoute, requestId }
}

const blocksOf = (conn: FakeSlack, call = 0) => JSON.stringify((conn.postBlocks.mock.calls[call] as unknown[])[1])
const rows = async (store: LocalStore) => await store.listPermissionRequests(AGENT)
/** Every rewrite of the message posted as `ts`, as text. */
const rewritesOf = (conn: FakeSlack, ts: string) =>
  conn.updateBlocks.mock.calls
    .filter((call) => (call as unknown[])[1] === ts)
    .map((call) => JSON.stringify((call as unknown[])[2]))

describe('a sub-session’s permission request in the conversation it belongs to', () => {
  it('posts the in-chat card into the conversation’s thread where anyone there may answer, and settles once', async () => {
    const w = await world({ chatOn: true })
    const decided = w.coordinator.onAcpPermission(OWNER, ACP, params())
    const id = await w.requestId()
    await vi.waitFor(() => expect(w.place.postBlocks).toHaveBeenCalledTimes(1))

    const [channel, , , thread] = w.place.postBlocks.mock.calls[0] as unknown[]
    expect([channel, thread]).toEqual(['C1', '100.1'])
    const card = blocksOf(w.place)
    expect(card).toContain('task “')
    expect(card).toContain('Fix the flaky test')
    expect(card).toContain('https://console.example.test/sessions/sid-sub')
    expect(card).toContain('12 hours')
    // Every option the runtime offered, "always allow" included, and the click comes home through the place's integration.
    for (const name of ['Always allow', 'Allow', 'Deny']) expect(card).toContain(name)
    expect(card).toContain('target:int-1')
    // Anyone in the place may answer, so no editor is DMed.
    expect(w.cp).not.toHaveBeenCalled()
    expect(w.coordinator.dmNotifiedVia(id, AGENT, 'int-1')).toBe(true)

    await w.coordinator.handlePermissionChoice({ requestId: id, optionId: 'o-always', actor: { userId: 'U9' } })
    await expect(decided).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'o-always' } })
    // A relayed click carries only the member's id, so the decider is named by a lookup.
    expect((await rows(w.store))[0]).toMatchObject({
      status: 'allowed',
      resolvedBy: 'slack:T1:U9',
      resolvedByName: 'Ada Example'
    })
    // The rewrite keeps who was asking, and the card's handle leaves the row with it.
    const rewritten = JSON.stringify((w.place.updateBlocks.mock.calls[0] as unknown[])[2])
    expect(rewritten).toContain('task “')
    expect(rewritten).toContain('Always allow — Ada Example')
    expect(await w.store.takeOrphanedPermissionNotices('int-1')).toEqual([])

    // A second click, and the wait it no longer has, change nothing.
    await w.coordinator.handlePermissionChoice({ requestId: id, optionId: 'o-deny', actor: { userId: 'U9' } })
    expect(w.place.updateBlocks).toHaveBeenCalledTimes(1)
    expect(w.coordinator.pendingSubsessionApprovals(AGENT)).toEqual([])
    expect(w.clock.pending).toBe(0)
    await w.store.close()
  })

  it('leaves a neutral notice in the conversation and DMs an editor when only an editor may answer', async () => {
    const w = await world()
    const decided = w.coordinator.onAcpPermission(OWNER, ACP, params())
    const id = await w.requestId()
    await vi.waitFor(() => expect(w.place.postBlocks).toHaveBeenCalledTimes(2))

    const [channel, , , thread] = w.place.postBlocks.mock.calls[0] as unknown[]
    expect([channel, thread]).toEqual(['C1', '100.1'])
    const notice = blocksOf(w.place)
    expect(notice).toContain('Ask an Agent editor')
    expect(notice).not.toContain('Write src/app.ts')
    expect(notice).not.toContain('"actions"')
    // The editor DM names the sub-session; a sub-session's turn has no requester to route from.
    expect((w.cp.mock.calls[0]![0] as { requesterId?: string }).requesterId).toBeUndefined()
    expect(blocksOf(w.place, 1)).toContain('task “')
    expect((w.place.postBlocks.mock.calls[1] as unknown[])[0]).toBe('D-ed')

    const ack = await w.coordinator.decideEditorPermission({
      agentId: AGENT,
      requestId: id,
      decision: 'allow',
      optionId: 'o-allow',
      decidedBy: 'user:cu-2',
      decidedByName: 'Grace'
    })
    expect(ack).toEqual({ ok: true })
    await expect(decided).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'o-allow' } })
    // The agent asked, so it is the requester the console shows.
    expect((await rows(w.store))[0]).toMatchObject({ status: 'allowed', requesterName: 'Butler', requesterId: null })
    // The notice says in place how it settled, still naming no tool, and its handle leaves the row.
    const [settled, ...more] = rewritesOf(w.place, '200.1')
    expect(more).toEqual([])
    expect(settled).toContain('“Fix the flaky test” got permission from Grace.')
    expect(settled).toContain('https://console.example.test/sessions/sid-sub')
    expect(settled).not.toContain('Write src/app.ts')
    expect(settled).not.toContain('waiting for permission')
    expect(rewritesOf(w.place, '200.2')).toHaveLength(1)
    expect(await w.store.takeOrphanedSubsessionNotices('int-1')).toEqual([])
    await w.store.close()
  })

  it.each([
    ['denied from the console', 'was denied permission by Grace.'],
    ['left unanswered past its wait', 'got no answer within 2 hours, so it was denied and stopped.'],
    ['released because its turn ended', 'no longer needs permission.']
  ] as const)('rewrites the notice when the request is %s', async (how, line) => {
    const w = await world({ route: routeTo(slackPlace(), 2) })
    const decided = w.coordinator.onAcpPermission(OWNER, ACP, params())
    const id = await w.requestId()
    await vi.waitFor(() => expect(w.place.postBlocks).toHaveBeenCalledTimes(2))
    expect(rewritesOf(w.place, '200.1')).toEqual([])

    if (how === 'denied from the console') {
      const ack = await w.coordinator.decideEditorPermission({
        agentId: AGENT,
        requestId: id,
        decision: 'deny',
        optionId: 'o-deny',
        decidedByName: 'Grace'
      })
      expect(ack).toEqual({ ok: true })
    } else if (how === 'left unanswered past its wait') w.clock.advance(2 * HOUR)
    else await w.coordinator.releaseApprovals(OWNER, ACP)
    await decided

    const [settled, ...more] = rewritesOf(w.place, '200.1')
    expect(more).toEqual([])
    expect(settled).toContain(`*Butler*’s task “Fix the flaky test” ${line}`)
    expect(settled).toContain('Open the task')
    expect(settled).not.toContain('Write src/app.ts')
    expect(await w.store.takeOrphanedSubsessionNotices('int-1')).toEqual([])
    await w.store.close()
  })

  it('rewrites a notice whose request was decided while it was being posted', async () => {
    const w = await world()
    let posted!: (ts: string) => void
    w.place.postBlocks.mockImplementationOnce(() => new Promise<string>((resolve) => (posted = resolve)))
    const decided = w.coordinator.onAcpPermission(OWNER, ACP, params())
    const id = await w.requestId()
    await vi.waitFor(() => expect(w.place.postBlocks).toHaveBeenCalledTimes(1))
    await w.coordinator.decideEditorPermission({
      agentId: AGENT,
      requestId: id,
      decision: 'allow',
      optionId: 'o-allow',
      decidedByName: 'Grace'
    })
    await decided

    posted('300.1')
    await vi.waitFor(() => expect(rewritesOf(w.place, '300.1')).toHaveLength(1))
    expect(rewritesOf(w.place, '300.1')[0]).toContain('got permission from Grace.')
    // Nothing is left on the row for a sweep, and no editor is DMed about a request already decided.
    expect(await w.store.takeOrphanedSubsessionNotices('int-1')).toEqual([])
    expect(w.place.postBlocks).toHaveBeenCalledTimes(1)
    await w.store.close()
  })

  it('leaves the notice and DMs an editor, not a card, where the conversation is closed', async () => {
    const w = await world({ chatOn: true, surface: 'closed' })
    void w.coordinator.onAcpPermission(OWNER, ACP, params())
    await w.requestId()
    await vi.waitFor(() => expect(w.place.postBlocks).toHaveBeenCalledTimes(2))
    expect(blocksOf(w.place)).toContain('Ask an Agent editor')
    expect(blocksOf(w.place)).not.toContain('"actions"')
    expect((w.place.postBlocks.mock.calls[1] as unknown[])[0]).toBe('D-ed')
    await w.store.close()
  })

  it('takes no click on a card whose conversation closed after it was posted', async () => {
    const over: { chatOn: boolean; surface: ChatSurface } = { chatOn: true, surface: 'open' }
    const w = await world(over)
    const decided = vi.fn()
    void w.coordinator.onAcpPermission(OWNER, ACP, params()).then(decided)
    const id = await w.requestId()
    await vi.waitFor(() => expect(w.place.postBlocks).toHaveBeenCalledTimes(1))
    over.surface = 'closed'
    await w.coordinator.handlePermissionChoice({ requestId: id, optionId: 'o-allow', actor: { userId: 'U9' } })
    expect(decided).not.toHaveBeenCalled()
    expect(w.coordinator.pendingSubsessionApprovals(AGENT)).toHaveLength(1)
    expect((await rows(w.store))[0]).toMatchObject({ status: 'pending' })
    await w.store.close()
  })

  it('posts nothing into a webchat conversation, which lists the request on its own page', async () => {
    const w = await world({ chatOn: true, route: routeTo({ kind: 'console' }) })
    void w.coordinator.onAcpPermission(OWNER, ACP, params())
    await w.requestId()
    // Only the editor DM goes out; the conversation's own page is its surface.
    await vi.waitFor(() => expect(w.place.postBlocks).toHaveBeenCalledTimes(1))
    expect(w.place.openDirectMessage).toHaveBeenCalledWith('U-ed')
    expect(blocksOf(w.place)).toContain('task “')
    await w.coordinator.releaseApprovals(OWNER, ACP)
    await w.store.close()
  })

  it.each([true, false])(
    'sends an external place’s card to its approver instead (chat approval %s)',
    async (chatOn) => {
      // The responsible user: their DM, whichever way chat approval is set, and nothing in the place.
      const member = await world({
        chatOn,
        route: routeTo(slackPlace({ external: true })),
        approver: { channel: 'D-approver', target: EDITOR }
      })
      const decided = member.coordinator.onAcpPermission(OWNER, ACP, params())
      const id = await member.requestId()
      await vi.waitFor(() => expect(member.place.postBlocks).toHaveBeenCalledTimes(1))
      expect((member.place.postBlocks.mock.calls[0] as unknown[])[0]).toBe('D-approver')
      expect(member.place.openDirectMessage).not.toHaveBeenCalled()
      expect(member.cp.mock.calls.every((call) => (call[0] as { verify?: unknown }).verify !== undefined)).toBe(true)
      await member.coordinator.handlePermissionChoice({ requestId: id, optionId: 'o-allow', actor: { userId: 'U-ed' } })
      await expect(decided).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'o-allow' } })
      await member.store.close()

      // No responsible user reachable: an editor's DM as for any other request, no conversation card, and Activity lists it.
      const nobody = await world({ chatOn, route: routeTo(slackPlace({ external: true })) })
      void nobody.coordinator.onAcpPermission(OWNER, ACP, params())
      await nobody.requestId()
      await vi.waitFor(() => expect(nobody.place.postBlocks).toHaveBeenCalledTimes(1))
      expect((nobody.place.postBlocks.mock.calls[0] as unknown[])[0]).toBe('D-ed')
      expect(nobody.other.postBlocks).not.toHaveBeenCalled()
      expect(nobody.coordinator.pendingSubsessionApprovals(AGENT)).toHaveLength(1)
      await nobody.coordinator.releaseApprovals(OWNER, ACP)
      await nobody.store.close()
    }
  )

  it('lets the first answer win across the card, the console and Activity', async () => {
    const w = await world({ chatOn: true })
    const decided = w.coordinator.onAcpPermission(OWNER, ACP, params())
    const id = await w.requestId()
    await vi.waitFor(() => expect(w.coordinator.dmNotifiedVia(id, AGENT, 'int-1')).toBe(true))

    // Activity and the sub-session page decide through the same console decision.
    const console = await w.coordinator.decideEditorPermission({
      agentId: AGENT,
      requestId: id,
      decision: 'deny',
      optionId: 'o-deny',
      decidedByName: 'Grace'
    })
    expect(console).toEqual({ ok: true })
    await expect(decided).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'o-deny' } })
    expect(JSON.stringify((w.place.updateBlocks.mock.calls[0] as unknown[])[2])).toContain('Deny — Grace')

    await w.coordinator.handlePermissionChoice({ requestId: id, optionId: 'o-allow', actor: { userId: 'U9' } })
    const again = await w.coordinator.decideEditorPermission({ agentId: AGENT, requestId: id, decision: 'allow' })
    expect(again).toEqual({ ok: false, reason: 'permission request is no longer pending' })
    expect(w.place.updateBlocks).toHaveBeenCalledTimes(1)
    expect((await rows(w.store))[0]).toMatchObject({ status: 'denied', resolvedByName: 'Grace' })
    expect(w.coordinator.pendingSubsessionApprovals(AGENT)).toEqual([])
    await w.store.close()
  })

  it('where only editors may answer, DMs an editor beside the card and takes only an editor’s click', async () => {
    const w = await world({ chatOn: true, editors: ['U-ed2'] })
    const decided = vi.fn()
    void w.coordinator.onAcpPermission(OWNER, ACP, params()).then(decided)
    const id = await w.requestId()
    await vi.waitFor(() => expect(w.place.postBlocks).toHaveBeenCalledTimes(2))
    expect((w.place.postBlocks.mock.calls[0] as unknown[])[0]).toBe('C1')
    expect(blocksOf(w.place)).toContain('"actions"')
    expect((w.place.postBlocks.mock.calls[1] as unknown[])[0]).toBe('D-ed')

    // Anyone else is told privately who can answer, and the card stays live.
    await w.coordinator.handlePermissionChoice({ requestId: id, optionId: 'o-allow', actor: { userId: 'U9' } })
    expect(w.place.postEphemeral).toHaveBeenCalledWith(
      'C1',
      'U9',
      expect.stringContaining('Only an Agent editor can answer this request.'),
      '100.1'
    )
    expect(w.place.updateBlocks).not.toHaveBeenCalled()
    expect(decided).not.toHaveBeenCalled()

    await w.coordinator.handlePermissionChoice({ requestId: id, optionId: 'o-allow', actor: { userId: 'U-ed2' } })
    await vi.waitFor(() =>
      expect(decided).toHaveBeenCalledWith({ outcome: { outcome: 'selected', optionId: 'o-allow' } })
    )
    expect((await rows(w.store))[0]).toMatchObject({ status: 'allowed', resolvedBy: 'slack:T1:U-ed2' })
    // The card and the DM both say how it settled.
    expect(rewritesOf(w.place, '200.1')).toHaveLength(1)
    expect(rewritesOf(w.place, '200.2')).toHaveLength(1)
    await w.store.close()
  })

  it('denies after the wait cap, records why, and stops the sub-session', async () => {
    const w = await world({ chatOn: true, route: routeTo(slackPlace(), 2) })
    const decided = w.coordinator.onAcpPermission(OWNER, ACP, params())
    const id = await w.requestId()
    await vi.waitFor(() => expect(w.place.postBlocks).toHaveBeenCalledTimes(1))
    expect(w.coordinator.pendingSubsessionApprovals(AGENT)[0]).toMatchObject({
      sessionId: 'sid-sub',
      parentSessionId: 'sid-parent',
      tool: 'Write src/app.ts',
      expiresAt: new Date(1_000_000 + 2 * HOUR).toISOString()
    })
    // Its own cap, so the turn watchdog's shorter answer window leaves it alone.
    expect(w.coordinator.hasOwnWaitCap(OWNER, ACP)).toBe(true)

    w.clock.advance(2 * HOUR - 1)
    expect(w.cancelTurn).not.toHaveBeenCalled()
    w.clock.advance(1)
    // A cancelled turn answers its pending request `cancelled`; the record says it was denied, and why.
    await expect(decided).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    await vi.waitFor(() => expect(w.cancelTurn).toHaveBeenCalledWith(w.p, 'approval wait expired'))
    expect((await rows(w.store))[0]).toMatchObject({
      id,
      status: 'denied',
      resolvedBy: null,
      resolvedByName: 'No answer within 2 hours'
    })
    expect(JSON.stringify((w.place.updateBlocks.mock.calls[0] as unknown[])[2])).toContain(
      'Denied — No answer within 2 hours'
    )
    // Answered by nobody, so nobody can answer it now.
    await w.coordinator.handlePermissionChoice({ requestId: id, optionId: 'o-allow', actor: { userId: 'U9' } })
    expect((await rows(w.store))[0]!.status).toBe('denied')
    await w.store.close()
  })

  it('caps an approval elicitation’s wait the same way, at the 12 hours a policy without one waits', async () => {
    const w = await world({ route: routeTo({ kind: 'console' }) })
    const answered = w.coordinator.onAcpElicit(OWNER, ACP, approvalElicitation())
    await w.requestId()
    w.clock.advance(12 * HOUR)
    await expect(answered).resolves.toEqual({ action: 'cancel' })
    await vi.waitFor(() => expect(w.cancelTurn).toHaveBeenCalledWith(w.p, 'approval wait expired'))
    expect((await rows(w.store))[0]).toMatchObject({ status: 'denied', resolvedByName: 'No answer within 12 hours' })
    await w.store.close()
  })

  it('expires the card when the turn is cancelled by other means, and the wait with it', async () => {
    const w = await world({ chatOn: true })
    const decided = w.coordinator.onAcpPermission(OWNER, ACP, params())
    const id = await w.requestId()
    await vi.waitFor(() => expect(w.coordinator.dmNotifiedVia(id, AGENT, 'int-1')).toBe(true))
    await w.coordinator.releaseApprovals(OWNER, ACP)
    await expect(decided).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    expect(JSON.stringify((w.place.updateBlocks.mock.calls[0] as unknown[])[2])).toContain('Cancelled')
    expect((await rows(w.store))[0]!.status).toBe('expired')
    expect(w.clock.pending).toBe(0)
    w.clock.advance(24 * HOUR)
    expect(w.cancelTurn).not.toHaveBeenCalled()
    await w.store.close()
  })

  it('opens nothing when a Stop sweeps the session while the route is still being looked up', async () => {
    for (const ask of ['permission', 'elicitation'] as const) {
      const w = await world({ route: routeTo({ kind: 'console' }) })
      let found!: (route: SubsessionApprovalRoute) => void
      w.subsessionApprovalRoute.mockImplementationOnce(() => new Promise((resolve) => (found = resolve)))
      const answered =
        ask === 'permission'
          ? w.coordinator.onAcpPermission(OWNER, ACP, params())
          : w.coordinator.onAcpElicit(OWNER, ACP, approvalElicitation())
      await vi.waitFor(() => expect(w.subsessionApprovalRoute).toHaveBeenCalledTimes(1))
      // A Stop suppresses the turn and sweeps its approvals before the lookup returns.
      ;(w.p as { outputSuppressed?: string }).outputSuppressed = 'stop'
      await w.coordinator.releaseApprovals(OWNER, ACP)
      found(routeTo({ kind: 'console' }))
      await expect(answered).resolves.toEqual(
        ask === 'permission' ? { outcome: { outcome: 'cancelled' } } : { action: 'cancel' }
      )
      expect(w.coordinator.pendingSubsessionApprovals(AGENT)).toHaveLength(0)
      expect(await rows(w.store)).toHaveLength(0)
      expect(w.clock.pending).toBe(0)
      await w.store.close()
    }
  })

  it('leaves no card that grants anything after a restart, and the sweep retires it', async () => {
    const database = new DatabaseSync(':memory:')
    const w = await world({ chatOn: true, database })
    void w.coordinator.onAcpPermission(OWNER, ACP, params())
    const id = await w.requestId()
    await vi.waitFor(() => expect(w.coordinator.dmNotifiedVia(id, AGENT, 'int-1')).toBe(true))

    // The process dies: the next one opens the store, which expires every request no resolver holds any more.
    const restarted = await world({ chatOn: true, database })
    await restarted.coordinator.handlePermissionChoice({ requestId: id, optionId: 'o-allow', actor: { userId: 'U9' } })
    expect(
      await restarted.coordinator.decideEditorPermission({ agentId: AGENT, requestId: id, decision: 'allow' })
    ).toEqual({ ok: false, reason: 'permission request is no longer pending' })
    expect((await rows(restarted.store))[0]).toMatchObject({ id, status: 'expired' })
    // The card in the conversation is on the row, so reconnecting its integration retires it.
    expect(await restarted.store.takeOrphanedPermissionNotices('int-1')).toMatchObject([
      { id, notifyChannel: 'C1', notifyTs: '200.1', status: 'expired' }
    ])
    expect(restarted.cancelTurn).not.toHaveBeenCalled()
    await restarted.store.close()
  })

  it('keeps both the card and the editor DM beside it on the row, so the sweep after a restart retires both', async () => {
    const database = new DatabaseSync(':memory:')
    const w = await world({ chatOn: true, editors: ['U-ed2'], database })
    void w.coordinator.onAcpPermission(OWNER, ACP, params())
    const id = await w.requestId()
    await vi.waitFor(() => expect(w.place.postBlocks).toHaveBeenCalledTimes(2))
    await vi.waitFor(async () =>
      expect(
        (await w.store.listPermissionRequests(AGENT)).length > 0 && w.coordinator.dmNotifiedVia(id, AGENT, 'int-1')
      ).toBe(true)
    )

    // The process dies: the next one expires the request, and reconnecting the integration finds both cards.
    const restarted = await world({ chatOn: true, editors: ['U-ed2'], database })
    expect((await rows(restarted.store))[0]).toMatchObject({ id, status: 'expired' })
    const orphans = await restarted.store.takeOrphanedPermissionNotices('int-1')
    expect(orphans.map((o) => [o.notifyChannel, o.notifyTs]).sort()).toEqual([
      ['C1', '200.1'],
      ['D-ed', '200.2']
    ])
    // Each is retired once.
    expect(await restarted.store.takeOrphanedPermissionNotices('int-1')).toEqual([])
    await restarted.store.close()
  })

  it('clears both handles when the request settles while the process lives', async () => {
    const w = await world({ chatOn: true, editors: ['U-ed2'] })
    const decided = w.coordinator.onAcpPermission(OWNER, ACP, params())
    const id = await w.requestId()
    await vi.waitFor(() => expect(w.place.postBlocks).toHaveBeenCalledTimes(2))
    await w.coordinator.handlePermissionChoice({ requestId: id, optionId: 'o-allow', actor: { userId: 'U-ed2' } })
    await decided
    expect(await w.store.takeOrphanedPermissionNotices('int-1')).toEqual([])
    await w.store.close()
  })

  it('settles a notice a restart left behind once its integration reconnects', async () => {
    const database = new DatabaseSync(':memory:')
    const w = await world({ database })
    await w.store.upsertSession({
      key: w.p.plan.sessionKey,
      agentId: AGENT,
      platform: 'slack',
      channel: 'C1',
      thread: w.p.plan.sessionThread,
      acpSessionId: ACP,
      sessionId: 'sid-sub',
      state: 'prompting',
      lastDeliveredTs: null,
      updatedAt: Date.now()
    })
    await w.store.setSessionTitle(
      w.p.plan.sessionKey,
      'From your own main conversation, as a background sub-session: fix it'
    )
    void w.coordinator.onAcpPermission(OWNER, ACP, params())
    const id = await w.requestId()
    await vi.waitFor(() => expect(w.place.postBlocks).toHaveBeenCalledTimes(2))

    // The process dies; the next one expires the request, and reconnecting the integration settles the notice once.
    const restarted = await world({ database })
    await restarted.coordinator.retireOrphanedSubsessionNotices('int-2')
    expect(restarted.place.updateBlocks).not.toHaveBeenCalled()
    await restarted.coordinator.retireOrphanedSubsessionNotices('int-1')
    await restarted.coordinator.retireOrphanedSubsessionNotices('int-1')
    expect(restarted.place.updateBlocks).toHaveBeenCalledTimes(1)
    const [channel, ts, blocks] = restarted.place.updateBlocks.mock.calls[0] as unknown[]
    expect([channel, ts]).toEqual(['C1', '200.1'])
    const settled = JSON.stringify(blocks)
    expect(settled).toContain('*Butler*’s task “fix it” no longer needs permission.')
    expect(settled).toContain('https://console.example.test/sessions/sid-sub')
    // The editor DM's card is still its own sweep's to retire.
    expect(await restarted.store.takeOrphanedPermissionNotices('int-1')).toMatchObject([
      { id, notifyChannel: 'D-ed', notifyTs: '200.2', status: 'expired' }
    ])
    await restarted.store.close()
  })

  it('never asks from a check, which refuses instead', async () => {
    const w = await world({ chatOn: true, thread: checkCoordinate('600.6') })
    await expect(w.coordinator.onAcpPermission(OWNER, ACP, params())).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'o-deny' }
    })
    await expect(w.coordinator.onAcpElicit(OWNER, ACP, approvalElicitation())).resolves.toEqual({ action: 'decline' })
    expect(w.subsessionApprovalRoute).not.toHaveBeenCalled()
    expect(w.place.postBlocks).not.toHaveBeenCalled()
    expect(await rows(w.store)).toEqual([])
    await w.store.close()
  })

  it('keeps a main conversation’s own request on today’s path, and a sub-session with no route too', async () => {
    const main = await world({ thread: '100.1' })
    void main.coordinator.onAcpPermission(OWNER, ACP, params())
    await vi.waitFor(() => expect(main.place.postBlocks).toHaveBeenCalledTimes(1))
    expect(main.subsessionApprovalRoute).not.toHaveBeenCalled()
    // Today's editor DM: routed from the turn's requester, and no wait cap.
    expect((main.cp.mock.calls[0]![0] as { requesterId?: string }).requesterId).toBe(AGENT)
    expect(blocksOf(main.place)).not.toContain('task “')
    expect(main.coordinator.pendingSubsessionApprovals(AGENT)).toEqual([])
    expect(main.clock.pending).toBe(0)
    expect(main.coordinator.hasOwnWaitCap(OWNER, ACP)).toBe(false)
    await main.coordinator.releaseApprovals(OWNER, ACP)
    await main.store.close()

    // The daemon answers no route for a sub-session it has not indexed: the request takes today's path.
    const plain = await world({ thread: taskCoordinate('700.7'), route: undefined })
    void plain.coordinator.onAcpPermission(OWNER, ACP, params())
    await vi.waitFor(() => expect(plain.place.postBlocks).toHaveBeenCalledTimes(1))
    expect(plain.subsessionApprovalRoute).toHaveBeenCalledTimes(1)
    expect((plain.place.postBlocks.mock.calls[0] as unknown[])[3]).toBeUndefined()
    expect(blocksOf(plain.place)).not.toContain('task “')
    expect(plain.clock.pending).toBe(0)
    await plain.coordinator.releaseApprovals(OWNER, ACP)
    await plain.store.close()
  })
})

describe('the approval queue names the conversation a sub-session asks from', () => {
  it('sets parentSessionId on a sub-session’s request only, settled ones included', async () => {
    const w = await world({ route: routeTo({ kind: 'console' }) })
    const thread = w.p.plan.sessionThread
    await w.store.upsertSession({
      key: w.p.plan.sessionKey,
      agentId: AGENT,
      platform: 'slack',
      channel: 'C1',
      thread,
      acpSessionId: ACP,
      sessionId: 'sid-sub',
      state: 'prompting',
      lastDeliveredTs: null,
      updatedAt: Date.now()
    })
    await w.store.assistantSubsessions.open({
      agentId: AGENT,
      childSessionKey: w.p.plan.sessionKey,
      parentSessionId: 'sid-parent',
      parentSessionKey: 'slack:C1:append:1:bot-a'
    })
    const decided = w.coordinator.onAcpPermission(OWNER, ACP, params())
    const id = await w.requestId()
    const host = {
      store: () => w.store,
      clock: () => w.clock,
      pendingPermissionOptions: (agentId: string, requestId: string) =>
        w.coordinator.pendingPermissionOptions(agentId, requestId)
    } as unknown as Parameters<typeof listAgentPermissionRequests>[0]
    const page = await listAgentPermissionRequests(host, { agentId: AGENT, limit: 50 })
    expect(page.requests).toMatchObject([
      { id, sessionId: 'sid-sub', parentSessionId: 'sid-parent', status: 'pending', requesterName: 'Butler' }
    ])
    expect(page.requests[0]!.options).toHaveLength(3)

    await w.coordinator.decideEditorPermission({ agentId: AGENT, requestId: id, decision: 'allow' })
    await decided
    const settled = await listAgentPermissionRequests(host, { agentId: AGENT, limit: 50 })
    expect(settled.requests[0]).toMatchObject({ status: 'allowed', parentSessionId: 'sid-parent' })

    // A main conversation's request names no parent.
    await w.store.upsertSession({
      key: 'slack:C1:100.1:bot-a',
      agentId: AGENT,
      platform: 'slack',
      channel: 'C1',
      thread: '100.1',
      acpSessionId: 'acp-main',
      sessionId: 'sid-main',
      state: 'prompting',
      lastDeliveredTs: null,
      updatedAt: Date.now()
    })
    await w.store.createPermissionRequest({
      id: '00000000-0000-4000-8000-000000000001',
      agentId: AGENT,
      sessionId: 'acp-main',
      createdAt: Date.now(),
      requesterId: 'U1',
      requesterName: null,
      command: 'Bash: ls',
      status: 'pending',
      resolvedAt: null
    })
    const both = await listAgentPermissionRequests(host, { agentId: AGENT, limit: 50 })
    const main = both.requests.find((r) => r.sessionId === 'sid-main')
    expect(main).toBeDefined()
    expect(main).not.toHaveProperty('parentSessionId')
    await w.store.close()
  })
})

describe('the name a sub-session’s cards give it', () => {
  it('uses the title, else the task without a released daemon’s wrapper, truncated, else none', () => {
    const wrapped = 'From your own main conversation, as a background sub-session: '
    expect(subsessionLabel('Fix the flaky test', `${wrapped}anything`)).toBe('Fix the flaky test')
    // The first-message title a sub-session is born with is the wrapper, so its task is read from the message.
    expect(subsessionLabel(`${wrapped}fix the f…`, `${wrapped}fix the flaky test and open a PR`)).toBe(
      'fix the flaky test and open a PR'
    )
    expect(subsessionLabel(`${wrapped}fix the f…`, undefined)).toBe('fix the f…')
    expect(subsessionLabel(null, `${wrapped}${'x'.repeat(200)}\nmore`)).toBe(`${'x'.repeat(80)}…`)
    expect(subsessionLabel(null, `${wrapped}  `)).toBeNull()
    expect(subsessionLabel(`  ${wrapped.trim()}  `, undefined)).toBeNull()
    expect(subsessionLabel(undefined, undefined)).toBeNull()
  })

  it('calls one with no name a task', () => {
    const notice = JSON.stringify(
      buildSubsessionApprovalNotice({
        agentName: 'Butler',
        title: null,
        sessionUrl: 'https://console.example.test/sessions/sid-sub',
        waitHours: 12
      })
    )
    expect(notice).toContain('*Butler*’s task is waiting for permission.')
    expect(notice).not.toContain('“')
  })
})

describe('the v44 → v45 notice handle on SQLite', () => {
  it('adds the notice columns to a v44 store and stamps the current version', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ac-subperm-v44-')), 'local.sqlite')
    await (await LocalStore.open(path)).close()
    const old = new DatabaseSync(path)
    for (const column of ['noticeIntegrationId', 'noticeChannel', 'noticeTs'])
      old.exec(`ALTER TABLE permission_requests DROP COLUMN ${column}`)
    old.exec('PRAGMA user_version = 44')
    old.close()

    const upgraded = await LocalStore.open(path)
    await upgraded.createPermissionRequest({
      id: 'request-1',
      agentId: AGENT,
      sessionId: ACP,
      createdAt: 100,
      requesterId: null,
      requesterName: 'Butler',
      command: 'Write src/app.ts',
      status: 'pending',
      resolvedAt: null
    })
    expect(await upgraded.setPermissionRequestNotice(AGENT, 'request-1', 'int-1', 'C1', '1.100')).toBe(true)
    await upgraded.close()
    const db = new DatabaseSync(path)
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION)
    db.close()
  })
})

const ORG = '00000000-0000-0000-0000-0000000000a1'

/** One Slack assistant-mode agent appending in `C1` with a one-hour wait, beside one that is not in assistant mode. */
function scaffold(opts: { external?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-subperm-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      runtimes: { claude: { command: 'node', args: ['unused'] } }
    })
  )
  for (const id of ['bot-a', 'bot-b']) {
    const adir = join(root, 'agents', id)
    mkdirSync(adir, { recursive: true })
    writeFileSync(
      join(adir, 'agent.json'),
      JSON.stringify({
        id,
        name: id,
        status: 'active',
        runtime: 'claude',
        workspace: { mode: 'from-scratch', path: join(adir, 'workspace') },
        integrations: [
          {
            id: `int-${id}`,
            platform: 'slack',
            core: {
              bindRules: [{ match: { kind: 'mention' } }],
              sessionModes: [{ channel: 'C1', mode: 'append' }],
              ...(opts.external ? { externalChannels: ['C1'] } : {})
            },
            config: { botToken: `xoxb-${id}`, appToken: `xapp-${id}` }
          }
        ],
        output: { mode: 'low' },
        chatActions: 'settings',
        ...(id === 'bot-a' ? { assistantMode: { enabled: true, limits: { permissionWaitHours: 1 } } } : {})
      })
    )
  }
  return root
}

/** Boot both agents; `agentId`'s main conversation in `C1` delegates to itself, and its sub-session asks for permission. */
async function delegateAndAsk(agentId: string, opts: { external?: boolean } = {}) {
  const clock = new FakeClock(Date.now())
  const answers: unknown[] = []
  // The runtime reaches back into the daemon it runs under, which exists only once it is built.
  const live: { d?: any } = {}
  const hostFactory = () => {
    let cancelled: (() => void) | undefined
    return {
      __started: true,
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => `acp-${randomUUID()}`),
      prompt: vi.fn(async (sessionId: string, blocks: unknown[]) => {
        if (!JSON.stringify(blocks).includes('as a delegated task')) return 'end_turn'
        const d = live.d
        const owner = [...d.pending.values()].find((p: Pending) => p.acpSessionId === sessionId)!.hostKey
        answers.push(await d.permissions.onAcpPermission(owner, sessionId, params(sessionId)))
        // A runtime keeps working after an answer until the stop reaches it.
        return await new Promise((resolve) => (cancelled = () => resolve('cancelled')))
      }),
      cancel: vi.fn(async () => cancelled?.()),
      stop: vi.fn(async () => {})
    } as any
  }
  const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root: scaffold(opts), hostFactory, clock })
  await daemon.start()
  const d = (live.d = daemon as any)
  const placements = [...d.agents.values()].map((agent: any) => ({
    agentId: agent.id,
    daemonId: 'local-daemon',
    name: agent.name,
    callPolicy: agent.callPolicy,
    allowedCallerAgentIds: agent.allowedCallerAgentIds,
    outboundPolicy: agent.outboundPolicy,
    allowedTargetAgentIds: agent.allowedTargetAgentIds
  }))
  d.cpCollab.replace({
    generation: 0,
    channels: [{ orgId: ORG, platform: 'slack', channelId: 'C1', agents: placements }],
    agents: placements.map((placement: any) => ({ ...placement, orgId: ORG }))
  })
  // A Control Plane that routes approval DMs and names the agent's responsible user.
  const approvalRoute = vi.fn(async (req: { requestId: string; responsible?: true }) => ({
    requestId: req.requestId,
    target: {
      integrationId: `int-${agentId}`,
      teamId: 'T0EXAMPLE',
      userId: req.responsible ? 'U0RESP' : 'U0EDITOR',
      consoleUserId: req.responsible ? 'usr-resp' : 'usr-editor'
    }
  }))
  const supported = [APPROVAL_DM_ROUTE_V1_FEATURE, ASSISTANT_RESPONSIBLE_ROUTE_V1_FEATURE]
  if (opts.external)
    d.cpClient = { supportsServerFeature: (f: string) => supported.includes(f), approvalRoute, stop() {} }
  const reports: NormalizedMessage[] = []
  const dispatch = d.dispatch.bind(d)
  d.dispatch = (id: string, msg: NormalizedMessage, ...rest: unknown[]) => {
    if (msg.parentReport === true) reports.push(msg)
    return dispatch(id, msg, ...rest)
  }
  const post = vi.spyOn(d.connByIntegration.get(`int-${agentId}`) as SlackConnection, 'postBlocks')

  const scope = d.transportScopeForIntegrationIds([`int-${agentId}`])
  const coordinate = await d.store.resolveAppendCoordinate(agentId, 'C1', scope, 1)
  await d.store.upsertSession({
    key: sessionKey('slack', 'C1', coordinate, agentId, scope),
    agentId,
    platform: 'slack',
    channel: 'C1',
    thread: coordinate,
    transportScope: scope,
    acpSessionId: 'acp-parent-1',
    sessionId: 'sid-parent-1',
    state: 'idle',
    lastDeliveredTs: null,
    updatedAt: Date.now()
  })
  const res = await d.collab.messageAgent({
    callerAgentId: agentId,
    platform: 'slack',
    callerChannel: 'C1',
    callerThread: coordinate,
    callerTransportScope: scope,
    toAgentId: agentId,
    text: 'fix the flaky test and open a PR',
    channel: 'C1',
    thread: '100.1',
    postless: true
  })
  expect(res).toMatchObject({ delivered: true, subsession: true })
  await vi.waitFor(() => expect(post).toHaveBeenCalled(), WAIT)
  return { daemon, d, clock, answers, reports, post, approvalRoute, res }
}

describe('through the daemon', () => {
  it.each([
    ['in assistant mode, after its configured hour', 'bot-a', 1, 'within 1 hour,', 'No answer within 1 hour'],
    ['outside assistant mode, after the default 12 hours', 'bot-b', 12, 'within 12 hours,', 'No answer within 12 hours']
  ])(
    'cards the parent’s Slack conversation %s, then the wait cap denies, stops and reports into it',
    async (_label, agentId, hours, cardWait, deniedBy) => {
      const { daemon, d, clock, answers, reports, post, res } = await delegateAndAsk(agentId)

      // An append conversation has no platform thread of its own, so the card goes to its root, as its reports do.
      const [channel, blocks, , thread] = post.mock.calls[0]!
      expect([channel, thread]).toEqual(['C1', undefined])
      expect(JSON.stringify(blocks)).toContain('task “')
      expect(JSON.stringify(blocks)).toContain(cardWait)
      expect(JSON.stringify(blocks)).toContain('Always allow')
      // Named by its task, not by the wrapper its first message carries.
      expect(JSON.stringify(blocks)).toContain('“fix the flaky test and open a PR”')
      expect(JSON.stringify(blocks)).not.toContain('From your own main conversation')
      expect(d.permissions.pendingSubsessionApprovals(agentId)).toMatchObject([
        { parentSessionId: 'sid-parent-1', tool: 'Write src/app.ts' }
      ])

      // Nothing is decided a moment before the cap.
      clock.advance(hours * HOUR - 1)
      expect(answers).toEqual([])
      clock.advance(1)
      await vi.waitFor(() => expect(reports).toHaveLength(1), WAIT)
      expect(answers).toEqual([{ outcome: { outcome: 'cancelled' } }])
      expect(modelText(reports[0]!).replace(SESSION_MESSAGE_HEADER, '')).toBe(
        `[task ended] Task "fix the flaky test and open a PR" stopped before finishing (approval wait expired). Anything it sent before this is all it reported. To give it more work in the same context, call sendMessage with {"action":"messageTask","taskId":"${res.targetSession}","message":"..."}.\n\n${REPORT_ANSWER_LANGUAGE}`
      )
      expect((await d.store.listPermissionRequests(agentId))[0]).toMatchObject({
        status: 'denied',
        resolvedByName: deniedBy
      })
      await vi.waitFor(
        async () => expect((await d.store.assistantSubsessions.get(agentId, res.targetSession))?.state).toBe('failed'),
        WAIT
      )
      await daemon.stop()
    }
  )

  it('sends an external place’s request of an agent outside assistant mode to its responsible user, never a card there', async () => {
    const { daemon, d, clock, reports, post, approvalRoute } = await delegateAndAsk('bot-b', { external: true })

    expect(approvalRoute).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'bot-b', responsible: true }),
      expect.anything()
    )
    // Only the direct message: nothing is posted into the conversation shared with another organization.
    await vi.waitFor(() => expect(post.mock.calls.map((call) => call[0])).toEqual(['D_FAKE']), WAIT)
    expect(JSON.stringify(post.mock.calls[0]![1])).toContain('task “')
    expect(d.permissions.pendingSubsessionApprovals('bot-b')).toMatchObject([{ parentSessionId: 'sid-parent-1' }])
    // Unanswered, it ends at the default cap like any other.
    clock.advance(12 * HOUR)
    await vi.waitFor(() => expect(reports).toHaveLength(1), WAIT)
    await daemon.stop()
  })
})
