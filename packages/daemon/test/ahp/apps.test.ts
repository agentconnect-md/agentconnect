import { describe, expect, it, vi } from 'vitest'
import {
  ActionType,
  SessionLifecycle,
  SessionStatus,
  sessionReducer,
  type SessionState
} from '@microsoft/agent-host-protocol'
import {
  AhpAppsProjection,
  dispatchAhpAppRequest,
  type AhpAppsCallbacks,
  type AhpAppsScope
} from '../../src/ahp/apps.js'

const card = { appId: 'app-a', title: 'Chart', toolName: 'charts__show', html: '<p>Chart</p>' }
const scope = (): AhpAppsScope => ({
  authorization: {
    orgId: 'org',
    agentId: 'agent',
    userId: 'user',
    user: 'User',
    callerRole: 'owner',
    callerApproves: true,
    conversationId: 'conversation',
    grant: { token: 'signed-grant', expiresAtMs: Number.MAX_SAFE_INTEGER }
  },
  binding: {
    reservationId: 'reservation',
    conversationId: 'conversation',
    sessionId: 'session',
    sessionUri: 'ahp-session:/conversation'
  },
  isCurrent: () => true
})
const request = {
  channel: 'ahp-chat:/conversation/main',
  appId: card.appId,
  callId: 'call',
  rpc: { method: 'tools/call', name: 'refresh' }
}
const callbacks = (): AhpAppsCallbacks => ({
  close: vi.fn(async () => {}),
  rpc: vi.fn(async (current, input, emit) => {
    emit({
      conversationId: current.binding.conversationId,
      turnId: 'turn',
      index: 0,
      event: {
        kind: 'app_rpc_result',
        appId: input.appId,
        callId: input.callId,
        outcome: { ok: true, result: { value: 42 } }
      }
    })
  })
})

describe('bounded optional AHP Apps metadata', () => {
  it('uses standard session metadata and the official reducer without changing identity', () => {
    const projection = new AhpAppsProjection()
    const update = projection.update('turn', { kind: 'app', ...card })!
    const state: SessionState = {
      provider: 'agent',
      title: 'Conversation',
      status: SessionStatus.Idle,
      lifecycle: SessionLifecycle.Ready,
      activeClients: [],
      chats: [],
      _meta: { 'agentconnect.md': { sessionId: 'session' } }
    }
    const next = sessionReducer(state, {
      type: ActionType.SessionMetaChanged,
      _meta: { 'agentconnect.md': { sessionId: 'session', ...update } }
    })
    expect(next._meta?.['agentconnect.md']).toMatchObject({ sessionId: 'session', apps: [{ html: card.html }] })
    update.apps[0]!.html = 'modified'
    expect(projection.snapshot()[0]!.html).toBe(card.html)
  })
  it('publishes complete ordered templates only, ignores duplicates and rejects gaps', () => {
    const projection = new AhpAppsProjection()
    projection.update('turn', { kind: 'app', ...card, html: undefined, htmlBytes: card.html.length })
    const chunk = { kind: 'app_template' as const, appId: card.appId, seq: 0, chunk: '<p>Chart' }
    expect(projection.update('turn', chunk)).toBeUndefined()
    expect(projection.update('turn', chunk)).toBeUndefined()
    expect(projection.snapshot()[0]).not.toHaveProperty('html')
    expect(() => projection.update('turn', { ...chunk, seq: 2, chunk: '</p>' })).toThrow('sequence gap')
    expect(projection.update('turn', { ...chunk, seq: 1, chunk: '</p>' })?.apps[0]!.html).toBe(card.html)
    projection.update('turn', { kind: 'app_resolved', appId: card.appId, outcome: 'closed' })
    expect(projection.update('turn', { ...chunk, seq: 2 })).toBeUndefined()
  })
  it('counts UTF-8 and all pending templates within 16 KiB without corrupting prior state', () => {
    const projection = new AhpAppsProjection()
    projection.update('turn', { kind: 'app', ...card })
    expect(() => projection.update('turn', { kind: 'app', ...card, html: '值'.repeat(6 * 1024) })).toThrow('limit')
    expect(projection.snapshot()[0]!.html).toBe(card.html)
    expect(() => projection.update('turn', { kind: 'app', ...card, html: undefined, htmlBytes: 1024 * 1024 })).toThrow(
      'limit'
    )
    for (const appId of ['a', 'b'])
      projection.update('turn', { kind: 'app', ...card, appId, html: undefined, htmlBytes: 14 * 1024 })
    projection.update('turn', { kind: 'app_template', appId: 'a', seq: 0, chunk: 'x'.repeat(10 * 1024) })
    expect(() =>
      projection.update('turn', { kind: 'app_template', appId: 'b', seq: 0, chunk: 'x'.repeat(10 * 1024) })
    ).toThrow('limit')
  })
  it('evicts only settled cards, retains at most16 and never broadcasts RPC results', () => {
    const projection = new AhpAppsProjection()
    for (let index = 0; index < 16; index++) projection.update('turn', { kind: 'app', ...card, appId: String(index) })
    expect(() => projection.update('turn', { kind: 'app', ...card })).toThrow('Too many')
    projection.update('turn', { kind: 'app_resolved', appId: '0', outcome: 'completed' })
    projection.update('turn', { kind: 'app', ...card })
    expect(projection.snapshot()).toHaveLength(16)
    expect(projection.snapshot().some((entry) => entry.card.appId === '0')).toBe(false)
    expect(
      projection.update('turn', {
        kind: 'app_rpc_result',
        appId: card.appId,
        callId: 'private',
        outcome: { ok: true, result: 'private' }
      })
    ).toBeUndefined()
  })
})

