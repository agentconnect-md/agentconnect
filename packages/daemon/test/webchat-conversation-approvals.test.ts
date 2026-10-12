// A webchat conversation's approval requests answered from that conversation (product-conventions.md, What people can do in chat).
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import type { RequestPermissionRequest } from '@agentclientprotocol/sdk'
import { FakeClock } from '@agentconnect.md/connection'
import { PERMISSION_REQUEST_NOT_IN_CONVERSATION, type ChatActions, type WebchatOutput } from '@agentconnect.md/protocol'
import { agentHostKey } from '../src/acp/host-key.js'
import { listAgentPermissionRequests } from '../src/cp/config-apply-handlers.js'
import { PermissionCoordinator, type PermissionHost } from '../src/permissions/coordinator.js'
import { subsessionCoordinate } from '../src/session/subsession-coordinate.js'
import { LocalStore, sessionKey } from '../src/store/local-store.js'
import { SqliteAsyncDatabase } from '../src/store/sqlite-async-database.js'
import { pendingTurnKey, type Pending } from '../src/daemon/turn-types.js'

const AGENT = 'bot-a'
const OWNER = agentHostKey(AGENT)
const SUB_THREAD = subsessionCoordinate('500.5')

const params = (sessionId: string): RequestPermissionRequest =>
  ({
    sessionId,
    toolCall: { toolCallId: `call-${sessionId}`, title: 'Bash: npm test' },
    options: [
      { optionId: 'o-allow', name: 'Allow', kind: 'allow_once' },
      { optionId: 'o-deny', name: 'Deny', kind: 'reject_once' }
    ]
  }) as unknown as RequestPermissionRequest

/** Two webchat conversations of one agent, and a background sub-session the first one opened. */
async function world(chatActions: ChatActions) {
  const store = await LocalStore.open({ database: SqliteAsyncDatabase.adopt(new DatabaseSync(':memory:')) })
  const clock = new FakeClock(1_000_000)
  const pending = new Map<string, Pending>()
  const outputs: WebchatOutput[] = []
  const turn = (acp: string, outward: string, platform: string, channel: string, thread: string, webchat: boolean) => {
    const key = sessionKey(platform, channel, thread, AGENT)
    const p = {
      plan: {
        sessionKey: key,
        agentId: AGENT,
        agentName: 'Butler',
        platform,
        channel,
        requesterId: 'user-1',
        sessionThread: thread,
        statusThread: thread,
        approvalSurfaceSuppressed: false
      },
      approval: { waitMs: 0, depth: 0 },
      acpSessionId: acp,
      hostKey: OWNER,
      outwardSessionId: outward,
      builtinSystemToolCallIds: new Set<string>(),
      entry: { msg: { text: 'run the tests' } },
      ...(webchat
        ? {
            webchat: {
              conversationId: channel,
              turnId: `turn-${acp}`,
              index: 0,
              sink: { output: (o: WebchatOutput) => outputs.push(o), done: vi.fn() }
            }
          }
        : {})
    } as unknown as Pending
    pending.set(pendingTurnKey(OWNER, acp), p)
    return { key, p }
  }
  const a = turn('acp-a', 'sid-a', 'webchat', 'conv-a', 'webchat:conv-a', true)
  const b = turn('acp-b', 'sid-b', 'webchat', 'conv-b', 'webchat:conv-b', true)
  const sub = turn('acp-sub', 'sid-sub', 'webchat', 'conv-a', SUB_THREAD, false)
  for (const [{ key }, acp, outward, channel, thread] of [
    [a, 'acp-a', 'sid-a', 'conv-a', 'webchat:conv-a'],
    [b, 'acp-b', 'sid-b', 'conv-b', 'webchat:conv-b'],
    [sub, 'acp-sub', 'sid-sub', 'conv-a', SUB_THREAD]
  ] as const) {
    await store.upsertSession({
      key,
      agentId: AGENT,
      platform: 'webchat',
      channel,
      thread,
      acpSessionId: acp,
      sessionId: outward,
      state: 'prompting',
      lastDeliveredTs: null,
      updatedAt: Date.now()
    })
  }
  await store.assistantSubsessions.open({
    agentId: AGENT,
    childSessionKey: sub.key,
    parentSessionId: 'sid-a',
    parentSessionKey: a.key
  })
  const host: PermissionHost = {
    log: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) as never,
    clock: () => clock,
    cancelTurn: vi.fn(async () => {}),
    store: () => store,
    agents: () => new Map([[AGENT, { id: AGENT, name: 'Butler', chatActions } as never]]),
    // Webchat has no integration, so no chat surface: its answers come through the conversation's page.
    chatSurface: () => 'closed',
    chatEditorsOnly: () => false,
    chatActor: async () => 'allowed' as const,
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
    cpApprovalRoute: () => undefined,
    orgForAgent: () => 'org-1',
    sessionLink: (sessionId) => `https://console.example.test/sessions/${sessionId}`,
    slackConnFor: () => undefined,
    approvalDmIntegrations: () => [],
    slackDmSessionTarget: (_p, integrationId) => `target:${integrationId}`,
    subsessionApprovalRoute: async (p) =>
      p === sub.p
        ? { parentSessionId: 'sid-a', title: 'Fix the flaky test', place: { kind: 'console' }, waitHours: 12 }
        : undefined
  }
  const coordinator = new PermissionCoordinator(host)
  const listHost = {
    store: () => store,
    clock: () => clock,
    pendingPermissionOptions: (agentId: string, requestId: string) =>
      coordinator.pendingPermissionOptions(agentId, requestId)
  } as unknown as Parameters<typeof listAgentPermissionRequests>[0]
  /** Ask one approval in each session, and name each request by the session that asked it. */
  const ask = async () => {
    const decided = ['acp-a', 'acp-b', 'acp-sub'].map((acp) => coordinator.onAcpPermission(OWNER, acp, params(acp)))
    await vi.waitFor(async () => expect(await store.listPermissionRequests(AGENT)).toHaveLength(3))
    const rows = await store.listPermissionRequests(AGENT)
    const idOf = (acp: string) => rows.find((row) => row.sessionId === acp)!.id
    return { decided, a: idOf('acp-a'), b: idOf('acp-b'), sub: idOf('acp-sub') }
  }
  return { store, coordinator, listHost, ask, outputs }
}

