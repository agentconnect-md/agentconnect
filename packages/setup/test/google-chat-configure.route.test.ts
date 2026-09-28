/** The deployment-owned Google Chat app (google-chat-integration.md §3): validated before it is stored, and the key never leaves as plaintext. */
import { generateKeyPairSync } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import {
  DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1,
  type DeploymentConfigStore,
  type DeploymentConfigValuesV1
} from '@agentconnect.md/control-plane/deployment-config-store'
import {
  GOOGLE_CHAT_PROBE_URL,
  GOOGLE_TOKEN_ENDPOINT,
  googleCloudProjectUrl
} from '@agentconnect.md/control-plane/google-chat-credential'
import { buildSetupServer } from '../src/server/index.js'

const PROJECT_ID = 'example-project'
const PROJECT_NUMBER = '123456789012'
const CRM_URL = googleCloudProjectUrl(PROJECT_ID)
const { privateKey: PRIVATE_KEY } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
})
const KEY = JSON.stringify({
  type: 'service_account',
  project_id: PROJECT_ID,
  private_key: PRIVATE_KEY,
  client_email: `agentconnect-chat@${PROJECT_ID}.iam.gserviceaccount.com`
})
const HTTPS_SERVICES = {
  web: 'https://console.example.test',
  controlPlane: 'https://api.example.test',
  relay: 'https://relay.example.test'
}

let running: FastifyInstance | undefined
afterEach(async () => {
  await running?.close()
  running = undefined
})

interface Replaced {
  values: DeploymentConfigValuesV1
  secrets?: Record<string, string | null>
}

type GoogleAnswer = 'ok' | 'rejected' | 'offline' | 'crm_disabled' | 'crm_forbidden'

function server(
  options: {
    values?: DeploymentConfigValuesV1
    storedKey?: string
    google?: GoogleAnswer
    services?: typeof HTTPS_SERVICES
  } = {}
) {
  const writes: Replaced[] = []
  const requests: string[] = []
  const admin = {
    schemaVersion: 1 as const,
    revision: 3,
    values: options.values ?? DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1,
    secrets: [] as { key: string; configured: boolean; fingerprint: string | null; updatedAt: Date | null }[],
    adminClaimedFor: null,
    updatedAt: new Date('2026-09-27T00:00:00.000Z')
  }
  const store = {
    getAdmin: async () => admin,
    replace: async (input: Replaced & { expectedRevision: number }) => {
      writes.push({ values: input.values, ...(input.secrets ? { secrets: input.secrets } : {}) })
      admin.values = input.values
      admin.revision += 1
      for (const [key, value] of Object.entries(input.secrets ?? {})) {
        admin.secrets = admin.secrets.filter((secret) => secret.key !== key)
        if (value !== null) {
          admin.secrets.push({ key, configured: true, fingerprint: 'sha256:fingerprint', updatedAt: admin.updatedAt })
        }
      }
      return admin
    },
    getRuntime: async () => ({
      schemaVersion: 1 as const,
      revision: admin.revision,
      values: admin.values,
      secrets: options.storedKey ? { 'googleChat.serviceAccountKey': options.storedKey } : {},
      updatedAt: admin.updatedAt
    }),
    markAdminClaimed: async () => {}
  } as unknown as DeploymentConfigStore
  const google = options.google ?? 'ok'
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input)
    requests.push(url)
    if (google === 'offline') throw new TypeError('fetch failed')
    if (url === GOOGLE_TOKEN_ENDPOINT) {
      return google === 'rejected'
        ? Response.json({ error: 'invalid_grant', error_description: 'Invalid JWT Signature.' }, { status: 400 })
        : Response.json({ access_token: 'synthetic-access-token' })
    }
    if (url === CRM_URL) {
      if (google === 'crm_disabled' || google === 'crm_forbidden') {
        const details = google === 'crm_disabled' ? [{ reason: 'SERVICE_DISABLED' }] : []
        return Response.json({ error: { code: 403, status: 'PERMISSION_DENIED', details } }, { status: 403 })
      }
      return Response.json({ projectNumber: PROJECT_NUMBER, projectId: PROJECT_ID })
    }
    if (url === GOOGLE_CHAT_PROBE_URL) return Response.json({ spaces: [] })
    throw new Error(`unexpected request to ${url}`)
  }) as typeof fetch
  const app = buildSetupServer({
    store,
    publicUrl: 'http://localhost:8091',
    fetch: fetchImpl,
    now: () => new Date('2026-09-27T00:00:00.000Z'),
    localAuthBootstrap: { issuer: 'http://localhost:3001/oidc', services: options.services ?? HTTPS_SERVICES }
  })
  running = app
  return { app, writes, requests }
}

