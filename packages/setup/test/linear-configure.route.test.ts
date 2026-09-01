/**
 * The deployment's one Linear OAuth app (linear-integration.md §7.1): the client id is
 * plain document state, and the client secret plus the webhook signing secret are
 * write-only entries the admin surface only ever reports as configured.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import {
  DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1,
  type DeploymentConfigStore,
  type DeploymentConfigValuesV1
} from '@agentconnect.md/control-plane/deployment-config-store'
import { buildSetupServer } from '../src/server/index.js'

const CLIENT_ID = 'linear-client-id'
const CLIENT_SECRET = 'linear-client-secret'
const SIGNING_SECRET = 'linear-signing-secret'

let running: FastifyInstance | undefined
afterEach(async () => {
  await running?.close()
  running = undefined
})

interface Replaced {
  values: DeploymentConfigValuesV1
  secrets?: Record<string, string | null>
}

function server(values: DeploymentConfigValuesV1 = DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1): {
  app: FastifyInstance
  writes: Replaced[]
} {
  const writes: Replaced[] = []
  const admin = {
    schemaVersion: 1 as const,
    revision: 4,
    values,
    // Redacted status rows, exactly as the store projects them: never a value.
    secrets: [] as { key: string; configured: boolean; fingerprint: string | null; updatedAt: Date | null }[],
    adminClaimedFor: null,
    updatedAt: new Date('2026-09-01T00:00:00.000Z')
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
    getRuntime: async () => null,
    markAdminClaimed: async () => {}
  } as unknown as DeploymentConfigStore
  const app = buildSetupServer({ store, publicUrl: 'http://localhost:8091' })
  running = app
  return { app, writes }
}

const configure = (app: FastifyInstance, application: unknown) =>
  app.inject({ method: 'POST', url: '/api/v1/configure/linear', payload: { application } })

describe('POST /api/v1/configure/linear (§7.1)', () => {
  it('saves the client id as document state and both secrets as write-only entries', async () => {
    const { app, writes } = server()

    const response = await configure(app, {
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      signingSecret: SIGNING_SECRET
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ revision: 5, restartRequired: true })
    expect(writes[0]?.values.linear).toEqual({ clientId: CLIENT_ID })
    expect(writes[0]?.secrets).toEqual({
      'linear.clientSecret': CLIENT_SECRET,
      'linear.signingSecret': SIGNING_SECRET
    })
  })

  it('never echoes either secret back to the browser', async () => {
    const { app } = server()

    const response = await configure(app, {
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      signingSecret: SIGNING_SECRET
    })
    expect(response.body).not.toContain(CLIENT_SECRET)
    expect(response.body).not.toContain(SIGNING_SECRET)
  })

  it('reports the saved secrets only as configured on the admin read', async () => {
    const { app } = server()
    await configure(app, { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, signingSecret: SIGNING_SECRET })

    const status = await app.inject({ method: 'GET', url: '/api/v1/deployment-config' })
    expect(status.statusCode).toBe(200)
    const keys = (status.json().secrets as { key: string }[]).map((secret) => secret.key)
    expect(keys).toEqual(expect.arrayContaining(['linear.clientSecret', 'linear.signingSecret']))
    expect(status.body).not.toContain(CLIENT_SECRET)
    expect(status.body).not.toContain(SIGNING_SECRET)
  })

  it('refuses a new client id that arrives without both secrets and writes nothing', async () => {
    const { app, writes } = server()

    const response = await configure(app, { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET })
    expect(response.statusCode).toBe(400)
    expect(response.json().message).toMatch(/requires both/)
    expect(writes).toEqual([])
  })

  it('refuses a blank client id and writes nothing', async () => {
    const { app, writes } = server()

    const response = await configure(app, { clientId: '   ' })
    expect(response.statusCode).toBe(400)
    expect(writes).toEqual([])
  })

  it('clears the application and both secrets together', async () => {
    const { app, writes } = server({ ...DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1, linear: { clientId: CLIENT_ID } })

    const response = await configure(app, null)
    expect(response.statusCode).toBe(200)
    expect(writes[0]?.values.linear).toBeNull()
    expect(writes[0]?.secrets).toEqual({ 'linear.clientSecret': null, 'linear.signingSecret': null })
  })
})
