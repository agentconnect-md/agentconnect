import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { FakeClock } from '../../../test/fakes/fake-clock.js'
import {
  MsTeamsConnectError,
  installMsTeamsApp,
  listMsTeamsTeams,
  mintMsTeamsConnectState,
  msTeamsAuthorizeUrl,
  msTeamsConnectKeys,
  openMsTeamsTicket,
  publishMsTeamsPackage,
  redeemMsTeamsCode,
  sealMsTeamsTicket,
  verifyMsTeamsConnectState
} from './connect.js'

const keys = msTeamsConnectKeys('p'.repeat(40))
const TENANT = '11111111-1111-4111-8111-111111111111'
const CLIENT = '22222222-2222-4222-8222-222222222222'
const attempt = { orgId: 'org-1', agentId: 'agent-1', userId: 'user-1' }

const idToken = (claims: Record<string, unknown>) =>
  ['e30', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig'].join('.')

describe('Teams connect state', () => {
  it('round-trips, and refuses a tampered, foreign or expired state', () => {
    const clock = new FakeClock(Date.UTC(2026, 0, 1))
    const state = mintMsTeamsConnectState(keys, attempt, clock)
    expect(verifyMsTeamsConnectState(keys, state, clock)).toEqual(attempt)
    const [payload, sig] = state.split('.')
    const forged = Buffer.from(JSON.stringify({ ...attempt, orgId: 'org-2', e: clock.now() + 1, n: 'x' })).toString(
      'base64url'
    )
    expect(verifyMsTeamsConnectState(keys, `${forged}.${sig}`, clock)).toBeNull()
    expect(verifyMsTeamsConnectState(msTeamsConnectKeys('q'.repeat(40)), state, clock)).toBeNull()
    expect(verifyMsTeamsConnectState(keys, `${payload}`, clock)).toBeNull()
    clock.advance(10 * 60_000 + 1)
    expect(verifyMsTeamsConnectState(keys, state, clock)).toBeNull()
  })

  it('asks for the three Graph scopes with a PKCE challenge the redemption answers', async () => {
    const clock = new FakeClock(Date.UTC(2026, 0, 1))
    const state = mintMsTeamsConnectState(keys, attempt, clock)
    const url = new URL(
      msTeamsAuthorizeUrl(keys, {
        clientId: CLIENT,
        redirectUri: 'https://console.example.test/msteams/connect',
        state
      })
    )
    expect(url.origin + url.pathname).toBe('https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize')
    expect(url.searchParams.get('scope')?.split(' ')).toEqual([
      'https://graph.microsoft.com/AppCatalog.ReadWrite.All',
      'https://graph.microsoft.com/Team.ReadBasic.All',
      'https://graph.microsoft.com/TeamsAppInstallation.ReadWriteAndConsentSelfForTeam',
      'openid'
    ])
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      Response.json({ access_token: 'delegated', id_token: idToken({ tid: TENANT.toUpperCase() }) })
    )
    await expect(
      redeemMsTeamsCode(
        keys,
        {
          clientId: CLIENT,
          clientSecret: 's',
          redirectUri: 'https://console.example.test/msteams/connect',
          code: 'c',
          state
        },
        fetchImpl
      )
    ).resolves.toEqual({ accessToken: 'delegated', tenantId: TENANT })
    const verifier = new URLSearchParams(String(fetchImpl.mock.calls[0]![1]?.body)).get('code_verifier')!
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(url.searchParams.get('code_challenge'))
  })

  it.each([
    [() => Response.json({ error: 'invalid_grant' }, { status: 400 }), 'MSTEAMS_CONNECT_DENIED'],
    [() => new Response(null, { status: 503 }), 'MSTEAMS_CONNECT_UNAVAILABLE'],
    [
      () => Response.json({ access_token: 'a', id_token: idToken({ tid: '9188040d-6c67-4c5b-b112-36a304b66dad' }) }),
      'MSTEAMS_CONNECT_PERSONAL_ACCOUNT'
    ],
    [() => Response.json({ access_token: 'a', id_token: idToken({}) }), 'MSTEAMS_CONNECT_UNAVAILABLE']
  ] as const)('refuses a redemption answered %#', async (respond, code) => {
    const error = await redeemMsTeamsCode(
      keys,
      {
        clientId: CLIENT,
        clientSecret: 's',
        redirectUri: 'https://console.example.test/msteams/connect',
        code: 'c',
        state: 's'
      },
      async () => respond()
    ).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(MsTeamsConnectError)
    expect((error as MsTeamsConnectError).code).toBe(code)
  })

  it('seals the delegated token so only the Control Plane reads it, until it expires', () => {
    const clock = new FakeClock(Date.UTC(2026, 0, 1))
    const ticket = sealMsTeamsTicket(
      keys,
      { accessToken: 'delegated', orgId: 'org-1', integrationId: 'i-1', catalogAppId: 'c-1' },
      clock
    )
    expect(ticket).not.toContain('delegated')
    expect(openMsTeamsTicket(keys, ticket, clock)).toMatchObject({ accessToken: 'delegated', orgId: 'org-1' })
    expect(openMsTeamsTicket(msTeamsConnectKeys('q'.repeat(40)), ticket, clock)).toBeNull()
    expect(openMsTeamsTicket(keys, `${ticket}x`, clock)).toBeNull()
    clock.advance(10 * 60_000 + 1)
    expect(openMsTeamsTicket(keys, ticket, clock)).toBeNull()
  })
})

