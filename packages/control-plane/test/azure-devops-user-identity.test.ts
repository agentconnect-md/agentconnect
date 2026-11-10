import { createHash } from 'node:crypto'
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AzureDevOpsApiClient } from '../src/azure-devops/api.js'
import { AzureDevOpsUserIdentityService } from '../src/azure-devops/user-identity.js'
import { LogtoIdentityService } from '../src/github/logto-identity.js'
import { PgAzureDevOpsUserIdentityStore } from '../src/persistence/repositories/azure-devops-user-identity.repo.js'
import { PgSocialIdentityMutationGate } from '../src/persistence/repositories/social-identity-mutation.gate.js'
import type { AzureDevOpsConnectionRecord } from '../src/persistence/ports.js'
import type { SecretCipher } from '../src/secrets/cipher.js'
import { FakeClock } from './fakes/fake-clock.js'
import { prisma } from './setup.db.js'

const CLIENT = '00000000-0000-4000-8000-000000000001'
const TENANT = '00000000-0000-4000-8000-000000000002'
const HOME_OBJECT = '00000000-0000-4000-8000-000000000003'
const GUEST_OBJECT = '00000000-0000-4000-8000-000000000004'
const CONNECTION = '00000000-0000-4000-8000-000000000005'
const BASE = 'https://login.microsoftonline.com'
const APP = { clientId: CLIENT, clientSecret: 'example-secret', webAppUrl: 'https://console.example.test' }
const MGMT = {
  endpoint: 'https://login.example.test',
  appId: 'app',
  appSecret: 'secret',
  resource: 'https://login.example.test/api'
}
const cipher: SecretCipher = {
  seal: async (value) => `sealed:${value}`,
  open: async (value) => {
    expect(value.startsWith('sealed:')).toBe(true)
    return value.slice(7)
  }
}

let keys: Awaited<ReturnType<typeof generateKeyPair>>
beforeAll(async () => {
  keys = await generateKeyPair('RS256', { extractable: true })
})
beforeEach(async () => {
  await prisma.user.createMany({
    data: ['member', 'other'].map((id) => ({ id, oidcSubject: id, email: `${id}@example.test` }))
  })
})

