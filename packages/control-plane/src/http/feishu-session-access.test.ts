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
    botSecrets: {
      get: async () => ({
        botToken: 'app-secret',
        appToken: 'cli_custom',
        signingSecret: null
      })
    } as never,
    clock: { now: () => 1_000 } as never,
    fetchImpl
  })
}

function viewer(unionIds: string[] = ['on_member']): FeishuSessionViewer {
  return { unionIdsFor: (region) => (region === 'lark' ? unionIds : []) }
}

describe('FeishuSessionAccessService', () => {
  it('resolves allowed scopes beyond the first 200 with one Bot-app tenant token', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.endsWith('/tenant_access_token/internal')
        ? json({ code: 0, tenant_access_token: 'tenant-token' })
        : json({ code: 0, data: { items: [{ member_id: 'on_member' }], has_more: false } })
    )
    const scopes = Array.from({ length: 201 }, (_, index) => scopeAt(index + 1))
    const result = await service(fetchImpl).resolve(scopes, viewer())
    expect(result.allowedScopes).toHaveLength(201)
    expect(result.degraded).toBe(false)
    expect(result.accessIssues).toEqual([])
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).endsWith('/tenant_access_token/internal'))).toHaveLength(
      1
    )
  })

  it('uses the Lark gateway and allows a current member of a custom Bot chat', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.endsWith('/tenant_access_token/internal')
        ? json({ code: 0, tenant_access_token: 'tenant-token' })
        : json({ code: 0, data: { items: [{ member_id: 'on_member' }], has_more: false } })
    )

    await expect(service(fetchImpl).resolve([scope()], viewer())).resolves.toEqual({
      allowedScopes: [{ id: scope().id, aclRevision: 2n }],
      degraded: false,
      accessIssues: []
    })
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining(
        'https://open.larksuite.com/open-apis/im/v1/chats/oc_chat/members?member_id_type=union_id'
      ),
      expect.objectContaining({ headers: expect.any(Headers) })
    )
    expect(new Headers(fetchImpl.mock.calls[1]?.[1]?.headers).get('authorization')).toBe('Bearer tenant-token')
  })

  it('denies when the viewer union_id is not in the chat', async () => {
    await expect(
      service(async (url) =>
        url.endsWith('/tenant_access_token/internal')
          ? json({ code: 0, tenant_access_token: 'tenant-token' })
          : json({ code: 0, data: { items: [], has_more: false } })
      ).resolve([scope()], viewer())
    ).resolves.toEqual({ allowedScopes: [], degraded: false, accessIssues: [] })
  })

  it('fails closed and reports degradation when no verified login identity is present', async () => {
    const fetchImpl = vi.fn(async () => json({ code: 0, data: { items: [{ member_id: 'on_member' }] } }))
    await expect(service(fetchImpl).resolve([scope()])).resolves.toEqual({
      allowedScopes: [],
      degraded: true,
      accessIssues: []
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('identifies a missing regional union_id without calling the chat API', async () => {
    const fetchImpl = vi.fn(async () => json({ code: 0, data: { items: [{ member_id: 'on_member' }] } }))
    await expect(service(fetchImpl).resolve([scope()], viewer([]))).resolves.toEqual({
      allowedScopes: [],
      degraded: true,
      accessIssues: [{ provider: 'feishu', region: 'lark', reason: 'authorization' }]
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('fails closed and reports degradation for a provider permission failure', async () => {
    await expect(
      service(async (url) =>
        url.endsWith('/tenant_access_token/internal')
          ? json({ code: 0, tenant_access_token: 'tenant-token' })
          : json({ code: 99991672, msg: 'missing scope' })
      ).resolve([scope()], viewer())
    ).resolves.toEqual({
      allowedScopes: [],
      degraded: true,
      accessIssues: [{ provider: 'feishu', region: 'lark', reason: 'unavailable' }]
    })
  })

  it('rejects a scope whose realm does not match its custom Bot app', async () => {
    const fetchImpl = vi.fn(async () => json({ code: 0, data: { items: [{ member_id: 'on_member' }] } }))
    await expect(service(fetchImpl).resolve([{ ...scope(), realmKey: 'lark:cli_other' }], viewer())).resolves.toEqual({
      allowedScopes: [],
      degraded: false,
      accessIssues: []
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
