import { createServer } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { FakeClock } from '../../../test/fakes/fake-clock.js'
import { BotId, OrgId } from '../../domain/ids.js'
import type { SessionAccessViewer } from '../../http/session-access-plugin.js'
import type { BotRecord, ExternalScopeRecord } from '../../persistence/ports.js'
import { mattermostExternalAppId } from './server-url.js'
import { MattermostSessionAccessService, resolveMattermostOauthRealmKey } from './session-access.js'

const ORG = OrgId('org-1')
const SERVER = 'https://chat.example.com/team'
const REALM = mattermostExternalAppId(SERVER)
const OTHER_REALM = mattermostExternalAppId('https://other-mm.example.com')
const CHANNEL = 'mmchan1234567890abcdefghij'
const TEAM = 'mmteam1234567890abcdefghij'
const MM_USER = 'mmuser1234567890abcdefghij'

function makeBot(overrides: Partial<BotRecord> = {}): BotRecord {
  return {
    id: BotId('bot-mm-1'),
    orgId: ORG,
    platform: 'mattermost',
    name: 'mm-bot',
    externalAppId: REALM,
    externalTenantId: 'mmbot00000000000abcdefghij',
    revokedAt: null,
    credentialRevision: 1,
    platformConfig: { serverUrl: SERVER, botUserId: 'mmbot00000000000abcdefghij', botUsername: 'mm-bot' },
    ...overrides
  } as BotRecord
}

function makeScope(overrides: Partial<ExternalScopeRecord> = {}): ExternalScopeRecord {
  return {
    id: 'scope-mm-1',
    orgId: ORG,
    provider: 'mattermost',
    realmKey: REALM,
    resourceKind: 'conversation',
    resourceKey: CHANNEL,
    credentialKind: 'bot',
    credentialId: 'bot-mm-1',
    revokedAt: null,
    aclRevision: 1n,
    ...overrides
  }
}

function makeViewer(overrides: Partial<SessionAccessViewer> = {}): SessionAccessViewer {
  return {
    orgId: ORG,
    userId: 'user-1',
    request: { oidcSubject: 'sub-1', log: {} as never },
    identitySet: new Set<string>(),
    ...overrides
  }
}

describe('resolveMattermostOauthRealmKey', () => {
  it('normalizes MATTERMOST_OAUTH_SERVER_URL, honors deployment config, and rejects link-local URLs', () => {
    expect(resolveMattermostOauthRealmKey({ MATTERMOST_OAUTH_SERVER_URL: 'http://192.168.1.25:8065/mm/' })).toBe(
      mattermostExternalAppId('http://192.168.1.25:8065/mm')
    )
    expect(resolveMattermostOauthRealmKey({ MATTERMOST_OAUTH_SERVER_URL: SERVER }, null)).toBeUndefined()
    expect(
      resolveMattermostOauthRealmKey({ MATTERMOST_OAUTH_SERVER_URL: 'https://stale.example.com' }, `${SERVER}/`)
    ).toBe(REALM)
    expect(() => resolveMattermostOauthRealmKey({ MATTERMOST_OAUTH_SERVER_URL: 'http://169.254.169.254/' })).toThrow(
      /not allowed/
    )
  })
})

