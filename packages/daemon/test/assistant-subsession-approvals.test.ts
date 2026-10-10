// A background sub-session's runtime permission request reaches the conversation it belongs to (assistant-mode.md §5.6).
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import type { CreateElicitationRequest, RequestPermissionRequest } from '@agentclientprotocol/sdk'
import { FakeClock } from '@agentconnect.md/connection'
import { agentHostKey } from '../src/acp/host-key.js'
import { listAgentPermissionRequests } from '../src/cp/config-apply-handlers.js'
import { Daemon } from '../src/daemon.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import { PermissionCoordinator, type PermissionHost } from '../src/permissions/coordinator.js'
import type { SubsessionApprovalRoute, SubsessionApprover } from '../src/permissions/subsession-approval.js'
import { patrolCoordinate, subsessionCoordinate, taskCoordinate } from '../src/session/subsession-coordinate.js'
import type { SlackConnection } from '../src/slack/connection.js'
import { LocalStore, sessionKey } from '../src/store/local-store.js'
import { SqliteAsyncDatabase } from '../src/store/sqlite-async-database.js'
import { pendingTurnKey, type Pending } from '../src/daemon/turn-types.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import { WAIT } from './wait-support.js'

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
    workspaceUrl: 'https://w.slack.example.test',
    workspaceId: () => 'T1'
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

