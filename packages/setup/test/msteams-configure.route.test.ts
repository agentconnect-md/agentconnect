/** The deployment-owned Teams app (teams-integration.md §8.2): checked with a client-credentials token before it is stored, the secret write-only. */
import { afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import {
  DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1,
  type DeploymentConfigStore,
  type DeploymentConfigValuesV1
} from '@agentconnect.md/control-plane/deployment-config-store'
import { buildSetupServer } from '../src/server/index.js'

const APP_ID = '33333333-3333-4333-8333-333333333333'
const TENANT_ID = '44444444-4444-4444-8444-444444444444'
const TOKEN_URL = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`
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

function server(
  options: { values?: DeploymentConfigValuesV1; storedSecret?: string; entra?: 'ok' | 'rejected' | 'offline' } = {}
) {
  const writes: Replaced[] = []
  const requests: string[] = []
  const admin = {
    schemaVersion: 1 as const,
    revision: 3,
    values: options.values ?? DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1,
    secrets: [] as { key: string; configured: boolean; fingerprint: string | null; updatedAt: Date | null }[],
    adminClaimedFor: null,
    updatedAt: new Date('2026-12-01T00:00:00.000Z')
  }
  const store = {
    getAdmin: async () => admin,
    replace: async (input: Replaced & { expectedRevision: number }) => {
      writes.push({ values: input.values, ...(input.secrets ? { secrets: input.secrets } : {}) })
      admin.values = input.values
      admin.revision += 1
      return admin
    },
    getRuntime: async () => ({
      schemaVersion: 1 as const,
      revision: admin.revision,
      values: admin.values,
      secrets: options.storedSecret ? { 'msTeams.clientSecret': options.storedSecret } : {},
      updatedAt: admin.updatedAt
    }),
    markAdminClaimed: async () => {}
  } as unknown as DeploymentConfigStore
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input)
    requests.push(url)
    if (options.entra === 'offline') throw new TypeError('fetch failed')
    if (url !== TOKEN_URL) throw new Error(`unexpected request to ${url}`)
    return options.entra === 'rejected'
      ? Response.json({ error: 'invalid_client', error_codes: [7000215] }, { status: 401 })
      : Response.json({ access_token: 'synthetic-access-token', expires_in: 3599 })
  }) as typeof fetch
  const app = buildSetupServer({
    store,
    publicUrl: 'http://localhost:8091',
    fetch: fetchImpl,
    now: () => new Date('2026-12-01T00:00:00.000Z'),
    localAuthBootstrap: { issuer: 'http://localhost:3001/oidc', services: HTTPS_SERVICES }
  })
  running = app
  return { app, writes, requests }
}

const configure = (app: FastifyInstance, application: unknown) =>
  app.inject({ method: 'POST', url: '/api/v1/configure/msteams', payload: { application } })

describe('POST /api/v1/configure/msteams (§8.2)', () => {
  it('checks the secret, stores it write-only, and answers the endpoints to register', async () => {
    const { app, writes, requests } = server()
    const response = await configure(app, { appId: APP_ID.toUpperCase(), tenantId: TENANT_ID, clientSecret: 's3cret' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      restartRequired: true,
      messagingEndpoint: 'https://relay.example.test/msteams/messages',
      connectRedirectUri: 'https://console.example.test/msteams/connect'
    })
    expect(requests).toEqual([TOKEN_URL])
    expect(writes[0]?.values.msTeams).toEqual({ appId: APP_ID, tenantId: TENANT_ID })
    expect(writes[0]?.secrets).toEqual({ 'msTeams.clientSecret': 's3cret' })
    expect(response.body).not.toContain('s3cret')
  })

  it('refuses a secret Entra rejects and stores nothing', async () => {
    const { app, writes } = server({ entra: 'rejected' })
    const response = await configure(app, { appId: APP_ID, tenantId: TENANT_ID, clientSecret: 'wrong' })
    expect(response.statusCode).toBe(400)
    expect(writes).toEqual([])
  })

  it('re-checks the stored secret of the same app, and asks for one when the app changes', async () => {
    const values = { ...DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1, msTeams: { appId: APP_ID, tenantId: TENANT_ID } }
    const same = server({ values, storedSecret: 'stored' })
    const kept = await configure(same.app, { appId: APP_ID, tenantId: TENANT_ID })
    expect(kept.statusCode).toBe(200)
    expect(same.writes[0]).not.toHaveProperty('secrets')
    const other = server({ values, storedSecret: 'stored' })
    const changed = await configure(other.app, { appId: '55555555-5555-4555-8555-555555555555', tenantId: TENANT_ID })
    expect(changed.statusCode).toBe(400)
    expect(other.writes).toEqual([])
  })

  it('clears the app and its secret', async () => {
    const values = { ...DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1, msTeams: { appId: APP_ID, tenantId: TENANT_ID } }
    const { app, writes } = server({ values })
    expect((await configure(app, null)).statusCode).toBe(200)
    expect(writes[0]).toMatchObject({ values: { msTeams: null }, secrets: { 'msTeams.clientSecret': null } })
  })
})
