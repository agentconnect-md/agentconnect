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
import { SlackConnection } from '../src/slack/connection.js'
import {
  ELICIT_CONFIRM_ACTION,
  elicitForm,
  elicitFormBlockId,
  elicitOptionToken,
  elicitTarget,
  SLACK_ELICIT_SURFACE,
  slackCardViolations,
  WEBCHAT_ELICIT_SURFACE
} from '../src/slack/render.js'

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
    expect(isBuiltinSystemTool(req({ title: 'mcp.agentconnect.viewSessionStatus' }))).toBe(true)
    expect(isBuiltinSystemTool(req({ title: 'please run mcp.agentconnect.viewSessionStatus' }))).toBe(false)
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
} {
  ;(daemon as any).store = {
    getSessionByAcpIdForAgent: () => ({ triggeredBy: 'user-1' }),
    getDisplayNames: () => new Map([['turn-user', 'Turn User']]),
    createPermissionRequest: vi.fn(),
    resolvePermissionRequest: vi.fn(() => true),
    upsertElicit: vi.fn(async () => {})
  }
  const pending = {
    plan: {
      platform: 'hook',
      agentId: 'agent-1',
      requesterId: 'turn-user',
      channel: 'test',
      transcriptChannel: 'test',
      statusThread: 'test',
      isDm: false,
      approvalSurfaceSuppressed: false
    },
    hostKey: 'agent-1',
    chrome: {},
    reply: { text: '', attemptText: '', attemptAnswerUpdates: [] },
    signals: { applyChain: Promise.resolve() },
    approval: { waitMs: 0, depth: 0 },
    builtinSystemToolCallIds: new Set<string>(),
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

// ── webchat's in-band elicitation card (issue #1794 gap 5) ────────────────────
// Webchat is a core-owned surface, so its card is a stream event and its answer a
// webchat inbound op — the same `elicitTarget` reduction Slack renders, never a
// second opinion about what is answerable.

/** A plain (non-approval) form elicitation — no `codex_approval_kind`, so it cards. */
function formElicitation(overrides: Record<string, unknown> = {}): CreateElicitationRequest {
  return {
    sessionId: 's1',
    mode: 'form',
    message: 'Which branch should I cut from?',
    requestedSchema: {
      type: 'object',
      properties: { branch: { type: 'string', enum: ['main', 'develop', 'release'] } },
      required: ['branch']
    },
    ...overrides
  } as CreateElicitationRequest
}

/** Attach a webchat turn context to the installed pending turn and hand back its sink spy. */
function installWebchat(pending: any, conversationId = 'conv-1'): { output: ReturnType<typeof vi.fn> } {
  const sink = { output: vi.fn(), done: vi.fn() }
  pending.plan.platform = 'webchat'
  pending.webchat = {
    conversationId,
    turnId: 'turn-1',
    sink,
    index: 0,
    replyText: '',
    heldText: '',
    messageEmitted: false
  }
  return sink
}

const streamEvents = (sink: { output: ReturnType<typeof vi.fn> }): any[] =>
  sink.output.mock.calls.map(([o]: any[]) => o.event)

/** The card's own events. A declined ask and a refused answer now stream a STANDING notice of
 *  their own (#1794), which is asserted where that refusal is decided — every assertion about
 *  the CARD stays about the card. */
const cardEvents = (sink: { output: ReturnType<typeof vi.fn> }): any[] =>
  streamEvents(sink).filter((e) => e.kind !== 'notice')

/** What this stream was TOLD, as opposed to shown: the standing notices, in order. */
const noticeTexts = (sink: { output: ReturnType<typeof vi.fn> }): string[] =>
  streamEvents(sink)
    .filter((e) => e.kind === 'notice' && e.standing === true)
    .map((e) => e.text as string)

describe('webchat renders and answers ACP elicitation cards', () => {
  it('streams the card, then accepts the tapped option and settles it in place', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
    const pending: any = installPending(daemon)
    const sink = installWebchat(pending)

    const result = (daemon as any).permissions.onAcpElicit('agent-1', 's1', formElicitation())
    await vi.waitFor(() => expect((daemon as any).permissions.pendingElicits.size).toBe(1))
    expect(sink.output).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', turnId: 'turn-1', index: 0 })
    )
    expect(cardEvents(sink)[0]).toEqual({
      kind: 'elicitation',
      requestId: expect.any(String),
      message: 'Which branch should I cut from?',
      // Uncapped and unabridged — every option the form offers reaches this surface.
      options: [
        { value: 'main', label: 'main' },
        { value: 'develop', label: 'develop' },
        { value: 'release', label: 'release' }
      ]
    })
    const [requestId] = (daemon as any).permissions.pendingElicits.keys()

    await (daemon as any).permissions.handleElicitChoice({
      requestId,
      value: 'develop',
      webchatConversationId: 'conv-1'
    })
    await expect(result).resolves.toEqual({ action: 'accept', content: { branch: 'develop' } })
    expect(cardEvents(sink)[1]).toEqual({
      kind: 'elicitation_resolved',
      requestId,
      outcome: 'accepted',
      label: 'develop'
    })
    expect((daemon as any).permissions.pendingElicits.size).toBe(0)
  })

  it('declines on Dismiss and cancels on turn release, settling the card either way', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
    const pending: any = installPending(daemon)
    const sink = installWebchat(pending)

    const dismissed = (daemon as any).permissions.onAcpElicit('agent-1', 's1', formElicitation())
    await vi.waitFor(() => expect((daemon as any).permissions.pendingElicits.size).toBe(1))
    const [firstId] = (daemon as any).permissions.pendingElicits.keys()
    await (daemon as any).permissions.handleElicitChoice({
      requestId: firstId,
      value: null,
      webchatConversationId: 'conv-1'
    })
    await expect(dismissed).resolves.toEqual({ action: 'decline' })
    expect(cardEvents(sink)[1]).toEqual({ kind: 'elicitation_resolved', requestId: firstId, outcome: 'dismissed' })

    const abandoned = (daemon as any).permissions.onAcpElicit('agent-1', 's1', formElicitation())
    await vi.waitFor(() => expect((daemon as any).permissions.pendingElicits.size).toBe(1))
    const [secondId] = (daemon as any).permissions.pendingElicits.keys()
    await (daemon as any).permissions.releaseElicits('agent-1', 's1')
    await expect(abandoned).resolves.toEqual({ action: 'cancel' })
    expect(cardEvents(sink).at(-1)).toEqual({
      kind: 'elicitation_resolved',
      requestId: secondId,
      outcome: 'cancelled'
    })
  })

  it('answers only cards this conversation was shown, with values the card offered', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
    const pending: any = installPending(daemon)
    const sink = installWebchat(pending)

    const result = (daemon as any).permissions.onAcpElicit('agent-1', 's1', formElicitation())
    await vi.waitFor(() => expect((daemon as any).permissions.pendingElicits.size).toBe(1))
    const [requestId] = (daemon as any).permissions.pendingElicits.keys()

    // A value the card never offered would inject an unoffered answer into the agent's content.
    await (daemon as any).permissions.handleElicitChoice({
      requestId,
      value: 'rm -rf /',
      webchatConversationId: 'conv-1'
    })
    // Another conversation must not reach this card, even knowing its `elicit-<n>` id.
    await (daemon as any).permissions.handleElicitChoice({
      requestId,
      value: 'main',
      webchatConversationId: 'conv-other'
    })
    expect((daemon as any).permissions.pendingElicits.size).toBe(1)
    expect(cardEvents(sink)).toHaveLength(1) // still live — nothing settled it

    await (daemon as any).permissions.handleElicitChoice({ requestId, value: 'main', webchatConversationId: 'conv-1' })
    await expect(result).resolves.toEqual({ action: 'accept', content: { branch: 'main' } })
  })

  it('refuses a Slack-surface answer for a webchat card, though both share one id counter', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
    const pending: any = installPending(daemon)
    const sink = installWebchat(pending)

    const result = (daemon as any).permissions.onAcpElicit('agent-1', 's1', formElicitation())
    await vi.waitFor(() => expect((daemon as any).permissions.pendingElicits.size).toBe(1))
    const [requestId] = (daemon as any).permissions.pendingElicits.keys()

    // No webchatConversationId ⇒ the answer came off a Slack card, which cannot settle this one.
    await (daemon as any).permissions.handleElicitChoice({ requestId, value: 'main' })
    expect((daemon as any).permissions.pendingElicits.size).toBe(1)
    expect(cardEvents(sink)).toHaveLength(1)

    await (daemon as any).permissions.handleElicitChoice({ requestId, value: 'main', webchatConversationId: 'conv-1' })
    await expect(result).resolves.toEqual({ action: 'accept', content: { branch: 'main' } })
  })

  it('declines a form no surface can render, exactly as Slack does', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
    const pending: any = installPending(daemon)
    const sink = installWebchat(pending)

    // A required field NO control can answer (#1795) stays unanswerable on webchat too — a
    // second RENDERABLE field is now a form, so the unanswerable one has to be the nested object.
    await expect(
      (daemon as any).permissions.onAcpElicit(
        'agent-1',
        's1',
        formElicitation({
          requestedSchema: {
            type: 'object',
            properties: { branch: { type: 'string', enum: ['main'] }, extra: { type: 'object' } },
            required: ['branch', 'extra']
          }
        })
      )
    ).resolves.toBeUndefined()
    // The decline stands, but it is no longer silent: webchat says what was asked and that it
    // could not be shown, the way Slack's channel notice does (#1794).
    expect(cardEvents(sink)).toEqual([])
    expect(noticeTexts(sink)).toEqual([expect.stringContaining("this chat can't collect an answer for")])
    expect((daemon as any).permissions.pendingElicits.size).toBe(0)
  })

  it('keeps MCP approvals on the editor queue and continuations on the platform path', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
    const pending: any = installPending(daemon)
    const sink = installWebchat(pending)

    // An approval never becomes a webchat card — it is a durable editor decision, and the
    // only thing that reaches the stream is today's neutral "ask an editor" notice.
    void (daemon as any).permissions.onAcpElicit('agent-1', 's1', elicitation('tc-approval'))
    await vi.waitFor(() => expect(sink.output).toHaveBeenCalled())
    expect((daemon as any).permissions.pendingEditorPermissions.size).toBe(1)
    expect(cardEvents(sink).map((e) => e.kind)).toEqual(['message'])
    await (daemon as any).permissions.releaseEditorPermissions('agent-1', 's1')
    sink.output.mockClear()

    // A continuation mirrors an origin platform, so it keeps falling through to the Slack
    // path — which, with no Slack connection on this turn, declines as it does today.
    pending.webchat.continuation = true
    await expect((daemon as any).permissions.onAcpElicit('agent-1', 's1', formElicitation())).resolves.toBeUndefined()
    expect(sink.output).not.toHaveBeenCalled()
  })
})

