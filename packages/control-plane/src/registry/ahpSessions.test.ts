import { describe, expect, it, vi } from 'vitest'
import type { AhpSessionBindingRepo } from '../persistence/ports.js'
import type { AhpGrantClaims } from './ahpGrant.js'
import { AhpSessionService } from './ahpSessions.js'

const binding = {
  orgId: 'org',
  agentId: 'agent',
  userId: 'owner',
  conversationId: 'conversation',
  reservationId: 'reservation',
  operationId: 'operation',
  sessionUri: 'ahp-session:/client-uri',
  sessionId: 'outward'
}
const request = { orgId: 'org', agentId: 'agent', grant: 'signed', sessionUri: binding.sessionUri }
function fixture(conversationId?: string) {
  const claims: AhpGrantClaims = {
    orgId: 'org',
    agentId: 'agent',
    userId: 'owner',
    user: 'Owner',
    ...(conversationId ? { conversationId } : { apiKeyId: 'key' })
  }
  const authorizeGrant = vi.fn(async () => claims)
  const repo = {
    reserve: vi.fn(async (_input: Parameters<AhpSessionBindingRepo['reserve']>[0]) => ({ ok: true, binding })),
    finalize: vi.fn(async () => ({ ok: true, binding })),
    get: vi.fn(async () => binding),
    forSession: vi.fn(async () => binding),
    bindExisting: vi.fn(async (_input: Parameters<AhpSessionBindingRepo['bindExisting']>[0]) => ({
      ok: true,
      binding
    })),
    forConversation: vi.fn(async () => binding),
    listOwned: vi.fn(async () => [binding])
  }
  return {
    repo,
    authorizeGrant,
    service: new AhpSessionService({
      authorization: { authorizeGrant, authorizeBinding: async () => 'owner' },
      bindings: repo as unknown as AhpSessionBindingRepo
    })
  }
}

