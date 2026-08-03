import { describe, expect, it, vi } from 'vitest'
import type { BotRecord, ExternalScopeRecord } from '../persistence/ports.js'
import { FeishuSessionAccessService, type FeishuSessionViewer } from './feishu-session-access.js'

const BOT_ID = 'b0b0b0b0-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function scope(): ExternalScopeRecord {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    orgId: 'org-1',
    provider: 'feishu',
    realmKey: 'lark:cli_custom',
    resourceKind: 'conversation',
    resourceKey: 'oc_chat',
    credentialKind: 'bot',
    credentialId: BOT_ID,
    aclRevision: 2n,
    revokedAt: null
  }
}

function scopeAt(index: number): ExternalScopeRecord {
  return {
    ...scope(),
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    resourceKey: `oc_chat_${index}`
  }
}

function bot(): BotRecord {
  return {
    id: BOT_ID,
    orgId: 'org-1',
    platform: 'feishu',
    feishuRegion: 'lark',
    feishuAppId: 'cli_custom',
    revokedAt: null,
    credentialRevision: 3
  } as BotRecord
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function service(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>) {
  return new FeishuSessionAccessService({
    bots: { get: async () => bot() } as never,
    clock: { now: () => 1_000 } as never,
    fetchImpl
  })
}

function viewer(accessTokenFor = vi.fn(async () => 'user-token')): FeishuSessionViewer {
  return { subject: 'logto-user', accessTokenFor }
}

describe('FeishuSessionAccessService', () => {
  it('resolves allowed scopes beyond the first 200 with one regional user token', async () => {
    const accessTokenFor = vi.fn(async () => 'user-token')
    const fetchImpl = async () => json({ code: 0, data: { is_in_chat: true } })
    const scopes = Array.from({ length: 201 }, (_, index) => scopeAt(index + 1))
    const result = await service(fetchImpl).resolve(scopes, viewer(accessTokenFor))
    expect(result.allowedScopes).toHaveLength(201)
    expect(result.degraded).toBe(false)
    expect(accessTokenFor).toHaveBeenCalledOnce()
  })

  it('uses the Lark gateway and allows a current member of a custom Bot chat', async () => {
    const fetchImpl = vi.fn(async () => json({ code: 0, data: { is_in_chat: true } }))

    await expect(service(fetchImpl).resolve([scope()], viewer())).resolves.toEqual({
      allowedScopes: [{ id: scope().id, aclRevision: 2n }],
      degraded: false
    })
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://open.larksuite.com/open-apis/im/v1/chats/oc_chat/members/is_in_chat',
      expect.objectContaining({ headers: expect.any(Headers) })
    )
    expect(new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get('authorization')).toBe('Bearer user-token')
  })

  it('denies when the user token is not in the chat', async () => {
    await expect(
      service(async () => json({ code: 0, data: { is_in_chat: false } })).resolve([scope()], viewer())
    ).resolves.toEqual({ allowedScopes: [], degraded: false })
  })

  it('fails closed and reports degradation when no request-bound user credential is present', async () => {
    const fetchImpl = vi.fn(async () => json({ code: 0, data: { is_in_chat: true } }))
    await expect(service(fetchImpl).resolve([scope()])).resolves.toEqual({ allowedScopes: [], degraded: true })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('fails closed and reports degradation for a provider permission failure', async () => {
    await expect(
      service(async () => json({ code: 99991672, msg: 'missing scope' })).resolve([scope()], viewer())
    ).resolves.toEqual({ allowedScopes: [], degraded: true })
  })

  it('rejects a scope whose realm does not match its custom Bot app', async () => {
    const fetchImpl = vi.fn(async () => json({ code: 0, data: { is_in_chat: true } }))
    await expect(service(fetchImpl).resolve([{ ...scope(), realmKey: 'lark:cli_other' }], viewer())).resolves.toEqual({
      allowedScopes: [],
      degraded: false
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
