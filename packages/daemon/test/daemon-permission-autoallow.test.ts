import { describe, it, expect, vi } from 'vitest'
import type { CreateElicitationRequest, RequestPermissionRequest } from '@agentclientprotocol/sdk'
import { Daemon, noneSuppressedApprovalSurface, isBuiltinSystemTool, isBuiltinSystemToolCall } from '../src/daemon.js'
import { ALL_TOOL_NAMES } from '../src/mcp/tools.js'
import { TerminalOutputFolder } from '../src/session/terminal-output-folder.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalStore } from '../src/store/local-store.js'
import { listAgentPermissionRequests } from '../src/cp/config-apply-handlers.js'

/**
 * Auto-approve policy for the daemon's OWN built-in MCP tools (UX fix): a human should
 * never have to tap a Slack permission card for a platform system tool like sendMessage.
 * `isBuiltinSystemTool` is the predicate `onAcpPermission` consults before rendering a card;
 * it matches the runtime-assigned `mcp__agentconnect__<name>` FQN against our registered
 * tool set, and is deliberately strict/fail-safe so an unknown title still prompts.
 */

/** A minimal permission request whose toolCall carries the given identifying fields. */
function req(fields: {
  title?: string
  kind?: string
  toolCallId?: string
  rawInput?: unknown
}): RequestPermissionRequest {
  return {
    sessionId: 's1',
    options: [
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
      { optionId: 'deny', name: 'Deny', kind: 'reject_once' }
    ],
    toolCall: { toolCallId: 'tc-1', ...fields }
  } as unknown as RequestPermissionRequest
}

describe('isBuiltinSystemTool — auto-approve the daemon’s own MCP tools', () => {
  it('auto-approves each built-in agentconnect MCP tool by its fully-qualified name', () => {
    for (const name of ALL_TOOL_NAMES) {
      expect(isBuiltinSystemTool(req({ title: `mcp__agentconnect__${name}` }))).toBe(true)
    }
  })

  it('matches the FQN wherever the runtime puts it (title / kind / toolCallId)', () => {
    expect(isBuiltinSystemTool(req({ kind: 'mcp__agentconnect__sendMessage' }))).toBe(true)
    expect(isBuiltinSystemTool(req({ toolCallId: 'mcp__agentconnect__sendMessage-42' }))).toBe(true)
    expect(isBuiltinSystemTool(req({ title: 'mcp.agentconnect.setSessionTitle' }))).toBe(true)
    expect(isBuiltinSystemTool(req({ title: 'please run mcp.agentconnect.setSessionTitle' }))).toBe(false)
  })

  it('matches an opaque id only after a trusted tool event correlated it', () => {
    expect(isBuiltinSystemTool(req({ toolCallId: 'opaque-42' }), new Set(['opaque-42']))).toBe(true)
    expect(isBuiltinSystemTool(req({ toolCallId: 'other-42' }), new Set(['opaque-42']))).toBe(false)
  })

  it('does NOT auto-approve the runtime’s dangerous built-ins (still card them)', () => {
    expect(isBuiltinSystemTool(req({ title: 'Bash' }))).toBe(false)
    expect(isBuiltinSystemTool(req({ title: 'Edit' }))).toBe(false)
    expect(isBuiltinSystemTool(req({ title: 'Write' }))).toBe(false)
  })

  it('does NOT auto-approve a same-named tool from a DIFFERENT MCP server', () => {
    expect(isBuiltinSystemTool(req({ title: 'mcp__othersrv__sendMessage' }))).toBe(false)
  })

  it('fail-safe: an unknown/friendly title or missing toolCall falls through to the card', () => {
    expect(isBuiltinSystemTool(req({ title: 'Message another agent' }))).toBe(false)
    expect(isBuiltinSystemTool(req({}))).toBe(false)
    expect(isBuiltinSystemTool({ sessionId: 's', options: [] } as unknown as RequestPermissionRequest)).toBe(false)
  })
})

