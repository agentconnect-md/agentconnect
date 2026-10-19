// An API turn's runtime approvals go to its caller first (shared-bot-relay.md §10.4): a refusal stands, and only an allow the caller may not make reaches an Agent editor.
import { describe, expect, it, vi } from 'vitest'
import type { CreateElicitationRequest, RequestPermissionRequest } from '@agentclientprotocol/sdk'
import { API_CALLER_ANSWER_TIMEOUT_MS } from '@agentconnect.md/protocol'
import { WEBCHAT_ELICIT_SURFACE } from '../src/slack/render.js'
import type { ChatEvent } from '../src/session/chat-turn.js'
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

function world(apiProtocol: string | undefined = 'ai-sdk-ui', platform = 'webchat') {
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
      platform,
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
    approvalCardFacet: () => undefined,
    chatCardsAt: () => undefined,
    approvalDmIntegrations: () => [],
    slackDmSessionTarget: () => 'encoded-target',
    chatSurface: () => 'open',
    chatEditorsOnly: () => false,
    chatActor: async () => 'allowed' as const
  }
  const events = (): any[] => sink.output.mock.calls.map(([o]: any[]) => o.event)
  return { p, host, store, events, timers, cancelTurn, coordinator: new PermissionCoordinator(host) }
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
    expect(w.events()[0]).toMatchObject({ kind: 'permission', requestId, tool: 'Bash', detail: 'rm -rf build' })
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
    await w.coordinator.releaseApprovals(OWNER, ACP_SESSION)
    await expect(outcome).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    expect(w.coordinator.awaitingHuman(OWNER, ACP_SESSION)).toBe(false)
  })

  it('stays with the Agent editors over a protocol whose stream cannot carry it', async () => {
    const w = world('ag-ui')
    void w.coordinator.onAcpPermission(OWNER, ACP_SESSION, PERMISSION)
    await vi.waitFor(() => expect(w.store.createPermissionRequest).toHaveBeenCalledTimes(1))
    expect(w.events().filter((e) => e.kind === 'permission')).toMatchObject([{ editorOnly: true }])
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

describe('scoped chat permission settlement', () => {
  const scope = (requestId: string) => ({
    agentId: AGENT,
    conversationId: CONV,
    outwardSessionId: 'outward-1',
    turnId: 'turn-1',
    requestId,
    allow: true,
    mayAllow: true,
    callerRole: 'owner' as const,
    userId: 'user-1',
    user: 'User'
  })

  it('rejects foreign scope and takes one exact offered caller choice', async () => {
    const w = world('ahp')
    const outcome = w.coordinator.onAcpPermission(OWNER, ACP_SESSION, PERMISSION)
    const requestId = await handedOut(w)
    for (const wrong of [
      { agentId: 'other' },
      { conversationId: 'other' },
      { outwardSessionId: 'other' },
      { turnId: 'other' },
      { userId: '' }
    ]) {
      expect(await w.coordinator.handleChatPermissionChoice({ ...scope(requestId), ...wrong })).toBe(false)
    }
    expect(await w.coordinator.handleChatPermissionChoice({ ...scope(requestId), selectedOptionId: 'no' })).toBe(false)
    expect(await w.coordinator.handleChatPermissionChoice({ ...scope(requestId), selectedOptionId: 'always' })).toBe(
      true
    )
    expect(await w.coordinator.handleChatPermissionChoice(scope(requestId))).toBe(false)
    await expect(outcome).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'always' } })
    expect(w.events().at(-1)).toMatchObject({
      kind: 'permission_resolved',
      requestId,
      outcome: 'allowed',
      selectedOptionId: 'always'
    })
  })

  it('does not treat escalation as approval and requires an editor for its new gate', async () => {
    const w = world('ahp')
    const outcome = w.coordinator.onAcpPermission(OWNER, ACP_SESSION, PERMISSION)
    const requestId = await handedOut(w)
    expect(await w.coordinator.handleChatPermissionChoice({ ...scope(requestId), mayAllow: false })).toBe(true)
    await vi.waitFor(() => expect(w.store.createPermissionRequest).toHaveBeenCalledOnce())
    expect(w.events().filter((e) => e.kind === 'permission_resolved')).toEqual([])
    const editorRequestId = (w.store.createPermissionRequest.mock.calls as unknown as [[{ id: string }]])[0][0].id
    expect(await w.coordinator.handleChatPermissionChoice(scope(editorRequestId))).toBe(false)
    expect(
      await w.coordinator.handleChatPermissionChoice({ ...scope(editorRequestId), callerRole: 'editor', allow: false })
    ).toBe(true)
    await expect(outcome).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'no' } })
    expect(w.events().filter((e) => e.kind === 'permission_resolved')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ requestId, outcome: 'denied' }),
        expect.objectContaining({ requestId: editorRequestId, outcome: 'denied' })
      ])
    )
  })

  it('retains the editor gate for continuation even if mayAllow is true', async () => {
    const w = world('ahp')
    w.p.webchat!.continuation = true
    const outcome = w.coordinator.onAcpPermission(OWNER, ACP_SESSION, PERMISSION)
    await vi.waitFor(() => expect(w.store.createPermissionRequest).toHaveBeenCalledOnce())
    const requestId = (w.store.createPermissionRequest.mock.calls as unknown as [[{ id: string }]])[0][0].id
    expect(await w.coordinator.handleChatPermissionChoice(scope(requestId))).toBe(false)
    expect(await w.coordinator.handleChatPermissionChoice({ ...scope(requestId), callerRole: 'editor' })).toBe(true)
    await expect(outcome).resolves.toMatchObject({ outcome: { outcome: 'selected', optionId: 'yes' } })
  })

  it('does not let an old request answer a replacement turn', async () => {
    const w = world('ahp')
    const outcome = w.coordinator.onAcpPermission(OWNER, ACP_SESSION, PERMISSION)
    const requestId = await handedOut(w)
    w.p.webchat!.turnId = 'replacement'
    expect(await w.coordinator.handleChatPermissionChoice(scope(requestId))).toBe(false)
    await w.coordinator.releaseApprovals(OWNER, ACP_SESSION)
    await expect(outcome).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
  })
})

