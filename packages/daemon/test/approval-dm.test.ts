import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import type { RequestPermissionRequest } from '@agentclientprotocol/sdk'
import { PermissionCoordinator, type PermissionHost } from '../src/permissions/coordinator.js'
import type { SlackConnection } from '../src/slack/connection.js'
import { LocalStore } from '../src/store/local-store.js'
import { SqliteAsyncDatabase } from '../src/store/sqlite-async-database.js'
import { pendingTurnKey, type Pending } from '../src/daemon/turn-types.js'

const AGENT = 'bot-a'
const ACP_SESSION = 'acp-1'
const TARGET = { integrationId: 'int-1', teamId: 'T1', userId: 'U1', consoleUserId: 'cu-1', displayName: 'Ada' }

function fakeSlackConn() {
  return {
    openDirectMessage: vi.fn(async () => 'D1'),
    postBlocks: vi.fn(async () => '111.222'),
    updateBlocks: vi.fn(async () => undefined),
    workspaceUrl: 'https://w.slack.com',
    workspaceId: () => 'T1'
  }
}

function permissionParams(): RequestPermissionRequest {
  return {
    sessionId: ACP_SESSION,
    toolCall: { toolCallId: 'call-1', title: 'Bash: rm -rf build' },
    options: [
      { optionId: 'o-allow', name: 'Allow', kind: 'allow_once' },
      { optionId: 'o-deny', name: 'Deny', kind: 'reject_once' }
    ]
  } as unknown as RequestPermissionRequest
}

async function world(over?: { route?: ReturnType<typeof vi.fn>; noChannel?: boolean; platform?: string }) {
  const store = await LocalStore.open({ database: SqliteAsyncDatabase.adopt(new DatabaseSync(':memory:')) })
  const conn = fakeSlackConn()
  const route =
    over?.route ??
    vi.fn(async (payload: { requestId: string; verify?: unknown }) =>
      payload.verify
        ? { requestId: payload.requestId, allowed: true, displayName: 'Ada' }
        : { requestId: payload.requestId, target: TARGET }
    )
  const pending = new Map<string, Pending>()
  const p = {
    plan: {
      sessionKey: 'sess-key',
      agentId: AGENT,
      agentName: 'Butler',
      platform: over?.platform ?? 'webchat',
      channel: 'C0',
      requesterId: undefined,
      approvalSurfaceSuppressed: false
    },
    approval: { waitMs: 0, depth: 0 },
    acpSessionId: ACP_SESSION,
    outwardSessionId: 'outward-1',
    builtinSystemToolCallIds: new Set<string>(),
    entry: { msg: { text: 'please run ls /' } }
  } as unknown as Pending
  pending.set(pendingTurnKey(AGENT, ACP_SESSION), p)
  const host: PermissionHost = {
    log: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) as never,
    clock: () => ({ now: () => Date.now() }) as never,
    store: () => store,
    agents: () => new Map([[AGENT, { id: AGENT } as never]]),
    pending: () => pending,
    evalHooks: () => ({ emit: vi.fn() }) as never,
    memoryExtractionInFlight: () => false,
    enqueueApply: vi.fn(),
    postCardSerialized: vi.fn(async () => undefined),
    httpSlackSessionTarget: () => undefined,
    maskAgentSecrets: (_agentId, payload) => payload,
    logSessionAction: vi.fn(),
    cpApprovalRoute: () => ({ approvalRoute: route as never }),
    orgForAgent: () => 'org-1',
    sessionLink: (sessionId) => `https://console.example/sessions/${sessionId}`,
    slackConnFor: (integrationId) =>
      integrationId === TARGET.integrationId && !over?.noChannel ? (conn as unknown as SlackConnection) : undefined,
    approvalDmIntegrations: () => ['int-1'],
    slackDmSessionTarget: () => 'encoded-target'
  }
  return { store, conn, route, host, coordinator: new PermissionCoordinator(host), p }
}

const requestIdOf = (route: ReturnType<typeof vi.fn>): string =>
  (route.mock.calls[0]![0] as { requestId: string }).requestId