describe('noneSuppressedApprovalSurface — Slack `none` live turns only', () => {
  it('is true only for a `none` Slack live turn', () => {
    expect(noneSuppressedApprovalSurface('none', { platform: 'slack' })).toBe(true)
    // Slack, but not a live IM turn:
    expect(noneSuppressedApprovalSurface('none', { platform: 'slack', webchat: { conversationId: 'c' } })).toBe(false)
    expect(noneSuppressedApprovalSurface('none', { platform: 'slack', headless: true })).toBe(false)
  })

  it('is false on platforms where `none` removes no Slack chat card', () => {
    for (const platform of ['telegram', 'discord', 'feishu', 'webchat']) {
      expect(noneSuppressedApprovalSurface('none', { platform })).toBe(false)
    }
  })

  it('is false for every other output mode (delivery-only, no execution change)', () => {
    for (const mode of ['minimal', 'low', 'medium', 'high']) {
      expect(noneSuppressedApprovalSurface(mode, { platform: 'slack' })).toBe(false)
    }
  })
})

function elicitation(toolCallId: string, overrides: Record<string, unknown> = {}): CreateElicitationRequest {
  return {
    sessionId: 's1',
    toolCallId,
    mode: 'form',
    message: 'Allow the agentconnect MCP server to run this tool?',
    requestedSchema: {
      type: 'object',
      properties: { persist: { type: 'string', enum: ['once', 'session'] } },
      required: ['persist']
    },
    _meta: { codex_approval_kind: 'mcp_tool_call', persist: 'session' },
    ...overrides
  } as CreateElicitationRequest
}

function installPending(daemon: Daemon): {
  plan: { platform: string; approvalSurfaceSuppressed: boolean }
  builtinSystemToolCallIds: Set<string>
  hiddenSessionTitleToolCallIds: Set<string>
} {
  ;(daemon as any).store = {
    getSessionByAcpIdForAgent: () => ({ triggeredBy: 'user-1' }),
    getDisplayNames: () => new Map([['turn-user', 'Turn User']]),
    createPermissionRequest: vi.fn(),
    resolvePermissionRequest: vi.fn(() => true)
  }
  const pending = {
    plan: {
      platform: 'hook',
      agentId: 'agent-1',
      requesterId: 'turn-user',
      channel: 'test',
      statusThread: 'test',
      approvalSurfaceSuppressed: false
    },
    chrome: {},
    reply: { text: '', attemptText: '', attemptAnswerUpdates: [] },
    signals: { applyChain: Promise.resolve() },
    approval: { waitMs: 0, depth: 0 },
    builtinSystemToolCallIds: new Set<string>(),
    hiddenSessionTitleToolCallIds: new Set<string>(),
    conv: { onUpdate: () => [], hasBuffered: () => false },
    rec: { onUpdate: () => [] },
    termOut: new TerminalOutputFolder()
  }
  ;(daemon as any).pending.set(JSON.stringify(['agent-1', 's1']), pending)
  return pending
}

describe('an approval publishes its resolver before the durable write', () => {
  it('a cancellation during createPermissionRequest leaves no orphaned wait or pending row', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
    const pending = installPending(daemon)
    pending.plan.approvalSurfaceSuppressed = true

    // Hold the durable write open so the cancellation sweep lands inside it — the window the
    // async store opened, which the synchronous path never had.
    let finishWrite!: () => void
    const write = new Promise<void>((r) => (finishWrite = r))
    const store = (daemon as any).store
    store.createPermissionRequest = vi.fn(() => write)
    store.resolvePermissionRequest = vi.fn(() => true)

    const permissionResult = (daemon as any).permissions.onAcpPermission(
      'agent-1',
      's1',
      req({ title: 'Bash', rawInput: { command: 'pnpm test' } })
    )
    // The resolver is reachable while the row is still being written.
    await vi.waitFor(() => expect((daemon as any).permissions.pendingEditorPermissions.size).toBe(1))
    const [requestId] = (daemon as any).permissions.pendingEditorPermissions.keys()

    // The sweep unpublishes immediately and settles the row once the write it is settling lands.
    const released = (daemon as any).permissions.releaseEditorPermissions('agent-1', 's1')
    expect((daemon as any).permissions.pendingEditorPermissions.size).toBe(0)
    finishWrite()
    await released
    await expect(permissionResult).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    await vi.waitFor(() =>
      expect(store.resolvePermissionRequest).toHaveBeenCalledWith(
        'agent-1',
        requestId,
        'expired',
        expect.any(Number),
        undefined
      )
    )
    expect((daemon as any).permissions.pendingEditorPermissions.size).toBe(0)
  })
})