describe('scoped chat input settlement', () => {
  const scope = (requestId: string) => ({
    agentId: AGENT,
    conversationId: CONV,
    outwardSessionId: 'outward-1',
    turnId: 'turn-1',
    requestId
  })
  const ask = {
    mode: 'form',
    message: 'Which branch?',
    requestedSchema: { type: 'object', properties: { branch: { type: 'string', enum: ['main', 'dev'] } } }
  } as unknown as CreateElicitationRequest
  async function question(w: ReturnType<typeof world>) {
    await vi.waitFor(() => expect(w.events().some((e) => e.kind === 'elicitation')).toBe(true))
    return w.events().find((e) => e.kind === 'elicitation')!.requestId as string
  }

  it('exposes only the exact live card and identifies the one valid settlement', async () => {
    const w = world('ahp')
    const outcome = w.coordinator.onAcpElicit(OWNER, ACP_SESSION, ask)
    const requestId = await question(w)
    expect(w.coordinator.chatElicitation(scope(requestId))).toMatchObject({ turnId: 'turn-1', card: { requestId } })
    for (const wrong of [
      { agentId: 'other' },
      { conversationId: 'other' },
      { outwardSessionId: 'other' },
      { turnId: 'other' }
    ]) {
      expect(w.coordinator.chatElicitation({ ...scope(requestId), ...wrong })).toBeUndefined()
    }
    const args = { ...scope(requestId), webchatConversationId: CONV }
    expect(await w.coordinator.handleCallerElicitChoice({ ...args, value: 'unoffered' })).toBe(false)
    const results = await Promise.all([
      w.coordinator.handleCallerElicitChoice({ ...args, value: 'dev' }),
      w.coordinator.handleCallerElicitChoice({ ...args, value: 'main' })
    ])
    expect(results).toEqual([true, false])
    await expect(outcome).resolves.toMatchObject({ action: 'accept', content: { branch: 'dev' } })
    expect(w.events().at(-1)).toMatchObject({ kind: 'elicitation_resolved', requestId, answers: { value: 'dev' } })
    expect(w.coordinator.chatElicitation(scope(requestId))).toBeUndefined()
  })

  it('emits masked typed accepted answers without changing the runtime response', async () => {
    const w = world('ahp')
    const typed = {
      mode: 'form',
      message: 'Options',
      requestedSchema: {
        type: 'object',
        properties: { name: { type: 'string' }, enabled: { type: 'boolean' }, count: { type: 'integer' } }
      }
    } as unknown as CreateElicitationRequest
    const outcome = w.coordinator.onAcpElicit(OWNER, ACP_SESSION, typed)
    const requestId = await question(w)
    w.host.maskAgentSecrets = <T>(_agent: string, payload: T): T =>
      JSON.parse(JSON.stringify(payload).replaceAll('secret-value', '[REDACTED]'))
    expect(
      await w.coordinator.handleCallerElicitChoice({
        ...scope(requestId),
        webchatConversationId: CONV,
        value: { name: 'secret-value', enabled: 'true', count: 3 }
      })
    ).toBe(true)
    await expect(outcome).resolves.toMatchObject({ content: { name: 'secret-value', enabled: true, count: 3 } })
    expect(w.events().at(-1)).toMatchObject({ answers: { name: '[REDACTED]', enabled: true, count: 3 } })
    expect(JSON.stringify(w.events().at(-1))).not.toContain('secret-value')
  })

  it('accepts only the offered URL and returns false once another path settled it', async () => {
    const w = world('ahp')
    const url = {
      mode: 'url',
      message: 'Open consent',
      elicitationId: 'flow',
      url: 'https://example.test/consent'
    } as unknown as CreateElicitationRequest
    const outcome = w.coordinator.onAcpElicit(OWNER, ACP_SESSION, url)
    const requestId = await question(w)
    const args = { ...scope(requestId), webchatConversationId: CONV }
    expect(await w.coordinator.handleCallerElicitChoice({ ...args, value: 'https://other.test/' })).toBe(false)
    await w.coordinator.handleElicitChoice({
      requestId,
      webchatConversationId: CONV,
      value: 'https://example.test/consent'
    })
    expect(await w.coordinator.handleCallerElicitChoice({ ...args, value: null })).toBe(false)
    await expect(outcome).resolves.toEqual({ action: 'accept' })
  })
})

