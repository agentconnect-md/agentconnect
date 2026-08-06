import { describe, expect, it, vi } from 'vitest'
import type { BotRecord, ExternalScopeRecord } from '../persistence/ports.js'
import type { SessionAccessViewer } from './session-access-plugin.js'
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

function scopeAt(index: number): ExternalScopeRecord {
  return {
    ...scope(),
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    resourceKey: `C_CHANNEL_${index}`
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

function service(
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
  log?: { warn: (obj: object, msg: string) => void }
) {
  return new SlackSessionAccessService({
    bots: { getUnscoped: async () => bot() } as never,
    botSecrets: { get: async () => ({ botToken: 'xoxb-test' }) } as never,
    clock: { now: () => 1_000 } as never,
    fetchImpl,
    ...(log ? { log } : {})
  })
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function viewer(identity: string): SessionAccessViewer {
  return {
    request: {} as never,
    orgId: 'org-1' as never,
    userId: 'user-1',
    identitySet: new Set([identity])
  }
}

describe('SlackSessionAccessService', () => {
  it('resolves allowed scopes beyond the first 200', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('conversations.info')) {
        return json({ ok: true, channel: { is_private: false, is_im: false, is_mpim: false } })
      }
      if (url.includes('users.info')) {
        return json({ ok: true, user: { team_id: 'T_INSTALL', deleted: false, is_restricted: false } })
      }
      throw new Error(`unexpected Slack request: ${url}`)
    })
    const scopes = Array.from({ length: 201 }, (_, index) => scopeAt(index + 1))

    const result = await service(fetchImpl).resolve(scopes, viewer('slack:T_INSTALL:U_MEMBER'))

    expect(result.degraded).toBe(false)
    expect(result.allowedScopes).toHaveLength(201)
    expect(result.allowedScopes.at(-1)).toEqual({ id: scopes[200]!.id, aclRevision: scopes[200]!.aclRevision })
  })

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

    await expect(service(fetchImpl).resolve([scope()], viewer('slack:T_INSTALL:U_NOT_JOINED'))).resolves.toEqual({
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

    await expect(resolver.resolve([scope()], viewer('slack:T_INSTALL:U_GUEST'))).resolves.toEqual({
      allowedScopes: [{ id: scope().id, aclRevision: 2n }],
      degraded: false
    })
    await expect(resolver.resolve([scope()], viewer('slack:T_INSTALL:U_OTHER_GUEST'))).resolves.toEqual({
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

      await expect(service(fetchImpl).resolve([scope()], viewer('slack:T_INSTALL:U_LIMITED'))).resolves.toEqual({
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

    await expect(resolver.resolve([scope()], viewer('slack:T_INSTALL:U_MEMBER'))).resolves.toEqual({
      allowedScopes: [{ id: scope().id, aclRevision: 2n }],
      degraded: false
    })
    await expect(resolver.resolve([scope()], viewer('slack:T_INSTALL:U_OTHER'))).resolves.toEqual({
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

    await expect(service(fetchImpl).resolve([scope()], viewer('slack:T_HOME:U_CONNECT'))).resolves.toEqual({
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

    await expect(service(fetchImpl).resolve([scope()], viewer('slack:T_HOME:U_CONNECT'))).resolves.toEqual({
      allowedScopes: [],
      degraded: false
    })
  })

  it('fails closed and reports degradation when Slack cannot answer', async () => {
    const resolver = service(async () => json({ ok: false, error: 'ratelimited' }))
    await expect(resolver.resolve([scope()], viewer('slack:T_INSTALL:U_MEMBER'))).resolves.toEqual({
      allowedScopes: [],
      degraded: true
    })
  })

  // Degradation is the ONLY trace a hidden session leaves: every failure above
  // collapses to `unknown`, the session is omitted, and the caller is told
  // "not visible". Without this line an operator cannot tell a Slack blip from
  // a real denial after the fact — which is exactly how an intermittent
  // vanishing conversation stayed undiagnosable.
  it('logs the degradation, with counts rather than channel keys', async () => {
    const warn = vi.fn()
    const resolver = service(async () => json({ ok: false, error: 'ratelimited' }), { warn })

    await resolver.resolve([scope()], viewer('slack:T_INSTALL:U_MEMBER'))

    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toEqual({ provider: 'slack', unknownScopes: 1, totalScopes: 1 })
    // A scope key names a channel; the operator needs the rate, not the target.
    expect(JSON.stringify(warn.mock.calls[0]?.[0])).not.toContain('C_')
  })

  it('stays silent when every check answered', async () => {
    const warn = vi.fn()
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('conversations.info')) {
        return json({ ok: true, channel: { is_private: false, is_im: false, is_mpim: false } })
      }
      if (url.includes('users.info')) {
        return json({ ok: true, user: { team_id: 'T_INSTALL', deleted: false, is_restricted: false } })
      }
      throw new Error(`unexpected Slack request: ${url}`)
    })

    const result = await service(fetchImpl, { warn }).resolve([scope()], viewer('slack:T_INSTALL:U_MEMBER'))

    expect(result.degraded).toBe(false)
    expect(warn).not.toHaveBeenCalled()
  })

  // A deleted private channel — and a bot removed from one, which is the same
  // answer over the wire — is an everyday event. It denies, but it must not be
  // reported as "access checks unavailable": nothing is broken and no retry
  // changes the verdict.
  it.each(['channel_not_found', 'not_in_channel'] as const)(
    'denies without degrading when the conversation is gone (%s)',
    async (error) => {
      const resolver = service(async () => json({ ok: false, error }))
      await expect(resolver.resolve([scope()], viewer('slack:T_INSTALL:U_MEMBER'))).resolves.toEqual({
        allowedScopes: [],
        degraded: false
      })
    }
  )

  it('denies without degrading when the member list no longer contains the workspace user', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('conversations.info')) {
        return json({ ok: true, channel: { is_private: true, is_im: false, is_mpim: false } })
      }
      return json({ ok: false, error: 'user_not_found' })
    })
    await expect(service(fetchImpl).resolve([scope()], viewer('slack:T_INSTALL:U_GONE'))).resolves.toEqual({
      allowedScopes: [],
      degraded: false
    })
  })

  // The definitive verdict earns the deny TTL, so a dead conversation is not
  // re-asked on every page of every list.
  it('caches the gone verdict instead of re-asking Slack per request', async () => {
    const fetchImpl = vi.fn(async () => json({ ok: false, error: 'channel_not_found' }))
    const resolver = service(fetchImpl)
    await resolver.resolve([scope()], viewer('slack:T_INSTALL:U_MEMBER'))
    const afterFirst = fetchImpl.mock.calls.length
    await resolver.resolve([scope()], viewer('slack:T_INSTALL:U_MEMBER'))
    expect(fetchImpl.mock.calls.length).toBe(afterFirst)
  })

  it('still degrades when the check itself fails', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('conversations.info')) {
        return json({ ok: true, channel: { is_private: true, is_im: false, is_mpim: false } })
      }
      return json({ ok: false, error: 'missing_scope' })
    })
    await expect(service(fetchImpl).resolve([scope()], viewer('slack:T_INSTALL:U_MEMBER'))).resolves.toEqual({
      allowedScopes: [],
      degraded: true
    })
  })
})
