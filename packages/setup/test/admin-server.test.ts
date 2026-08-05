import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1,
  DEPLOYMENT_SECRET_KEYS,
  deploymentAdminClaimKey,
  type DeploymentConfigAdmin,
  type DeploymentConfigRuntime,
  type DeploymentConfigStore,
  type DeploymentConfigValuesV1
} from '@agentconnect.md/control-plane/deployment-config-store'
import { LogtoManagementError } from '../src/admin/logto-management.js'
import { buildTenantAdminServer } from '../src/admin/server.js'

const updatedAt = new Date('2026-08-05T00:00:00.000Z')

const oidcValues: DeploymentConfigValuesV1 = {
  ...DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1,
  auth: {
    mode: 'oidc',
    issuer: 'https://login.example.test/oidc',
    audience: 'https://cp.example.test/api',
    browserClient: {
      endpoint: 'https://login.example.test',
      appId: 'browser-app-id',
      apiResource: 'https://cp.example.test/api'
    },
    socialProviders: ['github']
  },
  logto: {
    managementEndpoint: 'https://login.example.test',
    managementAppId: 'management-app-id',
    managementResource: 'https://login.example.test/api'
  }
}

function admin(values: DeploymentConfigValuesV1): DeploymentConfigAdmin {
  return {
    schemaVersion: 1,
    revision: 1,
    values,
    adminClaimedFor: deploymentAdminClaimKey(values),
    secrets: DEPLOYMENT_SECRET_KEYS.map((key) => ({
      key,
      configured: key === 'logto.managementAppSecret',
      fingerprint: key === 'logto.managementAppSecret' ? 'sha256:test' : null,
      updatedAt: key === 'logto.managementAppSecret' ? updatedAt : null
    })),
    updatedAt
  }
}

function store(
  current: DeploymentConfigAdmin | null,
  runtime: DeploymentConfigRuntime | null = null
): DeploymentConfigStore {
  return {
    getAdmin: async () => current,
    getRuntime: async () => runtime,
    replace: async (input) => {
      current = {
        ...admin(input.values),
        revision: (current?.revision ?? 0) + 1,
        adminClaimedFor: current?.adminClaimedFor ?? null
      }
      return current
    },
    markAdminClaimed: async (_expectedRevision, claimedFor) => {
      if (current) current = { ...current, adminClaimedFor: claimedFor }
    }
  }
}