const slackPlace = (over: Partial<Extract<SubsessionApprovalRoute['place'], { kind: 'slack' }>> = {}) => ({
  kind: 'slack' as const,
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
    database?: DatabaseSync
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
    agents: () => new Map([[AGENT, { id: AGENT, allowRuntimeChangesInChat: over.chatOn === true } as never]]),
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
    approvalDmIntegrations: () => ['int-1'],
    slackDmSessionTarget: (_p, integrationId) => `target:${integrationId}`,
    subsessionApprovalRoute,
    assistantApprover
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

describe('a sub-session’s permission request in the conversation it belongs to', () => {
  it('posts the in-chat card into the conversation’s thread where anyone there may answer, and settles once', async () => {
    const w = await world({ chatOn: true })
    const decided = w.coordinator.onAcpPermission(OWNER, ACP, params())
    const id = await w.requestId()
    await vi.waitFor(() => expect(w.place.postBlocks).toHaveBeenCalledTimes(1))

    const [channel, , , thread] = w.place.postBlocks.mock.calls[0] as unknown[]
    expect([channel, thread]).toEqual(['C1', '100.1'])
    const card = blocksOf(w.place)
    expect(card).toContain('background sub-session')
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
    expect((await rows(w.store))[0]).toMatchObject({ status: 'allowed', resolvedBy: 'slack:T1:U9' })
    // The rewrite keeps who was asking, and the card's handle leaves the row with it.
    const rewritten = JSON.stringify((w.place.updateBlocks.mock.calls[0] as unknown[])[2])
    expect(rewritten).toContain('background sub-session')
    expect(rewritten).toContain('Always allow')
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
    expect(blocksOf(w.place, 1)).toContain('background sub-session')
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
    await w.store.close()
  })

  it('posts nothing into a webchat conversation, which lists the request on its own page', async () => {
    const w = await world({ chatOn: true, route: routeTo({ kind: 'console' }) })
    void w.coordinator.onAcpPermission(OWNER, ACP, params())
    await w.requestId()
    // Only the editor DM goes out; the conversation's own page is its surface.
    await vi.waitFor(() => expect(w.place.postBlocks).toHaveBeenCalledTimes(1))
    expect(w.place.openDirectMessage).toHaveBeenCalledWith('U-ed')
    expect(blocksOf(w.place)).toContain('background sub-session')
    await w.coordinator.releaseApprovals(OWNER, ACP)
    await w.store.close()
  })

  it.each([true, false])(
    'sends an external place’s card to its approver instead (chat approval %s)',
    async (chatOn) => {
      // A linked editor: their DM, whichever way chat approval is set, and nothing in the place.
      const member = await world({
        chatOn,
        route: routeTo(slackPlace({ external: true })),
        approver: { kind: 'member', channel: 'D-approver', target: EDITOR }
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

      // The fallback conversation: its card where chat approval lets anyone answer, else its notice.
      const room = await world({
        chatOn,
        route: routeTo(slackPlace({ external: true })),
        approver: { kind: 'conversation', integrationId: 'int-2', channel: 'C-fallback' }
      })
      void room.coordinator.onAcpPermission(OWNER, ACP, params())
      await room.requestId()
      await vi.waitFor(() => expect(room.other.postBlocks).toHaveBeenCalledTimes(1))
      const [channel, , , thread] = room.other.postBlocks.mock.calls[0] as unknown[]
      expect([channel, thread]).toEqual(['C-fallback', undefined])
      expect(blocksOf(room.other).includes('"actions"')).toBe(chatOn)
      expect(room.place.postBlocks.mock.calls.every((call) => (call as unknown[])[0] !== 'C1')).toBe(true)
      await room.coordinator.releaseApprovals(OWNER, ACP)
      await room.store.close()
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

  it('never asks from a patrol, which refuses instead', async () => {
    const w = await world({ chatOn: true, thread: patrolCoordinate('600.6') })
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
    expect(blocksOf(main.place)).not.toContain('background sub-session')
    expect(main.coordinator.pendingSubsessionApprovals(AGENT)).toEqual([])
    expect(main.clock.pending).toBe(0)
    await main.coordinator.releaseApprovals(OWNER, ACP)
    await main.store.close()

    // The daemon answers no route for an agent out of assistant mode: the request takes today's path.
    const plain = await world({ thread: taskCoordinate('700.7'), route: undefined })
    void plain.coordinator.onAcpPermission(OWNER, ACP, params())
    await vi.waitFor(() => expect(plain.place.postBlocks).toHaveBeenCalledTimes(1))
    expect(plain.subsessionApprovalRoute).toHaveBeenCalledTimes(1)
    expect((plain.place.postBlocks.mock.calls[0] as unknown[])[3]).toBeUndefined()
    expect(blocksOf(plain.place)).not.toContain('background sub-session')
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

const ORG = '00000000-0000-0000-0000-0000000000a1'

/** One Slack assistant-mode agent appending in `C1`, beside one that is not in assistant mode. */
function scaffold(): string {
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
            core: { bindRules: [{ match: { kind: 'mention' } }], sessionModes: [{ channel: 'C1', mode: 'append' }] },
            config: { botToken: `xoxb-${id}`, appToken: `xapp-${id}` }
          }
        ],
        output: { mode: 'low' },
        allowRuntimeChangesInChat: true,
        ...(id === 'bot-a'
          ? { assistantMode: { enabled: true, responsibleUserId: 'user-1', limits: { permissionWaitHours: 1 } } }
          : {})
      })
    )
  }
  return root
}

describe('through the daemon', () => {
  it('cards the parent’s Slack conversation, then the wait cap denies, stops and reports into it', async () => {
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
          if (!JSON.stringify(blocks).includes('background sub-session')) return 'end_turn'
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
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root: scaffold(), hostFactory, clock })
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
    const reports: NormalizedMessage[] = []
    const dispatch = d.dispatch.bind(d)
    d.dispatch = (agentId: string, msg: NormalizedMessage, ...rest: unknown[]) => {
      if (msg.parentReport === true) reports.push(msg)
      return dispatch(agentId, msg, ...rest)
    }
    const post = vi.spyOn(d.connByIntegration.get('int-bot-a') as SlackConnection, 'postBlocks')

    // The main conversation in C1 delegates to itself.
    const scope = d.transportScopeForIntegrationIds(['int-bot-a'])
    const coordinate = await d.store.resolveAppendCoordinate('bot-a', 'C1', scope, 1)
    await d.store.upsertSession({
      key: sessionKey('slack', 'C1', coordinate, 'bot-a', scope),
      agentId: 'bot-a',
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
      callerAgentId: 'bot-a',
      platform: 'slack',
      callerChannel: 'C1',
      callerThread: coordinate,
      callerTransportScope: scope,
      toAgentId: 'bot-a',
      text: 'fix the flaky test and open a PR',
      channel: 'C1',
      thread: '100.1',
      postless: true
    })

    // An append conversation has no platform thread of its own, so the card goes to its root, as its reports do.
    await vi.waitFor(() => expect(post).toHaveBeenCalled(), WAIT)
    const [channel, blocks, , thread] = post.mock.calls[0]!
    expect([channel, thread]).toEqual(['C1', undefined])
    expect(JSON.stringify(blocks)).toContain('background sub-session')
    expect(JSON.stringify(blocks)).toContain('within 1 hour,')
    expect(d.permissions.pendingSubsessionApprovals('bot-a')).toMatchObject([
      { parentSessionId: 'sid-parent-1', tool: 'Write src/app.ts' }
    ])
    // The agent out of assistant mode gets no route, so its requests keep today's path.
    expect(
      await d.subsessionApprovalRoute({ plan: { agentId: 'bot-b', sessionKey: res.targetSession } })
    ).toBeUndefined()

    clock.advance(HOUR)
    await vi.waitFor(() => expect(reports).toHaveLength(1), WAIT)
    expect(answers).toEqual([{ outcome: { outcome: 'cancelled' } }])
    expect(reports[0]!.text).toBe(
      `[sub-session ended] Sub-session ${res.targetSession} stopped before finishing (approval wait expired). It sent no result; delegate again if the work is still needed.`
    )
    expect((await d.store.listPermissionRequests('bot-a'))[0]).toMatchObject({
      status: 'denied',
      resolvedByName: 'No answer within 1 hour'
    })
    await vi.waitFor(
      async () => expect((await d.store.assistantSubsessions.get('bot-a', res.targetSession))?.state).toBe('failed'),
      WAIT
    )
    await daemon.stop()
  })
})
