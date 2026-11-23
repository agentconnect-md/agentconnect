import { createServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import {
  DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1,
  DeploymentConfigValuesV1Schema,
  deploymentAdminClaimKey,
  type DeploymentConfigAdmin,
  type DeploymentConfigStore,
  type DeploymentSecretKey
} from '@agentconnect.md/control-plane/deployment-config-store'
import { LOGTO_MATTERMOST_CONNECTOR_ID } from '../src/logto-connectors.js'
import { buildSetupServer } from '../src/server/index.js'
import { LogtoAdminClaimClient, type LogtoSetupDesired } from '../src/server/logto-management.js'

let running: FastifyInstance | undefined
afterEach(async () => {
  await running?.close()
  running = undefined
})

const headers = { authorization: 'Bearer admin' }

function server(
  options: {
    useRealLogtoClient?: boolean
    existingConnectorId?: string
    onExternalFetch?: typeof fetch
    omitFetch?: boolean
    mattermostLookup?: typeof import('node:dns').lookup
  } = {}
) {
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
    updatedAt: new Date('2026-11-21T00:00:00Z')
  }
  admin.adminClaimedFor = deploymentAdminClaimKey(admin.values, 'https://login.example.test/oidc')
  const secrets: Partial<Record<DeploymentSecretKey, string>> = {
    'logto.managementAppSecret': 'management-secret',
    'logto.googleConnectorClientSecret': 'google-secret'
  }
  const syncSecrets = () => {
    admin.secrets = Object.keys(secrets).map((key) => ({
      key: key as DeploymentSecretKey,
      configured: true,
      fingerprint: 'sha256:example',
      updatedAt: admin.updatedAt
    }))
  }
  syncSecrets()

  const reconciled: Array<{ desired: LogtoSetupDesired; refresh: boolean }> = []
  const inspected: LogtoSetupDesired[] = []
  const resolveTargetsSeen: string[] = []

  const application: Record<string, unknown> = {
    id: 'browser-app',
    name: 'AgentConnect',
    type: 'SPA',
    oidcClientMetadata: {
      redirectUris: ['https://console.example.test/auth/callback', 'http://localhost:8091/auth/callback'],
      postLogoutRedirectUris: ['https://console.example.test/login']
    },
    customData: { agentconnectSetup: { version: 1, resource: 'browser' } }
  }
  const connectors: Record<string, unknown>[] = [
    {
      id: 'agentconnect-google',
      connectorId: 'google-universal',
      target: 'google',
      config: { clientId: 'google-client', clientSecret: 'google-secret' }
    },
    ...(options.existingConnectorId
      ? [
          {
            id: options.existingConnectorId,
            connectorId: 'oauth2',
            target: 'mattermost',
            metadata: { target: 'mattermost', name: { en: 'Mattermost' } },
            config: {}
          }
        ]
      : [])
  ]
  let signInExperience: Record<string, unknown> = {
    signIn: { methods: [] },
    signUp: { identifiers: [], password: false, verify: false, secondaryIdentifiers: [] },
    socialSignInConnectorTargets: ['google'],
    singleSignOnEnabled: false,
    signInMode: 'SignInAndRegister'
  }

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
      admin.values = DeploymentConfigValuesV1Schema.parse(input.values)
      admin.revision++
      for (const [key, value] of Object.entries(input.secrets ?? {})) {
        if (value === null) delete secrets[key as DeploymentSecretKey]
        else secrets[key as DeploymentSecretKey] = value
      }
      syncSecrets()
      return admin
    },
    markAdminClaimed: async () => {}
  }

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    if (url.pathname === '/oidc/token') return Response.json({ access_token: 'token', expires_in: 3600 })
    if (url.pathname === '/api/roles') {
      return Response.json([{ id: 'admin-role', name: 'ADMIN', type: 'User', isDefault: false }])
    }
    if (url.pathname === '/api/applications/browser-app') {
      return Response.json(application)
    }
    if (url.pathname === '/api/applications') return Response.json([application])
    if (url.pathname === '/api/connectors' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      const metadata = body.metadata as { target?: string } | undefined
      const connector = { ...body, target: metadata?.target ?? 'unknown' }
      connectors.push(connector)
      return Response.json(connector)
    }
    if (url.pathname.startsWith('/api/connectors/') && init?.method === 'PATCH') {
      const connector = connectors.find((item) => item.id === url.pathname.split('/').at(-1))
      if (!connector) return new Response(null, { status: 404 })
      Object.assign(connector, JSON.parse(String(init.body)))
      return Response.json(connector)
    }
    if (url.pathname === '/api/connectors') {
      resolveTargetsSeen.push('list')
      return Response.json(connectors)
    }
    if (url.pathname === '/api/sign-in-exp' && init?.method === 'PATCH') {
      signInExperience = { ...signInExperience, ...JSON.parse(String(init.body)) }
      return Response.json(signInExperience)
    }
    if (url.pathname === '/api/sign-in-exp') return Response.json(signInExperience)
    if (url.pathname === '/api/sso-connectors') return Response.json([])
    if (options.onExternalFetch) return options.onExternalFetch(input, init)
    return new Response(null, { status: 404 })
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
    ...(options.omitFetch ? {} : { fetch: fetchImpl }),
    ...(options.mattermostLookup ? { mattermostLookup: options.mattermostLookup } : {}),
    ...(options.useRealLogtoClient
      ? {
          makeLogtoSetupClient: (cfg) => new LogtoAdminClaimClient(cfg, fetchImpl),
          makeLogtoCheckClient: (cfg) => new LogtoAdminClaimClient(cfg, fetchImpl)
        }
      : {
          makeLogtoSetupClient: () => ({
            reconcileSetup: async (desired, opts) => {
              reconciled.push({ desired, refresh: opts?.refreshConnectorSecrets ?? false })
              return {
                changed: true,
                application: { id: 'browser-app', created: false, changed: false },
                connectors: [],
                sso: null,
                ssoConnectorsDeleted: [],
                signInExperienceChanged: true,
                tokenClaimsChanged: false,
                accountEmailChanged: false,
                adminRoleCreated: false
              }
            },
            createSsoConnector: async () => {
              throw new Error('not used')
            },
            deleteManagedSsoConnectors: async () => {
              throw new Error('not used')
            }
          }),
          makeLogtoCheckClient: () => ({
            verifyClientCredentials: async () => {},
            inspectAdminRole: async () => ({ exists: true, type: 'User', isDefault: false }),
            inspectSetup: async (desired) => {
              inspected.push(desired)
              return {
                application: { id: 'browser-app', exists: true, matches: true, diff: [] },
                connectors: desired.socialProviders.map((target) => ({
                  target,
                  id: target === 'mattermost' ? LOGTO_MATTERMOST_CONNECTOR_ID : `agentconnect-${target}`,
                  exists: true,
                  matches: true,
                  diff: []
                })),
                sso: null,
                signInExperienceMatches: true,
                signInExperienceDiff: [],
                tokenClaims: null,
                accountEmail: null
              }
            }
          })
        })
  })
  running = app
  return { app, admin, secrets, reconciled, inspected, connectors, resolveTargetsSeen }
}