// ── multi-select on webchat only (issue #1794 gap 2) ─────────────────────────
// A Slack card is a row of buttons and cannot express "pick several, then confirm", so the
// kind is one webchat renders and Slack still declines — the surfaces declare what they can
// render (`SLACK_ELICIT_SURFACE` / `WEBCHAT_ELICIT_SURFACE`) rather than each kind excluding Slack.

/** A multi-select form: an array of enum items, bounded unless `schema` says otherwise. */
function multiElicitation(items: Record<string, unknown> = {}): CreateElicitationRequest {
  return formElicitation({
    message: 'Which checks should I run?',
    requestedSchema: {
      type: 'object',
      properties: {
        checks: { type: 'array', items: { type: 'string', enum: ['lint', 'test', 'build'] }, ...items }
      },
      required: ['checks']
    }
  })
}

describe('webchat answers a multi-select elicitation with a list', () => {
  it('cards the options with their bounds, and accepts the confirmed list', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
    const pending: any = installPending(daemon)
    const sink = installWebchat(pending)

    const result = (daemon as any).permissions.onAcpElicit(
      'agent-1',
      's1',
      multiElicitation({ minItems: 1, maxItems: 2 })
    )
    await vi.waitFor(() => expect((daemon as any).permissions.pendingElicits.size).toBe(1))
    expect(cardEvents(sink)[0]).toEqual({
      kind: 'elicitation',
      requestId: expect.any(String),
      message: 'Which checks should I run?',
      options: [
        { value: 'lint', label: 'lint' },
        { value: 'test', label: 'test' },
        { value: 'build', label: 'build' }
      ],
      // `multi` is what makes this card toggles + a confirm rather than one-tap buttons.
      multi: { minItems: 1, maxItems: 2 }
    })
    const [requestId] = (daemon as any).permissions.pendingElicits.keys()

    await (daemon as any).permissions.handleElicitChoice({
      requestId,
      value: ['lint', 'build'],
      webchatConversationId: 'conv-1'
    })
    // The accepted content is the LIST, under the array property's name.
    await expect(result).resolves.toEqual({ action: 'accept', content: { checks: ['lint', 'build'] } })
    expect(cardEvents(sink)[1]).toEqual({
      kind: 'elicitation_resolved',
      requestId,
      outcome: 'accepted',
      // Every chosen label, in the words the card used — the single-select reading, extended.
      label: 'lint, build'
    })
  })

  // #1794: the card is a transcript row on THIS surface too. Without it a page reload lost the
  // question and the answer, and a reader who joined later never saw either.
  it('records the card in the transcript, and rewrites that row with the answer', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
    const pending: any = installPending(daemon)
    installWebchat(pending)
    const result = (daemon as any).permissions.onAcpElicit('agent-1', 's1', multiElicitation({ minItems: 1 }))
    await vi.waitFor(() => expect((daemon as any).permissions.pendingElicits.size).toBe(1))
    const rows = () => (daemon as any).store.upsertElicit.mock.calls.map(([r]: any[]) => r)
    const bodies = () => rows().map((r: any) => JSON.parse(r.body))
    // The row carries the reduced card — the same payload the live event streamed.
    expect(bodies()[0]).toMatchObject({
      message: 'Which checks should I run?',
      options: [
        { value: 'lint', label: 'lint' },
        { value: 'test', label: 'test' },
        { value: 'build', label: 'build' }
      ],
      multi: { minItems: 1 }
    })

    const [requestId] = (daemon as any).permissions.pendingElicits.keys()
    await (daemon as any).permissions.handleElicitChoice({
      requestId,
      value: ['lint'],
      webchatConversationId: 'conv-1'
    })
    await expect(result).resolves.toEqual({ action: 'accept', content: { checks: ['lint'] } })
    expect(rows()[1].ts).toBe(rows()[0].ts)
    expect(bodies()[1]).toMatchObject({ outcome: 'accepted', answerLabel: 'lint' })
  })

  it('re-checks the browser’s list: bounds, repeats, unoffered values, and the wrong shape', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
    const pending: any = installPending(daemon)
    const sink = installWebchat(pending)

    const result = (daemon as any).permissions.onAcpElicit(
      'agent-1',
      's1',
      multiElicitation({ minItems: 2, maxItems: 2 })
    )
    await vi.waitFor(() => expect((daemon as any).permissions.pendingElicits.size).toBe(1))
    const [requestId] = (daemon as any).permissions.pendingElicits.keys()
    const answer = (value: unknown, conversationId = 'conv-1') =>
      (daemon as any).permissions.handleElicitChoice({ requestId, value, webchatConversationId: conversationId })

    await answer(['lint']) // below minItems
    await answer(['lint', 'test', 'build']) // above maxItems
    await answer(['lint', 'lint']) // a repeat is not two picks
    await answer(['lint', 'rm -rf /']) // one unoffered value rejects the WHOLE answer
    await answer('lint') // a scalar cannot answer a multi-select card
    await answer(['lint', 'test'], 'conv-other') // another conversation was never shown this card
    expect((daemon as any).permissions.pendingElicits.size).toBe(1)
    expect(cardEvents(sink)).toHaveLength(1) // still live — nothing settled it
    // Each refusal of an answer THIS reader gave says so, and the card is left to answer again
    // (#1794): a Confirm that silently does nothing is indistinguishable from a broken card. The
    // last two are not this reader's answers at all — a shape no card of theirs could submit, and
    // another conversation's tap — so neither is explained to them.
    expect(noticeTexts(sink)).toEqual(Array(4).fill("That answer wasn't accepted — the question is still open."))

    await answer(['lint', 'test'])
    await expect(result).resolves.toEqual({ action: 'accept', content: { checks: ['lint', 'test'] } })
  })

  it('takes an unbounded empty confirm and a Dismiss apart', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
    const pending: any = installPending(daemon)
    const sink = installWebchat(pending)

    const result = (daemon as any).permissions.onAcpElicit('agent-1', 's1', multiElicitation())
    await vi.waitFor(() => expect((daemon as any).permissions.pendingElicits.size).toBe(1))
    expect(cardEvents(sink)[0].multi).toEqual({})
    const [requestId] = (daemon as any).permissions.pendingElicits.keys()

    // "None of them" is an ANSWER when the schema sets no minimum — not a refusal to answer.
    await (daemon as any).permissions.handleElicitChoice({ requestId, value: [], webchatConversationId: 'conv-1' })
    await expect(result).resolves.toEqual({ action: 'accept', content: { checks: [] } })
    expect(cardEvents(sink)[1]).toEqual({
      kind: 'elicitation_resolved',
      requestId,
      outcome: 'accepted',
      label: 'Nothing selected'
    })

    const dismissed = (daemon as any).permissions.onAcpElicit('agent-1', 's1', multiElicitation())
    await vi.waitFor(() => expect((daemon as any).permissions.pendingElicits.size).toBe(1))
    const [secondId] = (daemon as any).permissions.pendingElicits.keys()
    await (daemon as any).permissions.handleElicitChoice({
      requestId: secondId,
      value: null,
      webchatConversationId: 'conv-1'
    })
    await expect(dismissed).resolves.toEqual({ action: 'decline' })
  })

  it('is unchanged by Slack learning the kind: the same list still answers a browser card', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
    const pending: any = installPending(daemon)
    installWebchat(pending)

    const result = (daemon as any).permissions.onAcpElicit('agent-1', 's1', multiElicitation({ minItems: 1 }))
    await vi.waitFor(() => expect((daemon as any).permissions.pendingElicits.size).toBe(1))
    const [requestId] = (daemon as any).permissions.pendingElicits.keys()
    // A browser card carries its own answer, so Slack's Confirm verb is not its wire.
    await (daemon as any).permissions.submitElicitForm({ requestId, fields: { [elicitFormBlockId(0)]: ['lint'] } })
    expect((daemon as any).permissions.pendingElicits.size).toBe(1)
    await (daemon as any).permissions.handleElicitChoice({
      requestId,
      value: ['lint'],
      webchatConversationId: 'conv-1'
    })
    await expect(result).resolves.toEqual({ action: 'accept', content: { checks: ['lint'] } })
    expect(elicitTarget(multiElicitation({ minItems: 1 }), WEBCHAT_ELICIT_SURFACE)?.kind).toBe('multi-enum')
  })
})