function harness() {
  const clock = new FakeClock(Date.now())
  const store = new PgAzureDevOpsUserIdentityStore(prisma)
  const mutations = new PgSocialIdentityMutationGate(prisma)
  let linked: string | null = HOME_OBJECT
  let claims: JWTPayload = {}
  let profileId = GUEST_OBJECT
  let failure: { error: string; status: number } | undefined
  let beforeRefresh: (() => Promise<void>) | undefined
  let tokenCalls = 0
  let nonce = ''
  let challenge = ''
  const logto = new LogtoIdentityService(
    MGMT,
    clock,
    mutations,
    async (url, init) => {
      if (url.endsWith('/oidc/token')) return Response.json({ access_token: 'm2m-token', expires_in: 3600 })
      if (url === `${MGMT.endpoint}/api/users/member/identities/azuread` && init?.method === 'DELETE') {
        linked = null
        return new Response(null, { status: 204 })
      }
      // Only the official user endpoint exists; any fork endpoint makes this test fail.
      expect(url).toBe(`${MGMT.endpoint}/api/users/member`)
      return Response.json({
        identities: {
          google: { userId: 'google-member' },
          ...(linked ? { azuread: { userId: linked, details: { email: 'alex@example.test' } } } : {})
        }
      })
    },
    undefined,
    { clearMicrosoftTenantIdentities: (sub) => store.clearBySubject(sub) }
  )
  const api = new AzureDevOpsApiClient({
    fetch: async (url, init) => {
      if (url.endsWith('/discovery/v2.0/keys'))
        return Response.json({
          keys: [{ ...(await exportJWK(keys.publicKey)), kid: 'test', alg: 'RS256', use: 'sig' }]
        })
      if (url.startsWith('https://graph.microsoft.com/v1.0/me'))
        return Response.json({ id: profileId, mail: 'alex@example.test' })
      expect(url).toBe(`${BASE}/${TENANT}/oauth2/v2.0/token`)
      const body = new URLSearchParams(String(init?.body))
      expect(body.get('client_id')).toBe(CLIENT)
      expect(body.get('scope')).toContain('offline_access')
      expect(body.get('scope')).not.toContain('user_impersonation')
      if (body.get('grant_type') === 'authorization_code') {
        expect(createHash('sha256').update(body.get('code_verifier')!).digest('base64url')).toBe(challenge)
      } else {
        expect(body.get('grant_type')).toBe('refresh_token')
        expect(body.get('refresh_token')).toMatch(/^refresh-/)
        await beforeRefresh?.()
      }
      tokenCalls++
      if (failure) return Response.json({ error: failure.error }, { status: failure.status })
      const issuedAt = Math.floor(clock.now() / 1000)
      const token = await new SignJWT({
        aud: CLIENT,
        iss: `${BASE}/${TENANT}/v2.0`,
        tid: TENANT,
        oid: GUEST_OBJECT,
        sub: 'tenant-member',
        nonce,
        iat: issuedAt,
        exp: issuedAt + 3600,
        ...claims
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'test' })
        .sign(keys.privateKey)
      return Response.json({
        id_token: token,
        access_token: 'personal-graph-token',
        refresh_token: `refresh-${tokenCalls}`
      })
    }
  })
  const create = () =>
    new AzureDevOpsUserIdentityService({
      api,
      clock,
      cipher,
      store,
      mutations,
      connections: {
        get: async (orgId, id) =>
          orgId === 'org' && id === CONNECTION ? ({ tenantId: TENANT } as AzureDevOpsConnectionRecord) : null
      },
      subjectFor: async (userId) => userId,
      microsoftIdentityFor: () => logto.microsoftIdentityFor('member', 0),
      application: APP
    })
  const identity = create()
  const authorize = async () => {
    const { authorizeUrl } = await identity.authorize('org', 'member', CONNECTION)
    const url = new URL(authorizeUrl)
    nonce = url.searchParams.get('state')!
    challenge = url.searchParams.get('code_challenge')!
    return { url, state: nonce }
  }
  const verify = async () => {
    const { state } = await authorize()
    await identity.complete('org', 'member', state, 'example-code')
    return state
  }
  const refresh = (service = identity) =>
    service.identityFor('member', { objectId: HOME_OBJECT, email: 'alex@example.test' }, TENANT)
  return {
    identity,
    logto,
    store,
    clock,
    create,
    authorize,
    verify,
    refresh,
    claims: (value: JWTPayload) => {
      claims = value
    },
    profile: (value: string) => {
      profileId = value
    },
    link: (value: string | null) => {
      linked = value
    },
    fail: (error: string, status: number) => {
      failure = { error, status }
    },
    beforeRefresh: (run: () => Promise<void>) => {
      beforeRefresh = run
    },
    calls: () => tokenCalls
  }
}

