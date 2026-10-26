import { expect, it, vi } from 'vitest'
import {
  ActionType,
  MessageKind,
  ToolCallConfirmationReason,
  type DispatchActionParams
} from '@microsoft/agent-host-protocol'
import {
  AhpApplication,
  ahpTurnReceipt,
  type AhpApplicationHost,
  type AhpActionHooks,
  type AhpActionScope
} from '../../src/ahp/application.js'
import type { ChatSessionApplication, ChatTurnRequest } from '../../src/session/chat-application.js'
import type { ChatSessionContinuation } from '../../src/session/chat-continuation.js'
const scope: AhpActionScope = {
  agentId: 'agent',
  conversationId: 'conversation',
  sessionId: 'outward',
  sessionUri: 'ahp-session:/session',
  author: { id: 'principal', name: 'Person' },
  callerRole: 'owner',
  callerApproves: true
}
const origin = { clientId: 'untrusted-client-label', clientSeq: 1 }
const start: DispatchActionParams = {
  channel: 'ahp-chat:/session/main',
  clientSeq: 1,
  action: {
    type: ActionType.ChatTurnStarted,
    turnId: 'turn',
    startedAt: new Date(0).toISOString(),
    message: { text: 'hello', origin: { kind: MessageKind.User } }
  }
}
function fixture() {
  const turn = { agentId: scope.agentId, sessionKey: 'canonical', message: {} }
  const prepare = vi.fn(async (_request: ChatTurnRequest) => ({ accepted: true, turn }))
  const record = vi.fn(async () => {})
  const host: AhpApplicationHost = {
    application: {
      prepareTurn: prepare,
      checkAdmission: () => ({ accepted: true, turn }),
      recordAdmission: record,
      canChangeRuntime: () => true
    } as unknown as ChatSessionApplication,
    continuation: { prepare: vi.fn(), dispatch: vi.fn() } as unknown as ChatSessionContinuation,
    now: () => 1000,
    dispatch: vi.fn(async (_turn, _context, options) => {
      await options.onAdmission?.({ accepted: true })
      return null
    }),
    cancel: vi.fn(async () => true),
    permission: vi.fn(async () => true),
    elicit: vi.fn(async () => true),
    setRuntime: vi.fn(async () => true),
    onExecutionError: vi.fn()
  }
  const hooks: AhpActionHooks = {
    authorized: () => true,
    canStart: () => true,
    context: (turnId) => ({ conversationId: scope.conversationId, turnId, sink: { output: () => {}, done: () => {} } }),
    admitted: vi.fn(async () => {}),
    steered: vi.fn(async () => {}),
    echo: vi.fn(async () => {})
  }
  return { application: new AhpApplication(host), host, hooks, prepare, record }
}
it('uses authoritative principal and canonical durable receipt, awaiting publication before releasing execution', async () => {
  const f = fixture()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  f.hooks.admitted = vi.fn(async () => {
    await gate
  })
  let execution = false
  vi.mocked(f.host.dispatch).mockImplementation(async (_turn, _context, options) => {
    await options.onAdmission?.({ accepted: true })
    execution = true
    return null
  })
  const sending = f.application.dispatch(scope, start, origin, f.hooks)
  await vi.waitFor(() => expect(f.hooks.admitted).toHaveBeenCalledOnce())
  expect(execution).toBe(false)
  expect(f.prepare.mock.calls[0]?.[0]).toMatchObject({
    author: scope.author,
    conversationId: scope.conversationId,
    turnId: 'turn'
  })
  expect(vi.mocked(f.host.dispatch).mock.calls[0]?.[2]).toMatchObject({
    requireDurable: true,
    receiptId: ahpTurnReceipt(scope, 'turn')
  })
  release()
  await sending
  expect(execution).toBe(true)
  expect(f.record).toHaveBeenCalledOnce()
})
it("runs VS Code's turn shape as plain text on a continuation, ignoring its model, agent and context", async () => {
  const f = fixture()
  const vscode = {
    ...start,
    action: {
      ...start.action,
      message: {
        text: 'hello',
        origin: { kind: MessageKind.User },
        model: { id: 'copilot/gpt' },
        agent: { uri: 'file:///agents/review.agent.md' },
        attachments: [{ type: 'resource', label: 'main.ts', uri: 'file:///src/main.ts' }]
      }
    }
  } as DispatchActionParams
  await f.application.dispatch({ ...scope, targetSessionId: 'outward' }, vscode, origin, f.hooks)
  expect(f.prepare.mock.calls[0]?.[0]).toMatchObject({ text: 'hello' })
  expect(f.prepare.mock.calls[0]?.[0]).not.toHaveProperty('attachments')
  expect(f.host.setRuntime).not.toHaveBeenCalled()
  expect(f.hooks.admitted).toHaveBeenCalledOnce()
})
it('publishes a steering fallback without the client context the runtime never received', async () => {
  const f = fixture()
  const steer = {
    ...start,
    action: {
      type: ActionType.ChatPendingMessageSet,
      kind: 'steering',
      id: 'steer',
      message: {
        text: 'also this',
        origin: { kind: MessageKind.User },
        model: { id: 'copilot/gpt' },
        attachments: [{ type: 'simple', label: 'selection', modelRepresentation: 'secret text' }]
      }
    }
  } as DispatchActionParams
  await f.application.dispatch(scope, steer, origin, f.hooks)
  expect(f.hooks.steered).not.toHaveBeenCalled()
  expect(vi.mocked(f.hooks.echo).mock.calls[0]?.[0]).toEqual({
    type: ActionType.ChatPendingMessageSet,
    kind: 'steering',
    id: 'steer',
    message: { text: 'also this', origin: { kind: MessageKind.User } }
  })
})
it('does not wait for ACP completion after durable admission', async () => {
  const f = fixture()
  vi.mocked(f.host.dispatch).mockImplementation(async (_turn, _context, options) => {
    await options.onAdmission?.({ accepted: true })
    return new Promise(() => {})
  })
  await f.application.dispatch(scope, start, origin, f.hooks)
  expect(f.hooks.admitted).toHaveBeenCalledOnce()
})
it('does not record or re-execute an already admitted receipt', async () => {
  const f = fixture()
  vi.mocked(f.host.dispatch).mockImplementation(async (_turn, _context, options) => {
    await options.onAdmission?.({ accepted: true, duplicate: true })
    return null
  })
  await f.application.dispatch(scope, start, origin, f.hooks)
  expect(f.record).not.toHaveBeenCalled()
  expect(f.hooks.admitted).toHaveBeenCalledWith(start.action, origin, { duplicate: true })
  expect(ahpTurnReceipt({ ...scope, sessionId: 'other' }, 'turn')).not.toBe(ahpTurnReceipt(scope, 'turn'))
})
it('refuses active-turn, expired-grant and API-gate bypasses before dispatch', async () => {
  for (const mode of ['busy', 'expired', 'api'] as const) {
    const f = fixture()
    if (mode === 'busy') f.hooks.canStart = () => false
    if (mode === 'expired') f.hooks.authorized = () => false
    await expect(
      f.application.dispatch({ ...scope, ...(mode === 'api' ? { apiOrigin: true } : {}) }, start, origin, f.hooks)
    ).rejects.toMatchObject({ code: -32009 })
    expect(f.host.dispatch).not.toHaveBeenCalled()
  }
})
it('never echoes a denied approval or an unavailable permission request as accepted', async () => {
  const f = fixture()
  const params = {
    ...start,
    action: {
      type: ActionType.ChatToolCallConfirmed,
      turnId: 'turn',
      toolCallId: 'request',
      approved: true,
      confirmed: ToolCallConfirmationReason.UserAction
    }
  } as DispatchActionParams
  await expect(
    f.application.dispatch({ ...scope, callerApproves: false }, params, origin, f.hooks)
  ).rejects.toMatchObject({ code: -32009 })
  expect(f.host.permission).not.toHaveBeenCalled()
  vi.mocked(f.host.permission).mockResolvedValue(false)
  await expect(f.application.dispatch(scope, params, origin, f.hooks)).rejects.toMatchObject({ code: -32009 })
  expect(f.hooks.echo).not.toHaveBeenCalled()
})
it('rejects server-only actions and foreign channels without invoking domain operations', async () => {
  const f = fixture()
  await expect(
    f.application.dispatch(scope, { ...start, channel: 'ahp-chat:/foreign/main' }, origin, f.hooks)
  ).rejects.toBeDefined()
  await expect(
    f.application.dispatch(
      scope,
      { ...start, action: { type: ActionType.ChatDelta, turnId: 'turn', partId: 'part', content: 'forged' } },
      origin,
      f.hooks
    )
  ).rejects.toMatchObject({ code: -32602 })
  expect(f.host.dispatch).not.toHaveBeenCalled()
})

it('publishes its own durable claim without treating that claimed gate as a competing turn', async () => {
  const f = fixture()
  let claimed = false
  f.hooks.canStart = () => !claimed
  vi.mocked(f.host.dispatch).mockImplementation(async (_turn, _context, options) => {
    expect(options.startOnly).toBe(true)
    claimed = true
    await options.onAdmission?.({ accepted: true })
    return null
  })
  await f.application.dispatch(scope, start, origin, f.hooks)
  expect(f.hooks.admitted).toHaveBeenCalledOnce()
})