// ── long option lists (issue #1794 gap 7) ────────────────────────────────────

/** A single-field enum form with `n` options. */
function enumElicitation(options: string[]): CreateElicitationRequest {
  return formElicitation({
    message: 'Which one?',
    requestedSchema: { type: 'object', properties: { pick: { type: 'string', enum: options } }, required: ['pick'] }
  })
}

/** A Slack turn whose posted card blocks are captured, alongside every in-place rewrite. */
function slackPending(daemon: any): { pending: any; posted: any[][]; updated: any[][] } {
  const pending: any = installPending(daemon)
  const posted: any[][] = []
  const updated: any[][] = []
  pending.plan.platform = 'slack'
  const conn = Object.create(SlackConnection.prototype)
  conn.postBlocks = async (_c: string, blocks: any[]) => {
    posted.push(blocks)
    return 'ts-1'
  }
  conn.updateBlocks = async (_c: string, _ts: string, blocks: any[]) => {
    updated.push(blocks)
    return true
  }
  conn.workspaceId = () => 'T1'
  pending.conn = conn
  return { pending, posted, updated }
}

describe('a Slack card offers every option or none', () => {
  // The seven-option enum of the issue: five buttons went out, the reader never saw the last two,
  // and whichever they picked came back as `accept` on the whole question.
  it('cards all seven options and accepts a pick past the fifth', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
    const { posted } = slackPending(daemon)
    const seven = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
    const answered = (daemon as any).permissions.onAcpElicit('agent-1', 's1', enumElicitation(seven))
    await vi.waitFor(() => expect((daemon as any).permissions.pendingElicits.size).toBe(1))
    const [requestId] = (daemon as any).permissions.pendingElicits.keys()
    const elements = posted[0]![1]!.elements as any[]
    expect(elements.map((e) => e.text.text)).toEqual([...seven, 'Dismiss'])
    // The seventh button carries its POSITION, and the daemon resolves it back (#1794).
    await (daemon as any).permissions.handleElicitChoice({ requestId, value: elicitOptionToken(6) })
    await expect(answered).resolves.toEqual({ action: 'accept', content: { pick: 'g' } })
  })

  // Past what the surface declares, there is no card and no answer: the agent is declined and
  // can ask again, which is the same verdict a field Slack cannot render already gets.
  it('declines rather than posting a card built from part of the list', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
    const { posted } = slackPending(daemon)
    const many = Array.from({ length: 25 }, (_, i) => `o${i}`)
    await expect(
      (daemon as any).permissions.onAcpElicit('agent-1', 's1', enumElicitation(many))
    ).resolves.toBeUndefined()
    expect((daemon as any).permissions.pendingElicits.size).toBe(0)
    expect(posted).toHaveLength(0)
    // The same form is renderable where nothing declares a limit — webchat still shows them all.
    expect(elicitTarget(enumElicitation(many), WEBCHAT_ELICIT_SURFACE)?.options).toHaveLength(25)
  })
})

// ── multi-select on Slack (issue #1794, Slack column) ───────────────────────
// A `multi_static_select` expresses "pick several" but never submits on its own: Slack delivers
// an interaction per selection change, and the card needs its own Confirm. NOTHING is tracked
// between the two — a Confirm carries the selection out of its own payload's message state — so
// two readers of one card, and two interactions in any order, cannot answer for each other.