describe('built-in MCP approvals use one policy on both ACP paths', () => {
  it('uses structured MCP identity as authoritative over display text', () => {
    const event = {
      sessionUpdate: 'tool_call',
      toolCallId: 'tool-1',
      title: 'mcp.agentconnect.sendMessage',
      rawInput: { server: 'agentconnect', tool: 'sendMessage', arguments: {} }
    }
    expect(isBuiltinSystemToolCall(event)).toBe(true)
    expect(isBuiltinSystemToolCall({ ...event, rawInput: { ...event.rawInput, server: 'another-server' } })).toBe(false)
    expect(isBuiltinSystemToolCall({ ...event, title: 'Bash', rawInput: { command: 'pwd' } })).toBe(false)
  })

  it.each(ALL_TOOL_NAMES)('bypasses both approval paths for %s after a trusted tool event', async (name) => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
    const pending = installPending(daemon)
    const toolCallId = `opaque-${name}`

    ;(daemon as any).onAcpUpdate('agent-1', 's1', {
      sessionUpdate: 'tool_call',
      toolCallId,
      kind: 'execute',
      title: `mcp.agentconnect.${name}`,
      rawInput: { server: 'agentconnect', tool: name, arguments: {} }
    })

    expect(pending.builtinSystemToolCallIds).toContain(toolCallId)
    await expect((daemon as any).permissions.onAcpPermission('agent-1', 's1', req({ toolCallId }))).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'allow' }
    })
    await expect((daemon as any).permissions.onAcpElicit('agent-1', 's1', elicitation(toolCallId))).resolves.toEqual({
      action: 'accept'
    })
    expect((daemon as any).permissions.pendingEditorPermissions.size).toBe(0)
    expect((daemon as any).permissions.pendingChatPermissions.size).toBe(0)
    expect((daemon as any).permissions.pendingElicits.size).toBe(0)
  })

  it('queues non-system requests for an Agent editor even when `none` hides the chat surface', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
    const pending = installPending(daemon)
    pending.plan.approvalSurfaceSuppressed = true

    const permissionResult = (daemon as any).permissions.onAcpPermission(
      'agent-1',
      's1',
      req({ title: 'Bash', rawInput: { command: 'pnpm test' } })
    )
    await vi.waitFor(() => expect((daemon as any).permissions.pendingEditorPermissions.size).toBe(1))
    const [permissionRequestId] = (daemon as any).permissions.pendingEditorPermissions.keys()
    expect(
      await (daemon as any).permissions.decideEditorPermission({
        agentId: 'agent-1',
        requestId: permissionRequestId,
        decision: 'deny'
      })
    ).toEqual({ ok: true })
    await expect(permissionResult).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'deny' }
    })

    const elicitationResult = (daemon as any).permissions.onAcpElicit('agent-1', 's1', elicitation('uncorrelated'))
    await vi.waitFor(() => expect((daemon as any).permissions.pendingEditorPermissions.size).toBe(1))
    const [elicitationRequestId] = (daemon as any).permissions.pendingEditorPermissions.keys()
    expect(
      await (daemon as any).permissions.decideEditorPermission({
        agentId: 'agent-1',
        requestId: elicitationRequestId,
        decision: 'deny'
      })
    ).toEqual({ ok: true })
    await expect(elicitationResult).resolves.toEqual({
      action: 'cancel'
    })

    expect((daemon as any).store.createPermissionRequest).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        requesterId: 'turn-user',
        requesterName: 'Turn User',
        command: 'Bash: pnpm test'
      })
    )
    expect((daemon as any).store.createPermissionRequest).toHaveBeenCalledTimes(2)

    // The daemon's own system tools remain trusted and need no editor round-trip.
    ;(daemon as any).onAcpUpdate('agent-1', 's1', {
      sessionUpdate: 'tool_call',
      toolCallId: 'sys-1',
      kind: 'execute',
      title: 'mcp.agentconnect.sendMessage',
      rawInput: { server: 'agentconnect', tool: 'sendMessage', arguments: {} }
    })
    await expect(
      (daemon as any).permissions.onAcpPermission('agent-1', 's1', req({ toolCallId: 'sys-1' }))
    ).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'allow' }
    })
  })

  it('routes non-Slack and webchat requests to Agent editors instead of auto-allowing them', async () => {
    for (const platform of ['telegram', 'discord', 'feishu', 'webchat']) {
      const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
      const pending = installPending(daemon)
      pending.plan.platform = platform
      pending.plan.approvalSurfaceSuppressed = false

      const result = (daemon as any).permissions.onAcpPermission('agent-1', 's1', req({ title: 'Bash' }))
      await vi.waitFor(() => expect((daemon as any).permissions.pendingEditorPermissions.size).toBe(1))
      const [requestId] = (daemon as any).permissions.pendingEditorPermissions.keys()
      expect(
        await (daemon as any).permissions.decideEditorPermission({
          agentId: 'agent-1',
          requestId,
          decision: 'deny'
        })
      ).toEqual({ ok: true })
      await expect(result).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'deny' } })
    }
  })

  it('fails closed when the editor queue cannot be persisted', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
    installPending(daemon)
    ;(daemon as any).store.createPermissionRequest = vi.fn(() => {
      throw new Error('disk unavailable')
    })

    await expect((daemon as any).permissions.onAcpPermission('agent-1', 's1', req({ title: 'Bash' }))).resolves.toEqual(
      {
        outcome: { outcome: 'cancelled' }
      }
    )
    expect((daemon as any).permissions.pendingEditorPermissions.size).toBe(0)
    expect((daemon as any).permissions.pendingChatPermissions.size).toBe(0)
  })

  it('does not trust another server, an uncorrelated id, or malformed approval metadata', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
    const pending = installPending(daemon)

    ;(daemon as any).onAcpUpdate('agent-1', 's1', {
      sessionUpdate: 'tool_call',
      toolCallId: 'other-server-call',
      title: 'mcp.agentconnect.sendMessage',
      rawInput: { server: 'another-server', tool: 'sendMessage', arguments: {} }
    })

    expect(pending.builtinSystemToolCallIds).not.toContain('other-server-call')
    const permissionResult = (daemon as any).permissions.onAcpPermission(
      'agent-1',
      's1',
      req({ toolCallId: 'other-server-call' })
    )
    await vi.waitFor(() => expect((daemon as any).permissions.pendingEditorPermissions.size).toBe(1))
    const [permissionRequestId] = (daemon as any).permissions.pendingEditorPermissions.keys()
    await (daemon as any).permissions.decideEditorPermission({
      agentId: 'agent-1',
      requestId: permissionRequestId,
      decision: 'deny'
    })
    await expect(permissionResult).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'deny' }
    })

    const elicitationResult = (daemon as any).permissions.onAcpElicit('agent-1', 's1', elicitation('uncorrelated'))
    await vi.waitFor(() => expect((daemon as any).permissions.pendingEditorPermissions.size).toBe(1))
    const [elicitationRequestId] = (daemon as any).permissions.pendingEditorPermissions.keys()
    await (daemon as any).permissions.decideEditorPermission({
      agentId: 'agent-1',
      requestId: elicitationRequestId,
      decision: 'deny'
    })
    await expect(elicitationResult).resolves.toEqual({ action: 'cancel' })

    await expect(
      (daemon as any).permissions.onAcpElicit('agent-1', 's1', elicitation('uncorrelated', { _meta: {} }))
    ).resolves.toBeUndefined()
    await expect(
      (daemon as any).permissions.onAcpElicit('agent-1', 's1', elicitation('uncorrelated', { mode: 'url' }))
    ).resolves.toBeUndefined()
  })
})

