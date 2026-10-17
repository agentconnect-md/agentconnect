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
        socialProviders: ['google']
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
    updatedAt: new Date('2026-10-17T00:00:00Z')
  }
  admin.adminClaimedFor = deploymentAdminClaimKey(admin.values, 'https://login.example.test/oidc')
  const secrets: Partial<Record<DeploymentSecretKey, string>> = {
    'logto.managementAppSecret': 'management-secret',
    'logto.googleConnectorClientSecret': 'google-secret'
  }
  const reconciled: Array<{ desired: LogtoSetupDesired; refresh: boolean }> = []
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
      admin.secrets = Object.keys(secrets).map((key) => ({
        key: key as DeploymentSecretKey,
        configured: true,
        fingerprint: 'sha256:example',
        updatedAt: admin.updatedAt
      }))
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
    fetch: async (input) => {
      const path = new URL(String(input)).pathname
      if (path === '/oidc/token') return Response.json({ access_token: 'token', expires_in: 3600 })
      if (path === '/api/connectors')
        return Response.json(
          ['telegram', 'discord'].map((provider) => ({
            id: `existing-${provider}`,
            connectorId: provider === 'telegram' ? 'oidc' : 'discord-universal',
            target: provider,
            config: {}
          }))
        )
      return new Response(null, { status: 404 })
    },
    makeLogtoSetupClient: () => ({
      reconcileSetup: async (desired, options) => {
        reconciled.push({ desired, refresh: options?.refreshConnectorSecrets ?? false })
        return {
          changed: true,
          application: { id: 'browser-app', created: false, changed: false },
          connectors: [],
          signInExperienceChanged: true,
          adminRoleCreated: false
        }
      }
    })
  })
  running = app
  return { app, admin, secrets, reconciled }
}

describe('global login application configuration', () => {
  it('reuses the GitLab application for sign-in, rotates its secret and refuses clearing the last provider', async () => {
    const { app, admin, secrets, reconciled } = server()
    admin.values.gitlab = { clientId: 'gitlab-client', baseUrl: 'https://gitlab.example.test/prefix/' }
    secrets['gitlab.clientSecret'] = 'gitlab-secret'
    const configure = (enabled: boolean) =>
      app.inject({ method: 'POST', url: '/api/v1/configure/gitlab-login', headers, payload: { enabled } })
    expect((await configure(true)).statusCode).toBe(200)
    const status = await app.inject({ url: '/api/v1/deployment-config', headers })
    expect(status.statusCode).toBe(200)
    expect(status.body).not.toContain('gitlab-secret')
    expect(status.json().providerExpectations.gitlabSignIn.redirects).toEqual([
      'https://login.example.test/callback/agentconnect-gitlab',
      'https://login.example.test/account/callback/social/agentconnect-gitlab',
      'https://console.example.test/auth/social/callback'
    ])
    expect(
      (await app.inject({ method: 'POST', url: '/api/v1/reconcile/logto', headers, payload: {} })).statusCode
    ).toBe(200)
    expect(reconciled.at(-1)?.desired.gitlab).toEqual({
      clientId: 'gitlab-client',
      clientSecret: 'gitlab-secret',
      baseUrl: 'https://gitlab.example.test/prefix'
    })
    secrets['gitlab.clientSecret'] = 'rotated-secret'
    await app.inject({
      method: 'POST',
      url: '/api/v1/reconcile/logto',
      headers,
      payload: { refreshConnectorSecrets: true }
    })
    expect(reconciled.at(-1)?.desired.gitlab?.clientSecret).toBe('rotated-secret')
    expect(
      (await app.inject({ method: 'POST', url: '/api/v1/configure/gitlab', headers, payload: { application: null } }))
        .statusCode
    ).toBe(400)
    admin.values.logto!.browser!.socialProviders = ['gitlab']
    expect((await configure(false)).statusCode).toBe(400)
    admin.values.logto!.browser!.socialProviders = ['google', 'gitlab']
    expect((await configure(false)).statusCode).toBe(200)
  })

  it.each(['telegram', 'discord'] as const)(
    'saves, reconciles, rotates and clears %s without exposing its secret',
    async (provider) => {
      const { app, admin, secrets, reconciled } = server()
      const url = `/api/v1/configure/login-app/${provider}`
      const secretKey = `logto.${provider}ConnectorClientSecret` as const
      const configure = (application: unknown) => app.inject({ method: 'POST', url, headers, payload: { application } })
      const reconcile = (refreshConnectorSecrets = false) =>
        app.inject({ method: 'POST', url: '/api/v1/reconcile/logto', headers, payload: { refreshConnectorSecrets } })
      expect((await configure({ clientId: 'login-client' })).statusCode).toBe(400)
      expect((await configure({ clientId: 'login-client', clientSecret: 'login-secret' })).statusCode).toBe(200)
      expect((await reconcile()).statusCode).toBe(200)
      expect(reconciled.at(-1)?.desired[provider]).toEqual({ clientId: 'login-client', clientSecret: 'login-secret' })
      expect(admin.values.auth).toMatchObject({ socialProviders: ['google', provider] })
      const status = await app.inject({ method: 'GET', url: '/api/v1/deployment-config', headers })
      expect(status.statusCode).toBe(200)
      expect(status.body).not.toContain('login-secret')
      expect(status.json().providerExpectations[provider].redirects).toEqual([
        `https://login.example.test/callback/existing-${provider}`,
        `https://login.example.test/account/callback/social/existing-${provider}`,
        'https://console.example.test/auth/social/callback'
      ])
      expect((await configure({ clientId: 'login-client' })).statusCode).toBe(200)
      expect(secrets[secretKey]).toBe('login-secret')
      expect((await configure({ clientId: 'another-client' })).statusCode).toBe(400)
      expect((await configure({ clientId: 'login-client', clientSecret: 'rotated-secret' })).statusCode).toBe(200)
      expect((await reconcile(true)).statusCode).toBe(200)
      expect(reconciled.at(-1)).toMatchObject({
        refresh: true,
        desired: { [provider]: { clientSecret: 'rotated-secret' } }
      })
      expect((await configure(null)).statusCode).toBe(200)
      expect((await reconcile()).statusCode).toBe(200)
      expect(admin.values.logto?.[`${provider}Connector`]).toBeNull()
      expect(admin.values.auth).toMatchObject({ socialProviders: ['google'] })
      expect(secrets[secretKey]).toBeUndefined()
    }
  )

  it('requires ADMIN access and refuses to remove the last sign-in provider', async () => {
    const { app, admin } = server()
    const request = {
      method: 'POST' as const,
      url: '/api/v1/configure/login-app/telegram',
      payload: { application: null }
    }
    expect((await app.inject(request)).statusCode).toBe(401)
    expect((await app.inject({ ...request, headers: { authorization: 'Bearer member' } })).statusCode).toBe(403)
    admin.values.logto!.browser!.socialProviders = ['telegram']
    expect((await app.inject({ ...request, headers })).statusCode).toBe(400)
    expect(admin.values.logto!.browser!.socialProviders).toEqual(['telegram'])
  })
})
