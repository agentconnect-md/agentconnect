// An API turn's runtime approvals go to its caller first (shared-bot-relay.md §10.4): a refusal stands, and only an allow the caller may not make reaches an Agent editor.
import { describe, expect, it, vi } from 'vitest'
import type { CreateElicitationRequest, RequestPermissionRequest } from '@agentclientprotocol/sdk'
import { API_CALLER_ANSWER_TIMEOUT_MS } from '@agentconnect.md/protocol'
import { agentHostKey } from '../src/acp/host-key.js'
import { PermissionCoordinator, type PermissionHost } from '../src/permissions/coordinator.js'
import { pendingTurnKey, type Pending } from '../src/daemon/turn-types.js'

const AGENT = 'bot-a'
const OWNER = agentHostKey(AGENT)
const ACP_SESSION = 'acp-1'
const CONV = 'conv-1'

const PERMISSION: RequestPermissionRequest = {
  sessionId: ACP_SESSION,
  toolCall: { toolCallId: 'call-1', title: 'Bash', kind: 'execute', rawInput: { command: 'rm -rf build' } },
  options: [
    { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
    { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
    { optionId: 'no', name: 'Reject', kind: 'reject_once' }
  ]
}

function world(apiProtocol: string | undefined = 'ai-sdk-ui') {
  const store = {
    getSessionByAcpIdForAgent: async () => ({ triggeredBy: 'user-1' }),
    getDisplayNames: async () => new Map<string, string>(),
    createPermissionRequest: vi.fn(async () => {}),
    resolvePermissionRequest: vi.fn(async () => true),
    clearPermissionRequestNotify: vi.fn(async () => {}),
    upsertElicit: vi.fn(async () => {})
  }
  const sink = { output: vi.fn(), done: vi.fn() }
  const p = {
    plan: {
      sessionKey: 'sess-key',
      agentId: AGENT,
      platform: 'webchat',
      channel: CONV,
      statusThread: CONV,
      transcriptChannel: CONV,
      requesterId: 'user-1',
      approvalSurfaceSuppressed: false
    },
    approval: { waitMs: 0, depth: 0 },
    acpSessionId: ACP_SESSION,
    hostKey: OWNER,
    outwardSessionId: 'outward-1',
    builtinSystemToolCallIds: new Set<string>(),
    entry: { msg: { text: 'clean the build' } },
    webchat: {
      conversationId: CONV,
      turnId: 'turn-1',
      sink,
      index: 0,
      replyText: '',
      heldText: '',
      messageEmitted: false,
      ...(apiProtocol ? { apiProtocol } : {})
    }
  } as unknown as Pending
  const pending = new Map<string, Pending>([[pendingTurnKey(OWNER, ACP_SESSION), p]])
  const timers: Array<{ fn: () => void; ms: number }> = []
  const cancelTurn = vi.fn(async () => {})
  const host: PermissionHost = {
    log: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) as never,
    clock: () =>
      ({
        now: () => Date.now(),
        setTimeout: (fn: () => void, ms: number) => timers.push({ fn, ms }),
        clearTimeout: () => {}
      }) as never,
    cancelTurn,
    store: () => store as never,
    agents: () => new Map([[AGENT, { id: AGENT } as never]]),
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
    slackDmSessionTarget: () => 'encoded-target'
  }
  const events = (): any[] => sink.output.mock.calls.map(([o]: any[]) => o.event)
  return { store, events, timers, cancelTurn, coordinator: new PermissionCoordinator(host) }
}

/** Wait for the stream to carry the caller's approval and hand back its request id. */
async function handedOut(w: ReturnType<typeof world>): Promise<string> {
  await vi.waitFor(() => expect(w.events().some((e) => e.kind === 'permission')).toBe(true))
  return w.events().find((e) => e.kind === 'permission')!.requestId
}

describe("an API turn's runtime approval", () => {
  it('is handed to the caller, and its refusal stands without an Agent editor ever seeing it', async () => {
    const w = world()
    const outcome = w.coordinator.onAcpPermission(OWNER, ACP_SESSION, PERMISSION)
    const requestId = await handedOut(w)
    expect(w.events()[0]).toEqual({ kind: 'permission', requestId, tool: 'Bash', detail: 'rm -rf build' })
    expect(w.coordinator.awaitsApiCaller(CONV)).toBe(true)
    w.coordinator.handleCallerPermissionChoice({ requestId, allow: false, mayAllow: false, conversationId: CONV })
    await expect(outcome).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'no' } })
    expect(w.store.createPermissionRequest).not.toHaveBeenCalled()
    expect(w.coordinator.awaitsApiCaller(CONV)).toBe(false)
  })

  it('takes the narrowest allow from a caller who may allow it', async () => {
    const w = world()
    const outcome = w.coordinator.onAcpPermission(OWNER, ACP_SESSION, PERMISSION)
    const requestId = await handedOut(w)
    w.coordinator.handleCallerPermissionChoice({ requestId, allow: true, mayAllow: true, conversationId: CONV })
    await expect(outcome).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'yes' } })
    expect(w.store.createPermissionRequest).not.toHaveBeenCalled()
  })

  it('refers an allow the caller may not make to an Agent editor, who decides it', async () => {
    const w = world()
    const outcome = w.coordinator.onAcpPermission(OWNER, ACP_SESSION, PERMISSION)
    const requestId = await handedOut(w)
    w.coordinator.handleCallerPermissionChoice({ requestId, allow: true, mayAllow: false, conversationId: CONV })
    await vi.waitFor(() => expect(w.store.createPermissionRequest).toHaveBeenCalledTimes(1))
    // The caller's resumed stream says who it waits for now.
    expect(w.events().at(-1)).toMatchObject({ kind: 'message', text: expect.stringContaining('Agent editor') })
    const [[row]] = w.store.createPermissionRequest.mock.calls as unknown as [[{ id: string }]]
    await w.coordinator.decideEditorPermission({ agentId: AGENT, requestId: row.id, decision: 'allow' })
    await expect(outcome).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'yes' } })
  })

  it('ignores an answer from another conversation', async () => {
    const w = world()
    void w.coordinator.onAcpPermission(OWNER, ACP_SESSION, PERMISSION)
    const requestId = await handedOut(w)
    w.coordinator.handleCallerPermissionChoice({ requestId, allow: false, mayAllow: false, conversationId: 'conv-2' })
    expect(w.coordinator.awaitsApiCaller(CONV)).toBe(true)
  })

  it('cancels the turn once its caller leaves it unanswered for the deadline, and not after an answer', async () => {
    const w = world()
    void w.coordinator.onAcpPermission(OWNER, ACP_SESSION, PERMISSION)
    await handedOut(w)
    expect(w.timers.map((t) => t.ms)).toEqual([API_CALLER_ANSWER_TIMEOUT_MS])
    w.timers[0]!.fn()
    expect(w.cancelTurn).toHaveBeenCalledTimes(1)

    const answered = world()
    void answered.coordinator.onAcpPermission(OWNER, ACP_SESSION, PERMISSION)
    const requestId = await handedOut(answered)
    answered.coordinator.handleCallerPermissionChoice({
      requestId,
      allow: false,
      mayAllow: false,
      conversationId: CONV
    })
    answered.timers[0]!.fn()
    expect(answered.cancelTurn).not.toHaveBeenCalled()
  })

  it('is cancelled with the turn', async () => {
    const w = world()
    const outcome = w.coordinator.onAcpPermission(OWNER, ACP_SESSION, PERMISSION)
    await handedOut(w)
    await w.coordinator.releaseEditorPermissions(OWNER, ACP_SESSION)
    await expect(outcome).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    expect(w.coordinator.awaitingHuman(OWNER, ACP_SESSION)).toBe(false)
  })

  it('stays with the Agent editors over a protocol whose stream cannot carry it', async () => {
    const w = world('ag-ui')
    void w.coordinator.onAcpPermission(OWNER, ACP_SESSION, PERMISSION)
    await vi.waitFor(() => expect(w.store.createPermissionRequest).toHaveBeenCalledTimes(1))
    expect(w.events().some((e) => e.kind === 'permission')).toBe(false)
    expect(w.timers).toEqual([])
  })

  it('carries an MCP tool approval the same way, a refusal declining it', async () => {
    const w = world()
    const approval = {
      mode: 'form',
      message: 'Allow the search tool to run?',
      requestedSchema: { type: 'object', properties: {} },
      _meta: { codex_approval_kind: 'mcp_tool_call' }
    } as unknown as CreateElicitationRequest
    const outcome = w.coordinator.onAcpElicit(OWNER, ACP_SESSION, approval)
    const requestId = await handedOut(w)
    expect(w.events()[0]).toMatchObject({ tool: 'Allow the search tool to run?', detail: '' })
    w.coordinator.handleCallerPermissionChoice({ requestId, allow: false, mayAllow: true, conversationId: CONV })
    await expect(outcome).resolves.toEqual({ action: 'decline' })
  })
})

describe("an API turn's question", () => {
  it('is streamed as the webchat card and cancels the turn when left unanswered', async () => {
    const w = world()
    const ask = {
      mode: 'form',
      message: 'Which branch?',
      requestedSchema: { type: 'object', properties: { branch: { type: 'string', enum: ['main', 'dev'] } } }
    } as unknown as CreateElicitationRequest
    const outcome = w.coordinator.onAcpElicit(OWNER, ACP_SESSION, ask)
    await vi.waitFor(() => expect(w.events().some((e) => e.kind === 'elicitation')).toBe(true))
    const card = w.events().find((e) => e.kind === 'elicitation')!
    expect(w.coordinator.awaitsApiCaller(CONV)).toBe(true)
    expect(w.timers.map((t) => t.ms)).toEqual([API_CALLER_ANSWER_TIMEOUT_MS])
    await w.coordinator.handleElicitChoice({ requestId: card.requestId, value: 'dev', webchatConversationId: CONV })
    await expect(outcome).resolves.toMatchObject({ action: 'accept', content: { branch: 'dev' } })
    w.timers[0]!.fn()
    expect(w.cancelTurn).not.toHaveBeenCalled()
  })
})