describe('the approval list names its session the way the console asked for it', () => {
  it('reports the outward id, so the console can scope approvals to the session it is showing', async () => {
    const store = await LocalStore.open(join(mkdtempSync(join(tmpdir(), 'ac-approvals-')), 'local.sqlite'))
    const key = ['slack', 'C1', '100.1', 'bot-a'].join('\u001f')
    await store.upsertSession({
      key,
      agentId: 'bot-a',
      platform: 'slack',
      channel: 'C1',
      thread: '100.1',
      acpSessionId: 'acp-1',
      state: 'prompting',
      lastDeliveredTs: null,
      updatedAt: 1
    })
    const outward = (await store.getSession(key))!.sessionId!
    expect(outward).not.toBe('acp-1')
    // The row itself is keyed by the runtime's id — the permission arrives over ACP.
    await store.createPermissionRequest({
      id: 'p1',
      agentId: 'bot-a',
      sessionId: 'acp-1',
      createdAt: 100,
      requesterId: null,
      requesterName: null,
      command: 'rm -rf /tmp/x',
      status: 'pending',
      resolvedAt: null
    })

    const host = { store: () => store, clock: () => ({ now: () => 1_000 }) } as never
    const page = await listAgentPermissionRequests(host, { agentId: 'bot-a', limit: 10 })
    // The console routes on the outward id, so filtering by it must find this request.
    expect(page.requests.map((r) => r.sessionId)).toEqual([outward])
    await store.close()
  })
})
