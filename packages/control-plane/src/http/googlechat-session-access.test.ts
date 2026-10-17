import { describe, expect, it, vi } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { FakeClock } from '../../test/fakes/fake-clock.js'
import { classifySession } from '../domain/session-visibility.js'
import { BotId, OrgId } from '../domain/ids.js'
import type { BotRecord, ExternalScopeRecord } from '../persistence/ports.js'
import type { SessionAccessViewer } from './session-access-plugin.js'
import { GoogleChatSessionAccessService } from './googlechat-session-access.js'

const PROJECT = '123456789012'
const OTHER_PROJECT = '210987654321'
const ACCOUNT = '100000000000000000001'

function bots(): BotRecord[] {
  return [
    { platform: 'googlechat', externalAppId: PROJECT, revokedAt: null },
    { platform: 'googlechat', externalAppId: PROJECT, revokedAt: null },
    { platform: 'googlechat', externalAppId: OTHER_PROJECT, revokedAt: new Date(0) },
    { platform: 'googlechat', externalAppId: null, revokedAt: null },
    { platform: 'slack', externalAppId: 'A0SLACK', revokedAt: null }
  ] as BotRecord[]
}

function viewer(oidcSubject: string | null = 'logto-sub'): SessionAccessViewer {
  return {
    request: (oidcSubject ? { oidcSubject } : {}) as never,
    orgId: OrgId('org-1'),
    userId: 'user-1',
    identitySet: new Set(['user:user-1'])
  }
}

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const key = JSON.stringify({
  type: 'service_account',
  project_id: 'example-project',
  client_email: 'chat-bot@example-project.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' })
})