describe('scoped private AHP Apps requests', () => {
  it('passes only verified scope and app input to the existing host, with null close response', async () => {
    const current = scope()
    const host = callbacks()
    await expect(dispatchAhpAppRequest('agentconnect/appRpc', request, current, host)).resolves.toEqual({
      ok: true,
      result: { value: 42 }
    })
    expect(host.rpc).toHaveBeenCalledWith(
      current,
      { appId: card.appId, callId: 'call', rpc: request.rpc },
      expect.any(Function)
    )
    await expect(
      dispatchAhpAppRequest(
        'agentconnect/appClose',
        { channel: current.binding.sessionUri, appId: card.appId },
        current,
        host
      )
    ).resolves.toBeNull()
  })
  it.each([
    { ...request, userId: 'forged' },
    { ...request, channel: 'ahp-session:/foreign' },
    { ...request, rpc: { method: 'ui/open-link', url: 'https://example.test' } }
  ])('rejects forged identity, scope or unsupported methods before dispatch', async (input) => {
    const host = callbacks()
    await expect(dispatchAhpAppRequest('agentconnect/appRpc', input, scope(), host)).rejects.toThrow()
    expect(host.rpc).not.toHaveBeenCalled()
  })
  it('rechecks authority after await and ignores a response from another conversation/app/call', async () => {
    const current = scope()
    let active = true
    current.isCurrent = () => active
    const host = callbacks()
    host.close = async () => {
      active = false
    }
    await expect(
      dispatchAhpAppRequest('agentconnect/appClose', { channel: request.channel, appId: card.appId }, current, host)
    ).rejects.toThrow('denied')
    active = true
    host.rpc = async (_scope, _input, emit) => {
      for (const mismatch of ['conversation', 'app', 'call'])
        emit({
          conversationId: mismatch === 'conversation' ? 'foreign' : current.binding.conversationId,
          turnId: 'turn',
          index: 0,
          event: {
            kind: 'app_rpc_result',
            appId: mismatch === 'app' ? 'foreign' : card.appId,
            callId: mismatch === 'call' ? 'foreign' : 'call',
            outcome: { ok: true, result: 'wrong answer' }
          }
        })
    }
    await expect(dispatchAhpAppRequest('agentconnect/appRpc', request, current, host)).rejects.toThrow('did not answer')
  })
  it('rejects a response larger than the public carrier bound', async () => {
    const host = callbacks()
    host.rpc = async (current, input, emit) =>
      emit({
        conversationId: current.binding.conversationId,
        turnId: 'turn',
        index: 0,
        event: {
          kind: 'app_rpc_result',
          appId: input.appId,
          callId: input.callId,
          outcome: { ok: true, result: 'x'.repeat(64 * 1024) }
        }
      })
    await expect(dispatchAhpAppRequest('agentconnect/appRpc', request, scope(), host)).rejects.toThrow('limit')
  })
})