describe('Teams Graph calls', () => {
  it('publishes a new app, or adds a definition to the one the catalog holds', async () => {
    const zip = new Uint8Array([1, 2, 3])
    const fresh = vi.fn(async (url: string | URL | Request, _init?: RequestInit) =>
      String(url).includes('$filter')
        ? Response.json({ value: [] })
        : Response.json({ id: 'catalog-1' }, { status: 201 })
    )
    expect(await publishMsTeamsPackage(fresh, 't', 'ext-1', zip)).toBe('catalog-1')
    expect(String(fresh.mock.calls[1]![0])).toBe(
      'https://graph.microsoft.com/v1.0/appCatalogs/teamsApps?requiresReview=false'
    )
    expect(fresh.mock.calls[1]![1]?.headers).toMatchObject({ 'content-type': 'application/zip' })
    const known = vi.fn(async (url: string | URL | Request, _init?: RequestInit) =>
      String(url).includes('$filter')
        ? Response.json({ value: [{ id: 'catalog-2', externalId: 'ext-1' }] })
        : Response.json({}, { status: 201 })
    )
    expect(await publishMsTeamsPackage(known, 't', 'ext-1', zip)).toBe('catalog-2')
    expect(String(known.mock.calls[1]![0])).toBe(
      'https://graph.microsoft.com/v1.0/appCatalogs/teamsApps/catalog-2/appDefinitions'
    )
  })

  it('names a refused Graph call as a missing administrator', async () => {
    const error = await listMsTeamsTeams(async () => new Response(null, { status: 403 }), 't').catch((e: unknown) => e)
    expect((error as MsTeamsConnectError).code).toBe('MSTEAMS_CONNECT_NOT_ADMIN')
  })

  it('installs with the consented permissions and treats an existing install as done', async () => {
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) => new Response(null, { status: 409 })
    )
    await installMsTeamsApp(fetchImpl, 't', {
      teamId: 'team-1',
      catalogAppId: 'catalog-1',
      permissions: [{ name: 'ChannelMessage.Read.Group', type: 'Application' }]
    })
    expect(JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body))).toEqual({
      'teamsApp@odata.bind': 'https://graph.microsoft.com/v1.0/appCatalogs/teamsApps/catalog-1',
      consentedPermissionSet: {
        resourceSpecificPermissions: [{ permissionValue: 'ChannelMessage.Read.Group', permissionType: 'application' }]
      }
    })
  })
})