describe('a Slack multi-select card confirms the selection it was sent', () => {
  const selectOf = (posted: any[][]) => posted[0]!.find((b: any) => b.type === 'input')!.element
  /** The one live card's request id, once its posted `ts` is on the record — a settle before that
   *  has no message to rewrite, which is the card path's own pre-existing race (#1821), not ours. */
  const liveCard = async (daemon: any): Promise<string> => {
    await vi.waitFor(() => expect(daemon.permissions.pendingElicits.size).toBe(1))
    const [requestId] = daemon.permissions.pendingElicits.keys()
    await vi.waitFor(() => expect(daemon.permissions.pendingElicits.get(requestId).ts).toBe('ts-1'))
    return requestId
  }
  /** The `checks` options in the order {@link multiElicitation} declares them — a Slack card
   *  carries each option's POSITION rather than its value (#1794), so a Confirm sends these. */
  const CHECKS = ['lint', 'test', 'build']
  const carried = (values: string[]) => values.map((v) => elicitOptionToken(CHECKS.indexOf(v)))
  const confirm = (daemon: any, requestId: string, values: string[], actor?: { userId: string }) =>
    daemon.permissions.submitElicitForm({
      requestId,
      fields: { [elicitFormBlockId(0)]: carried(values) },
      ...(actor ? { actor } : {})
    })

  it('cards a select plus Confirm, and accepts the confirmed list', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
    const { posted, updated } = slackPending(daemon)
    const answered = (daemon as any).permissions.onAcpElicit(
      'agent-1',
      's1',
      multiElicitation({ minItems: 1, maxItems: 2 })
    )
    const requestId = await liveCard(daemon)
    // The select is an INPUT block of its own — Slack refuses a multi-select inside `actions`
    // and drops the WHOLE message — and Confirm plus Dismiss keep the routing actions block.
    expect(slackCardViolations(posted[0]!)).toEqual([])
    expect(selectOf(posted).type).toBe('checkboxes')
    expect(selectOf(posted).action_id).toBe('ac_elicit_input')
    const elements = posted[0]!.at(-1)!.elements as any[]
    expect(elements.map((e) => [e.type, e.text.text])).toEqual([
      ['button', 'Confirm'],
      ['button', 'Dismiss']
    ])
    expect(elements[0].action_id).toBe(ELICIT_CONFIRM_ACTION)
    expect(updated).toHaveLength(0) // nothing has answered it yet

    await confirm(daemon, requestId, ['lint', 'build'])
    await expect(answered).resolves.toEqual({ action: 'accept', content: { checks: ['lint', 'build'] } })
    // The settled card names the chosen option LABELS, as #1801 settled a browser card.
    expect(updated[0]![0].text.text).toContain(':white_check_mark: checks: lint, build')
  })

  // The bug this shape exists to prevent: a per-card record of "the last selection seen" is
  // shared by every reader and ordered by processing, so A's Confirm could submit B's picks —
  // an `accept` asserting one reader answered what another chose, and every value in it is a
  // valid option, so no whitelist can catch it. A Confirm carrying its own snapshot cannot.
  it('answers each reader with the selection THEIR Confirm carried', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
    slackPending(daemon)
    const answered = (daemon as any).permissions.onAcpElicit('agent-1', 's1', multiElicitation({ minItems: 1 }))
    const requestId = await liveCard(daemon)

    // A selects lint, B selects test — neither reaches the daemon; only a Confirm does. A then
    // confirms the card A was looking at, and that is what the runtime is told.
    await confirm(daemon, requestId, ['lint'], { userId: 'U-A' })
    await expect(answered).resolves.toEqual({ action: 'accept', content: { checks: ['lint'] } })

    // And the same card confirmed by B alone answers with B's own selection, not A's.
    const second = (daemon as any).permissions.onAcpElicit('agent-1', 's1', multiElicitation({ minItems: 1 }))
    const secondId = await liveCard(daemon)
    await confirm(daemon, secondId, ['test'], { userId: 'U-B' })
    await expect(second).resolves.toEqual({ action: 'accept', content: { checks: ['test'] } })
  })

  it('refuses a selection outside minItems/maxItems and leaves the card live', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
    const { updated } = slackPending(daemon)
    const answered = (daemon as any).permissions.onAcpElicit(
      'agent-1',
      's1',
      multiElicitation({ minItems: 2, maxItems: 2 })
    )
    const requestId = await liveCard(daemon)
    await confirm(daemon, requestId, []) // an emptied select is an answer, and not a legal one here
    await confirm(daemon, requestId, ['lint']) // below minItems
    await confirm(daemon, requestId, ['lint', 'test', 'build']) // above maxItems — Slack's own cap is not the gate
    await confirm(daemon, requestId, ['lint', 'lint']) // a repeat is not two picks
    await (daemon as any).permissions.submitElicitForm({
      requestId,
      // A relayed value the card never offered — and it has no position either.
      fields: { [elicitFormBlockId(0)]: [elicitOptionToken(0), 'rm -rf /'] }
    })
    expect((daemon as any).permissions.pendingElicits.size).toBe(1)
    expect(updated).toHaveLength(0)

    await confirm(daemon, requestId, ['lint', 'test'])
    await expect(answered).resolves.toEqual({ action: 'accept', content: { checks: ['lint', 'test'] } })
  })

  // The card still SHOWS the schema default (`initial_options`), which is what Slack then reports
  // as that select's state for a reader who never touched it — so the seeding lives on the card
  // alone, and the daemon holds no copy of it to go stale.
  it('shows the schema default as the select’s own initial state', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
    const { posted } = slackPending(daemon)
    const answered = (daemon as any).permissions.onAcpElicit(
      'agent-1',
      's1',
      multiElicitation({ minItems: 1, default: ['test'] })
    )
    const requestId = await liveCard(daemon)
    expect(selectOf(posted).initial_options.map((o: any) => o.value)).toEqual([elicitOptionToken(1)])
    await confirm(daemon, requestId, ['test'])
    await expect(answered).resolves.toEqual({ action: 'accept', content: { checks: ['test'] } })
  })

  it('takes Dismiss as decline and the turn ending as cancel', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
    const { updated } = slackPending(daemon)
    const dismissed = (daemon as any).permissions.onAcpElicit('agent-1', 's1', multiElicitation({ minItems: 1 }))
    const first = await liveCard(daemon)
    await (daemon as any).permissions.handleElicitChoice({ requestId: first, value: null })
    await expect(dismissed).resolves.toEqual({ action: 'decline' })
    expect(updated[0]![0].text.text).toContain(':no_entry_sign: Dismissed')

    const cancelled = (daemon as any).permissions.onAcpElicit('agent-1', 's1', multiElicitation({ minItems: 1 }))
    await liveCard(daemon)
    await (daemon as any).permissions.releaseElicits('agent-1', 's1')
    await expect(cancelled).resolves.toEqual({ action: 'cancel' })
    expect((daemon as any).permissions.pendingElicits.size).toBe(0)
  })

  it('declines a list past what a Slack select holds, rather than carding part of it', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
    const { posted } = slackPending(daemon)
    const many = Array.from({ length: 101 }, (_, i) => `o${i}`)
    const over = multiElicitation({ items: { type: 'string', enum: many } })
    await expect((daemon as any).permissions.onAcpElicit('agent-1', 's1', over)).resolves.toBeUndefined()
    expect((daemon as any).permissions.pendingElicits.size).toBe(0)
    expect(posted).toHaveLength(0)
    expect(elicitTarget(over, WEBCHAT_ELICIT_SURFACE)?.options).toHaveLength(101)
  })

  it('ignores a Confirm aimed at a card that has no fields to submit', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
    const { updated } = slackPending(daemon)
    const answered = (daemon as any).permissions.onAcpElicit('agent-1', 's1', enumElicitation(['a', 'b']))
    const requestId = await liveCard(daemon)
    await confirm(daemon, requestId, ['a'])
    expect((daemon as any).permissions.pendingElicits.size).toBe(1)
    expect(updated).toHaveLength(0)
    await (daemon as any).permissions.handleElicitChoice({ requestId, value: elicitOptionToken(0) })
    await expect(answered).resolves.toEqual({ action: 'accept', content: { pick: 'a' } })
  })
})

// ── every surface re-derives its answer (issue #1812) ────────────────────────
// The whitelist used to sit inside the webchat-only branch, so a Slack answer became agent
// content unchecked — correctness resting on the relay and on Slack rather than on the card
// the daemon itself posted.

describe('a Slack answer is re-derived against the card that offered it', () => {
  it('drops a value the card never offered, says so, and leaves the card live', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
    const { updated } = slackPending(daemon)
    const applied: any[] = []
    ;(daemon as any).enqueueApply = (_p: any, action: any) => void applied.push(action)
    const answered = (daemon as any).permissions.onAcpElicit('agent-1', 's1', enumElicitation(['a', 'b', 'c']))
    await vi.waitFor(() => expect((daemon as any).permissions.pendingElicits.size).toBe(1))
    const [requestId] = (daemon as any).permissions.pendingElicits.keys()

    // Neither a value the card never offered nor a position past the list it did.
    await (daemon as any).permissions.handleElicitChoice({ requestId, value: 'rm -rf /' })
    await (daemon as any).permissions.handleElicitChoice({ requestId, value: elicitOptionToken(9) })
    expect((daemon as any).permissions.pendingElicits.size).toBe(1) // still live — nothing settled it
    expect(updated).toHaveLength(0)
    // The refusal stands, and the thread hears it — the same words a refused Confirm gets, since
    // the reader cannot tell a rejected tap from a dead button either way (#1794).
    expect(applied.filter((a) => a.kind === 'notice').map((a) => a.text)).toEqual([
      "That answer wasn't accepted — the question is still open.",
      "That answer wasn't accepted — the question is still open."
    ])

    // A Slack tap on a button the card actually carries still resolves, unchanged.
    await (daemon as any).permissions.handleElicitChoice({ requestId, value: elicitOptionToken(1) })
    await expect(answered).resolves.toEqual({ action: 'accept', content: { pick: 'b' } })
  })

  it('resolves a Codex MCP approval through the persist option its own card offered', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
    const { posted, updated } = slackPending(daemon)
    ;(daemon as any).agents.set('agent-1', { allowRuntimeChangesInChat: true })
    const approval = (daemon as any).permissions.onAcpElicit('agent-1', 's1', elicitation('call-1'))
    await vi.waitFor(() => expect(posted).toHaveLength(1))
    const [requestId] = (daemon as any).permissions.pendingElicits.keys()
    // The approval's enum reaches Slack as one button per value, each carrying that option's
    // POSITION rather than the value itself (#1794).
    const elements = posted[0]![1]!.elements as any[]
    expect(elements.map((e) => e.value)).toEqual([
      `${requestId}|${elicitOptionToken(0)}`,
      `${requestId}|${elicitOptionToken(1)}`,
      requestId
    ])

    // A `persist` the schema never enumerated is not an approval this card can report — and
    // neither is a position past the options it offered.
    await (daemon as any).permissions.handleElicitChoice({ requestId, value: 'always' })
    await (daemon as any).permissions.handleElicitChoice({ requestId, value: elicitOptionToken(9) })
    expect((daemon as any).permissions.pendingElicits.size).toBe(1)
    expect(updated).toHaveLength(0)

    await (daemon as any).permissions.handleElicitChoice({ requestId, value: elicitOptionToken(1) })
    await expect(approval).resolves.toEqual({ action: 'accept', content: { persist: 'session' } })
  })
})