describe('Azure tenant verification with official Logto identities', () => {
  it('binds PKCE to the tenant and caller, then revalidates offline after a CP restart', async () => {
    const h = harness()
    const { state, url } = await h.authorize()
    expect(url.pathname).toBe(`/${TENANT}/oauth2/v2.0/authorize`)
    expect(url.searchParams.get('redirect_uri')).toBe('https://console.example.test/azure-devops/connect')
    expect(url.searchParams.get('nonce')).toBe(state)
    await expect(h.identity.complete('org', 'other', state, 'code')).rejects.toMatchObject({
      code: 'AZURE_DEVOPS_IDENTITY_STATE_INVALID'
    })
    await expect(h.identity.complete('another-org', 'member', state, 'code')).rejects.toMatchObject({
      code: 'AZURE_DEVOPS_IDENTITY_STATE_INVALID'
    })
    expect(h.calls()).toBe(0)
    await h.identity.complete('org', 'member', state, 'code')
    expect(await h.store.find('member', TENANT)).toMatchObject({
      linkedObjectId: HOME_OBJECT,
      objectId: GUEST_OBJECT,
      refreshToken: 'sealed:refresh-1'
    })
    await expect(h.identity.complete('org', 'member', state, 'code')).rejects.toMatchObject({
      code: 'AZURE_DEVOPS_IDENTITY_STATE_INVALID'
    })
    h.clock.advance(8 * 60 * 60_000)
    expect(await h.refresh(h.create())).toEqual({ objectId: GUEST_OBJECT, email: 'alex@example.test' })
    expect((await h.store.find('member', TENANT))!.refreshToken).toBe('sealed:refresh-2')
    expect(await h.logto.microsoftIdentityFor('member', 0)).toEqual({
      objectId: HOME_OBJECT,
      email: 'alex@example.test'
    })
  })

  it.each([
    ['tenant', { tid: HOME_OBJECT }],
    ['audience', { aud: HOME_OBJECT }],
    ['issuer', { iss: 'https://other.example.test' }],
    ['nonce', { nonce: 'wrong' }],
    ['expiry', { exp: 1 }]
  ] as const)('rejects a wrong %s without retaining a verification', async (_name, claims) => {
    const h = harness()
    h.claims(claims)
    await expect(h.verify()).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    expect(await h.store.find('member', TENANT)).toBeNull()
  })

  it('requires agreement with Graph and refuses a different object on renewal', async () => {
    const h = harness()
    h.profile(HOME_OBJECT)
    await expect(h.verify()).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    h.profile(GUEST_OBJECT)
    await h.verify()
    h.claims({ oid: HOME_OBJECT })
    await expect(h.refresh()).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    expect((await h.store.find('member', TENANT))!.objectId).toBe(GUEST_OBJECT)
  })

  it('requires new verification for revoked consent but treats provider outages as retryable', async () => {
    const h = harness()
    await h.verify()
    h.fail('invalid_grant', 400)
    await expect(h.refresh()).rejects.toMatchObject({ code: 'AZURE_DEVOPS_IDENTITY_VERIFICATION_REQUIRED' })
    h.fail('temporarily_unavailable', 503)
    await expect(h.refresh()).rejects.toMatchObject({ code: 'UNAVAILABLE', retryable: true })
    expect(await h.store.find('member', TENANT)).not.toBeNull()
  })

  it('expires pending flows and binds them to the current Microsoft link', async () => {
    const h = harness()
    let { state } = await h.authorize()
    h.clock.advance(10 * 60_000)
    await expect(h.identity.complete('org', 'member', state, 'code')).rejects.toMatchObject({
      code: 'AZURE_DEVOPS_IDENTITY_STATE_INVALID'
    })
    ;({ state } = await h.authorize())
    h.link(GUEST_OBJECT)
    await expect(h.identity.complete('org', 'member', state, 'code')).rejects.toMatchObject({
      code: 'AZURE_DEVOPS_IDENTITY_VERIFICATION_REQUIRED'
    })
    expect(h.calls()).toBe(0)
  })

  it('removes saved and pending verifications when Microsoft is unlinked', async () => {
    const h = harness()
    await h.verify()
    const { state } = await h.authorize()
    await h.logto.unlinkSocialIdentity('member', 'azuread')
    expect(await h.store.find('member', TENANT)).toBeNull()
    h.link(HOME_OBJECT)
    await expect(h.identity.complete('org', 'member', state, 'code')).rejects.toMatchObject({
      code: 'AZURE_DEVOPS_IDENTITY_STATE_INVALID'
    })
    await expect(h.refresh()).rejects.toMatchObject({ code: 'AZURE_DEVOPS_IDENTITY_VERIFICATION_REQUIRED' })
  })

  it('cannot restore a deleted grant or a changed link from an in-flight refresh', async () => {
    const h = harness()
    await h.verify()
    h.beforeRefresh(() => h.store.clearBySubject('member'))
    await expect(h.refresh()).rejects.toMatchObject({ code: 'AZURE_DEVOPS_IDENTITY_VERIFICATION_REQUIRED' })
    expect(await h.store.find('member', TENANT)).toBeNull()
    await h.verify()
    h.beforeRefresh(async () => {
      h.link(null)
    })
    await expect(h.refresh()).rejects.toMatchObject({ code: 'MICROSOFT_IDENTITY_REQUIRED' })
  })
})
