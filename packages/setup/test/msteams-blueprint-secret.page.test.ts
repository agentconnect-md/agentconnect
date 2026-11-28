// @vitest-environment happy-dom
/** The Setup page's agent-bots group against the real routes: a saved blueprint's secret is replaced in place, keeping the blueprint. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { HTMLElement, HTMLInputElement, Window } from 'happy-dom'
import {
  DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1,
  type DeploymentConfigStore,
  type DeploymentConfigValuesV1
} from '@agentconnect.md/control-plane/deployment-config-store'
import { buildSetupServer } from '../src/server/index.js'
import { SETUP_HTML } from '../src/server/html.js'

const APP_ID = '00000000-0000-4000-8000-0000000000a1'
const HOME = '00000000-0000-4000-8000-0000000000b1'
const BLUEPRINT = '00000000-0000-4000-8000-0000000000c1'
const AGENT_BOTS = {
  blueprintId: BLUEPRINT,
  subscriptionId: '00000000-0000-4000-8000-0000000000d1',
  resourceGroup: 'example-bots'
}
const SECRET_KEY = 'msTeams.blueprintClientSecret'

let running: FastifyInstance | undefined
afterEach(async () => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  await running?.close()
  running = undefined
})

beforeEach(() => {
  sessionStorage.clear()
  localStorage.clear()
})

function values(agentBots: typeof AGENT_BOTS | null): DeploymentConfigValuesV1 {
  return {
    ...DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1,
    auth: {
      mode: 'oidc',
      audience: 'browser-app',
      browserClient: { appId: 'browser-app', apiResource: null },
      socialProviders: ['azuread'],
      sso: null
    },
    logto: {
      managementAppId: 'management-app',
      managementResource: 'https://login.example.test/api',
      browser: { applicationName: 'AgentConnect', apiResource: null, socialProviders: ['azuread'] },
      githubConnector: null,
      googleConnector: null,
      azureadConnector: { clientId: APP_ID }
    },
    msTeams: { tenantId: HOME, ...(agentBots ? { agentBots } : {}) }
  } as DeploymentConfigValuesV1
}

function server(initialValues: DeploymentConfigValuesV1, initial: Record<string, string>) {
  const sealed = new Map(Object.entries(initial))
  const rows = () =>
    [...sealed.keys()].map((key) => ({
      key,
      configured: true,
      fingerprint: 'sha256:fingerprint',
      updatedAt: new Date(0)
    }))
  const admin = {
    schemaVersion: 1 as const,
    revision: 4,
    values: initialValues,
    secrets: rows(),
    adminClaimedFor: null,
    updatedAt: new Date(0)
  }
  const store = {
    getAdmin: async () => admin,
    replace: async (input: { values: DeploymentConfigValuesV1; secrets?: Record<string, string | null> }) => {
      admin.values = input.values
      admin.revision += 1
      for (const [key, value] of Object.entries(input.secrets ?? {})) {
        if (value === null) sealed.delete(key)
        else sealed.set(key, value)
      }
      admin.secrets = rows()
      return admin
    },
    getRuntime: async () => ({ values: admin.values, secrets: Object.fromEntries(sealed) }),
    markAdminClaimed: async () => {}
  } as unknown as DeploymentConfigStore
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
    }
  })
  running = app
  return { app, sealed, admin }
}

/** Boots the page with its requests answered by the real routes, as a signed-in administrator. */
async function openPage(app: FastifyInstance) {
  vi.stubGlobal('fetch', async (input: string, init: RequestInit = {}) => {
    const url = String(input)
    if (url === '/api/v1/auth-config') return Response.json({ mode: 'oidc', claimAvailable: false })
    if (url === '/api/v1/check/logto') return Response.json({ findings: [] })
    const reply = await app.inject({
      method: (init.method ?? 'GET') as 'GET',
      url,
      ...(init.body ? { payload: String(init.body), headers: { 'content-type': 'application/json' } } : {})
    })
    return new Response(reply.body, { status: reply.statusCode, headers: { 'content-type': 'application/json' } })
  })
  sessionStorage.setItem('agentconnect.setup.token', 'example-id-token')
  const body = /<body>([\s\S]*)<script>/.exec(SETUP_HTML)![1]!
  const script = /<script>([\s\S]*?)<\/script>/.exec(SETUP_HTML)![1]!
  page.document.body.innerHTML = body
  new Function(script)()
  await vi.waitFor(() => expect(byId('setup').hidden).toBe(false))
}

const page = globalThis as unknown as Window
const byId = (id: string) => page.document.getElementById(id) as HTMLElement
const editButton = () =>
  page.document.querySelector('[data-secret-display="azuread-agent-bots-secret"]') as unknown as HTMLElement

describe('Setup page: agent bots blueprint secret', () => {
  it('replaces a saved blueprint secret in place and keeps the blueprint', async () => {
    const { app, sealed, admin } = server(values(AGENT_BOTS), { [SECRET_KEY]: 'blueprint-secret-v1' })
    await openPage(app)

    await vi.waitFor(() => expect(byId('azuread-agent-bots-secret').textContent).toBe('***'))
    expect(editButton().hidden).toBe(false)
    // The entry form stays hidden: replacing the secret must not need the blueprint cleared first.
    expect(byId('azuread-agent-bots-controls').hidden).toBe(true)

    editButton().click()
    const row = editButton().closest('.secret-line') as unknown as HTMLElement
    const field = row.querySelector('.secret-editor input') as unknown as HTMLInputElement
    field.value = 'blueprint-secret-v2'
    ;(row.querySelector('.secret-editor button') as unknown as HTMLElement).click()

    await vi.waitFor(() => expect(sealed.get(SECRET_KEY)).toBe('blueprint-secret-v2'))
    expect(admin.values.msTeams?.agentBots).toEqual(AGENT_BOTS)
    await vi.waitFor(() => expect(byId('message').textContent).toMatch(/Secret replaced/))
  })

  it('offers no replacement before a blueprint is saved', async () => {
    const { app } = server(values(null), {})
    await openPage(app)

    await vi.waitFor(() => expect(byId('azuread-agent-bots').hidden).toBe(false))
    expect(byId('azuread-agent-bots-secret').textContent).toBe('Not configured')
    expect(editButton().hidden).toBe(true)
    expect(byId('azuread-agent-bots-controls').hidden).toBe(false)
  })
})