describe('tenant-admin server boundary', () => {
  it('allows unconfigured access only through a loopback Host', async () => {
    const app = buildTenantAdminServer({ store: store(null), publicUrl: 'http://localhost:8091' })
    const local = await app.inject({
      method: 'GET',
      url: '/api/v1/deployment-config',
      headers: { host: 'localhost:8091' }
    })
    const logto = await app.inject({ method: 'GET', url: '/api/v1/check/logto', headers: { host: 'localhost:8091' } })
    const remote = await app.inject({
      method: 'GET',
      url: '/api/v1/deployment-config',
      headers: { host: 'admin.example.test' }
    })
    await app.close()

    expect(local.statusCode).toBe(200)
    expect(local.json()).toMatchObject({ configured: false, revision: 0, values: DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1 })
    expect(logto.json()).toMatchObject({
      findings: [
        { id: 'logto.configuration', status: 'fail', message: 'Deployment configuration has not been saved.' }
      ],
      summary: { pass: 0, fail: 1, unknown: 0 }
    })
    expect(remote.statusCode).toBe(403)
  })

  it('requires an exact ADMIN role and validates the ID-token browser audience', async () => {
    const seen: unknown[] = []
    const app = buildTenantAdminServer({
      store: store(admin(oidcValues)),
      publicUrl: 'http://localhost:8091',
      verifyOidcToken: async (_token, config) => {
        seen.push(config)
        return { sub: 'operator', roles: ['ADMIN'] }
      }
    })
    const missing = await app.inject({ method: 'GET', url: '/api/v1/deployment-config' })
    const allowed = await app.inject({
      method: 'GET',
      url: '/api/v1/deployment-config',
      headers: { authorization: 'Bearer id-token' }
    })
    await app.close()

    expect(missing.statusCode).toBe(401)
    expect(allowed.statusCode).toBe(200)
    expect(seen).toEqual([{ issuer: 'https://login.example.test/oidc', audience: 'browser-app-id' }])
  })

  it('keeps loopback repair access open until ADMIN is successfully claimed', async () => {
    const unclaimed = admin(oidcValues)
    unclaimed.adminClaimedFor = null
    const app = buildTenantAdminServer({ store: store(unclaimed), publicUrl: 'http://localhost:8091' })

    const local = await app.inject({
      method: 'GET',
      url: '/api/v1/deployment-config',
      headers: { host: 'localhost:8091' }
    })
    const remote = await app.inject({
      method: 'GET',
      url: '/api/v1/deployment-config',
      headers: { host: 'admin.example.test' }
    })
    await app.close()

    expect(local.statusCode).toBe(200)
    expect(remote.statusCode).toBe(403)
  })

  it('requires the last observed revision on configuration writes', async () => {
    const app = buildTenantAdminServer({
      store: store(admin(DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1)),
      publicUrl: 'http://localhost:8091'
    })
    const staleShape = await app.inject({
      method: 'PUT',
      url: '/api/v1/deployment-config',
      headers: { host: 'localhost:8091' },
      payload: { values: DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1 }
    })
    const saved = await app.inject({
      method: 'PUT',
      url: '/api/v1/deployment-config',
      headers: { host: 'localhost:8091' },
      payload: { expectedRevision: 1, values: DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1 }
    })
    await app.close()

    expect(staleShape.statusCode).toBe(400)
    expect(saved.statusCode).toBe(200)
    expect(saved.json().revision).toBe(2)
  })

  it('lets any verified local operator claim the shared ADMIN role', async () => {
    const claimed: string[] = []
    const runtime: DeploymentConfigRuntime = {
      schemaVersion: 1,
      revision: 1,
      values: oidcValues,
      secrets: { 'logto.managementAppSecret': 'management-secret' },
      updatedAt
    }
    const record = admin(oidcValues)
    record.adminClaimedFor = null
    const deploymentStore = store(record, runtime)
    const app = buildTenantAdminServer({
      store: deploymentStore,
      publicUrl: 'http://localhost:8091',
      verifyOidcToken: async () => ({ sub: 'another-operator' }),
      makeLogtoClaimClient: () => ({ assignAdmin: async (subject) => void claimed.push(subject) })
    })
    const result = await app.inject({
      method: 'POST',
      url: '/api/v1/bootstrap/claim',
      headers: { host: 'localhost:8091', authorization: 'Bearer id-token' }
    })
    await app.close()

    expect(result.statusCode).toBe(200)
    expect(result.json()).toEqual({ claimed: true, reloginRequired: true })
    expect(claimed).toEqual(['another-operator'])
    expect((await deploymentStore.getAdmin())?.adminClaimedFor).toBe(deploymentAdminClaimKey(oidcValues))
  })

  it('closes self-claim after ADMIN has been claimed for the current OIDC application', async () => {
    const claimed: string[] = []
    const runtime: DeploymentConfigRuntime = {
      schemaVersion: 1,
      revision: 1,
      values: oidcValues,
      secrets: { 'logto.managementAppSecret': 'management-secret' },
      updatedAt
    }
    const app = buildTenantAdminServer({
      store: store(admin(oidcValues), runtime),
      publicUrl: 'http://localhost:8091',
      fetch: (async () =>
        new Response(
          JSON.stringify({
            authorization_endpoint: 'https://login.example.test/oidc/auth',
            token_endpoint: 'https://login.example.test/oidc/token'
          }),
          { headers: { 'content-type': 'application/json' } }
        )) as typeof fetch,
      verifyOidcToken: async () => ({ sub: 'later-operator' }),
      makeLogtoClaimClient: () => ({ assignAdmin: async (subject) => void claimed.push(subject) })
    })
    const result = await app.inject({
      method: 'POST',
      url: '/api/v1/bootstrap/claim',
      headers: { host: 'localhost:8091', authorization: 'Bearer id-token' }
    })
    const authConfig = await app.inject({ method: 'GET', url: '/api/v1/auth-config' })
    await app.close()

    expect(result.statusCode).toBe(409)
    expect(result.json()).toMatchObject({ code: 'ADMIN_ALREADY_CLAIMED' })
    expect(authConfig.json()).toMatchObject({ mode: 'oidc', claimAvailable: false })
    expect(claimed).toEqual([])
  })

  it('serializes concurrent first claims so only one identity is promoted', async () => {
    const runtime: DeploymentConfigRuntime = {
      schemaVersion: 1,
      revision: 1,
      values: oidcValues,
      secrets: { 'logto.managementAppSecret': 'management-secret' },
      updatedAt
    }
    const record = admin(oidcValues)
    record.adminClaimedFor = null
    const claimed: string[] = []
    let releaseFirst!: () => void
    const firstAssigned = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let firstStarted!: () => void
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve
    })
    const app = buildTenantAdminServer({
      store: store(record, runtime),
      publicUrl: 'http://localhost:8091',
      verifyOidcToken: async (token) => ({ sub: token }),
      makeLogtoClaimClient: () => ({
        assignAdmin: async (subject) => {
          claimed.push(subject)
          firstStarted()
          await firstAssigned
        }
      })
    })

    const first = app.inject({
      method: 'POST',
      url: '/api/v1/bootstrap/claim',
      headers: { host: 'localhost:8091', authorization: 'Bearer first' }
    })
    await started
    const second = app.inject({
      method: 'POST',
      url: '/api/v1/bootstrap/claim',
      headers: { host: 'localhost:8091', authorization: 'Bearer second' }
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(claimed).toEqual(['first'])
    releaseFirst()
    const responses = await Promise.all([first, second])
    await app.close()

    expect(responses.map(({ statusCode }) => statusCode)).toEqual([200, 409])
    expect(claimed).toEqual(['first'])
  })

  it('checks Logto credentials, roles permission, and ADMIN without returning credentials', async () => {
    const runtime: DeploymentConfigRuntime = {
      schemaVersion: 1,
      revision: 1,
      values: oidcValues,
      secrets: { 'logto.managementAppSecret': 'management-secret' },
      updatedAt
    }
    const app = buildTenantAdminServer({
      store: store(admin(oidcValues), runtime),
      publicUrl: 'http://localhost:8091',
      now: () => updatedAt,
      verifyOidcToken: async () => ({ sub: 'admin', roles: ['ADMIN'] }),
      makeLogtoCheckClient: () => ({
        verifyClientCredentials: async () => undefined,
        inspectAdminRole: async () => ({ exists: true, type: 'User', isDefault: false })
      })
    })
    const result = await app.inject({
      method: 'GET',
      url: '/api/v1/check/logto',
      headers: { authorization: 'Bearer id-token' }
    })
    await app.close()

    expect(result.statusCode).toBe(200)
    expect(result.json()).toEqual({
      schemaVersion: '1',
      checkedAt: updatedAt.toISOString(),
      findings: [
        { id: 'logto.configuration', status: 'pass', message: 'Logto Management API configuration is complete.' },
        {
          id: 'logto.client_credentials',
          status: 'pass',
          message: 'Logto accepted the Management API client_credentials grant with scope all.'
        },
        { id: 'logto.roles_read', status: 'pass', message: 'The Management API application can read Logto roles.' },
        { id: 'logto.admin_role', status: 'pass', message: 'The exact non-default global User role ADMIN exists.' }
      ],
      summary: { pass: 4, fail: 0, unknown: 0 }
    })
    expect(result.body).not.toContain('management-secret')
  })

  it.each([
    [401, 'fail'],
    [503, 'unknown']
  ] as const)('classifies Logto client-credentials HTTP %i as %s', async (statusCode, expected) => {
    const runtime: DeploymentConfigRuntime = {
      schemaVersion: 1,
      revision: 1,
      values: oidcValues,
      secrets: { 'logto.managementAppSecret': 'management-secret' },
      updatedAt
    }
    const app = buildTenantAdminServer({
      store: store(admin(oidcValues), runtime),
      publicUrl: 'http://localhost:8091',
      verifyOidcToken: async () => ({ sub: 'admin', roles: ['ADMIN'] }),
      makeLogtoCheckClient: () => ({
        verifyClientCredentials: async () => {
          throw new LogtoManagementError('LOGTO_UNAVAILABLE', 'upstream failure', statusCode)
        },
        inspectAdminRole: async () => ({ exists: false, type: null, isDefault: null })
      })
    })
    const result = await app.inject({
      method: 'GET',
      url: '/api/v1/check/logto',
      headers: { authorization: 'Bearer id-token' }
    })
    await app.close()

    expect(result.statusCode).toBe(200)
    expect(result.json().findings.at(-1)).toMatchObject({ id: 'logto.client_credentials', status: expected })
    expect(result.json().summary).toEqual({
      pass: 1,
      fail: expected === 'fail' ? 1 : 0,
      unknown: expected === 'unknown' ? 1 : 0
    })
  })
})
