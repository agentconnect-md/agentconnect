import { afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import {
  DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1,
  deploymentAdminClaimKey,
  type DeploymentConfigAdmin,
  type DeploymentConfigStore,
  type DeploymentSecretKey
} from '@agentconnect.md/control-plane/deployment-config-store'
import { buildSetupServer } from '../src/server/index.js'
import type { LogtoSetupDesired } from '../src/server/logto-management.js'

let running: FastifyInstance | undefined
afterEach(async () => {
  await running?.close()
})
const headers = { authorization: 'Bearer admin' }

function server() {
  const admin: DeploymentConfigAdmin = {
    schemaVersion: 1,
    revision: 1,
    values: {
      ...DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1,
      auth: {
        mode: 'oidc',
        audience: 'browser-app',
        browserClient: { appId: 'browser-app', apiResource: null },
        socialProviders: ['google'],
        sso: null
      },
      logto: {
        managementAppId: 'management-app',
        managementResource: 'https://login.example.test/api',
        browser: { applicationName: 'AgentConnect', apiResource: null, socialProviders: ['google'] },
        githubConnector: null,
        googleConnector: { clientId: 'google-client' }
      }
    },
    secrets: [],
    adminClaimedFor: null,
    updatedAt: new Date('2026-11-04T00:00:00Z')
  }
  admin.adminClaimedFor = deploymentAdminClaimKey(admin.values, 'https://login.example.test/oidc')
  const secrets: Partial<Record<DeploymentSecretKey, string>> = {
    'logto.managementAppSecret': 'management-secret',
    'logto.googleConnectorClientSecret': 'google-secret'
  }
  const reconciled: LogtoSetupDesired[] = []
  const created: Array<{ providerName: string; displayName: string }> = []
  const store: DeploymentConfigStore = {
    getAdmin: async () => admin,
    getRuntime: async (keys) => ({
      ...admin,
      secrets: Object.fromEntries(
        Object.entries(secrets).filter(([key]) => !keys || keys.includes(key as DeploymentSecretKey))
      )
    }),
    replace: async (input) => {
      expect(input.expectedRevision).toBe(admin.revision)
      admin.values = input.values
      admin.revision++
      for (const [key, value] of Object.entries(input.secrets ?? {})) {
        if (value === null) delete secrets[key as DeploymentSecretKey]
        else secrets[key as DeploymentSecretKey] = value
      }
      return admin
    },
    markAdminClaimed: async () => {}
  }
  const app = buildSetupServer({
    store,
    publicUrl: 'http://localhost:8091',
    localAuthBootstrap: {
      issuer: 'https://login.example.test/oidc',
      services: {
        web: 'https://console.example.test',
        controlPlane: 'https://api.example.test',
        relay: 'https://relay.example.test'
      }
    },
    verifyOidcToken: async (token) => ({ sub: 'operator', roles: token === 'admin' ? ['ADMIN'] : [] }),
    fetch: async () => new Response(null, { status: 404 }),
    makeLogtoSetupClient: () => ({
      reconcileSetup: async (desired) => {
        reconciled.push(desired)
        return {
          changed: true,
          application: { id: 'browser-app', created: false, changed: false },
          connectors: [],
          sso: desired.sso ? { id: desired.sso.connectorId, changed: true } : null,
          signInExperienceChanged: true,
          adminRoleCreated: false
        }
      },
      createSsoConnector: async (input) => {
        created.push(input)
        return { id: 'sso-1', created: created.length === 1 }
      }
    })
  })
  running = app
  return { app, admin, secrets, reconciled, created }
}

const post = (app: FastifyInstance, url: string, payload: unknown) =>
  app.inject({ method: 'POST', url, headers, payload: payload as Record<string, unknown> })

describe('SSO configuration', () => {
  it('creates the connector, takes the OIDC client, and signs in through it alone', async () => {
    const { app, admin, secrets, reconciled, created } = server()

    const create = await post(app, '/api/v1/create/sso', { protocol: 'oidc', name: 'Example SSO' })
    expect(create.statusCode).toBe(200)
    expect(create.json()).toMatchObject({
      connectorId: 'sso-1',
      protocol: 'oidc',
      redirectUri: 'https://login.example.test/callback/sso-1'
    })
    expect(created).toEqual([{ providerName: 'OIDC', displayName: 'Example SSO' }])
    expect(admin.values.logto?.ssoConnector).toEqual({
      connectorId: 'sso-1',
      protocol: 'oidc',
      name: 'Example SSO',
      domains: [],
      oidc: null,
      saml: null
    })
    // A retried create keeps the same connector and leaves the document alone.
    const revision = admin.revision
    expect((await post(app, '/api/v1/create/sso', { protocol: 'oidc', name: 'Example SSO' })).statusCode).toBe(200)
    expect(admin.revision).toBe(revision)

    // Without its IdP the connector is not a way in yet.
    admin.values.logto!.browser!.socialProviders = []
    const early = await post(app, '/api/v1/reconcile/logto', {})
    expect(early.statusCode).toBe(409)
    expect(early.json().detail ?? early.body).toContain('SSO connector')

    const oidc = { issuer: 'https://idp.example.test', clientId: 'client', trustUnverifiedEmail: true }
    const noSecret = await post(app, '/api/v1/configure/sso', {
      connector: { name: 'Example SSO', domains: ['Example.TEST'], oidc }
    })
    expect(noSecret.statusCode).toBe(400)

    const configure = await post(app, '/api/v1/configure/sso', {
      connector: { name: 'Example SSO', domains: ['Example.TEST'], oidc: { ...oidc, clientSecret: 'idp-secret' } }
    })
    expect(configure.statusCode).toBe(200)
    expect(configure.body).not.toContain('idp-secret')
    expect(secrets['logto.ssoConnectorClientSecret']).toBe('idp-secret')
    expect(admin.values.logto?.ssoConnector).toMatchObject({
      domains: ['example.test'],
      oidc: { issuer: 'https://idp.example.test', clientId: 'client', scope: '', trustUnverifiedEmail: true }
    })

    const reconcile = await post(app, '/api/v1/reconcile/logto', {})
    expect(reconcile.statusCode).toBe(200)
    expect(reconciled.at(-1)?.sso).toEqual({
      connectorId: 'sso-1',
      displayName: 'Example SSO',
      providerName: 'OIDC',
      domains: ['example.test'],
      config: {
        issuer: 'https://idp.example.test',
        clientId: 'client',
        clientSecret: 'idp-secret',
        trustUnverifiedEmail: true
      }
    })
    expect(admin.values.auth).toMatchObject({
      mode: 'oidc',
      socialProviders: [],
      sso: { connectorId: 'sso-1', name: 'Example SSO' }
    })

    // The last way in cannot be removed.
    expect((await post(app, '/api/v1/configure/sso', { connector: null })).statusCode).toBe(400)
    admin.values.logto!.browser!.socialProviders = ['google']
    expect((await post(app, '/api/v1/configure/sso', { connector: null })).statusCode).toBe(200)
    expect(admin.values.logto?.ssoConnector).toBeNull()
    expect(secrets['logto.ssoConnectorClientSecret']).toBeUndefined()
    await post(app, '/api/v1/reconcile/logto', {})
    expect(reconciled.at(-1)?.sso).toBeUndefined()
    expect(admin.values.auth).toMatchObject({ socialProviders: ['google'], sso: null })
  })

  it('takes SAML metadata by URL and refuses settings for the other protocol', async () => {
    const { app, admin, reconciled } = server()
    const create = await post(app, '/api/v1/create/sso', { protocol: 'saml', name: 'Example SAML' })
    expect(create.json()).toMatchObject({
      assertionConsumerServiceUrl: 'https://login.example.test/api/authn/single-sign-on/saml/sso-1',
      entityId: 'https://login.example.test/enterprise-sso/sso-1'
    })
    expect(
      (
        await post(app, '/api/v1/configure/sso', {
          connector: {
            name: 'Example SAML',
            oidc: { issuer: 'https://idp.example.test', clientId: 'c', trustUnverifiedEmail: false }
          }
        })
      ).statusCode
    ).toBe(400)
    expect(
      (await post(app, '/api/v1/configure/sso', { connector: { name: 'Example SAML', saml: {} } })).statusCode
    ).toBe(400)
    const saml = { metadataUrl: 'https://idp.example.test/metadata', attributeMapping: { email: 'mail' } }
    // Without a domain Logto would silently refuse the connector at sign-in, so Setup refuses it here.
    const noDomain = await post(app, '/api/v1/configure/sso', { connector: { name: 'Example SAML', saml } })
    expect(noDomain.statusCode).toBe(400)
    expect(noDomain.body).toContain('email domain')
    const configure = (domains: string[]) =>
      post(app, '/api/v1/configure/sso', { connector: { name: 'Example SAML', domains, saml } })
    expect((await configure(['example.test'])).statusCode).toBe(200)
    expect((await post(app, '/api/v1/reconcile/logto', {})).statusCode).toBe(200)
    expect(reconciled.at(-1)?.sso).toMatchObject({
      providerName: 'SAML',
      config: { metadataUrl: 'https://idp.example.test/metadata', attributeMapping: { email: 'mail' } }
    })
    expect(admin.values.auth).toMatchObject({ socialProviders: ['google'], sso: { connectorId: 'sso-1' } })
  })
})