// ── free text and numbers (issue #1794 gap 3) ────────────────────────────────

/** A free-text form, optionally constrained. */
function textElicitation(
  prop: Record<string, unknown> = {},
  message = 'What should I name the branch?'
): CreateElicitationRequest {
  return formElicitation({
    message,
    requestedSchema: {
      type: 'object',
      properties: { name: { type: 'string', ...prop } },
      required: ['name']
    }
  })
}

/** A numeric form, optionally constrained. */
function numberElicitation(prop: Record<string, unknown> = {}): CreateElicitationRequest {
  return formElicitation({
    message: 'How many retries?',
    requestedSchema: {
      type: 'object',
      properties: { retries: { type: 'number', ...prop } },
      required: ['retries']
    }
  })
}

describe('webchat answers a typed elicitation with the schema’s own type', () => {
  it('cards a text field with its constraints and default, and accepts the typed string', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
    const pending: any = installPending(daemon)
    const sink = installWebchat(pending)

    const result = (daemon as any).permissions.onAcpElicit(
      'agent-1',
      's1',
      textElicitation({ minLength: 3, maxLength: 50, pattern: '^[a-z-]+$', default: 'fix-login' })
    )
    await vi.waitFor(() => expect((daemon as any).permissions.pendingElicits.size).toBe(1))
    expect(cardEvents(sink)[0]).toEqual({
      kind: 'elicitation',
      requestId: expect.any(String),
      message: 'What should I name the branch?',
      // A typed field offers nothing to pick; `text` is what makes the card an input.
      options: [],
      text: { minLength: 3, maxLength: 50, pattern: '^[a-z-]+$' },
      defaultValue: 'fix-login'
    })
    const [requestId] = (daemon as any).permissions.pendingElicits.keys()

    await (daemon as any).permissions.handleElicitChoice({
      requestId,
      value: 'add-retries',
      webchatConversationId: 'conv-1'
    })
    await expect(result).resolves.toEqual({ action: 'accept', content: { name: 'add-retries' } })
    // A typed answer has no label but itself — the reader's own words, back in the transcript.
    expect(cardEvents(sink)[1]).toEqual({
      kind: 'elicitation_resolved',
      requestId,
      outcome: 'accepted',
      label: 'add-retries'
    })
  })

  it('cards a number field and accepts a real number, never the string that spelled it', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
    const pending: any = installPending(daemon)
    const sink = installWebchat(pending)

    const result = (daemon as any).permissions.onAcpElicit(
      'agent-1',
      's1',
      numberElicitation({ minimum: 0, maximum: 100, default: 50 })
    )
    await vi.waitFor(() => expect((daemon as any).permissions.pendingElicits.size).toBe(1))
    expect(cardEvents(sink)[0]).toEqual({
      kind: 'elicitation',
      requestId: expect.any(String),
      message: 'How many retries?',
      options: [],
      number: { minimum: 0, maximum: 100 },
      defaultValue: 50
    })
    const [requestId] = (daemon as any).permissions.pendingElicits.keys()

    await (daemon as any).permissions.handleElicitChoice({ requestId, value: 7, webchatConversationId: 'conv-1' })
    await expect(result).resolves.toEqual({ action: 'accept', content: { retries: 7 } })
    expect(cardEvents(sink)[1]).toEqual({
      kind: 'elicitation_resolved',
      requestId,
      outcome: 'accepted',
      label: '7'
    })
  })

  it('re-checks the browser’s typed answer: bounds, pattern, format, and the wrong shape', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
    const pending: any = installPending(daemon)
    const sink = installWebchat(pending)

    const result = (daemon as any).permissions.onAcpElicit(
      'agent-1',
      's1',
      textElicitation({ minLength: 3, maxLength: 8, format: 'email' })
    )
    await vi.waitFor(() => expect((daemon as any).permissions.pendingElicits.size).toBe(1))
    const [requestId] = (daemon as any).permissions.pendingElicits.keys()
    const answer = (value: unknown) =>
      (daemon as any).permissions.handleElicitChoice({ requestId, value, webchatConversationId: 'conv-1' })

    await answer('ab') // below minLength
    await answer('a@example.com') // above maxLength
    await answer('abcdef') // not an email at all
    await answer(7) // a number cannot answer a text card
    await answer(['a@b.co']) // nor can a list
    expect((daemon as any).permissions.pendingElicits.size).toBe(1)
    expect(cardEvents(sink)).toHaveLength(1) // still live — nothing settled it

    await answer('a@b.co')
    await expect(result).resolves.toEqual({ action: 'accept', content: { name: 'a@b.co' } })
  })

  it('re-checks the browser’s number: its bounds, its integer-ness, and a string spelling it', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
    const pending: any = installPending(daemon)
    const sink = installWebchat(pending)

    const result = (daemon as any).permissions.onAcpElicit(
      'agent-1',
      's1',
      formElicitation({
        message: 'How many retries?',
        requestedSchema: {
          type: 'object',
          properties: { retries: { type: 'integer', minimum: 1, maximum: 5 } },
          required: ['retries']
        }
      })
    )
    await vi.waitFor(() => expect((daemon as any).permissions.pendingElicits.size).toBe(1))
    const [requestId] = (daemon as any).permissions.pendingElicits.keys()
    const answer = (value: unknown) =>
      (daemon as any).permissions.handleElicitChoice({ requestId, value, webchatConversationId: 'conv-1' })

    await answer(0) // below minimum
    await answer(6) // above maximum
    await answer(2.5) // not a whole number
    await answer('3') // the string is a different type than the schema asked for
    expect((daemon as any).permissions.pendingElicits.size).toBe(1)
    expect(cardEvents(sink)).toHaveLength(1)

    await answer(3)
    await expect(result).resolves.toEqual({ action: 'accept', content: { retries: 3 } })
  })

  it('declines a form whose pattern could hang the daemon, rather than run it', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
    const pending: any = installPending(daemon)
    installWebchat(pending)

    // (a+)+$ against a long non-matching string is the textbook catastrophic backtrack: the
    // card never exists, so the daemon never gets the chance to run it.
    await expect(
      (daemon as any).permissions.onAcpElicit('agent-1', 's1', textElicitation({ pattern: '^(a+)+$' }))
    ).resolves.toBeUndefined()
    expect((daemon as any).permissions.pendingElicits.size).toBe(0)
  })
})

// ── multi-field forms (issue #1794 gap 1) ────────────────────────────────────
// A single card answers ONE field, so `elicitTarget` still requires one property to satisfy
// `required` alone. Webchat reads the whole form (`elicitForm`) and answers it with a value per
// field — the first thing that can honestly accept a form whose `required` names more than one
// property. Slack asks the same whole form in a modal (slack-elicit-form.test.ts).

/** A two-field form: a required pick plus an optional typed note. */
function twoFieldElicitation(required = ['branch']): CreateElicitationRequest {
  return formElicitation({
    message: 'Cut a branch',
    requestedSchema: {
      type: 'object',
      properties: {
        branch: { type: 'string', enum: ['main', 'develop'], title: 'Base branch' },
        note: { type: 'string', maxLength: 20 }
      },
      required
    }
  })
}

