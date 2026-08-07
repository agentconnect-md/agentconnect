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
      degraded: false,
      accessIssues: []
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
      degraded: false,
      accessIssues: []
    })
    await expect(resolver.resolve([scope()], viewer('slack:T_INSTALL:U_OTHER_GUEST'))).resolves.toEqual({
      allowedScopes: [],
      degraded: false,
      accessIssues: []
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
        degraded: false,
        accessIssues: []
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
      degraded: false,
      accessIssues: []
    })
    await expect(resolver.resolve([scope()], viewer('slack:T_INSTALL:U_OTHER'))).resolves.toEqual({
      allowedScopes: [],
      degraded: false,
      accessIssues: []
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
      degraded: false,
      accessIssues: []
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
      degraded: false,
      accessIssues: []
    })
  })

  it('fails closed and reports degradation when Slack cannot answer', async () => {
    const resolver = service(async () => json({ ok: false, error: 'ratelimited' }))
    await expect(resolver.resolve([scope()], viewer('slack:T_INSTALL:U_MEMBER'))).resolves.toEqual({
      allowedScopes: [],
      degraded: true,
      // Rate limiting clears on its own: the console keeps the generic
      // "unavailable" copy rather than sending anyone to reauthorize an app.
      accessIssues: [{ provider: 'slack', reason: 'unavailable' }]
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
    expect(warn.mock.calls[0]?.[0]).toEqual({
      provider: 'slack',
      unknownScopes: 1,
      totalScopes: 1,
      reasons: { ratelimited: 1 }
    })
    // A scope key names a channel; the operator needs the rate, not the target.
    expect(JSON.stringify(warn.mock.calls[0]?.[0])).not.toContain('C_')
  })

  // Slack refuses over HTTP 200 with `ok: false`, so its code is the ONLY thing
  // that separates a missing OAuth scope from rate limiting from an outage —
  // and a rate with no cause cannot be acted on. Without this, diagnosing a
  // steady stream of degraded resolves means reaching for production traces.
  it('names the Slack error a degraded check failed on', async () => {
    const warn = vi.fn()
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes('conversations.info')
        ? json({ ok: true, channel: { is_private: true, is_im: false, is_mpim: false } })
        : json({ ok: false, error: 'missing_scope' })
    )

    const result = await service(fetchImpl, { warn }).resolve([scope()], viewer('slack:T_INSTALL:U_MEMBER'))

    // Unchanged: it still fails closed. Only the diagnosis is new.
    expect(result).toEqual({
      allowedScopes: [],
      degraded: true,
      accessIssues: [{ provider: 'slack', reason: 'app_authorization' }]
    })
    expect(warn.mock.calls[0]?.[0]).toEqual({
      provider: 'slack',
      unknownScopes: 1,
      totalScopes: 1,
      reasons: { missing_scope: 1 }
    })
  })

  // The gap this whole seam existed to close: the plugin knew the cause, the
  // DTO had a field for it, and nothing connected the two — so an app short of
  // a required scope reached the console as a bare `degraded` and got the
  // "checks unavailable" copy, which reads as an outage and never clears.
  it.each([
    'missing_scope',
    'invalid_auth',
    'account_inactive',
    'token_revoked',
    'token_expired',
    'no_permission'
  ] as const)('reports a short app grant as one the org can act on (%s)', async (error) => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes('conversations.info')
        ? json({ ok: true, channel: { is_private: true, is_im: false, is_mpim: false } })
        : json({ ok: false, error })
    )

    const result = await service(fetchImpl).resolve([scope()], viewer('slack:T_INSTALL:U_MEMBER'))

    expect(result.accessIssues).toEqual([{ provider: 'slack', reason: 'app_authorization' }])
  })

  // The other half of the same decision. Relabelling these would put a
  // "reauthorize your app" prompt in front of someone with nothing to fix.
  it.each(['ratelimited', 'service_unavailable', 'fatal_error', 'ekm_access_denied'] as const)(
    'leaves a transient failure on the generic copy (%s)',
    async (error) => {
      const resolver = service(async () => json({ ok: false, error }))

      const result = await resolver.resolve([scope()], viewer('slack:T_INSTALL:U_MEMBER'))

      expect(result.accessIssues).toEqual([{ provider: 'slack', reason: 'unavailable' }])
    }
  )

  // A failure on THIS side of the call says nothing about the app's grant.
  it('reports a transport failure as unavailable rather than an app problem', async () => {
    const resolver = service(async () => json({ ok: false, error: 'missing_scope' }, 500))

    const result = await resolver.resolve([scope()], viewer('slack:T_INSTALL:U_MEMBER'))

    expect(result.accessIssues).toEqual([{ provider: 'slack', reason: 'unavailable' }])
  })

  // `accessIssues` crosses to the browser, where the log discipline's rationale
  // — "the operator needs the rate, not the target" — is replaced by a stricter
  // one: a reason is a CAUSE, and a member has no business learning which
  // conversation, workspace or credential was behind one.
  it('carries no channel, workspace, viewer or credential into the issues', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes('conversations.info')
        ? json({ ok: true, channel: { is_private: true, is_im: false, is_mpim: false } })
        : json({ ok: false, error: 'missing_scope' })
    )

    const result = await service(fetchImpl).resolve([scope()], viewer('slack:T_INSTALL:U_MEMBER'))

    const serialized = JSON.stringify(result.accessIssues)
    for (const identifier of ['C_CHANNEL', 'T_INSTALL', 'U_MEMBER', scope().id, BOT_ID, 'xoxb']) {
      expect(serialized).not.toContain(identifier)
    }
  })

  // One issue per REMEDY, not per hidden scope: the console renders one banner
  // for each thing the reader could go and do, and 200 channels behind the same
  // short grant are one thing to do.
  it('collapses many hidden scopes into one issue per remedy', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('conversations.info')) {
        return json({ ok: true, channel: { is_private: true, is_im: false, is_mpim: false } })
      }
      return json({ ok: false, error: url.includes('C_CHANNEL_1') ? 'ratelimited' : 'missing_scope' })
    })
    const scopes = [scopeAt(1), scopeAt(2), scopeAt(3)]

    const result = await service(fetchImpl).resolve(scopes, viewer('slack:T_INSTALL:U_MEMBER'))

    expect(result.accessIssues).toEqual([
      { provider: 'slack', reason: 'unavailable' },
      { provider: 'slack', reason: 'app_authorization' }
    ])
  })

  it('aggregates a mixed batch by code, one reason per hidden scope', async () => {
    const warn = vi.fn()
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('C_CHANNEL_3')) {
        return json({ ok: true, channel: { is_private: false, is_im: false, is_mpim: false } })
      }
      if (url.includes('users.info')) return json({ ok: true, user: { team_id: 'T_INSTALL' } })
      return json({ ok: false, error: url.includes('C_CHANNEL_1') ? 'missing_scope' : 'ratelimited' })
    })
    const scopes = [scopeAt(1), scopeAt(2), scopeAt(3)]

    await service(fetchImpl, { warn }).resolve(scopes, viewer('slack:T_INSTALL:U_MEMBER'))

    const payload = warn.mock.calls[0]?.[0] as { unknownScopes: number; reasons: Record<string, number> }
    expect(payload).toEqual({
      provider: 'slack',
      unknownScopes: 2,
      totalScopes: 3,
      reasons: { missing_scope: 1, ratelimited: 1 }
    })
    // The counts partition the hidden scopes, so one code's share of an hour of
    // these lines is readable as a share of the sessions actually hidden.
    const counted = Object.values(payload.reasons).reduce((sum, count) => sum + count, 0)
    expect(counted).toBe(payload.unknownScopes)
  })

  it('reports a failure on this side of the call rather than a Slack code', async () => {
    const warn = vi.fn()
    // A body is present, but the status means it was never read.
    const resolver = service(async () => json({ ok: false, error: 'ratelimited' }, 500), { warn })

    await resolver.resolve([scope()], viewer('slack:T_INSTALL:U_MEMBER'))

    expect(warn.mock.calls[0]?.[0]).toMatchObject({ reasons: { http_500: 1 } })
  })

  // The reason is a CAUSE, never a TARGET. Slack's error vocabulary is
  // lowercase words and every Slack id is uppercase-prefixed, so anything
  // id-shaped arriving in `error` is reported as its shape and dropped —
  // a warn that names channels is the one thing this log must never become.
  it('drops an error payload outside Slack error vocabulary', async () => {
    const warn = vi.fn()
    const resolver = service(async () => json({ ok: false, error: 'C_PRIVATE_CHANNEL' }), { warn })

    await resolver.resolve([scope()], viewer('slack:T_INSTALL:U_MEMBER'))

    expect(warn.mock.calls[0]?.[0]).toMatchObject({ reasons: { unrecognized_error: 1 } })
    expect(JSON.stringify(warn.mock.calls[0]?.[0])).not.toContain('C_PRIVATE_CHANNEL')
  })

  it('carries no identifier of what was hidden, and no credential', async () => {
    const warn = vi.fn()
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes('conversations.info')
        ? json({ ok: true, channel: { is_private: true, is_im: false, is_mpim: false } })
        : json({ ok: false, error: 'missing_scope' })
    )

    await service(fetchImpl, { warn }).resolve([scope()], viewer('slack:T_INSTALL:U_MEMBER'))

    const logged = JSON.stringify(warn.mock.calls[0]?.[0])
    // Channel, workspace, viewer, scope row — and the bot token, which
    // `shouldIgnoreUndiciRequest` keeps out of telemetry for the same reason.
    for (const identifier of ['C_CHANNEL', 'T_INSTALL', 'U_MEMBER', scope().id, 'xoxb']) {
      expect(logged).not.toContain(identifier)
    }
  })

  // A resolve riding a cached `unknown` is the one that would otherwise report
  // a rate with no cause — the cache holds the reason, not just the verdict.
  it('still reports the cause when the verdict came from cache', async () => {
    const warn = vi.fn()
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes('conversations.info')
        ? json({ ok: true, channel: { is_private: true, is_im: false, is_mpim: false } })
        : json({ ok: false, error: 'missing_scope' })
    )
    const resolver = service(fetchImpl, { warn })

    await resolver.resolve([scope()], viewer('slack:T_INSTALL:U_MEMBER'))
    const afterFirst = fetchImpl.mock.calls.length
    await resolver.resolve([scope()], viewer('slack:T_INSTALL:U_MEMBER'))

    expect(fetchImpl.mock.calls.length).toBe(afterFirst)
    expect(warn).toHaveBeenCalledTimes(2)
    expect(warn.mock.calls[1]?.[0]).toEqual(warn.mock.calls[0]?.[0])
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
        degraded: false,
        accessIssues: []
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
      degraded: false,
      accessIssues: []
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
      degraded: true,
      accessIssues: [{ provider: 'slack', reason: 'app_authorization' }]
    })
  })

  it('reads a conversation audience once for every viewer that asks about it', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('conversations.info')) {
        return json({ ok: true, channel: { is_private: false, is_im: false, is_mpim: false } })
      }
      if (url.includes('users.info')) return json({ ok: true, user: { team_id: 'T_INSTALL' } })
      return json({ ok: false, error: 'unexpected' })
    })
    const resolver = service(fetchImpl)

    await resolver.resolve([scope()], viewer('slack:T_INSTALL:U_ONE'))
    await resolver.resolve([scope()], viewer('slack:T_INSTALL:U_TWO'))

    // Whether the channel is public is not a question about the viewer, so the
    // second one rides the first one's answer — only `users.info`, which IS per
    // person, is asked again.
    const info = fetchImpl.mock.calls.filter(([url]) => String(url).includes('conversations.info'))
    const users = fetchImpl.mock.calls.filter(([url]) => String(url).includes('users.info'))
    expect(info).toHaveLength(1)
    expect(users).toHaveLength(2)
  })

  it('keeps an unanswerable audience a per-request verdict rather than caching it', async () => {
    let attempt = 0
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('conversations.info')) {
        attempt += 1
        // A blip, then a real answer — the blip must not pin the channel.
        return attempt === 1
          ? json({ ok: false, error: 'ratelimited' })
          : json({ ok: true, channel: { is_private: false, is_im: false, is_mpim: false } })
      }
      if (url.includes('users.info')) return json({ ok: true, user: { team_id: 'T_INSTALL' } })
      return json({ ok: false, error: 'unexpected' })
    })
    const resolver = service(fetchImpl)

    await expect(resolver.resolve([scope()], viewer('slack:T_INSTALL:U_ONE'))).resolves.toMatchObject({
      allowedScopes: [],
      degraded: true
    })
    await expect(resolver.resolve([scope()], viewer('slack:T_INSTALL:U_TWO'))).resolves.toMatchObject({
      degraded: false
    })
    expect(attempt).toBe(2)
  })
})
