import { describe, expect, it, vi } from 'vitest'
import type { BotRecord, ExternalScopeRecord } from '../persistence/ports.js'
import { SlackSessionAccessService } from './slack-session-access.js'

const BOT_ID = 'b0b0b0b0-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function scope(): ExternalScopeRecord {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    orgId: 'org-1',
    provider: 'slack',
    realmKey: 'T_INSTALL',
    resourceKind: 'conversation',
    resourceKey: 'C_PRIVATE',
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
    platform: 'slack',
    workspaceId: 'T_INSTALL',
    teamId: 'T_INSTALL',
    revokedAt: null,
    credentialRevision: 3
  } as BotRecord
}

function service(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>) {
  return new SlackSessionAccessService({
    bots: { get: async () => bot() } as never,
    botSecrets: { get: async () => ({ botToken: 'xoxb-test' }) } as never,
    clock: { now: () => 1_000 } as never,
    fetchImpl
  })
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('SlackSessionAccessService', () => {
  it('allows only a linked identity that is a current conversation member', async () => {
    const fetchImpl = vi.fn(async () => json({ ok: true, members: ['U_MEMBER'], response_metadata: {} }))
    const resolver = service(fetchImpl)

    await expect(resolver.resolve([scope()], new Set(['slack:T_INSTALL:U_MEMBER']))).resolves.toEqual({
      allowedScopes: [{ id: scope().id, aclRevision: 2n }],
      degraded: false
    })
    await expect(resolver.resolve([scope()], new Set(['slack:T_INSTALL:U_OTHER']))).resolves.toEqual({
      allowedScopes: [],
      degraded: false
    })
  })

  it('verifies a Slack Connect member against the linked identity home team', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes('conversations.members')
        ? json({ ok: true, members: ['U_CONNECT'], response_metadata: {} })
        : json({ ok: true, user: { team_id: 'T_HOME' } })
    )

    await expect(service(fetchImpl).resolve([scope()], new Set(['slack:T_HOME:U_CONNECT']))).resolves.toEqual({
      allowedScopes: [{ id: scope().id, aclRevision: 2n }],
      degraded: false
    })
  })

  it('fails closed and reports degradation when Slack cannot answer', async () => {
    const resolver = service(async () => json({ ok: false, error: 'ratelimited' }))
    await expect(resolver.resolve([scope()], new Set(['slack:T_INSTALL:U_MEMBER']))).resolves.toEqual({
      allowedScopes: [],
      degraded: true
    })
  })
})