describe('webchat answers a multi-field elicitation form with a record', () => {
  it('cards one field per property and accepts the whole record, in the schema’s own types', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
    const pending: any = installPending(daemon)
    const sink = installWebchat(pending)

    const result = (daemon as any).permissions.onAcpElicit(
      'agent-1',
      's1',
      formElicitation({
        message: 'Cut a branch',
        requestedSchema: {
          type: 'object',
          properties: {
            branch: { type: 'string', enum: ['main', 'develop'], title: 'Base branch' },
            force: { type: 'boolean' },
            retries: { type: 'integer', minimum: 1, maximum: 5, default: 2 }
          },
          required: ['branch', 'force']
        }
      })
    )
    await vi.waitFor(() => expect((daemon as any).permissions.pendingElicits.size).toBe(1))
    expect(cardEvents(sink)[0]).toEqual({
      kind: 'elicitation',
      requestId: expect.any(String),
      message: 'Cut a branch',
      // The single-field descriptors are ALL absent: an old reader gets a card with nothing
      // to pick and only Dismiss, never one it could half-fill.
      options: [],
      fields: [
        {
          propName: 'branch',
          label: 'Base branch',
          kind: 'enum',
          required: true,
          options: [
            { value: 'main', label: 'main' },
            { value: 'develop', label: 'develop' }
          ]
        },
        {
          propName: 'force',
          label: 'force',
          kind: 'boolean',
          required: true,
          options: [
            { value: 'true', label: 'Yes' },
            { value: 'false', label: 'No' }
          ]
        },
        {
          propName: 'retries',
          label: 'retries',
          kind: 'number',
          options: [],
          number: { integer: true, minimum: 1, maximum: 5 },
          defaultValue: 2
        }
      ]
    })
    const [requestId] = (daemon as any).permissions.pendingElicits.keys()

    await (daemon as any).permissions.handleElicitChoice({
      requestId,
      value: { branch: 'develop', force: 'false', retries: 4 },
      webchatConversationId: 'conv-1'
    })
    // Each value carries its own schema type — the boolean is a boolean, not its spelling.
    await expect(result).resolves.toEqual({
      action: 'accept',
      content: { branch: 'develop', force: false, retries: 4 }
    })
    // The settled card names each field and what it was answered with, in the card's own words.
    expect(cardEvents(sink)[1]).toEqual({
      kind: 'elicitation_resolved',
      requestId,
      outcome: 'accepted',
      label: 'Base branch: develop · force: No · retries: 4'
    })
  })

  it('lets an OPTIONAL field be left out, and still refuses a missing required one', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
    const pending: any = installPending(daemon)
    const sink = installWebchat(pending)

    const result = (daemon as any).permissions.onAcpElicit('agent-1', 's1', twoFieldElicitation())
    await vi.waitFor(() => expect((daemon as any).permissions.pendingElicits.size).toBe(1))
    const [requestId] = (daemon as any).permissions.pendingElicits.keys()
    const answer = (value: unknown) =>
      (daemon as any).permissions.handleElicitChoice({ requestId, value, webchatConversationId: 'conv-1' })

    await answer({ note: 'no branch' }) // the required field is missing
    expect((daemon as any).permissions.pendingElicits.size).toBe(1)
    expect(cardEvents(sink)).toHaveLength(1) // still live

    // The optional `note` is simply absent — legal per the schema, and the accept says only
    // what the reader actually answered.
    await answer({ branch: 'main' })
    await expect(result).resolves.toEqual({ action: 'accept', content: { branch: 'main' } })
    expect(cardEvents(sink)[1]).toEqual({
      kind: 'elicitation_resolved',
      requestId,
      outcome: 'accepted',
      label: 'Base branch: main'
    })
  })

  // A form of nothing but optional fields, submitted untouched, is a real answer: schema-valid
  // empty content. The wire used to refuse the frame, so an enabled Submit did nothing.
  it('accepts an all-optional form submitted with nothing filled in', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
    const pending: any = installPending(daemon)
    const sink = installWebchat(pending)

    const result = (daemon as any).permissions.onAcpElicit('agent-1', 's1', twoFieldElicitation([]))
    await vi.waitFor(() => expect((daemon as any).permissions.pendingElicits.size).toBe(1))
    const [requestId] = (daemon as any).permissions.pendingElicits.keys()

    await (daemon as any).permissions.handleElicitChoice({ requestId, value: {}, webchatConversationId: 'conv-1' })
    await expect(result).resolves.toEqual({ action: 'accept', content: {} })
    // Settled as an answer, not left looking like a card that never resolved.
    expect(cardEvents(sink)[1]).toMatchObject({ outcome: 'accepted', label: 'Nothing filled in' })
  })

  it('refuses the WHOLE record for one bad, extra, or misspelled field', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
    const pending: any = installPending(daemon)
    const sink = installWebchat(pending)

    const result = (daemon as any).permissions.onAcpElicit('agent-1', 's1', twoFieldElicitation(['branch', 'note']))
    await vi.waitFor(() => expect((daemon as any).permissions.pendingElicits.size).toBe(1))
    const [requestId] = (daemon as any).permissions.pendingElicits.keys()
    const answer = (value: unknown, conversationId = 'conv-1') =>
      (daemon as any).permissions.handleElicitChoice({ requestId, value, webchatConversationId: conversationId })

    await answer({ branch: 'trunk', note: 'ok' }) // an option the card never offered
    await answer({ branch: 'main', note: 'far too long to be accepted' }) // past maxLength
    await answer({ branch: 'main', note: 'ok', nope: 'x' }) // a field the agent never asked for
    await answer({ branch: 'main', Note: 'ok' }) // misspelled: the required one is missing too
    await answer({ branch: ['main'], note: 'ok' }) // the wrong shape for that field
    await answer('main') // a scalar cannot answer a form card
    await answer(['main']) // nor can a list
    await answer({ branch: 'main', note: 'ok' }, 'conv-other') // another conversation, never shown this card
    expect((daemon as any).permissions.pendingElicits.size).toBe(1)
    expect(cardEvents(sink)).toHaveLength(1) // still live — nothing settled it

    await answer({ branch: 'main', note: 'ok' })
    await expect(result).resolves.toEqual({ action: 'accept', content: { branch: 'main', note: 'ok' } })
  })

  it('settles a form card on Dismiss, which is still an explicit refusal to answer', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
    const pending: any = installPending(daemon)
    const sink = installWebchat(pending)

    const result = (daemon as any).permissions.onAcpElicit('agent-1', 's1', twoFieldElicitation())
    await vi.waitFor(() => expect((daemon as any).permissions.pendingElicits.size).toBe(1))
    const [requestId] = (daemon as any).permissions.pendingElicits.keys()
    await (daemon as any).permissions.handleElicitChoice({ requestId, value: null, webchatConversationId: 'conv-1' })
    await expect(result).resolves.toEqual({ action: 'decline' })
    expect(cardEvents(sink)[1]).toEqual({ kind: 'elicitation_resolved', requestId, outcome: 'dismissed' })
  })

  it('takes the INPUT-BLOCK path on a Slack turn rather than a single-field card', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
    const pending: any = installPending(daemon)
    pending.plan.platform = 'slack'
    pending.plan.channel = 'C1'
    pending.plan.statusThread = 'T1'
    const conn = Object.create(SlackConnection.prototype)
    const posted: unknown[][] = []
    conn.postBlocks = async (_c: string, blocks: unknown[]) => {
      posted.push(blocks)
      return 'ts-1'
    }
    conn.updateBlocks = async () => true
    pending.conn = conn

    void (daemon as any).permissions.onAcpElicit('agent-1', 's1', twoFieldElicitation(['branch', 'note']))
    await vi.waitFor(() => expect((daemon as any).permissions.pendingElicits.size).toBe(1))
    // The card carries both fields as `input` blocks and ONE Confirm — never one per question.
    await vi.waitFor(() => expect(JSON.stringify(posted[0])).toContain(ELICIT_CONFIRM_ACTION))
    expect((posted[0] as any[]).filter((b: any) => b.type === 'input')).toHaveLength(2)
    expect((posted[0] as any[]).filter((b: any) => b.type === 'actions')).toHaveLength(1)
    expect(slackCardViolations(posted[0] as any[])).toEqual([])
    // Unchanged where it matters: the per-field reduction still needs one field that satisfies
    // `required` alone, and there is none here.
    expect(elicitTarget(twoFieldElicitation(['branch', 'note']), SLACK_ELICIT_SURFACE)).toBeNull()
    expect(elicitForm(twoFieldElicitation(['branch', 'note']), WEBCHAT_ELICIT_SURFACE)).toHaveLength(2)
    await (daemon as any).permissions.releaseElicits('agent-1', 's1')
  })

  it('keeps a one-field form on the single-field card, byte for byte', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
    const pending: any = installPending(daemon)
    const sink = installWebchat(pending)

    const result = (daemon as any).permissions.onAcpElicit('agent-1', 's1', formElicitation())
    await vi.waitFor(() => expect((daemon as any).permissions.pendingElicits.size).toBe(1))
    // Exactly the payload the single-field card always carried: no `fields`, options intact.
    expect(cardEvents(sink)[0]).toEqual({
      kind: 'elicitation',
      requestId: expect.any(String),
      message: 'Which branch should I cut from?',
      options: [
        { value: 'main', label: 'main' },
        { value: 'develop', label: 'develop' },
        { value: 'release', label: 'release' }
      ]
    })
    const [requestId] = (daemon as any).permissions.pendingElicits.keys()
    // And it still answers with the scalar, not a record — a form record is refused here.
    await (daemon as any).permissions.handleElicitChoice({
      requestId,
      value: { branch: 'main' },
      webchatConversationId: 'conv-1'
    })
    expect((daemon as any).permissions.pendingElicits.size).toBe(1)
    await (daemon as any).permissions.handleElicitChoice({ requestId, value: 'main', webchatConversationId: 'conv-1' })
    await expect(result).resolves.toEqual({ action: 'accept', content: { branch: 'main' } })
  })
})

