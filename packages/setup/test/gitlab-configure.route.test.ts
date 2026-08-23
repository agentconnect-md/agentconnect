/**
 * The staged GitLab instance save (gitlab-com-integration.md §24.2): only the
 * URL shape refuses the save; an instance the Setup Server cannot reach is
 * saved with the probe verdict attached, because the Control Plane may sit
 * somewhere this process does not.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import {
  DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1,
  type DeploymentConfigStore
} from '@agentconnect.md/control-plane/deployment-config-store'
import { buildSetupServer } from '../src/server/index.js'

const INSTANCE = 'https://gitlab.example.test'

let running: FastifyInstance | undefined
afterEach(async () => {
  await running?.close()
  running = undefined
})

interface Replaced {
  values: { gitlab?: { clientId: string; baseUrl?: string | null } | null }
  secrets?: Record<string, string | null>
}

function server(fetchImpl: typeof fetch): { app: FastifyInstance; writes: Replaced[] } {
  const writes: Replaced[] = []
  const admin = {
    schemaVersion: 1 as const,
    revision: 7,
    values: DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1,
    secrets: [],
    adminClaimedFor: null,
    updatedAt: new Date('2026-08-24T00:00:00.000Z')
  }
  const store = {
    getAdmin: async () => admin,
    replace: async (input: Replaced & { expectedRevision: number }) => {
      writes.push({ values: input.values, ...(input.secrets ? { secrets: input.secrets } : {}) })
      return { ...admin, revision: admin.revision + 1 }
    },
    getRuntime: async () => null,
    markAdminClaimed: async () => {}
  } as unknown as DeploymentConfigStore
  const app = buildSetupServer({ store, publicUrl: 'http://localhost:8091', fetch: fetchImpl })
  running = app
  return { app, writes }
}

const configure = (app: FastifyInstance, baseUrl: string) =>
  app.inject({
    method: 'POST',
    url: '/api/v1/configure/gitlab',
    payload: { application: { clientId: 'application-id', clientSecret: 'application-secret', baseUrl } }
  })

describe('POST /api/v1/configure/gitlab (§24.2)', () => {
  it('saves an unreachable instance and returns the warning', async () => {
    const { app, writes } = server((async () => {
      throw Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })
      })
    }) as typeof fetch)

    const response = await configure(app, INSTANCE)
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      revision: 8,
      restartRequired: true,
      probe: { status: 'unreachable', baseUrl: INSTANCE }
    })
    expect(writes[0]?.values.gitlab).toEqual({ clientId: 'application-id', baseUrl: INSTANCE })
  })

  it('refuses a shape the axis does not accept and writes nothing', async () => {
    const seen: string[] = []
    const { app, writes } = server((async (input) => {
      seen.push(String(input))
      return new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch)

    const response = await configure(app, 'http://gitlab.example.test')
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ code: 'invalid_url' })
    expect(writes).toEqual([])
    expect(seen).toEqual([])
  })

  it('saves the normalized base URL when the instance answers as an API root', async () => {
    const { app, writes } = server(
      (async () =>
        new Response(JSON.stringify({ message: '401 Unauthorized' }), {
          status: 401,
          headers: { 'content-type': 'application/json' }
        })) as typeof fetch
    )

    const response = await configure(app, `${INSTANCE}:8443/gitlab/`)
    expect(response.json()).toMatchObject({ probe: { status: 'ok' } })
    expect(writes[0]?.values.gitlab).toEqual({
      clientId: 'application-id',
      baseUrl: `${INSTANCE}:8443/gitlab`
    })
  })

  it('leaves GitLab.com probe-free when the axis is not set', async () => {
    const seen: string[] = []
    const { app, writes } = server((async (input) => {
      seen.push(String(input))
      return new Response('{}', { status: 401 })
    }) as typeof fetch)

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/configure/gitlab',
      payload: { application: { clientId: 'application-id', clientSecret: 'application-secret' } }
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).not.toHaveProperty('probe')
    expect(seen).toEqual([])
    expect(writes[0]?.values.gitlab).toEqual({ clientId: 'application-id', baseUrl: null })
  })
})
