import { describe, expect, it, vi } from 'vitest'
import { FakeClock } from '../../../test/fakes/fake-clock.js'
import { BotId, OrgId } from '../../domain/ids.js'
import type { SessionAccessViewer } from '../../http/session-access-plugin.js'
import type { BotRecord, ExternalScopeRecord } from '../../persistence/ports.js'
import { MSTEAMS_CONNECTOR_ORIGIN, createMsTeamsSessionAccess } from './session-access.js'

const APP = '22222222-2222-4222-8222-222222222222'
const TENANT = '11111111-1111-4111-8111-111111111111'
const MEMBER = '33333333-3333-4333-8333-333333333333'
const CHANNEL = '19:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA@thread.tacv2'

function fixture(respond: (url: string) => Response = () => Response.json({ aadObjectId: MEMBER, tenantId: TENANT })) {
  const clock = new FakeClock(Date.UTC(2026, 0, 1))
  const bot = {
    id: BotId('bot-1'),
    orgId: OrgId('org-1'),
    platform: 'msteams',
    externalAppId: APP,
    externalTenantId: TENANT,
    revokedAt: null,
    credentialRevision: 1
  } as BotRecord
  const fetchImpl = vi.fn(async (url: string | URL | Request, _init?: RequestInit) =>
    String(url).includes('login.microsoftonline.com')
      ? Response.json({ access_token: 'synthetic-token', expires_in: 3599 })
      : respond(String(url))
  )
  const identity = {
    chatIdentitiesFor: vi.fn(async () => [{ platform: 'msteams', tenant: 'global', memberId: MEMBER }])
  }
  const service = createMsTeamsSessionAccess(
    {
      clock,
      configured: true,
      identity,
      bots: { getUnscoped: async () => bot, listForOrg: async () => [bot] },
      botSecrets: { get: async () => ({ botToken: 'synthetic-secret', appToken: null, signingSecret: null }) }
    },
    fetchImpl
  )
  const viewer = {
    orgId: bot.orgId,
    userId: 'user-1',
    request: { oidcSubject: 'sub-1' },
    identitySet: new Set<string>()
  } as SessionAccessViewer
  const scope = (resourceKey = CHANNEL): ExternalScopeRecord => ({
    id: 'scope-1',
    orgId: bot.orgId,
    provider: 'msteams',
    realmKey: TENANT,
    resourceKind: 'conversation',
    resourceKey,
    credentialKind: 'bot',
    credentialId: bot.id,
    revokedAt: null,
    aclRevision: 1n
  })
  return { bot, clock, fetchImpl, identity, service, viewer, scope }
}

describe('Microsoft Teams session access', () => {
  it('admits a linked member of the conversation, checked with the bot’s own token', async () => {
    const f = fixture()
    await f.service.addViewerIdentities(f.viewer)
    expect(f.viewer.identitySet).toEqual(new Set([`msteams:global:${MEMBER}`, `msteams:${TENANT}:${MEMBER}`]))
    await expect(f.service.resolve([f.scope()], f.viewer)).resolves.toEqual({
      allowedScopes: [{ id: 'scope-1', aclRevision: 1n }],
      degraded: false,
      accessIssues: []
    })
    const [tokenCall, memberCall] = f.fetchImpl.mock.calls
    expect(String(tokenCall![0])).toBe(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`)
    expect(String(tokenCall![1]?.body)).toContain(`client_id=${APP}`)
    expect(String(memberCall![0])).toBe(
      `${MSTEAMS_CONNECTOR_ORIGIN}v3/conversations/${encodeURIComponent(CHANNEL)}/members/${MEMBER}`
    )
  })

  it('checks a 1:1 chat the same way', async () => {
    const f = fixture()
    await f.service.addViewerIdentities(f.viewer)
    const dm = 'a:1AAAAAAAAAAAAAAAAAAAA-AAAAAAAAAAAAAAAA'
    expect((await f.service.resolve([f.scope(dm)], f.viewer)).allowedScopes).toHaveLength(1)
  })

  it.each([
    [404, { error: { code: 'MemberNotFoundInConversation' } }, false, undefined],
    [200, { aadObjectId: '44444444-4444-4444-8444-444444444444', tenantId: TENANT }, true, 'unavailable'],
    [200, { aadObjectId: MEMBER, tenantId: '55555555-5555-4555-8555-555555555555' }, true, 'unavailable'],
    [200, { aadObjectId: MEMBER }, true, 'unavailable'],
    [401, {}, true, 'app_authorization'],
    [403, {}, true, 'app_authorization'],
    [503, {}, true, 'unavailable']
  ] as const)('refuses HTTP %s %j', async (status, body, degraded, reason) => {
    const f = fixture(() => Response.json(body, { status }))
    await f.service.addViewerIdentities(f.viewer)
    expect(await f.service.resolve([f.scope()], f.viewer)).toEqual({
      allowedScopes: [],
      degraded,
      accessIssues: reason ? [{ provider: 'msteams', reason }] : []
    })
  })

  it('never calls Teams for a malformed conversation or a bot from another tenant', async () => {
    const f = fixture()
    await f.service.addViewerIdentities(f.viewer)
    expect((await f.service.resolve([f.scope('19:x;messageid=1')], f.viewer)).allowedScopes).toHaveLength(0)
    f.bot.externalTenantId = '55555555-5555-4555-8555-555555555555'
    expect((await f.service.resolve([f.scope()], f.viewer)).allowedScopes).toHaveLength(0)
    expect(f.fetchImpl).not.toHaveBeenCalled()
  })

  it('reuses the bot token until it nears expiry or the secret rotates', async () => {
    const f = fixture()
    await f.service.addViewerIdentities(f.viewer)
    const tokenCalls = () =>
      f.fetchImpl.mock.calls.filter(([url]) => String(url).includes('login.microsoftonline.com')).length
    await f.service.resolve([f.scope()], f.viewer)
    f.clock.advance(120_001)
    await f.service.resolve([f.scope()], f.viewer)
    expect(tokenCalls()).toBe(1)
    f.bot.credentialRevision++
    await f.service.resolve([f.scope()], f.viewer)
    expect(tokenCalls()).toBe(2)
  })

  it('takes a deployment app’s token from its home tenant and still fences on the tenant it serves', async () => {
    const HOME = '66666666-6666-4666-8666-666666666666'
    const f = fixture()
    f.bot.platformConfig = { tenantId: TENANT, tokenTenantId: HOME }
    await f.service.addViewerIdentities(f.viewer)
    expect((await f.service.resolve([f.scope()], f.viewer)).allowedScopes).toHaveLength(1)
    expect(String(f.fetchImpl.mock.calls[0]![0])).toBe(`https://login.microsoftonline.com/${HOME}/oauth2/v2.0/token`)
  })

  it('reports a refused client secret as the bot’s authorization', async () => {
    const f = fixture()
    f.fetchImpl.mockImplementation(async () => Response.json({ error: 'invalid_client' }, { status: 401 }))
    await f.service.addViewerIdentities(f.viewer)
    expect(await f.service.resolve([f.scope()], f.viewer)).toMatchObject({
      allowedScopes: [],
      accessIssues: [{ provider: 'msteams', reason: 'app_authorization' }]
    })
  })
})