describe('approval DM (slack-approval-dm.md §5–§6)', () => {
  it('routes, DMs the target, and resolves on the verified target click', async () => {
    const w = await world({ platform: 'slack' })
    const decided = w.coordinator.onAcpPermission(AGENT, ACP_SESSION, permissionParams())
    await vi.waitFor(() => expect(w.conn.postBlocks).toHaveBeenCalledTimes(1))
    expect(w.conn.openDirectMessage).toHaveBeenCalledWith('U1')
    // Top-level message: no thread ts.
    expect((w.conn.postBlocks.mock.calls[0] as unknown[])[3]).toBeUndefined()
    // §5.2 intro: session deep link plus a quote of the triggering Slack message.
    const posted = JSON.stringify((w.conn.postBlocks.mock.calls[0] as unknown[])[1])
    expect(posted).toContain('https://console.example/sessions/outward-1')
    expect(posted).toContain('> please run ls /')
    const requestId = requestIdOf(w.route)

    await w.coordinator.handlePermissionChoice({ requestId, optionId: 'o-allow', actor: { userId: 'U1' } })
    await expect(decided).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'o-allow' } })
    // The resolved rewrite keeps the intro — the links must survive the decision.
    const rewritten = JSON.stringify((w.conn.updateBlocks.mock.calls[0] as unknown[])[2])
    expect(rewritten).toContain('https://console.example/sessions/outward-1')
    // The verify form named the addressed console user.
    const verify = (w.route.mock.calls[1]![0] as { verify?: { consoleUserId: string } }).verify
    expect(verify?.consoleUserId).toBe('cu-1')
    const rows = await w.store.listPermissionRequests(AGENT)
    expect(rows).toMatchObject([{ status: 'allowed', resolvedBy: 'slack:T1:U1', resolvedByName: 'Ada' }])
    expect(w.conn.updateBlocks).toHaveBeenCalled()
    await w.store.close()
  })

  it('refuses a wrong actor and an unanswerable verify without settling the request', async () => {
    const w = await world()
    const decided = w.coordinator.onAcpPermission(AGENT, ACP_SESSION, permissionParams())
    await vi.waitFor(() => expect(w.conn.postBlocks).toHaveBeenCalledTimes(1))
    const requestId = requestIdOf(w.route)

    // Wrong actor: no verify round trip, card untouched, still pending.
    await w.coordinator.handlePermissionChoice({ requestId, optionId: 'o-allow', actor: { userId: 'U-intruder' } })
    expect(w.route).toHaveBeenCalledTimes(1)
    expect(w.conn.updateBlocks).not.toHaveBeenCalled()

    // Verify outage: fail closed but keep the live card for a retry.
    w.route.mockRejectedValueOnce(new Error('cp down'))
    await w.coordinator.handlePermissionChoice({ requestId, optionId: 'o-allow', actor: { userId: 'U1' } })
    expect(w.conn.updateBlocks).not.toHaveBeenCalled()
    expect((await w.store.listPermissionRequests(AGENT))[0]!.status).toBe('pending')

    // Authoritative refusal: rights are gone — the card retires, the request stays pending.
    w.route.mockResolvedValueOnce({ requestId, allowed: false })
    await w.coordinator.handlePermissionChoice({ requestId, optionId: 'o-allow', actor: { userId: 'U1' } })
    expect(w.conn.updateBlocks).toHaveBeenCalledTimes(1)
    expect((await w.store.listPermissionRequests(AGENT))[0]!.status).toBe('pending')

    // The console can still decide it.
    const ack = await w.coordinator.decideEditorPermission({
      agentId: AGENT,
      requestId,
      decision: 'deny',
      decidedBy: 'user:cu-2',
      decidedByName: 'Lin'
    })
    expect(ack.ok).toBe(true)
    await expect(decided).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'o-deny' } })
    expect((await w.store.listPermissionRequests(AGENT))[0]).toMatchObject({
      status: 'denied',
      resolvedBy: 'user:cu-2',
      resolvedByName: 'Lin'
    })
    // The console decision also retired the DM card.
    expect(w.conn.updateBlocks).toHaveBeenCalledTimes(2)
    await w.store.close()
  })

  it("leaves today's behavior intact when the CP answers no target", async () => {
    const route = vi.fn(async (payload: { requestId: string }) => ({ requestId: payload.requestId }))
    const w = await world({ route })
    const decided = w.coordinator.onAcpPermission(AGENT, ACP_SESSION, permissionParams())
    await vi.waitFor(() => expect(route).toHaveBeenCalledTimes(1))
    expect(w.conn.openDirectMessage).not.toHaveBeenCalled()
    const requestId = requestIdOf(route)
    await w.coordinator.decideEditorPermission({ agentId: AGENT, requestId, decision: 'allow' })
    await expect(decided).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'o-allow' } })
    await w.store.close()
  })

  it('release retires the DM card and cancels the request', async () => {
    const w = await world()
    const decided = w.coordinator.onAcpPermission(AGENT, ACP_SESSION, permissionParams())
    await vi.waitFor(() => expect(w.conn.postBlocks).toHaveBeenCalledTimes(1))
    await w.coordinator.releaseEditorPermissions(AGENT, ACP_SESSION)
    await expect(decided).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    expect(w.conn.updateBlocks).toHaveBeenCalledTimes(1)
    expect((await w.store.listPermissionRequests(AGENT))[0]!.status).toBe('expired')
    await w.store.close()
  })
})
