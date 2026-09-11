/**
 * The staged Gitea instance save (gitea-integration.md §3). Two verdicts refuse the save — the URL
 * shape and the 1.23 version floor — and an instance this process cannot reach is saved with the
 * probe verdict attached, because the Control Plane may sit somewhere this process does not.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import {
  DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1,
  type DeploymentConfigStore
} from '@agentconnect.md/control-plane/deployment-config-store'
import { buildSetupServer } from '../src/server/index.js'

const INSTANCE = 'https://gitea.example.test'

let running: FastifyInstance | undefined
afterEach(async () => {
  await running?.close()
  running = undefined
})

interface Replaced {
  values: { gitea?: { baseUrl?: string | null } | null }
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
    updatedAt: new Date('2026-09-12T00:00:00.000Z')
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

const version = (value: string): typeof fetch =>
  (async () =>
    new Response(JSON.stringify({ version: value }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })) as typeof fetch

const configure = (app: FastifyInstance, baseUrl: string) =>
  app.inject({ method: 'POST', url: '/api/v1/configure/gitea', payload: { instance: { baseUrl } } })

describe('POST /api/v1/configure/gitea (§3)', () => {
  it('saves the normalized base URL and the version it read', async () => {
    const { app, writes } = server(version('1.23.1'))

    const response = await configure(app, `${INSTANCE}:8443/gitea/`)
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ revision: 8, restartRequired: true, probe: { status: 'ok' } })
    // No secret travels with a Gitea save: the bot token is per-organization state.
    expect(writes[0]?.values.gitea).toEqual({ baseUrl: `${INSTANCE}:8443/gitea` })
    expect(writes[0]?.secrets).toBeUndefined()
  })

  it('saves an unreachable instance and returns the warning', async () => {
    const { app, writes } = server((async () => {
      throw Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })
      })
    }) as typeof fetch)

    const response = await configure(app, INSTANCE)
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ probe: { status: 'unreachable', baseUrl: INSTANCE } })
    expect(writes[0]?.values.gitea).toEqual({ baseUrl: INSTANCE })
  })

  it('refuses a shape the axis does not accept and writes nothing', async () => {
    const { app, writes } = server(version('1.23.1'))

    const response = await configure(app, 'http://gitea.example.test')
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ code: 'invalid_url' })
    expect(writes).toEqual([])
  })

  it('refuses an instance below the floor and writes nothing', async () => {
    const { app, writes } = server(version('1.22.6'))

    const response = await configure(app, INSTANCE)
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ code: 'instance_version_unsupported' })
    expect(writes).toEqual([])
  })

  it('leaves gitea.com probe-free when the axis is not set', async () => {
    const seen: string[] = []
    const { app, writes } = server((async (input) => {
      seen.push(String(input))
      return new Response('{}', { status: 200 })
    }) as typeof fetch)

    const response = await app.inject({ method: 'POST', url: '/api/v1/configure/gitea', payload: { instance: {} } })
    expect(response.statusCode).toBe(200)
    expect(response.json()).not.toHaveProperty('probe')
    expect(seen).toEqual([])
    expect(writes[0]?.values.gitea).toEqual({ baseUrl: null })
  })

  it('clears the entry when the instance is null', async () => {
    const { app, writes } = server(version('1.23.1'))

    const response = await app.inject({ method: 'POST', url: '/api/v1/configure/gitea', payload: { instance: null } })
    expect(response.statusCode).toBe(200)
    expect(writes[0]?.values.gitea).toBeNull()
  })
})