const configure = (app: FastifyInstance, application: unknown) =>
  app.inject({ method: 'POST', url: '/api/v1/configure/google-chat', payload: { application } })

const configured = {
  ...DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1,
  googleChat: { projectId: PROJECT_ID, projectNumber: PROJECT_NUMBER }
}

describe('POST /api/v1/configure/google-chat (§3)', () => {
  it('validates the key, stores it write-only, and returns what to copy into Google Cloud Console', async () => {
    const { app, writes, requests } = server()

    const response = await configure(app, {
      projectId: PROJECT_ID,
      projectNumber: PROJECT_NUMBER,
      serviceAccountKey: KEY
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      revision: 4,
      restartRequired: true,
      callbackUrl: 'https://relay.example.test/googlechat/events',
      probe: { status: 'ok' }
    })
    expect(requests).toEqual([GOOGLE_TOKEN_ENDPOINT, CRM_URL, GOOGLE_TOKEN_ENDPOINT, GOOGLE_CHAT_PROBE_URL])
    expect(writes[0]?.values.googleChat).toEqual({ projectId: PROJECT_ID, projectNumber: PROJECT_NUMBER })
    expect(JSON.parse(writes[0]?.secrets?.['googleChat.serviceAccountKey'] ?? '{}')).toEqual(JSON.parse(KEY))
    expect(response.body).not.toContain('PRIVATE KEY')
  })

  it('reports the stored key only as configured on the admin read', async () => {
    const { app } = server()
    await configure(app, { projectId: PROJECT_ID, projectNumber: PROJECT_NUMBER, serviceAccountKey: KEY })

    const status = await app.inject({ method: 'GET', url: '/api/v1/deployment-config' })
    expect(status.statusCode).toBe(200)
    expect(status.json().providerExpectations.googleChat).toEqual({
      callbackUrl: 'https://relay.example.test/googlechat/events',
      configurationUrl: expect.stringContaining('chat.googleapis.com')
    })
    expect(status.json().secrets).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: 'googleChat.serviceAccountKey', configured: true })])
    )
    expect(status.body).not.toContain('PRIVATE KEY')
  })

  it('refuses a key whose project_id was edited away from its service account’s project', async () => {
    const { app, writes, requests } = server()

    const response = await configure(app, {
      projectId: 'other-example-project',
      serviceAccountKey: JSON.stringify({ ...JSON.parse(KEY), project_id: 'other-example-project' })
    })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({
      code: 'invalid_key',
      message: `the key's project_id other-example-project does not match its service account's project ${PROJECT_ID}`
    })
    expect(requests).toEqual([])
    expect(writes).toEqual([])
  })

  it('refuses a key from another project before calling Google', async () => {
    const { app, writes, requests } = server()

    const response = await configure(app, {
      projectId: 'other-example-project',
      projectNumber: PROJECT_NUMBER,
      serviceAccountKey: KEY
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().code).toBe('project_mismatch')
    expect(requests).toEqual([])
    expect(writes).toEqual([])
  })

  it('refuses a non-numeric project number', async () => {
    const { app, writes, requests } = server()

    const response = await configure(app, { projectId: PROJECT_ID, projectNumber: 'example', serviceAccountKey: KEY })
    expect(response.statusCode).toBe(400)
    expect(requests).toEqual([])
    expect(writes).toEqual([])
  })

  it('answers a rejected key as an authentication failure and saves nothing', async () => {
    const { app, writes } = server({ google: 'rejected' })

    const response = await configure(app, {
      projectId: PROJECT_ID,
      projectNumber: PROJECT_NUMBER,
      serviceAccountKey: KEY
    })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({
      code: 'key_rejected',
      message: expect.stringMatching(/^Authentication failed/)
    })
    expect(response.body).not.toContain('PRIVATE KEY')
    expect(writes).toEqual([])
  })

  it('answers an unreachable Google as a connectivity failure and saves nothing', async () => {
    const { app, writes } = server({ google: 'offline' })

    const response = await configure(app, {
      projectId: PROJECT_ID,
      projectNumber: PROJECT_NUMBER,
      serviceAccountKey: KEY
    })
    expect(response.statusCode).toBe(502)
    expect(response.json()).toMatchObject({ code: 'unreachable', message: expect.stringMatching(/^Connection failed/) })
    expect(writes).toEqual([])
  })

  it('needs an HTTPS ingress URL to publish the HTTP endpoint', async () => {
    const { app, writes, requests } = server({
      services: { web: 'http://localhost:3000', controlPlane: 'http://localhost:8080', relay: 'http://localhost:8090' }
    })

    const response = await configure(app, {
      projectId: PROJECT_ID,
      projectNumber: PROJECT_NUMBER,
      serviceAccountKey: KEY
    })
    expect(response.statusCode).toBe(409)
    expect(requests).toEqual([])
    expect(writes).toEqual([])
  })

  it('stores the number resolved from the key when none is entered', async () => {
    const { app, writes } = server()

    const response = await configure(app, { projectId: PROJECT_ID, serviceAccountKey: KEY })
    expect(response.statusCode).toBe(200)
    expect(writes[0]?.values.googleChat).toEqual({ projectId: PROJECT_ID, projectNumber: PROJECT_NUMBER })
  })

  it('refuses an entered number that is not the key’s project and saves nothing', async () => {
    const { app, writes, requests } = server()

    const response = await configure(app, {
      projectId: PROJECT_ID,
      projectNumber: '210987654321',
      serviceAccountKey: KEY
    })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({
      code: 'project_number_mismatch',
      message: `the project number 210987654321 does not match project ${PROJECT_ID}, whose number is ${PROJECT_NUMBER}`
    })
    expect(requests).not.toContain(GOOGLE_CHAT_PROBE_URL)
    expect(writes).toEqual([])
  })

  it('names the Cloud Resource Manager API and the Browser role when the project cannot be read', async () => {
    const disabled = await configure(server({ google: 'crm_disabled' }).app, {
      projectId: PROJECT_ID,
      serviceAccountKey: KEY
    })
    expect(disabled.statusCode).toBe(400)
    expect(disabled.json()).toMatchObject({
      code: 'crm_disabled',
      message: expect.stringMatching(/^Enable the Cloud Resource Manager API/)
    })
    await running?.close()
    const forbidden = await configure(server({ google: 'crm_forbidden' }).app, {
      projectId: PROJECT_ID,
      serviceAccountKey: KEY
    })
    expect(forbidden.statusCode).toBe(400)
    expect(forbidden.json()).toMatchObject({ code: 'crm_forbidden', message: expect.stringMatching(/Browser role/) })
  })

  it('re-validates the stored key when the project is unchanged', async () => {
    const { app, writes, requests } = server({ values: configured, storedKey: KEY })

    const response = await configure(app, { projectId: PROJECT_ID, projectNumber: PROJECT_NUMBER })
    expect(response.statusCode).toBe(200)
    expect(requests).toEqual([GOOGLE_TOKEN_ENDPOINT, CRM_URL, GOOGLE_TOKEN_ENDPOINT, GOOGLE_CHAT_PROBE_URL])
    expect(writes[0]?.values.googleChat).toEqual({ projectId: PROJECT_ID, projectNumber: PROJECT_NUMBER })
    expect(writes[0]?.secrets).toBeUndefined()
  })

  it('describes one app that every Google Workspace organization claims', async () => {
    const { app } = server()

    const page = await app.inject({ method: 'GET', url: '/' })
    expect(page.statusCode).toBe(200)
    expect(page.body).toContain('Each Google Workspace organization connects itself from Google Chat.')
    expect(page.body).toContain('Configure Google sign-in above')
    expect(page.body).toContain('add a slash command named /help')
  })

  it('requires a key for a different project', async () => {
    const { app, writes, requests } = server({ values: configured, storedKey: KEY })

    const response = await configure(app, { projectId: 'other-example-project', projectNumber: PROJECT_NUMBER })
    expect(response.statusCode).toBe(400)
    expect(requests).toEqual([])
    expect(writes).toEqual([])
  })

  it('clears the app and its key together', async () => {
    const { app, writes, requests } = server({ values: configured, storedKey: KEY })

    const response = await configure(app, null)
    expect(response.statusCode).toBe(200)
    expect(requests).toEqual([])
    expect(writes[0]?.values.googleChat).toBeNull()
    expect(writes[0]?.secrets).toEqual({ 'googleChat.serviceAccountKey': null })
  })
})