describe('Mattermost Logto connector wiring in Setup Server', () => {
  it('wires desired.mattermost from deployment config + secret into reconcile and check', async () => {
    const { app, admin, reconciled, inspected } = server()

    const putResponse = await app.inject({
      method: 'PUT',
      url: '/api/v1/deployment-config',
      headers,
      payload: {
        expectedRevision: 1,
        values: {
          ...admin.values,
          logto: {
            ...admin.values.logto!,
            browser: {
              ...admin.values.logto!.browser!,
              socialProviders: ['google', 'mattermost']
            },
            mattermostConnector: {
              serverUrl: 'https://chat.example.test/team/',
              clientId: 'mm-oauth-client'
            }
          }
        },
        secrets: {
          'logto.mattermostConnectorClientSecret': 'mm-oauth-secret'
        }
      }
    })
    expect(putResponse.statusCode).toBe(200)
    expect(putResponse.body).not.toContain('mm-oauth-secret')
    expect(putResponse.json().values.logto.mattermostConnector).toEqual({
      serverUrl: 'https://chat.example.test/team',
      clientId: 'mm-oauth-client'
    })
    expect(putResponse.json().providerExpectations.mattermostSignIn.redirects).toEqual([
      'https://login.example.test/callback/agentconnect-mattermost',
      'https://login.example.test/account/callback/social/agentconnect-mattermost',
      'https://console.example.test/auth/social/callback'
    ])

    const reconcileResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/reconcile/logto',
      headers,
      payload: {}
    })
    expect(reconcileResponse.statusCode).toBe(200)
    expect(reconciled.at(-1)?.desired.socialProviders).toEqual(['google', 'mattermost'])
    expect(reconciled.at(-1)?.desired.mattermost).toEqual({
      clientId: 'mm-oauth-client',
      clientSecret: 'mm-oauth-secret',
      serverUrl: 'https://chat.example.test/team'
    })

    const checkResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/check/logto',
      headers
    })
    expect(checkResponse.statusCode).toBe(200)
    expect(inspected.at(-1)?.mattermost).toEqual({
      clientId: 'mm-oauth-client',
      clientSecret: 'mm-oauth-secret',
      serverUrl: 'https://chat.example.test/team'
    })
  })

  it('resolves existing mattermost connector IDs and creates/validates oauth2 connector end-to-end', async () => {
    const existing = server({ existingConnectorId: 'existing-mm-connector' })
    const status = await existing.app.inject({ method: 'GET', url: '/api/v1/deployment-config', headers })
    expect(status.statusCode).toBe(200)
    expect(status.json().providerExpectations.mattermostSignIn.redirects).toEqual([
      'https://login.example.test/callback/existing-mm-connector',
      'https://login.example.test/account/callback/social/existing-mm-connector',
      'https://console.example.test/auth/social/callback'
    ])
    await existing.app.close()

    const real = server({ useRealLogtoClient: true })
    const save = await real.app.inject({
      method: 'PUT',
      url: '/api/v1/deployment-config',
      headers,
      payload: {
        expectedRevision: 1,
        values: {
          ...real.admin.values,
          logto: {
            ...real.admin.values.logto!,
            browser: {
              ...real.admin.values.logto!.browser!,
              socialProviders: ['google', 'mattermost']
            },
            mattermostConnector: {
              serverUrl: 'http://mattermost.internal:8065/sub/',
              clientId: 'mm-client-2'
            }
          }
        },
        secrets: { 'logto.mattermostConnectorClientSecret': 'mm-secret-2' }
      }
    })
    expect(save.statusCode).toBe(200)

    const reconcile = await real.app.inject({
      method: 'POST',
      url: '/api/v1/reconcile/logto',
      headers,
      payload: {}
    })
    expect(reconcile.statusCode, reconcile.body).toBe(200)
    expect(reconcile.json().connectors).toEqual([
      { target: 'google', id: 'agentconnect-google', created: false, changed: false },
      { target: 'mattermost', id: 'agentconnect-mattermost', created: true, changed: true }
    ])
    expect(real.connectors.find((c) => c.target === 'mattermost')).toMatchObject({
      id: LOGTO_MATTERMOST_CONNECTOR_ID,
      connectorId: 'oauth2',
      metadata: { target: 'mattermost', name: { en: 'Mattermost' } },
      config: {
        clientId: 'mm-client-2',
        clientSecret: 'mm-secret-2',
        authorizationEndpoint: 'http://mattermost.internal:8065/sub/oauth/authorize',
        tokenEndpoint: 'http://mattermost.internal:8065/sub/oauth/access_token',
        userInfoEndpoint: 'http://mattermost.internal:8065/sub/api/v4/users/me',
        tokenEndpointResponseType: 'json',
        profileMap: { id: 'id', name: 'username', email: '__disabled_unverified_email__' }
      }
    })
    expect(real.connectors.find((c) => c.target === 'mattermost')?.config).not.toHaveProperty('scope')

    Object.assign(real.connectors.find((c) => c.target === 'mattermost')!.config as Record<string, unknown>, {
      responseType: 'code',
      grantType: 'authorization_code',
      tokenEndpointAuthMethod: 'client_secret_post',
      profileMap: { id: 'id', name: 'username', email: '__disabled_unverified_email__' }
    })

    const check = await real.app.inject({ method: 'GET', url: '/api/v1/check/logto', headers })
    expect(check.statusCode).toBe(200)
    expect(check.json().summary).toMatchObject({ fail: 0, unknown: 0 })
    expect(check.json().findings.find((f: { id: string }) => f.id === 'logto.connectors')).toMatchObject({
      status: 'pass'
    })

    // Rotating the Mattermost OAuth client secret and reconciling with refreshConnectorSecrets updates Logto.
    const rotate = await real.app.inject({
      method: 'PUT',
      url: '/api/v1/deployment-config',
      headers,
      payload: {
        expectedRevision: real.admin.revision,
        values: real.admin.values,
        secrets: { 'logto.mattermostConnectorClientSecret': 'mm-secret-rotated' }
      }
    })
    expect(rotate.statusCode).toBe(200)
    const refreshed = await real.app.inject({
      method: 'POST',
      url: '/api/v1/reconcile/logto',
      headers,
      payload: { refreshConnectorSecrets: true }
    })
    expect(refreshed.statusCode).toBe(200)
    expect(real.connectors.find((c) => c.target === 'mattermost')).toMatchObject({
      config: { clientSecret: 'mm-secret-rotated' }
    })
  })

  it('probes Mattermost via POST /api/v1/check/mattermost using explicit or saved serverUrl', async () => {
    const seen: string[] = []
    let nextPing: (url: URL) => Promise<Response> | Response = () =>
      Response.json({ status: 'OK', ActiveSearchBackend: 'database' })

    const { app, admin } = server({
      onExternalFetch: (async (input) => {
        const url = new URL(String(input))
        seen.push(url.toString())
        return nextPing(url)
      }) as typeof fetch
    })

    const missing = await app.inject({
      method: 'POST',
      url: '/api/v1/check/mattermost',
      headers,
      payload: {}
    })
    expect(missing.statusCode).toBe(400)

    const emptyBodyUrl = await app.inject({
      method: 'POST',
      url: '/api/v1/check/mattermost',
      headers,
      payload: { serverUrl: '   ' }
    })
    expect(emptyBodyUrl.statusCode).toBe(400)

    const explicitOk = await app.inject({
      method: 'POST',
      url: '/api/v1/check/mattermost',
      headers,
      payload: { serverUrl: 'https://chat.example.test/team/' }
    })
    expect(explicitOk.statusCode).toBe(200)
    expect(explicitOk.json()).toMatchObject({
      status: 'ok',
      serverUrl: 'https://chat.example.test/team',
      ok: true,
      blocksSave: false
    })
    expect(seen).toEqual(['https://chat.example.test/team/api/v4/system/ping'])

    const blockedShape = await app.inject({
      method: 'POST',
      url: '/api/v1/check/mattermost',
      headers,
      payload: { serverUrl: 'http://169.254.169.254' }
    })
    expect(blockedShape.statusCode).toBe(200)
    expect(blockedShape.json()).toMatchObject({
      status: 'invalid_url',
      ok: false,
      blocksSave: true
    })
    expect(seen).toHaveLength(1)

    nextPing = () => {
      throw Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('self signed cert'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' })
      })
    }
    const tlsErr = await app.inject({
      method: 'POST',
      url: '/api/v1/check/mattermost',
      headers,
      payload: { serverUrl: 'https://chat.example.test' }
    })
    expect(tlsErr.statusCode).toBe(200)
    expect(tlsErr.json()).toMatchObject({
      status: 'tls_untrusted',
      serverUrl: 'https://chat.example.test',
      ok: false,
      blocksSave: false
    })
    expect(tlsErr.json().message).toContain('NODE_EXTRA_CA_CERTS')

    nextPing = () => {
      throw Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
      })
    }
    const unreachable = await app.inject({
      method: 'POST',
      url: '/api/v1/check/mattermost',
      headers,
      payload: { serverUrl: 'http://10.20.30.40:8065/' }
    })
    expect(unreachable.statusCode).toBe(200)
    expect(unreachable.json()).toMatchObject({
      status: 'unreachable',
      serverUrl: 'http://10.20.30.40:8065',
      ok: false,
      blocksSave: false
    })

    // Save mattermostConnector and verify POST /api/v1/check/mattermost with {} falls back to saved serverUrl.
    const save = await app.inject({
      method: 'PUT',
      url: '/api/v1/deployment-config',
      headers,
      payload: {
        expectedRevision: admin.revision,
        values: {
          ...admin.values,
          logto: {
            ...admin.values.logto!,
            mattermostConnector: {
              serverUrl: 'http://mattermost.internal:8065/sub/',
              clientId: 'mm-oauth-client'
            }
          }
        }
      }
    })
    expect(save.statusCode).toBe(200)

    nextPing = () => Response.json({ status: 'OK' })
    const fromSaved = await app.inject({
      method: 'POST',
      url: '/api/v1/check/mattermost',
      headers
    })
    expect(fromSaved.statusCode).toBe(200)
    expect(fromSaved.json()).toMatchObject({
      status: 'ok',
      serverUrl: 'http://mattermost.internal:8065/sub',
      ok: true,
      blocksSave: false
    })
    expect(seen.at(-1)).toBe('http://mattermost.internal:8065/sub/api/v4/system/ping')
  })

  it('serves the Mattermost connector setup section and controls in setupHtml', async () => {
    const { app } = server()
    const home = await app.inject({ method: 'GET', url: '/' })
    expect(home.statusCode).toBe(200)
    expect(home.body).toContain('id="mattermost-section"')
    expect(home.body).toContain('id="mattermost-server-url-input"')
    expect(home.body).toContain('id="probe-mattermost"')
    expect(home.body).toContain('id="save-mattermost"')
    expect(home.body).toContain('id="check-mattermost"')
    expect(home.body).toContain('id="clear-mattermost"')
  })

  it('rejects DNS SSRF targets (169.254.169.254 / fe80::1) and uses pinned DNS lookup in default buildSetupServer without deps.fetch', async () => {
    let resolvedAddresses: Array<{ address: string; family: number }> = [{ address: '169.254.169.254', family: 4 }]
    const lookup = ((_host: string, opts: unknown, cb: (e: null, a: unknown, f?: number) => void) => {
      if ((opts as { all?: boolean } | undefined)?.all) {
        cb(null, resolvedAddresses)
      } else {
        cb(null, resolvedAddresses[0]!.address, resolvedAddresses[0]!.family)
      }
    }) as unknown as typeof import('node:dns').lookup

    const { app } = server({ omitFetch: true, mattermostLookup: lookup })

    const imdsV4 = await app.inject({
      method: 'POST',
      url: '/api/v1/check/mattermost',
      headers,
      payload: { serverUrl: 'http://rebind.example.test:8065' }
    })
    expect(imdsV4.statusCode).toBe(200)
    expect(imdsV4.json()).toMatchObject({ status: 'invalid_url', ok: false, blocksSave: true })

    resolvedAddresses = [{ address: 'fe80::1', family: 6 }]
    const linkLocalV6 = await app.inject({
      method: 'POST',
      url: '/api/v1/check/mattermost',
      headers,
      payload: { serverUrl: 'http://rebind.example.test:8065' }
    })
    expect(linkLocalV6.statusCode).toBe(200)
    expect(linkLocalV6.json()).toMatchObject({ status: 'invalid_url', ok: false, blocksSave: true })

    const mmServer = createServer((req, res) => {
      expect(req.url).toBe('/api/v4/system/ping')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ status: 'OK' }))
    })
    await new Promise<void>((resolve) => mmServer.listen(0, '127.0.0.1', resolve))
    try {
      const port = (mmServer.address() as { port: number }).port
      resolvedAddresses = [{ address: '127.0.0.1', family: 4 }]
      const okRes = await app.inject({
        method: 'POST',
        url: '/api/v1/check/mattermost',
        headers,
        payload: { serverUrl: `http://intranet-mm.example.test:${port}` }
      })
      expect(okRes.statusCode).toBe(200)
      expect(okRes.json()).toMatchObject({
        status: 'ok',
        serverUrl: `http://intranet-mm.example.test:${port}`,
        ok: true,
        blocksSave: false
      })
    } finally {
      await new Promise<void>((resolve) => mmServer.close(() => resolve()))
    }
  })
})
