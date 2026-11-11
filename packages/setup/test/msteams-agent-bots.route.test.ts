// Setup's agent bots (teams-integration.md §8.6.3): a blueprint entered by hand or created through Graph, checked before it is saved.
import { Script } from 'node:vm'
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
import { SETUP_HTML } from '../src/server/html.js'

const APP_ID = '00000000-0000-4000-8000-0000000000a1'
const HOME = '00000000-0000-4000-8000-0000000000b1'
const BLUEPRINT = '00000000-0000-4000-8000-0000000000c1'
const CREATED = '00000000-0000-4000-8000-0000000000c9'
const SUBSCRIPTION = '00000000-0000-4000-8000-0000000000d1'
const AZURE = { subscriptionId: SUBSCRIPTION, resourceGroup: 'example-bots' }
const headers = { authorization: 'Bearer admin' }

let running: FastifyInstance | undefined
afterEach(async () => {
  await running?.close()
})

interface Microsoft {
  audience?: string
  group?: number
  provider?: string
  graphCreate?: number
}

function server(options: { teams?: boolean; microsoft?: Microsoft } = {}) {
  const ms = options.microsoft ?? {}
  const admin: DeploymentConfigAdmin = {
    schemaVersion: 1,
    revision: 1,
    values: {
      ...DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1,
      auth: {
        mode: 'oidc',
        audience: 'browser-app',
        browserClient: { appId: 'browser-app', apiResource: null },
        socialProviders: ['google', 'azuread'],
        sso: null
      },
      logto: {
        managementAppId: 'management-app',
        managementResource: 'https://login.example.test/api',
        browser: { applicationName: 'AgentConnect', apiResource: null, socialProviders: ['google', 'azuread'] },
        githubConnector: null,
        googleConnector: { clientId: 'google-client' },
        azureadConnector: { clientId: APP_ID }
      },
      msTeams: options.teams === false ? null : { tenantId: HOME }
    },
    secrets: [],
    adminClaimedFor: null,
    updatedAt: new Date('2026-11-01T00:00:00Z')
  }
  admin.adminClaimedFor = deploymentAdminClaimKey(admin.values, 'https://login.example.test/oidc')
  const secrets: Partial<Record<DeploymentSecretKey, string>> = {
    'logto.managementAppSecret': 'management-secret',
    'logto.googleConnectorClientSecret': 'google-secret',
    'logto.azureadConnectorClientSecret': 'app-secret'
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
  const calls: string[] = []
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
    msTeamsBlueprintWait: async () => {},
    fetch: async (input, init) => {
      const url = new URL(String(input))
      calls.push(`${init?.method ?? 'GET'} ${url.host}${url.pathname}`)
      if (url.host === 'login.microsoftonline.com') {
        const form = new URLSearchParams(String(init?.body))
        // The app's and each blueprint's synthetic good secret; anything else is Entra's wrong-secret refusal.
        const good: Record<string, string> = {
          [APP_ID]: 'app-secret',
          [BLUEPRINT]: 'blueprint-secret',
          [CREATED]: 'created-secret'
        }
        return good[form.get('client_id') ?? ''] === form.get('client_secret')
          ? Response.json({ access_token: `token-${form.get('client_id')}`, expires_in: 3599 })
          : Response.json({ error: 'invalid_client', error_codes: [7000215] }, { status: 401 })
      }
      if (url.host === 'graph.microsoft.com') {
        if (url.pathname.endsWith('/addPassword')) return Response.json({ secretText: 'created-secret' })
        if (url.pathname.startsWith('/v1.0/applications(')) {
          return Response.json({ signInAudience: ms.audience ?? 'AzureADMultipleOrgs' })
        }
        if (url.pathname === '/v1.0/applications') {
          return ms.graphCreate
            ? Response.json({ error: { code: 'Authorization_RequestDenied' } }, { status: ms.graphCreate })
            : Response.json({ appId: CREATED }, { status: 201 })
        }
        if (url.pathname.endsWith('agentIdentityBlueprintPrincipal')) return Response.json({ id: 'p' }, { status: 201 })
      }
      if (url.host === 'management.azure.com') {
        if (url.pathname.includes('/resourcegroups/')) return Response.json({}, { status: ms.group ?? 200 })
        return Response.json({ registrationState: ms.provider ?? 'Registered' })
      }
      return new Response(null, { status: 404 })
    }
  })
  running = app
  const post = (url: string, payload: unknown) =>
    app.inject({ method: 'POST', url, headers, payload: payload as object })
  const save = (agentBots: unknown) => post('/api/v1/configure/msteams-agent-bots', { agentBots })
  const create = (payload: unknown) => post('/api/v1/configure/msteams-agent-bots/blueprint', payload)
  return { app, admin, secrets, calls, save, create, post }
}