describe('AHP session control service', () => {
  it('checks signed scope before a repository read or write', async () => {
    const f = fixture()
    f.authorizeGrant.mockResolvedValue(null as never)
    expect(await f.service.resolve(request)).toEqual({ ok: false, reason: 'forbidden' })
    expect(await f.service.reserve({ ...request, operationId: 'op' }, 'daemon')).toEqual({
      ok: false,
      reason: 'forbidden'
    })
    expect(f.repo.get).not.toHaveBeenCalled()
    expect(f.repo.reserve).not.toHaveBeenCalled()
  })

  it('passes trusted identity and the daemon lease through reservation, without publishing the internal operation', async () => {
    const f = fixture()
    const duty = { groupId: 'group', term: '9' }
    const result = await f.service.reserve({ ...request, operationId: 'retry-operation', duty }, 'daemon')
    expect(f.repo.reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'owner',
        apiKeyId: 'key',
        operationId: 'retry-operation',
        writer: { daemonId: 'daemon', duty }
      })
    )
    expect(result).toEqual({
      ok: true,
      reservationId: 'reservation',
      conversationId: 'conversation',
      sessionUri: binding.sessionUri,
      sessionId: 'outward',
      callerRole: 'owner'
    })
    expect(result).not.toHaveProperty('userId')
    expect(result).not.toHaveProperty('operationId')
  })

  it('reuses a bound browser conversation URI instead of shadowing a prior client-chosen URI', async () => {
    const f = fixture('conversation')
    const result = await f.service.reserve(
      { ...request, sessionUri: 'ahp-session:/candidate', operationId: 'op' },
      'daemon'
    )
    expect(result).toMatchObject({ ok: true, sessionUri: binding.sessionUri })
    expect(f.repo.reserve).not.toHaveBeenCalled()
    expect(await f.service.finalize({ ...request, reservationId: 'foreign', sessionId: 'id' }, 'daemon')).toEqual({
      ok: false,
      reason: 'forbidden'
    })
    expect(f.repo.finalize).not.toHaveBeenCalled()
  })

  it('creates only an already-authorized browser conversation slot when its binding is missing', async () => {
    const f = fixture('conversation')
    f.repo.forConversation.mockResolvedValue(null as never)
    await f.service.reserve({ ...request, operationId: 'op' }, 'daemon')
    expect(f.repo.reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conversation',
        userId: 'owner',
        sessionUri: 'ahp-session:/conversation/agent'
      })
    )
  })

  it('allocates different stable URI and internal operation identities to each conversation participant', async () => {
    const first = fixture('conversation')
    const second = fixture('conversation')
    first.repo.forConversation.mockResolvedValue(null as never)
    second.repo.forConversation.mockResolvedValue(null as never)
    await first.service.reserve({ ...request, operationId: 'same-client-operation' }, 'daemon')
    await second.service.reserve({ ...request, agentId: 'peer', operationId: 'same-client-operation' }, 'daemon')
    const a = first.repo.reserve.mock.calls[0]![0] as unknown as { sessionUri: string; operationId: string }
    const b = second.repo.reserve.mock.calls[0]![0] as unknown as { sessionUri: string; operationId: string }
    expect(a.sessionUri).toBe('ahp-session:/conversation/agent')
    expect(b.sessionUri).toBe('ahp-session:/conversation/peer')
    expect(a.operationId).not.toBe(b.operationId)
    await first.service.reserve({ ...request, operationId: 'new-connection-operation' }, 'daemon')
    expect(first.repo.reserve.mock.calls[1]![0]).toMatchObject({ operationId: a.operationId, sessionUri: a.sessionUri })
  })

  it('does not disclose another principal’s binding or an unfinished creation', async () => {
    const f = fixture()
    f.repo.get.mockResolvedValue({ ...binding, userId: 'somebody-else' })
    expect(await f.service.resolve(request)).toEqual({ ok: false, reason: 'not_found' })
    f.repo.get.mockResolvedValue({ ...binding, sessionId: null as never })
    expect(await f.service.resolve(request)).toEqual({ ok: false, reason: 'not_found' })
  })

  it('confines browser discovery to its conversation and API-key discovery to its owner', async () => {
    const browser = fixture('conversation')
    expect(await browser.service.list({ ...request, limit: 10 })).toMatchObject({
      ok: true,
      sessions: [{ sessionUri: binding.sessionUri }]
    })
    expect(browser.repo.listOwned).not.toHaveBeenCalled()
    const api = fixture()
    await api.service.list({ ...request, limit: 10, cursor: 'previous' })
    expect(api.repo.listOwned).toHaveBeenCalledWith({
      orgId: 'org',
      agentId: 'agent',
      userId: 'owner',
      after: 'previous',
      limit: 10
    })
  })
  it('exports an authorized continuation as the same outward session without creating a conversation or runtime slot', async () => {
    const f = fixture('new-attachment-conversation')
    f.authorizeGrant.mockResolvedValue({
      orgId: 'org',
      agentId: 'agent',
      userId: 'other-authorized-member',
      user: 'Member',
      conversationId: 'new-attachment-conversation',
      targetSessionId: 'outward'
    })
    expect(await f.service.reserve({ ...request, operationId: 'ignored' }, 'daemon')).toMatchObject({
      ok: true,
      sessionUri: binding.sessionUri,
      sessionId: 'outward',
      conversationId: 'new-attachment-conversation'
    })
    expect(f.repo.bindExisting).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'outward', sessionUri: 'ahp-session:/outward' })
    )
    expect(f.repo.reserve).not.toHaveBeenCalled()
    expect(await f.service.resolve(request)).toMatchObject({
      ok: true,
      sessionId: 'outward',
      conversationId: 'new-attachment-conversation'
    })
    expect(
      await f.service.finalize({ ...request, reservationId: binding.reservationId, sessionId: 'replacement' }, 'daemon')
    ).toEqual({ ok: false, reason: 'forbidden' })
    expect(f.repo.finalize).not.toHaveBeenCalled()
  })
})
