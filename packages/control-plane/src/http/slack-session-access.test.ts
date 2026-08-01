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
    resourceKey: 'C_CHANNEL',
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
  it('allows a full workspace member to read a public channel without joining it', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('conversations.info')) {
        return json({ ok: true, channel: { is_private: false, is_im: false, is_mpim: false } })
      }
      if (url.includes('users.info')) {
        return json({ ok: true, user: { team_id: 'T_INSTALL', deleted: false, is_restricted: false } })
      }
      throw new Error(`unexpected Slack request: ${url}`)
    })

    await expect(service(fetchImpl).resolve([scope()], new Set(['slack:T_INSTALL:U_NOT_JOINED']))).resolves.toEqual({
      allowedScopes: [{ id: scope().id, aclRevision: 2n }],
      degraded: false
    })
    expect(fetchImpl.mock.calls.some(([url]) => String(url).includes('conversations.members'))).toBe(false)
  })

  it('requires a public-channel guest to be a current conversation member', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('conversations.info')) {
        return json({ ok: true, channel: { is_private: false, is_im: false, is_mpim: false } })
      }
      if (url.includes('users.info')) {
        return json({ ok: true, user: { team_id: 'T_INSTALL', is_restricted: true } })
      }
      return json({ ok: true, members: ['U_GUEST'], response_metadata: {} })
    })
    const resolver = service(fetchImpl)

    await expect(resolver.resolve([scope()], new Set(['slack:T_INSTALL:U_GUEST']))).resolves.toEqual({
      allowedScopes: [{ id: scope().id, aclRevision: 2n }],
      degraded: false
    })
    await expect(resolver.resolve([scope()], new Set(['slack:T_INSTALL:U_OTHER_GUEST']))).resolves.toEqual({
      allowedScopes: [],
      degraded: false
    })
  })

  it.each(['is_profile_only_user', 'is_invited_user'] as const)(
    'does not grant public-channel access to a user with %s',
    async (field) => {
      const fetchImpl = vi.fn(async (url: string) => {
        if (url.includes('conversations.info')) {
          return json({ ok: true, channel: { is_private: false, is_im: false, is_mpim: false } })
        }
        if (url.includes('users.info')) {
          return json({ ok: true, user: { team_id: 'T_INSTALL', [field]: true } })
        }
        throw new Error(`unexpected Slack request: ${url}`)
      })

      await expect(service(fetchImpl).resolve([scope()], new Set(['slack:T_INSTALL:U_LIMITED']))).resolves.toEqual({
        allowedScopes: [],
        degraded: false
      })
      expect(fetchImpl.mock.calls.some(([url]) => String(url).includes('conversations.members'))).toBe(false)
    }
  )

  it('allows only a linked identity that is a current private-conversation member', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes('conversations.info')
        ? json({ ok: true, channel: { is_private: true, is_im: false, is_mpim: false } })
        : json({ ok: true, members: ['U_MEMBER'], response_metadata: {} })
    )
    const resolver = service(fetchImpl)

    await expect(resolver.resolve([scope()], new Set(['slack:T_INSTALL:U_MEMBER']))).resolves.toEqual({
      allowedScopes: [{ id: scope().id, aclRevision: 2n }],
      degraded: false
    })
    await expect(resolver.resolve([scope()], new Set(['slack:T_INSTALL:U_OTHER']))).resolves.toEqual({
      allowedScopes: [],
      degraded: false
    })
    expect(fetchImpl.mock.calls.some(([url]) => String(url).includes('users.info'))).toBe(false)
  })

  it('requires a Slack Connect user to be a public-channel member', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('conversations.info')) {
        return json({ ok: true, channel: { is_private: false, is_im: false, is_mpim: false } })
      }
      if (url.includes('conversations.members')) {
        return json({ ok: true, members: ['U_CONNECT'], response_metadata: {} })
      }
      return json({ ok: true, user: { team_id: 'T_HOME', is_external: true } })
    })

    await expect(service(fetchImpl).resolve([scope()], new Set(['slack:T_HOME:U_CONNECT']))).resolves.toEqual({
      allowedScopes: [{ id: scope().id, aclRevision: 2n }],
      degraded: false
    })
  })

  it('rejects a private Slack Connect member when the linked home team does not match Slack', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('conversations.info')) {
        return json({ ok: true, channel: { is_private: true, is_im: false, is_mpim: false } })
      }
      if (url.includes('conversations.members')) {
        return json({ ok: true, members: ['U_CONNECT'], response_metadata: {} })
      }
      return json({ ok: true, user: { team_id: 'T_OTHER' } })
    })

    await expect(service(fetchImpl).resolve([scope()], new Set(['slack:T_HOME:U_CONNECT']))).resolves.toEqual({
      allowedScopes: [],
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