describe('an approval decided from a webchat conversation', () => {
  it('is refused for another conversation’s request, and answers its own and its sub-sessions’', async () => {
    const w = await world('approve')
    const asked = await w.ask()
    const from = (requestId: string, sessionId: string) =>
      w.coordinator.decideEditorPermission({
        agentId: AGENT,
        requestId,
        decision: 'allow',
        decidedBy: 'user:user-1',
        conversation: { sessionId }
      })

    expect(await from(asked.b, 'sid-a')).toEqual({ ok: false, reason: PERMISSION_REQUEST_NOT_IN_CONVERSATION })
    expect((await w.store.listPermissionRequests(AGENT)).find((row) => row.id === asked.b)?.status).toBe('pending')
    expect(await from(asked.a, 'sid-a')).toEqual({ ok: true })
    expect(await from(asked.sub, 'sid-a')).toEqual({ ok: true })
    expect(await from(asked.b, 'sid-b')).toEqual({ ok: true })
    // One already decided is no longer pending, wherever it is decided from.
    expect(await from(asked.a, 'sid-b')).toEqual({ ok: false, reason: 'permission request is no longer pending' })
    for (const decided of asked.decided)
      expect(await decided).toEqual({ outcome: { outcome: 'selected', optionId: 'o-allow' } })
    await w.store.close()
  })

  it('lists a conversation’s own requests and its sub-sessions’, and nothing of another', async () => {
    const w = await world('approve')
    const asked = await w.ask()
    const page = await listAgentPermissionRequests(w.listHost, {
      agentId: AGENT,
      limit: 100,
      conversation: { sessionId: 'sid-a' }
    })
    expect(page.requests.map((r) => [r.id, r.sessionId, r.parentSessionId]).sort()).toEqual(
      [
        [asked.a, 'sid-a', undefined],
        [asked.sub, 'sid-sub', 'sid-a']
      ].sort()
    )
    expect((await listAgentPermissionRequests(w.listHost, { agentId: AGENT, limit: 100 })).requests).toHaveLength(3)
    for (const id of [asked.a, asked.b, asked.sub])
      await w.coordinator.decideEditorPermission({ agentId: AGENT, requestId: id, decision: 'deny' })
    await Promise.all(asked.decided)
    await w.store.close()
  })

  it.each([
    ['approve', 'The conversation’s owner or an Agent editor can answer it on its Session page.'],
    ['talk', 'Ask an Agent editor to allow it from the Agent or Session page.']
  ] as const)('tells the conversation who answers at %s', async (level, says) => {
    const w = await world(level)
    const asked = await w.ask()
    const notices = w.outputs.flatMap((o) => (o.event?.kind === 'message' ? [o.event.text] : []))
    expect(notices).toEqual([`🔒 Permission requested. ${says}`, `🔒 Permission requested. ${says}`])
    for (const id of [asked.a, asked.b, asked.sub])
      await w.coordinator.decideEditorPermission({ agentId: AGENT, requestId: id, decision: 'deny' })
    await Promise.all(asked.decided)
    await w.store.close()
  })
})