describe('MattermostSessionAccessService', () => {
  it('reports availability only when both identity and mattermostOauthRealmKey are configured', () => {
    const base = {
      bots: { getUnscoped: vi.fn(async () => null), listForOrg: vi.fn(async () => []) },
      botSecrets: { get: vi.fn(async () => null) },
      clock: new FakeClock(0)
    }
    expect(new MattermostSessionAccessService({ ...base, mattermostOauthRealmKey: REALM }).available).toBe(false)
    expect(
      new MattermostSessionAccessService({ ...base, identity: { chatIdentitiesFor: async () => [] } }).available
    ).toBe(false)
    expect(
      new MattermostSessionAccessService({
        ...base,
        mattermostOauthRealmKey: REALM,
        identity: { chatIdentitiesFor: async () => [] }
      }).available
    ).toBe(true)
  })

  function setup(
    respond: (path: string, auth: string) => Response,
    opts: { bot?: BotRecord; clock?: FakeClock; realmKey?: string } = {}
  ) {
    const bot = opts.bot ?? makeBot()
    const clock = opts.clock ?? new FakeClock(1_800_000_000_000)
    const calls: string[] = []
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      calls.push(url.pathname + url.search)
      const headers = init?.headers as Record<string, string> | undefined
      return respond(url.pathname + url.search, headers?.Authorization ?? '')
    })
    const service = new MattermostSessionAccessService({
      bots: { getUnscoped: async (id) => (id === bot.id ? bot : null), listForOrg: async () => [bot] },
      botSecrets: { get: async () => ({ botToken: 'mm-bot-tok', appToken: null, signingSecret: null }) },
      clock,
      mattermostOauthRealmKey: opts.realmKey ?? REALM,
      fetchImpl: fetchImpl as never,
      identity: {
        chatIdentitiesFor: async () => [{ platform: 'mattermost', tenant: opts.realmKey ?? REALM, memberId: MM_USER }]
      }
    })
    return { bot, clock, calls, service }
  }

  it('admits channel members directly with a non-System-Admin bot token', async () => {
    const { calls, service } = setup((path, auth) => {
      expect(auth).toBe('Bearer mm-bot-tok')
      if (path === `/team/api/v4/channels/${CHANNEL}/members/${MM_USER}`) {
        return Response.json({ channel_id: CHANNEL, user_id: MM_USER })
      }
      if (path === `/team/api/v4/users/${MM_USER}`) {
        return Response.json({ id: MM_USER, delete_at: 0, roles: 'system_user' })
      }
      return new Response('unexpected', { status: 500 })
    })
    const viewer = makeViewer()
    await service.addViewerIdentities(viewer)
    expect(viewer.identitySet.has(`mattermost:${REALM}:${MM_USER}`)).toBe(true)

    const res = await service.resolve([makeScope()], viewer)
    expect(res).toEqual({
      allowedScopes: [{ id: 'scope-mm-1', aclRevision: 1n }],
      degraded: false,
      accessIssues: []
    })
    expect(calls).toEqual([`/team/api/v4/channels/${CHANNEL}/members/${MM_USER}`, `/team/api/v4/users/${MM_USER}`])
  })

  it('falls back to public channel + active team membership on 404, and rejects private/DM/deleted channels', async () => {
    let channelType = 'O'
    let channelDeleteAt = 0
    let teamDeleteAt = 0
    const channelMemberStatus = 404
    const clock = new FakeClock(1_800_000_000_000)
    const { service } = setup(
      (path) => {
        if (path === `/team/api/v4/channels/${CHANNEL}/members/${MM_USER}`) {
          return new Response('{}', { status: channelMemberStatus })
        }
        if (path === `/team/api/v4/users/${MM_USER}`) {
          return Response.json({ id: MM_USER, delete_at: 0, roles: 'system_user' })
        }
        if (path === `/team/api/v4/channels/${CHANNEL}`) {
          return Response.json({ id: CHANNEL, type: channelType, delete_at: channelDeleteAt, team_id: TEAM })
        }
        if (path === `/team/api/v4/teams/${TEAM}/members/${MM_USER}`) {
          return Response.json({ team_id: TEAM, user_id: MM_USER, delete_at: teamDeleteAt })
        }
        return new Response('{}', { status: 404 })
      },
      { clock }
    )

    const viewer = makeViewer()
    await service.addViewerIdentities(viewer)

    expect((await service.resolve([makeScope()], viewer)).allowedScopes).toEqual([
      { id: 'scope-mm-1', aclRevision: 1n }
    ])

    let rev = 2n
    for (const mutate of [
      () => {
        channelType = 'P'
      },
      () => {
        channelType = 'D'
      },
      () => {
        channelType = 'G'
      },
      () => {
        channelType = 'O'
        channelDeleteAt = 1700000000
      },
      () => {
        clock.advance(120_001)
        channelDeleteAt = 0
        teamDeleteAt = 1700000000
      }
    ]) {
      channelType = 'O'
      channelDeleteAt = 0
      teamDeleteAt = 0
      mutate()
      const denied = await service.resolve([makeScope({ aclRevision: rev++ })], viewer)
      expect(denied).toEqual({ allowedScopes: [], degraded: false, accessIssues: [] })
    }
  })

  it('never lets a Mattermost identity from one server authorize a scope from a different Mattermost server', async () => {
    const calls: string[] = []
    const botA = makeBot({
      id: BotId('bot-a'),
      externalAppId: REALM,
      platformConfig: { serverUrl: SERVER, botUserId: 'b1', botUsername: 'b1' }
    })
    const botB = makeBot({
      id: BotId('bot-b'),
      externalAppId: OTHER_REALM,
      platformConfig: { serverUrl: 'https://other-mm.example.com', botUserId: 'b2', botUsername: 'b2' }
    })
    const service = new MattermostSessionAccessService({
      bots: {
        getUnscoped: async (id) => (id === 'bot-a' ? botA : id === 'bot-b' ? botB : null),
        listForOrg: async () => [botA, botB]
      },
      botSecrets: { get: async () => ({ botToken: 'tok', appToken: null, signingSecret: null }) },
      clock: new FakeClock(0),
      mattermostOauthRealmKey: REALM,
      fetchImpl: async (url: string) => {
        calls.push(url)
        return Response.json({ channel_id: CHANNEL, user_id: MM_USER })
      },
      identity: {
        chatIdentitiesFor: async () => [{ platform: 'mattermost', tenant: REALM, memberId: MM_USER }]
      }
    })

    const viewer = makeViewer()
    await service.addViewerIdentities(viewer)
    const res = await service.resolve([makeScope({ realmKey: OTHER_REALM, credentialId: 'bot-b' })], viewer)
    expect(res).toEqual({
      allowedScopes: [],
      degraded: true,
      accessIssues: [{ provider: 'mattermost', reason: 'authorization' }]
    })
    expect(calls).toEqual([])
  })

  it('surfaces app_authorization on 401/403 and unavailable on 5xx/redirect/invalid JSON, with decision TTLs', async () => {
    let status = 403
    let body: unknown = { message: 'Forbidden' }
    const clock = new FakeClock(1000)
    const { calls, service } = setup(
      () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }),
      { clock }
    )
    const viewer = makeViewer()
    await service.addViewerIdentities(viewer)

    expect(await service.resolve([makeScope()], viewer)).toEqual({
      allowedScopes: [],
      degraded: true,
      accessIssues: [{ provider: 'mattermost', reason: 'app_authorization' }]
    })
    expect(await service.resolve([makeScope()], viewer)).toMatchObject({ degraded: true })
    expect(calls).toHaveLength(1)

    clock.advance(5_001)
    status = 502
    expect(await service.resolve([makeScope()], viewer)).toEqual({
      allowedScopes: [],
      degraded: true,
      accessIssues: [{ provider: 'mattermost', reason: 'unavailable' }]
    })

    clock.advance(5_001)
    status = 302
    expect(await service.resolve([makeScope()], viewer)).toEqual({
      allowedScopes: [],
      degraded: true,
      accessIssues: [{ provider: 'mattermost', reason: 'unavailable' }]
    })

    clock.advance(5_001)
    status = 200
    body = 'not json'
    expect(await service.resolve([makeScope()], viewer)).toEqual({
      allowedScopes: [],
      degraded: true,
      accessIssues: [{ provider: 'mattermost', reason: 'unavailable' }]
    })
  })

  it('denies non-member team users for Group DM (G) and deleted public channels, while admitting explicit Group DM members', async () => {
    const gmMemberSet = new Set<string>([MM_USER])
    let gmChannelType: 'G' | 'O' = 'G'
    let gmDeleteAt = 0
    const { service } = setup((path) => {
      if (path === `/team/api/v4/channels/${CHANNEL}/members/${MM_USER}`) {
        return gmMemberSet.has(MM_USER)
          ? Response.json({ channel_id: CHANNEL, user_id: MM_USER })
          : new Response('{}', { status: 404 })
      }
      if (path === `/team/api/v4/users/${MM_USER}`) {
        return Response.json({ id: MM_USER, delete_at: 0, roles: 'system_user' })
      }
      if (path === `/team/api/v4/channels/${CHANNEL}`) {
        return Response.json({ id: CHANNEL, type: gmChannelType, delete_at: gmDeleteAt, team_id: TEAM })
      }
      if (path === `/team/api/v4/teams/${TEAM}/members/${MM_USER}`) {
        return Response.json({ team_id: TEAM, user_id: MM_USER, delete_at: 0 })
      }
      return new Response('{}', { status: 404 })
    })

    const viewer = makeViewer()
    await service.addViewerIdentities(viewer)

    // Explicit Group DM (G) member is admitted.
    expect((await service.resolve([makeScope()], viewer)).allowedScopes).toEqual([
      { id: 'scope-mm-1', aclRevision: 1n }
    ])

    // Removing the user from the Group DM denies them even though they remain an active team member.
    gmMemberSet.clear()
    expect((await service.resolve([makeScope({ aclRevision: 2n })], viewer)).allowedScopes).toEqual([])

    // Deleted public channel (O with delete_at > 0) is also denied for team members.
    gmChannelType = 'O'
    gmDeleteAt = 1_750_000_000
    expect((await service.resolve([makeScope({ aclRevision: 3n })], viewer)).allowedScopes).toEqual([])
  })

  it('uses guardedRequest in production (allows loopback Mattermost server and blocks link-local URLs)', async () => {
    const server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json')
      if (req.url === `/api/v4/channels/${CHANNEL}/members/${MM_USER}`) {
        res.end(JSON.stringify({ channel_id: CHANNEL, user_id: MM_USER }))
        return
      }
      if (req.url === `/api/v4/users/${MM_USER}`) {
        res.end(JSON.stringify({ id: MM_USER, delete_at: 0, roles: 'system_user' }))
        return
      }
      res.statusCode = 404
      res.end('{}')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const port = (server.address() as { port: number }).port
      const localUrl = `http://127.0.0.1:${port}`
      const realm = mattermostExternalAppId(localUrl)
      const bot = makeBot({
        externalAppId: realm,
        platformConfig: { serverUrl: localUrl, botUserId: 'bot1', botUsername: 'bot1' }
      })
      const service = new MattermostSessionAccessService({
        bots: { getUnscoped: async () => bot, listForOrg: async () => [bot] },
        botSecrets: { get: async () => ({ botToken: 'loopback-tok', appToken: null, signingSecret: null }) },
        clock: new FakeClock(0),
        allowPrivateNetwork: true,
        mattermostOauthRealmKey: realm,
        identity: {
          chatIdentitiesFor: async () => [{ platform: 'mattermost', tenant: realm, memberId: MM_USER }]
        }
      })
      const viewer = makeViewer()
      await service.addViewerIdentities(viewer)
      const res = await service.resolve([makeScope({ realmKey: realm })], viewer)
      expect(res.allowedScopes).toEqual([{ id: 'scope-mm-1', aclRevision: 1n }])

      // By default (allowPrivateNetwork unset/false), loopback requires an explicit allowlist entry.
      const defaultBlockedService = new MattermostSessionAccessService({
        bots: { getUnscoped: async () => bot, listForOrg: async () => [bot] },
        botSecrets: { get: async () => ({ botToken: 'loopback-tok', appToken: null, signingSecret: null }) },
        clock: new FakeClock(0),
        mattermostOauthRealmKey: realm,
        identity: {
          chatIdentitiesFor: async () => [{ platform: 'mattermost', tenant: realm, memberId: MM_USER }]
        }
      })
      const blockedViewer = makeViewer()
      await defaultBlockedService.addViewerIdentities(blockedViewer)
      const defaultBlockedRes = await defaultBlockedService.resolve([makeScope({ realmKey: realm })], blockedViewer)
      expect(defaultBlockedRes.allowedScopes).toEqual([])

      const allowlistedService = new MattermostSessionAccessService({
        bots: { getUnscoped: async () => bot, listForOrg: async () => [bot] },
        botSecrets: { get: async () => ({ botToken: 'loopback-tok', appToken: null, signingSecret: null }) },
        clock: new FakeClock(0),
        allowlist: new Set(['127.0.0.1']),
        mattermostOauthRealmKey: realm,
        identity: {
          chatIdentitiesFor: async () => [{ platform: 'mattermost', tenant: realm, memberId: MM_USER }]
        }
      })
      const allowlistedViewer = makeViewer()
      await allowlistedService.addViewerIdentities(allowlistedViewer)
      const allowlistedRes = await allowlistedService.resolve([makeScope({ realmKey: realm })], allowlistedViewer)
      expect(allowlistedRes.allowedScopes).toEqual([{ id: 'scope-mm-1', aclRevision: 1n }])
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }

    const blockedUrl = 'http://169.254.169.254'
    const blockedRealm = mattermostExternalAppId(blockedUrl)
    const blockedBot = makeBot({
      externalAppId: blockedRealm,
      platformConfig: { serverUrl: blockedUrl, botUserId: 'bot1', botUsername: 'bot1' }
    })
    const blockedService = new MattermostSessionAccessService({
      bots: { getUnscoped: async () => blockedBot, listForOrg: async () => [blockedBot] },
      botSecrets: { get: async () => ({ botToken: 'tok', appToken: null, signingSecret: null }) },
      clock: new FakeClock(0),
      mattermostOauthRealmKey: blockedRealm,
      identity: {
        chatIdentitiesFor: async () => [{ platform: 'mattermost', tenant: blockedRealm, memberId: MM_USER }]
      }
    })
    const blockedViewer = makeViewer()
    await blockedService.addViewerIdentities(blockedViewer)
    const blockedRes = await blockedService.resolve([makeScope({ realmKey: blockedRealm })], blockedViewer)
    expect(blockedRes.allowedScopes).toEqual([])
  })

  it('denies deactivated Mattermost users even with explicit channel membership and denies guests on open-channel fallback', async () => {
    let channelMember = true
    let userDeleteAt = 0
    let userRoles = 'system_user'
    let teamSchemeGuest = false
    let teamRoles = 'team_user'
    const clock = new FakeClock(2_000_000_000_000)

    const { service } = setup(
      (path) => {
        if (path === `/team/api/v4/channels/${CHANNEL}/members/${MM_USER}`) {
          return channelMember
            ? Response.json({ channel_id: CHANNEL, user_id: MM_USER })
            : new Response('{}', { status: 404 })
        }
        if (path === `/team/api/v4/users/${MM_USER}`) {
          return Response.json({ id: MM_USER, delete_at: userDeleteAt, roles: userRoles })
        }
        if (path === `/team/api/v4/channels/${CHANNEL}`) {
          return Response.json({ id: CHANNEL, type: 'O', delete_at: 0, team_id: TEAM })
        }
        if (path === `/team/api/v4/teams/${TEAM}/members/${MM_USER}`) {
          return Response.json({
            team_id: TEAM,
            user_id: MM_USER,
            delete_at: 0,
            scheme_guest: teamSchemeGuest,
            roles: teamRoles
          })
        }
        return new Response('{}', { status: 404 })
      },
      { clock }
    )
    const viewer = makeViewer()
    await service.addViewerIdentities(viewer)

    // Deactivated user (delete_at > 0) is rejected despite explicit channel membership.
    userDeleteAt = 1_750_000_000
    expect((await service.resolve([makeScope({ aclRevision: 10n })], viewer)).allowedScopes).toEqual([])

    // Once active, fall back to open channel; system_guest or scheme_guest / team_guest is denied.
    clock.advance(120_001)
    channelMember = false
    userDeleteAt = 0
    userRoles = 'system_guest'
    expect((await service.resolve([makeScope({ aclRevision: 11n })], viewer)).allowedScopes).toEqual([])

    clock.advance(120_001)
    userRoles = 'system_user'
    teamSchemeGuest = true
    expect((await service.resolve([makeScope({ aclRevision: 12n })], viewer)).allowedScopes).toEqual([])

    clock.advance(120_001)
    teamSchemeGuest = false
    teamRoles = 'team_guest'
    expect((await service.resolve([makeScope({ aclRevision: 13n })], viewer)).allowedScopes).toEqual([])

    // Non-guest active team member is admitted.
    clock.advance(120_001)
    teamRoles = 'team_user'
    expect((await service.resolve([makeScope({ aclRevision: 14n })], viewer)).allowedScopes).toEqual([
      { id: 'scope-mm-1', aclRevision: 14n }
    ])
  })

  it('decouples per-lookup timeouts from caller batch signals, caches team memberships, and memoizes bot/secret lookups per batch', async () => {
    const bot = makeBot()
    const getUnscoped = vi.fn(async () => bot)
    const getSecret = vi.fn(async () => ({ botToken: 'mm-bot-tok', appToken: null, signingSecret: null }))
    const calls: string[] = []
    let releaseMemberFetch!: () => void
    const memberFetchGate = new Promise<void>((resolve) => {
      releaseMemberFetch = resolve
    })
    const secondChannel = 'mmchan2234567890abcdefghij'

    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname
      calls.push(path)
      if (path === `/team/api/v4/channels/${CHANNEL}/members/${MM_USER}`) {
        await memberFetchGate
        expect(init?.signal?.aborted).toBe(false)
        return new Response('{}', { status: 404 })
      }
      if (path === `/team/api/v4/channels/${secondChannel}/members/${MM_USER}`) {
        return new Response('{}', { status: 404 })
      }
      if (path === `/team/api/v4/channels/${CHANNEL}` || path === `/team/api/v4/channels/${secondChannel}`) {
        const id = path.split('/').pop()!
        return Response.json({ id, type: 'O', delete_at: 0, team_id: TEAM })
      }
      if (path === `/team/api/v4/users/${MM_USER}`) {
        return Response.json({ id: MM_USER, delete_at: 0, roles: 'system_user' })
      }
      if (path === `/team/api/v4/teams/${TEAM}/members/${MM_USER}`) {
        return Response.json({ team_id: TEAM, user_id: MM_USER, delete_at: 0 })
      }
      return new Response('{}', { status: 404 })
    })

    const service = new MattermostSessionAccessService({
      bots: { getUnscoped, listForOrg: async () => [bot] },
      botSecrets: { get: getSecret },
      clock: new FakeClock(3_000_000_000_000),
      mattermostOauthRealmKey: REALM,
      fetchImpl: fetchImpl as never,
      identity: { chatIdentitiesFor: async () => [{ platform: 'mattermost', tenant: REALM, memberId: MM_USER }] }
    })

    const viewer = makeViewer()
    await service.addViewerIdentities(viewer)

    // Caller A expires its batch signal while LRUCache#fetch is in flight; Caller B must still get the valid answer
    // and the underlying cached decision must NOT be poisoned with a timeout verdict.
    const callerAController = new AbortController()
    const scope1 = makeScope({ id: 'scope-mm-1', resourceKey: CHANNEL })
    const scope2 = makeScope({ id: 'scope-mm-2', resourceKey: secondChannel })
    const pA = service.resolve([scope1], viewer, callerAController.signal)
    const pB = service.resolve([scope1, scope2], viewer)

    await new Promise((r) => setTimeout(r, 15))
    callerAController.abort()
    const resA = await pA
    expect(resA).toEqual({
      allowedScopes: [],
      degraded: true,
      accessIssues: [{ provider: 'mattermost', reason: 'unavailable' }]
    })

    releaseMemberFetch()
    const resB = await pB
    expect(resB.degraded).toBe(false)
    expect(resB.accessIssues).toEqual([])
    expect([...resB.allowedScopes].sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: 'scope-mm-1', aclRevision: 1n },
      { id: 'scope-mm-2', aclRevision: 1n }
    ])

    // Team membership for TEAM + user state were cached across both public channels in the batch.
    expect(calls.filter((p) => p === `/team/api/v4/teams/${TEAM}/members/${MM_USER}`)).toHaveLength(1)
    expect(calls.filter((p) => p === `/team/api/v4/users/${MM_USER}`)).toHaveLength(1)
    // Bot + secret lookups were memoized across scopes per batch (2 calls for pA + 1 for pB, or coalesced).
    expect(getUnscoped.mock.calls.length).toBeLessThanOrEqual(2)
    expect(getSecret.mock.calls.length).toBeLessThanOrEqual(2)

    // Subsequent resolve hits cached decisions without touching botSecrets or HTTP again.
    const callsBefore = calls.length
    const secretsBefore = getSecret.mock.calls.length
    const resC = await service.resolve([scope1, scope2], viewer)
    expect(resC.allowedScopes).toHaveLength(2)
    expect(calls).toHaveLength(callsBefore)
    expect(getSecret).toHaveBeenCalledTimes(secretsBefore)
  })
})
