import { describe, expect, it, vi } from 'vitest'
import type { BotRecord, ExternalScopeRecord } from '../persistence/ports.js'
import type { SessionAccessViewer } from './session-access-plugin.js'
import { FeishuSessionAccessService } from './feishu-session-access.js'

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

function service(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>, now: () => number = () => 1_000) {
  return new FeishuSessionAccessService({
    bots: { getUnscoped: async () => bot() } as never,
    botSecrets: {
      get: async () => ({
        botToken: 'app-secret',
        appToken: 'cli_custom',
        signingSecret: null
      })
    } as never,
    clock: { now } as never,
    fetchImpl
  })
}

function viewer(unionIds: string[] = ['on_member']): SessionAccessViewer {
  return {
    request: {} as never,
    orgId: 'org-1' as never,
    userId: 'user-1',
    identitySet: new Set(unionIds.map((id) => `feishu:lark:cli_custom:${id}`))
  }
}

describe('FeishuSessionAccessService', () => {
  it('links one login union_id into every active same-region Bot App domain', async () => {
    const resolver = new FeishuSessionAccessService({
      bots: {
        listForOrg: async () => [
          { platform: 'feishu', feishuRegion: 'lark', feishuAppId: 'cli_one', revokedAt: null },
          { platform: 'feishu', feishuRegion: 'lark', feishuAppId: 'cli_two', revokedAt: null },
          { platform: 'feishu', feishuRegion: 'feishu', feishuAppId: 'cli_mainland', revokedAt: null }
        ]
      } as never,
      botSecrets: {} as never,
      clock: { now: () => 1_000 } as never,
      identity: { feishuIdentitiesFor: async () => [{ region: 'lark', unionId: 'on_member' }] }
    })
    const current = viewer([])
    current.request = { oidcSubject: 'logto-sub' } as never

    await resolver.addViewerIdentities(current)

    expect(current.identitySet).toEqual(new Set(['feishu:lark:cli_one:on_member', 'feishu:lark:cli_two:on_member']))
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

  it('coalesces concurrent viewers into one shared Bot chat member snapshot', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.endsWith('/tenant_access_token/internal')
        ? json({ code: 0, tenant_access_token: 'tenant-token' })
        : json({
            code: 0,
            data: { items: [{ member_id: 'on_member' }, { member_id: 'on_other' }], has_more: false }
          })
    )
    const resolver = service(fetchImpl)

    const [member, other] = await Promise.all([
      resolver.resolve([scope()], viewer(['on_member'])),
      resolver.resolve([scope()], viewer(['on_other']))
    ])
    await resolver.resolve([scope()], viewer(['on_member']))

    expect(member.allowedScopes).toHaveLength(1)
    expect(other.allowedScopes).toHaveLength(1)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
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

  it('classifies exhausted tenant quota and backs off other chats in the same organization', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.endsWith('/tenant_access_token/internal')
        ? json({ code: 0, tenant_access_token: 'tenant-token' })
        : json({ code: 99991403, msg: "This month's API call quota has been exceeded" }, 429)
    )
    const resolver = service(fetchImpl)
    const anotherScope = {
      ...scope(),
      id: '22222222-2222-4222-8222-222222222222',
      resourceKey: 'oc_another_chat'
    }

    await expect(resolver.resolve([scope()], viewer())).resolves.toEqual({
      allowedScopes: [],
      degraded: true,
      accessIssues: [{ provider: 'feishu', region: 'lark', reason: 'quota' }]
    })
    await expect(resolver.resolve([anotherScope], viewer())).resolves.toEqual({
      allowedScopes: [],
      degraded: true,
      accessIssues: [{ provider: 'feishu', region: 'lark', reason: 'quota' }]
    })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  // Running out of quota is a fact about the APP, not about who is in the chat,
  // so it must never occupy the chat's membership entry — `quotaBlockedUntil` is
  // what suppresses the retry storm.
  it('does not leave a quota verdict standing in for a chat’s membership', async () => {
    let now = 1_777_000_000_000
    let memberCalls = 0
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/tenant_access_token/internal')) {
        return json({ code: 0, tenant_access_token: 'tenant-token' })
      }
      memberCalls += 1
      return memberCalls === 1
        ? json({ code: 99991403, msg: "This month's API call quota has been exceeded" }, 429)
        : json({ code: 0, data: { items: [{ member_id: 'on_member' }] } })
    })
    const resolver = service(fetchImpl, () => now)

    await expect(resolver.resolve([scope()], viewer())).resolves.toMatchObject({ degraded: true })

    // Past the organization-wide backoff, the chat has to be asked again.
    now += 60 * 60_000 + 1
    await expect(resolver.resolve([scope()], viewer())).resolves.toEqual({
      allowedScopes: [{ id: scope().id, aclRevision: scope().aclRevision }],
      degraded: false,
      accessIssues: []
    })
    expect(memberCalls).toBe(2)
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