// ── URL-mode elicitation (issue #1794 gap 4) ─────────────────────────────────
// The seam the spec reserves for credentials, OAuth and payment: `accept` means only that the
// user consented to OPEN the URL, never that the flow behind it finished, and the page itself
// never reaches the daemon, the card, or the model.

/** A URL-mode elicitation (ACP `ElicitationUrlMode`). */
function urlElicitation(overrides: Record<string, unknown> = {}): CreateElicitationRequest {
  return {
    sessionId: 's1',
    mode: 'url',
    elicitationId: 'el-1',
    url: 'https://billing.example.com/oauth/authorize?state=xyz',
    message: 'Sign in to the billing provider to continue',
    ...overrides
  } as CreateElicitationRequest
}

describe('webchat renders and settles a URL-mode consent card', () => {
  it('streams the exact URL, resolves accept on consent, and never carries a form field', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
    const pending: any = installPending(daemon)
    const sink = installWebchat(pending)

    const result = (daemon as any).permissions.onAcpElicit('agent-1', 's1', urlElicitation())
    await vi.waitFor(() => expect((daemon as any).permissions.pendingElicits.size).toBe(1))
    // No options and no field descriptors: a reader that does not know `url` can only Dismiss.
    expect(cardEvents(sink)[0]).toEqual({
      kind: 'elicitation',
      requestId: expect.any(String),
      message: 'Sign in to the billing provider to continue',
      options: [],
      url: 'https://billing.example.com/oauth/authorize?state=xyz'
    })
    const [requestId] = (daemon as any).permissions.pendingElicits.keys()

    await (daemon as any).permissions.handleElicitChoice({
      requestId,
      value: 'https://billing.example.com/oauth/authorize?state=xyz',
      webchatConversationId: 'conv-1'
    })
    // Consent resolves the ACP request — with no `content`, since nothing was answered here.
    await expect(result).resolves.toEqual({ action: 'accept' })
    expect(cardEvents(sink)[1]).toEqual({
      kind: 'elicitation_resolved',
      requestId,
      outcome: 'accepted',
      label: 'Opened'
    })
  })

  it('refuses a value the card never offered, and declines only on an explicit dismissal', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
    const pending: any = installPending(daemon)
    installWebchat(pending)

    const result = (daemon as any).permissions.onAcpElicit('agent-1', 's1', urlElicitation())
    await vi.waitFor(() => expect((daemon as any).permissions.pendingElicits.size).toBe(1))
    const [requestId] = (daemon as any).permissions.pendingElicits.keys()

    // A browser frame is not what makes consent valid: only the card's own URL is consent.
    await (daemon as any).permissions.handleElicitChoice({
      requestId,
      value: 'https://billing.example.com.evil.test/oauth/authorize?state=xyz',
      webchatConversationId: 'conv-1'
    })
    expect((daemon as any).permissions.pendingElicits.size).toBe(1)
    // And another conversation cannot consent on this one's behalf.
    await (daemon as any).permissions.handleElicitChoice({
      requestId,
      value: 'https://billing.example.com/oauth/authorize?state=xyz',
      webchatConversationId: 'conv-2'
    })
    expect((daemon as any).permissions.pendingElicits.size).toBe(1)

    await (daemon as any).permissions.handleElicitChoice({ requestId, value: null, webchatConversationId: 'conv-1' })
    await expect(result).resolves.toEqual({ action: 'decline' })
  })

  it('cancels rather than declines when the turn ends under a live consent card', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
    const pending: any = installPending(daemon)
    const sink = installWebchat(pending)

    const result = (daemon as any).permissions.onAcpElicit('agent-1', 's1', urlElicitation())
    await vi.waitFor(() => expect((daemon as any).permissions.pendingElicits.size).toBe(1))
    await (daemon as any).permissions.releaseElicits('agent-1', 's1')
    await expect(result).resolves.toEqual({ action: 'cancel' })
    expect(cardEvents(sink).at(-1)).toEqual(expect.objectContaining({ outcome: 'cancelled' }))
  })

  it('settles the consented card on elicitation/complete, and ignores an id it does not hold', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
    const pending: any = installPending(daemon)
    const sink = installWebchat(pending)

    void (daemon as any).permissions.onAcpElicit('agent-1', 's1', urlElicitation())
    await vi.waitFor(() => expect((daemon as any).permissions.pendingElicits.size).toBe(1))
    const [requestId] = (daemon as any).permissions.pendingElicits.keys()
    await (daemon as any).permissions.handleElicitChoice({
      requestId,
      value: 'https://billing.example.com/oauth/authorize?state=xyz',
      webchatConversationId: 'conv-1'
    })

    // An id never consented to — and one from another agent host — settles nothing.
    ;(daemon as any).permissions.onAcpElicitComplete('agent-1', 'el-nope')
    ;(daemon as any).permissions.onAcpElicitComplete('agent-2', 'el-1')
    expect(cardEvents(sink)).toHaveLength(2)

    ;(daemon as any).permissions.onAcpElicitComplete('agent-1', 'el-1')
    expect(cardEvents(sink)[2]).toEqual({ kind: 'elicitation_resolved', requestId, outcome: 'completed' })
    // The notification is advisory and arrives at most once: a repeat is ignored.
    ;(daemon as any).permissions.onAcpElicitComplete('agent-1', 'el-1')
    expect(cardEvents(sink)).toHaveLength(3)
  })

  it('declines a URL a browser tab must never be handed, and one on a form-only surface', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
    const pending: any = installPending(daemon)
    installWebchat(pending)

    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'not a url'])
      await expect(
        (daemon as any).permissions.onAcpElicit('agent-1', 's1', urlElicitation({ url }))
      ).resolves.toBeUndefined()
    // An elicitationId is what a completion notification is keyed by; without one there is
    // nothing to consent to either.
    await expect(
      (daemon as any).permissions.onAcpElicit('agent-1', 's1', urlElicitation({ elicitationId: '' }))
    ).resolves.toBeUndefined()
    expect((daemon as any).permissions.pendingElicits.size).toBe(0)

    // And a platform whose chrome declares no input cards keeps declining.
    const telegram: any = installPending(daemon)
    telegram.plan.platform = 'telegram'
    await expect((daemon as any).permissions.onAcpElicit('agent-1', 's1', urlElicitation())).resolves.toBeUndefined()
  })

  it('masks an agent secret embedded in the URL before the card carries it', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
    const pending: any = installPending(daemon)
    const sink = installWebchat(pending)
    ;(daemon as any).agents = new Map([
      ['agent-1', { id: 'agent-1', runtimeOverrides: { secrets: [{ name: 'TOKEN', value: 'sk-live-DEADBEEF' }] } }]
    ])

    void (daemon as any).permissions.onAcpElicit(
      'agent-1',
      's1',
      urlElicitation({ url: 'https://billing.example.com/pay?token=sk-live-DEADBEEF' })
    )
    await vi.waitFor(() => expect(cardEvents(sink)).toHaveLength(1))
    expect(cardEvents(sink)[0].url).not.toContain('sk-live-DEADBEEF')
  })
})

// ── Slack's URL-mode consent card (#1794, Slack column) ──────────────────────
// URL mode used to decline on Slack — latterly with a notice (#1819), which the reader still
// could not act on without leaving the channel. The card is a second SURFACE for the machinery
// #1810 built, not a second implementation of it.

/** Every mrkdwn string a posted card carries, in block order. */
const cardText = (blocks: any[]): string[] =>
  blocks.filter((b) => b.type === 'section').map((b) => b.text.text as string)

/** The card's action row elements. */
const cardButtons = (blocks: any[]): any[] => blocks.find((b) => b.type === 'actions')?.elements ?? []

/** The one live card's request id, once it is actually ON the channel — a reader cannot tap a
 *  card whose `chat.postMessage` has not returned, and only then can the record be rewritten. */
async function liveSlackCard(daemon: any): Promise<string> {
  return await vi.waitFor(() => {
    const [id, rec] = [...daemon.permissions.pendingElicits.entries()][0] ?? []
    expect(rec?.ts).toBeTruthy()
    return id as string
  })
}

