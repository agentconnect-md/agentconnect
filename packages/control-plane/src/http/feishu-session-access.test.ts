import { describe, expect, it, vi } from 'vitest'
import type { BotRecord, ExternalScopeRecord } from '../persistence/ports.js'
import { FeishuSessionAccessService } from './feishu-session-access.js'

const BOT_ID = 'b0b0b0b0-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function scope(): ExternalScopeRecord {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    orgId: 'org-1',
    provider: 'feishu',
    realmKey: 'lark:cli_platform',
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
    feishuAppId: 'cli_platform',
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
    apps: { lark: { appId: 'cli_platform', appSecret: 'secret' } },
    clock: { now: () => 1_000 } as never,
    fetchImpl
  })
}

describe('FeishuSessionAccessService', () => {
  it('resolves allowed scopes beyond the first 200', async () => {
    const fetchImpl = async (url: string) =>
      url.includes('/auth/v3/')
        ? json({ code: 0, tenant_access_token: 'token', expire: 3600 })
        : json({ code: 0, data: { items: [{ member_id: 'ou_member' }], has_more: false } })
    const scopes = Array.from({ length: 201 }, (_, index) => scopeAt(index + 1))
    const result = await service(fetchImpl).resolve(scopes, new Set(['feishu:lark:cli_platform:ou_member']))
    expect(result.allowedScopes).toHaveLength(201)
    expect(result.degraded).toBe(false)
  })

  it('uses the Lark gateway and allows a current chat member', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes('/auth/v3/')
        ? json({ code: 0, tenant_access_token: 'token', expire: 3600 })
        : json({ code: 0, data: { items: [{ member_id: 'ou_member' }], has_more: false } })
    )

    await expect(
      service(fetchImpl).resolve([scope()], new Set(['feishu:lark:cli_platform:ou_member']))
    ).resolves.toEqual({ allowedScopes: [{ id: scope().id, aclRevision: 2n }], degraded: false })
    expect(fetchImpl.mock.calls.every(([url]) => String(url).startsWith('https://open.larksuite.com/'))).toBe(true)
  })

  it('walks member pages and denies a user who is absent', async () => {
    let page = 0
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/auth/v3/')) return json({ code: 0, tenant_access_token: 'token', expire: 3600 })
      page++
      return page === 1
        ? json({ code: 0, data: { items: [{ member_id: 'ou_other' }], has_more: true, page_token: 'next' } })
        : json({ code: 0, data: { items: [], has_more: false } })
    })

    await expect(
      service(fetchImpl).resolve([scope()], new Set(['feishu:lark:cli_platform:ou_missing']))
    ).resolves.toEqual({ allowedScopes: [], degraded: false })
    expect(page).toBe(2)
  })

  it('treats an inaccessible or dissolved chat as a definitive denial', async () => {
    const fetchImpl = async (url: string) =>
      url.includes('/auth/v3/')
        ? json({ code: 0, tenant_access_token: 'token', expire: 3600 })
        : json({ code: 232011, msg: 'operator is not in chat' })
    await expect(
      service(fetchImpl).resolve([scope()], new Set(['feishu:lark:cli_platform:ou_member']))
    ).resolves.toEqual({ allowedScopes: [], degraded: false })
  })

  it('fails closed and reports degradation for missing scope or provider failure', async () => {
    const fetchImpl = async (url: string) =>
      url.includes('/auth/v3/')
        ? json({ code: 0, tenant_access_token: 'token', expire: 3600 })
        : json({ code: 99991672, msg: 'missing scope' })
    await expect(
      service(fetchImpl).resolve([scope()], new Set(['feishu:lark:cli_platform:ou_member']))
    ).resolves.toEqual({ allowedScopes: [], degraded: true })
  })

  it('never compares an open_id from a different app domain', async () => {
    const fetchImpl = vi.fn(async () => json({ code: 0 }))
    await expect(service(fetchImpl).resolve([scope()], new Set(['feishu:lark:cli_other:ou_member']))).resolves.toEqual({
      allowedScopes: [],
      degraded: false
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