describe('passive platform permission and input observation', () => {
  function native() {
    const w = world(undefined, 'fixture')
    delete w.p.webchat
    w.p.conn = {} as never
    const observed: ChatEvent[] = []
    w.host.chatObservation = (p) =>
      p === w.p ? { turnId: 'native-turn', emit: (event) => observed.push(event) } : undefined
    w.host.elicitCardFacet = () => ({
      platform: 'fixture',
      reduction: WEBCHAT_ELICIT_SURFACE,
      build: () => ({}),
      send: async () => 'card-1',
      settle: vi.fn()
    })
    return { ...w, observed }
  }
  const scope = (requestId: string) => ({
    agentId: AGENT,
    conversationId: 'verified-alias',
    outwardSessionId: 'outward-1',
    turnId: 'native-turn',
    requestId,
    callerRole: 'editor' as const,
    userId: 'user-1'
  })

  it('observes the existing editor gate without adding a chat context or allowing alias-owner escalation', async () => {
    const w = native()
    const outcome = w.coordinator.onAcpPermission(OWNER, ACP_SESSION, PERMISSION)
    await vi.waitFor(() => expect(w.store.createPermissionRequest).toHaveBeenCalledOnce())
    const requestId = w.observed.find((e) => e.kind === 'permission')!.requestId
    const args = { ...scope(requestId), allow: true, mayAllow: true }
    expect(await w.coordinator.handleChatPermissionChoice({ ...args, callerRole: 'owner' })).toBe(false)
    expect(await w.coordinator.handleChatPermissionChoice({ ...args, turnId: 'foreign' })).toBe(false)
    expect(await w.coordinator.handleChatPermissionChoice(args)).toBe(true)
    await expect(outcome).resolves.toMatchObject({ outcome: { optionId: 'yes' } })
    expect(w.observed.at(-1)).toMatchObject({ kind: 'permission_resolved', outcome: 'allowed' })
    expect(w.p.webchat).toBeUndefined()
  })

  it('validates the platform card literal through its existing option mapping and resolver', async () => {
    const w = native()
    const ask = {
      mode: 'form',
      message: 'Branch?',
      requestedSchema: { type: 'object', properties: { branch: { type: 'string', enum: ['main', 'dev'] } } }
    } as unknown as CreateElicitationRequest
    const outcome = w.coordinator.onAcpElicit(OWNER, ACP_SESSION, ask)
    await vi.waitFor(() => expect(w.observed.some((e) => e.kind === 'elicitation')).toBe(true))
    const requestId = w.observed.find((e) => e.kind === 'elicitation')!.requestId
    const args = { ...scope(requestId), webchatConversationId: 'verified-alias', value: 'dev' }
    expect(w.coordinator.chatElicitation(scope(requestId))).toMatchObject({
      turnId: 'native-turn',
      card: { requestId }
    })
    expect(await w.coordinator.handleCallerElicitChoice({ ...args, callerRole: 'owner' })).toBe(false)
    expect(await w.coordinator.handleCallerElicitChoice({ ...args, value: 'foreign' })).toBe(false)
    expect(await w.coordinator.handleCallerElicitChoice(args)).toBe(true)
    await expect(outcome).resolves.toMatchObject({ action: 'accept', content: { branch: 'dev' } })
    expect(w.observed.at(-1)).toMatchObject({ kind: 'elicitation_resolved', answers: { value: 'dev' } })
    expect(w.p.webchat).toBeUndefined()
  })

  it('uses the same form validator for a single native text field and masks the accepted observation', async () => {
    const w = native()
    const ask = {
      mode: 'form',
      message: 'Name?',
      requestedSchema: { type: 'object', properties: { name: { type: 'string', minLength: 3 } } }
    } as unknown as CreateElicitationRequest
    const outcome = w.coordinator.onAcpElicit(OWNER, ACP_SESSION, ask)
    await vi.waitFor(() => expect(w.observed.some((e) => e.kind === 'elicitation')).toBe(true))
    const requestId = w.observed.find((e) => e.kind === 'elicitation')!.requestId
    w.host.maskAgentSecrets = <T>(_agent: string, payload: T): T =>
      JSON.parse(JSON.stringify(payload).replaceAll('valid name', '[REDACTED]'))
    const args = { ...scope(requestId), webchatConversationId: 'verified-alias' }
    expect(await w.coordinator.handleCallerElicitChoice({ ...args, value: 'x' })).toBe(false)
    expect(await w.coordinator.handleCallerElicitChoice({ ...args, value: 'valid name' })).toBe(true)
    await expect(outcome).resolves.toMatchObject({ action: 'accept', content: { name: 'valid name' } })
    expect(w.observed.at(-1)).toMatchObject({ answers: { value: '[REDACTED]' } })
  })
  it('observes cancellation from the original platform resolver and refuses a later answer', async () => {
    const w = native()
    const ask = {
      mode: 'form',
      message: 'Branch?',
      requestedSchema: { type: 'object', properties: { branch: { type: 'string', enum: ['main', 'dev'] } } }
    } as unknown as CreateElicitationRequest
    const outcome = w.coordinator.onAcpElicit(OWNER, ACP_SESSION, ask)
    await vi.waitFor(() => expect(w.observed.some((e) => e.kind === 'elicitation')).toBe(true))
    const requestId = w.observed.find((e) => e.kind === 'elicitation')!.requestId
    await w.coordinator.releaseElicits(OWNER, ACP_SESSION)
    await expect(outcome).resolves.toEqual({ action: 'cancel' })
    expect(w.observed.at(-1)).toMatchObject({ kind: 'elicitation_resolved', outcome: 'cancelled' })
    expect(
      await w.coordinator.handleCallerElicitChoice({
        ...scope(requestId),
        webchatConversationId: 'verified-alias',
        value: 'dev'
      })
    ).toBe(false)
  })
})