describe('Slack renders and settles a URL-mode consent card', () => {
  it('shows the whole URL unfollowable, opens it from the button, and resolves accept on consent', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
    const { posted, updated } = slackPending(daemon)

    const result = (daemon as any).permissions.onAcpElicit('agent-1', 's1', urlElicitation())
    await vi.waitFor(() => expect(posted).toHaveLength(1))
    const url = 'https://billing.example.com/oauth/authorize?state=xyz'
    const text = cardText(posted[0]!).join('\n')
    // The full URL is examinable, and it sits in a code span — which Slack mrkdwn does not
    // autolink, so following it as TEXT (and thus consenting unobservably) is not on offer.
    expect(text).toContain(`\`${url}\``)
    expect(text).not.toContain(`<${url}`)
    // The real host stands on its own line, so a userinfo prefix or a lookalike path cannot
    // pass itself off as the destination.
    expect(text).toContain('Host: `billing.example.com`')
    expect(text).toContain('Sign in to the billing provider to continue')

    const [open, dismiss] = cardButtons(posted[0]!)
    // Slack's `url` field is what both opens the page and still delivers an interaction. The
    // `value` carries the card's one OPTION rather than the URL, which is what keeps a URL too
    // long for a Slack button value from losing its card (#1794).
    expect(open).toMatchObject({
      text: { text: 'Open link' },
      url,
      value: `${await liveSlackCard(daemon)}|${elicitOptionToken(0)}`
    })
    expect(dismiss).toMatchObject({ text: { text: 'Dismiss' } })

    const requestId = await liveSlackCard(daemon)
    await (daemon as any).permissions.handleElicitChoice({ requestId, value: elicitOptionToken(0) })
    // Consent resolves the ACP request — with no `content`, since nothing was answered here.
    await expect(result).resolves.toEqual({ action: 'accept' })
    // "Opened" and not "Done": the tap proves consent, never that the flow behind it finished.
    await vi.waitFor(() => expect(cardText(updated[0] ?? [])[0]).toContain(':white_check_mark: Opened'))
    expect(cardText(updated[0]!)[0]).toContain(`\`${url}\``)
    expect(cardButtons(updated[0]!)).toEqual([])
  })

  it('declines on Dismiss and cancels when the turn ends under a live card', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
    const { updated } = slackPending(daemon)
    const dismissed = (daemon as any).permissions.onAcpElicit('agent-1', 's1', urlElicitation())
    const first = await liveSlackCard(daemon)
    await (daemon as any).permissions.handleElicitChoice({ requestId: first, value: null })
    await expect(dismissed).resolves.toEqual({ action: 'decline' })
    await vi.waitFor(() => expect(cardText(updated[0] ?? [])[0]).toContain(':no_entry_sign: Dismissed'))

    const abandoned = (daemon as any).permissions.onAcpElicit('agent-1', 's1', urlElicitation())
    await liveSlackCard(daemon)
    await (daemon as any).permissions.releaseElicits('agent-1', 's1')
    await expect(abandoned).resolves.toEqual({ action: 'cancel' })
    await vi.waitFor(() => expect(cardText(updated[1] ?? [])[0]).toContain(':hourglass: Cancelled'))
  })

  it('flags a Punycode host and calls out an unencrypted one', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
    const { posted } = slackPending(daemon)

    void (daemon as any).permissions.onAcpElicit(
      'agent-1',
      's1',
      urlElicitation({ url: 'http://xn--80ak6aa92e.example-login.com/authorize' })
    )
    await vi.waitFor(() => expect(posted).toHaveLength(1))
    const text = cardText(posted[0]!).join('\n')
    expect(text).toContain('Not encrypted (http)')
    expect(text).toContain('not plain ASCII')
    // Whatever it warns about, the bytes the agent asked for are still shown verbatim.
    expect(text).toContain('`http://xn--80ak6aa92e.example-login.com/authorize`')
    await (daemon as any).permissions.releaseElicits('agent-1', 's1')
  })

  it('declines a scheme no browser tab may be handed, with no card at all', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
    const { posted } = slackPending(daemon)
    for (const url of ['javascript:alert(1)', 'data:text/html,<script>1</script>', 'file:///etc/passwd'])
      await expect(
        (daemon as any).permissions.onAcpElicit('agent-1', 's1', urlElicitation({ url }))
      ).resolves.toBeUndefined()
    expect(posted).toEqual([])
    expect((daemon as any).permissions.pendingElicits.size).toBe(0)
  })

  it('cannot let the agent’s own message contribute a second followable link', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
    const { posted } = slackPending(daemon)

    void (daemon as any).permissions.onAcpElicit(
      'agent-1',
      's1',
      urlElicitation({ message: 'Or sign in at <https://evil.example/x|your account> or https://evil.example/y' })
    )
    await vi.waitFor(() => expect(posted).toHaveLength(1))
    const text = cardText(posted[0]!).join('\n')
    // A Slack CARD is an mrkdwn section, so the syntax to kill is `<url|label>` — and a bare URL
    // autolinks, so it lands in a code span instead.
    expect(text).not.toContain('<https://evil.example/x')
    expect(text).toContain('&lt;`https://evil.example/x|your` account&gt;')
    expect(text).toContain('`https://evil.example/y`')
    // The consent URL stays the ONE followable thing on the card: no other button carries a url.
    expect(cardButtons(posted[0]!).filter((b: any) => b.url)).toHaveLength(1)
    await (daemon as any).permissions.releaseElicits('agent-1', 's1')
  })

  it('refuses a consent naming a URL other than the card’s own, and a browser answering a Slack card', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
    slackPending(daemon)
    const result = (daemon as any).permissions.onAcpElicit('agent-1', 's1', urlElicitation())
    const requestId = await liveSlackCard(daemon)

    await (daemon as any).permissions.handleElicitChoice({
      requestId,
      value: 'https://billing.example.com.evil.test/oauth/authorize?state=xyz'
    })
    expect((daemon as any).permissions.pendingElicits.size).toBe(1)
    // A webchat frame cannot settle a card posted to Slack, guessable `elicit-<n>` id or not.
    await (daemon as any).permissions.handleElicitChoice({
      requestId,
      value: 'https://billing.example.com/oauth/authorize?state=xyz',
      webchatConversationId: 'conv-1'
    })
    expect((daemon as any).permissions.pendingElicits.size).toBe(1)
    await (daemon as any).permissions.releaseElicits('agent-1', 's1')
    await expect(result).resolves.toEqual({ action: 'cancel' })
  })

  it('re-labels the settled card on elicitation/complete, and ignores an id it does not hold', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
    const { updated } = slackPending(daemon)
    void (daemon as any).permissions.onAcpElicit('agent-1', 's1', urlElicitation())
    const requestId = await liveSlackCard(daemon)
    await (daemon as any).permissions.handleElicitChoice({ requestId, value: elicitOptionToken(0) })
    await vi.waitFor(() => expect(updated).toHaveLength(1))
    ;(daemon as any).permissions.onAcpElicitComplete('agent-1', 'el-nope')
    ;(daemon as any).permissions.onAcpElicitComplete('agent-2', 'el-1')
    expect(updated).toHaveLength(1)
    ;(daemon as any).permissions.onAcpElicitComplete('agent-1', 'el-1')
    await vi.waitFor(() => expect(cardText(updated[1] ?? [])[0]).toContain(':white_check_mark: Completed'))
    // Advisory and at most once: a repeat re-labels nothing, and never arriving is also fine.
    ;(daemon as any).permissions.onAcpElicitComplete('agent-1', 'el-1')
    expect(updated).toHaveLength(2)
  })

  it('masks an agent secret embedded in the URL before the card carries it', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
    const { posted } = slackPending(daemon)
    ;(daemon as any).agents = new Map([
      ['agent-1', { id: 'agent-1', runtimeOverrides: { secrets: [{ name: 'TOKEN', value: 'sk-live-DEADBEEF' }] } }]
    ])

    void (daemon as any).permissions.onAcpElicit(
      'agent-1',
      's1',
      urlElicitation({ url: 'https://billing.example.com/pay?token=sk-live-DEADBEEF' })
    )
    await vi.waitFor(() => expect(posted).toHaveLength(1))
    expect(JSON.stringify(posted[0])).not.toContain('sk-live-DEADBEEF')
    await (daemon as any).permissions.releaseElicits('agent-1', 's1')
  })
})