describe('the agent bots a deployment configures in Setup', () => {
  it('saves a blueprint entered by hand once Microsoft and Azure accept it, and never returns its secret', async () => {
    const { app, admin, secrets, save } = server()
    const entered = { blueprintId: BLUEPRINT.toUpperCase(), clientSecret: 'blueprint-secret', ...AZURE }
    const saved = await save(entered)
    expect(saved.statusCode).toBe(200)
    expect(saved.json()).toEqual({ revision: 2, restartRequired: true, blueprintId: BLUEPRINT })
    expect(admin.values.msTeams).toEqual({ tenantId: HOME, agentBots: { blueprintId: BLUEPRINT, ...AZURE } })
    expect(secrets['msTeams.blueprintClientSecret']).toBe('blueprint-secret')
    const status = await app.inject({ url: '/api/v1/deployment-config', headers })
    expect(status.body).not.toContain('blueprint-secret')

    // The same blueprint keeps its sealed secret, which is checked again; another one needs its own.
    expect((await save({ blueprintId: BLUEPRINT, ...AZURE, resourceGroup: 'moved-bots' })).statusCode).toBe(200)
    expect(admin.values.msTeams?.agentBots?.resourceGroup).toBe('moved-bots')
    expect((await save({ blueprintId: CREATED, ...AZURE })).statusCode).toBe(400)
    expect(admin.values.msTeams?.agentBots?.blueprintId).toBe(BLUEPRINT)

    expect((await save(null)).statusCode).toBe(200)
    expect(admin.values.msTeams).toEqual({ tenantId: HOME, agentBots: null })
    expect(secrets['msTeams.blueprintClientSecret']).toBeUndefined()
  })

  it('needs the Teams app first, and a complete request', async () => {
    const { save, create } = server({ teams: false })
    const entered = { blueprintId: BLUEPRINT, clientSecret: 'blueprint-secret', ...AZURE }
    expect((await save(entered)).statusCode).toBe(409)
    expect((await create({ operator: 'operator@example.test', ...AZURE })).statusCode).toBe(409)
    const ready = server()
    expect((await ready.save({ ...entered, resourceGroup: 'ends-in-a-period.' })).statusCode).toBe(400)
    expect((await ready.save({ ...entered, subscriptionId: 'not-a-guid' })).statusCode).toBe(400)
    expect((await ready.create({ ...AZURE })).statusCode).toBe(400)
    expect(ready.calls).toEqual([])
  })

  it.each([
    [{}, { clientSecret: 'wrong' }, 'MSTEAMS_AGENT_BOTS_BLUEPRINT_CREDENTIALS'],
    [{ audience: 'AzureADMyOrg' }, {}, 'MSTEAMS_AGENT_BOTS_BLUEPRINT_SINGLE_TENANT'],
    [{ group: 403 }, {}, 'MSTEAMS_AGENT_BOTS_RESOURCE_GROUP'],
    [{ provider: 'NotRegistered' }, {}, 'MSTEAMS_AGENT_BOTS_PROVIDER_UNREGISTERED']
  ] as const)('refuses what Microsoft does not accept and saves nothing (%#)', async (microsoft, over, code) => {
    const { admin, save } = server({ microsoft })
    const refused = await save({ blueprintId: BLUEPRINT, clientSecret: 'blueprint-secret', ...AZURE, ...over })
    expect(refused.statusCode).toBe(400)
    expect(refused.json().code).toBe(code)
    expect(admin.values.msTeams).toEqual({ tenantId: HOME })
  })

  it('creates the blueprint through Graph after Azure checks out, and seals its secret unseen', async () => {
    const { admin, secrets, calls, create } = server()
    const made = await create({ operator: 'operator@example.test', ...AZURE })
    expect(made.statusCode).toBe(200)
    expect(made.json()).toEqual({ revision: 2, restartRequired: true, blueprintId: CREATED, check: 'ok' })
    expect(made.body).not.toContain('created-secret')
    expect(admin.values.msTeams?.agentBots).toEqual({ blueprintId: CREATED, ...AZURE })
    expect(secrets['msTeams.blueprintClientSecret']).toBe('created-secret')
    // Azure first, then the blueprint, its principal and its secret.
    const graph = calls.filter((call) => call.includes('graph.microsoft.com') || call.includes('management.azure.com'))
    expect(graph.slice(0, 5)).toEqual([
      expect.stringContaining('/resourcegroups/example-bots'),
      expect.stringContaining('/providers/Microsoft.BotService'),
      'POST graph.microsoft.com/v1.0/applications',
      'POST graph.microsoft.com/v1.0/servicePrincipals/microsoft.graph.agentIdentityBlueprintPrincipal',
      `POST graph.microsoft.com/v1.0/applications(appId='${CREATED}')/addPassword`
    ])
    // A saved blueprint is cleared before another is made.
    expect((await create({ operator: 'operator@example.test', ...AZURE })).statusCode).toBe(409)
  })

  it('makes no blueprint when Azure is not ready, and names the missing permission when Graph refuses', async () => {
    const unready = server({ microsoft: { group: 403 } })
    const refused = await unready.create({ operator: 'operator@example.test', ...AZURE })
    expect(refused.json().code).toBe('MSTEAMS_AGENT_BOTS_RESOURCE_GROUP')
    expect(unready.calls.some((call) => call.includes('graph.microsoft.com'))).toBe(false)

    const denied = server({ microsoft: { graphCreate: 403 } })
    const answer = await denied.create({ operator: 'operator@example.test', ...AZURE })
    expect(answer.statusCode).toBe(400)
    expect(answer.json().code).toBe('MSTEAMS_BLUEPRINT_REFUSED')
    expect(denied.admin.values.msTeams).toEqual({ tenantId: HOME })
  })

  it('keeps agent bots while the Teams app keeps its application and home tenant, and drops them with either', async () => {
    const { admin, secrets, save, post } = server()
    await save({ blueprintId: BLUEPRINT, clientSecret: 'blueprint-secret', ...AZURE })
    const login = (teamsTenantId: string | null) =>
      post('/api/v1/configure/login-app/azuread', { application: { clientId: APP_ID }, teamsTenantId })
    expect((await login(HOME)).statusCode).toBe(200)
    expect(admin.values.msTeams?.agentBots?.blueprintId).toBe(BLUEPRINT)
    expect(secrets['msTeams.blueprintClientSecret']).toBe('blueprint-secret')

    expect((await login(null)).statusCode).toBe(200)
    expect(admin.values.msTeams).toBeNull()
    expect(secrets['msTeams.blueprintClientSecret']).toBeUndefined()
  })

  it('serves a page whose script parses and carries the group', () => {
    const script = /<script>([\s\S]*?)<\/script>/.exec(SETUP_HTML)?.[1]
    expect(script).toBeTruthy()
    expect(() => new Script(`(async () => {${script}\n})`)).not.toThrow()
    for (const id of ['azuread-agent-bots', 'create-azuread-agent-bots-blueprint', 'save-azuread-agent-bots'])
      expect(SETUP_HTML).toContain(`id="${id}"`)
  })
})