function setup(
  opts: {
    reported?: () => Promise<string | null>
    recorded?: string | null
    bots?: BotRecord[]
    response?: () => Response
  } = {}
) {
  const googleAccountIdFor = vi.fn(opts.reported ?? (async () => ACCOUNT))
  const setGoogleAccountId = vi.fn(async () => {})
  const listForOrg = vi.fn(async () => opts.bots ?? bots())
  const clock = new FakeClock(Date.UTC(2026, 0, 1))
  const bot = {
    id: BotId('b0b0b0b0-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
    orgId: OrgId('org-1'),
    platform: 'googlechat',
    externalAppId: PROJECT,
    revokedAt: null,
    credentialRevision: 1
  } as BotRecord
  const fetchImpl = vi.fn(async (url: string | URL | Request) =>
    String(url).endsWith('/token')
      ? Response.json({ access_token: 'synthetic-token' })
      : (opts.response?.() ??
        Response.json({
          name: `spaces/AAAAAAAAAAA/members/${ACCOUNT}`,
          state: 'JOINED',
          member: { name: `users/${ACCOUNT}`, type: 'HUMAN' }
        }))
  )
  const service = new GoogleChatSessionAccessService(
    {
      bots: { listForOrg, getUnscoped: async () => bot },
      botSecrets: { get: async () => ({ botToken: key, appToken: null, signingSecret: null }) },
      clock,
      configured: true,
      users: { getGoogleAccountId: async () => opts.recorded ?? null, setGoogleAccountId },
      identity: { googleAccountIdFor, chatIdentitiesFor: async () => [] }
    },
    fetchImpl
  )
  return { service, googleAccountIdFor, setGoogleAccountId, listForOrg, clock, bot, fetchImpl }
}

/** The owner the ingest path records for a DM this account sent through this app. */
function dmOwner(project: string, account: string): string | null {
  const classified = classifySession({
    platform: 'googlechat',
    conversationKind: 'dm',
    transportScope: project,
    triggeredBy: `users/${account}`
  })
  return classified.inherit ? null : classified.ownerIdentity
}

describe('GoogleChatSessionAccessService', () => {
  it('adds the owner that a DM from this Google account records, under every Chat app of the org', async () => {
    const { service, googleAccountIdFor } = setup()
    const current = viewer()

    await service.addViewerIdentities(current)

    expect(current.identitySet).toEqual(
      new Set([
        'user:user-1',
        `googlechat:global:users/${ACCOUNT}`,
        dmOwner(PROJECT, ACCOUNT),
        dmOwner(OTHER_PROJECT, ACCOUNT)
      ])
    )
    // Served under the identity lease, never a fresh identity provider read.
    expect(googleAccountIdFor).toHaveBeenCalledWith('logto-sub', undefined)
  })

  it('does not match a DM sent by a different Google account', async () => {
    const { service } = setup({ reported: async () => '100000000000000000002' })
    const current = viewer()

    await service.addViewerIdentities(current)

    expect(current.identitySet.has(dmOwner(PROJECT, ACCOUNT)!)).toBe(false)
  })

  it('adds nothing for a viewer without a Google identity and clears a stale recorded id', async () => {
    const { service, setGoogleAccountId } = setup({ reported: async () => null, recorded: ACCOUNT })
    const current = viewer()

    await service.addViewerIdentities(current)

    expect(current.identitySet).toEqual(new Set(['user:user-1']))
    expect(setGoogleAccountId).toHaveBeenCalledWith('user-1', null)
  })

  it('fails closed on an identity provider failure and caches nothing', async () => {
    const reported = vi
      .fn<() => Promise<string | null>>()
      .mockRejectedValueOnce(new Error('logto user lookup failed: 503'))
      .mockResolvedValueOnce(ACCOUNT)
    const { service, setGoogleAccountId } = setup({ reported, recorded: ACCOUNT })
    const failed = viewer()

    await expect(service.addViewerIdentities(failed)).rejects.toThrow('503')
    expect(failed.identitySet).toEqual(new Set(['user:user-1']))
    expect(setGoogleAccountId).not.toHaveBeenCalled()

    const retried = viewer()
    await service.addViewerIdentities(retried)
    expect(retried.identitySet.has(dmOwner(PROJECT, ACCOUNT)!)).toBe(true)
    expect(reported).toHaveBeenCalledTimes(2)
  })

  it('asks the identity provider nothing for a caller without a verified subject or an org without Chat apps', async () => {
    const unverified = setup()
    await unverified.service.addViewerIdentities(viewer(null))
    expect(unverified.listForOrg).not.toHaveBeenCalled()
    expect(unverified.googleAccountIdFor).not.toHaveBeenCalled()

    const noChat = setup({ bots: [{ platform: 'slack', externalAppId: 'A0SLACK', revokedAt: null } as BotRecord] })
    const current = viewer()
    await noChat.service.addViewerIdentities(current)
    expect(noChat.googleAccountIdFor).not.toHaveBeenCalled()
    expect(current.identitySet).toEqual(new Set(['user:user-1']))
  })

  it('is available only with an identity provider client', async () => {
    expect(setup().service.available).toBe(true)
    const listForOrg = vi.fn(async () => bots())
    const without = new GoogleChatSessionAccessService({
      bots: { listForOrg, getUnscoped: async () => null },
      botSecrets: { get: async () => null },
      clock: new FakeClock(),
      configured: true,
      users: { getGoogleAccountId: async () => ACCOUNT, setGoogleAccountId: async () => {} }
    })
    const current = viewer()

    await without.addViewerIdentities(current)

    expect(without.available).toBe(false)
    expect(listForOrg).not.toHaveBeenCalled()
    expect(current.identitySet).toEqual(new Set(['user:user-1']))
  })

  const space: ExternalScopeRecord = {
    id: '11111111-1111-4111-8111-111111111111',
    orgId: OrgId('org-1'),
    provider: 'googlechat',
    realmKey: PROJECT,
    resourceKind: 'conversation',
    resourceKey: 'spaces/AAAAAAAAAAA',
    credentialKind: 'bot',
    credentialId: 'b0b0b0b0-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    aclRevision: 1n,
    revokedAt: null
  }

  it('uses the app credential to admit a linked current Space member', async () => {
    const { service: plugin, fetchImpl } = setup()
    const current = viewer()
    await plugin.addViewerIdentities!(current)

    await expect(plugin.resolve([space], current)).resolves.toEqual({
      allowedScopes: [{ id: space.id, aclRevision: 1n }],
      degraded: false,
      accessIssues: []
    })
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      'https://oauth2.googleapis.com/token',
      `https://chat.googleapis.com/v1/spaces/AAAAAAAAAAA/members/${ACCOUNT}`
    ])
  })

  it.each([
    [404, {}, false, undefined],
    [200, { state: 'INVITED' }, false, undefined],
    [200, { state: 'NOT_A_MEMBER' }, false, undefined],
    [200, { state: 'STATE_UNSPECIFIED' }, true, 'unavailable'],
    [200, { member: { name: 'users/999', type: 'HUMAN' } }, true, 'unavailable'],
    [200, { name: 'spaces/OTHER/members/123' }, true, 'unavailable'],
    [200, { member: { name: `users/${ACCOUNT}`, type: 'BOT' } }, true, 'unavailable'],
    [403, {}, true, 'app_authorization'],
    [503, {}, true, 'unavailable']
  ] as const)('refuses HTTP %s membership %j', async (status, overrides, degraded, reason) => {
    const { service } = setup({
      response: () =>
        Response.json(
          {
            name: `spaces/AAAAAAAAAAA/members/${ACCOUNT}`,
            state: 'JOINED',
            member: { name: `users/${ACCOUNT}`, type: 'HUMAN' },
            ...overrides
          },
          { status }
        )
    })
    const current = viewer()
    await service.addViewerIdentities(current)
    expect(await service.resolve([space], current)).toEqual({
      allowedScopes: [],
      degraded,
      accessIssues: reason ? [{ provider: 'googlechat', reason }] : []
    })
  })

  it('invalidates membership on expiry, key rotation and unlink, and fences other apps and organizations', async () => {
    let response = () =>
      Response.json({
        name: `spaces/AAAAAAAAAAA/members/${ACCOUNT}`,
        state: 'JOINED',
        member: { name: `users/${ACCOUNT}`, type: 'HUMAN' }
      })
    const f = setup({ response: () => response() })
    const current = viewer()
    await f.service.addViewerIdentities(current)
    const resolve = () => f.service.resolve([space], current)
    expect((await resolve()).allowedScopes).toHaveLength(1)
    response = () => new Response(null, { status: 404 })
    expect((await resolve()).allowedScopes).toHaveLength(1)
    f.clock.advance(120_001)
    expect((await resolve()).allowedScopes).toHaveLength(0)
    response = () =>
      Response.json({
        name: `spaces/AAAAAAAAAAA/members/${ACCOUNT}`,
        state: 'JOINED',
        member: { name: `users/${ACCOUNT}`, type: 'HUMAN' }
      })
    f.bot.credentialRevision++
    expect((await resolve()).allowedScopes).toHaveLength(1)
    f.bot.externalAppId = OTHER_PROJECT
    expect((await resolve()).allowedScopes).toHaveLength(0)
    f.bot.externalAppId = PROJECT
    f.bot.orgId = OrgId('other-org')
    expect((await resolve()).allowedScopes).toHaveLength(0)
    f.bot.orgId = current.orgId
    f.googleAccountIdFor.mockResolvedValue(null)
    const unlinked = viewer()
    await f.service.addViewerIdentities(unlinked)
    expect(await f.service.resolve([space], unlinked)).toMatchObject({
      allowedScopes: [],
      accessIssues: [{ provider: 'googlechat', reason: 'authorization' }]
    })
  })
})
