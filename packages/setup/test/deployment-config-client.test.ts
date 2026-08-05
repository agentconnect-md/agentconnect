import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import {
  applyDeploymentConfig,
  DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1,
  DEPLOYMENT_SECRET_KEYS,
  DeploymentConfigPutSchema,
  githubDeploymentPut,
  logtoGithubConnectorPut,
  readDeploymentConfigPut,
  slackDeploymentPut,
  TenantAdminClient,
  type DeploymentConfigAdmin,
  type LogtoCheckResult
} from '../src/deployment-config-client.js'

function admin(overrides: Partial<DeploymentConfigAdmin> = {}): DeploymentConfigAdmin {
  return {
    configured: false,
    schemaVersion: 1,
    revision: 0,
    values: DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1,
    secrets: DEPLOYMENT_SECRET_KEYS.map((key) => ({
      key,
      configured: false,
      fingerprint: null,
      updatedAt: null
    })),
    updatedAt: null,
    ...overrides
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

describe('tenant-admin deployment config client', () => {
  it('keeps the browser token audience aligned with the Control Plane verifier', () => {
    const auth = {
      mode: 'oidc' as const,
      issuer: 'https://login.example.test/oidc',
      audience: 'https://wrong.example.test',
      browserClient: {
        endpoint: 'https://login.example.test',
        appId: 'browser-app',
        apiResource: 'https://api.example.test'
      },
      socialProviders: ['github']
    }
    expect(
      DeploymentConfigPutSchema.safeParse({
        values: { ...DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1, auth }
      }).success
    ).toBe(false)
  })

  it('rejects non-origin service URLs and plaintext remote auth endpoints', () => {
    expect(
      DeploymentConfigPutSchema.safeParse({
        values: {
          ...DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1,
          publicUrls: {
            ...DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1.publicUrls,
            controlPlane: 'https://api.example.test/base'
          }
        }
      }).success
    ).toBe(false)
    expect(
      DeploymentConfigPutSchema.safeParse({
        values: {
          ...DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1,
          logto: {
            managementEndpoint: 'http://login.example.test',
            managementAppId: 'm2m',
            managementResource: 'https://default.logto.app/api'
          }
        }
      }).success
    ).toBe(false)
  })

  it('uses the env-supplied bearer boundary and parses only redacted responses', async () => {
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.method).toBe('GET')
      expect(init?.headers).toMatchObject({ authorization: 'Bearer admin-id-token' })
      return json(admin())
    })
    const client = new TenantAdminClient('http://127.0.0.1:8091', {
      fetch: fetcher,
      idToken: 'admin-id-token'
    })

    expect(await client.get()).toEqual(admin())
    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:8091/api/v1/deployment-config',
      expect.objectContaining({ method: 'GET', redirect: 'error' })
    )
  })

  it('never echoes an untrusted error response and rejects insecure remote admin URLs', async () => {
    const secretDiagnostic = 'provider-secret-that-must-not-escape'
    const client = new TenantAdminClient('http://127.0.0.1:8091', {
      idToken: 'token',
      fetch: async () => json({ message: secretDiagnostic }, 500)
    })
    await expect(client.get()).rejects.not.toThrow(secretDiagnostic)
    expect(() => new TenantAdminClient('http://admin.example.test', { idToken: 'token' })).toThrow(/HTTPS/)
  })

  it('preserves only the stable error code needed for login App bootstrap', async () => {
    const client = new TenantAdminClient(undefined, {
      fetch: async () =>
        json(
          {
            code: 'GITHUB_CONNECTOR_CREDENTIALS_REQUIRED',
            message: 'provider detail that must not be surfaced'
          },
          409
        )
    })

    await expect(client.reconcileLogto()).rejects.toMatchObject({
      status: 409,
      code: 'GITHUB_CONNECTOR_CREDENTIALS_REQUIRED'
    })
  })

  it('allows no-token bootstrap and explains the token requirement after a 401', async () => {
    const bootstrapFetch = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.headers).not.toHaveProperty('authorization')
      return json(admin())
    })
    await expect(new TenantAdminClient(undefined, { idToken: '', fetch: bootstrapFetch }).get()).resolves.toMatchObject(
      {
        configured: false
      }
    )

    const protectedClient = new TenantAdminClient(undefined, {
      idToken: '',
      fetch: async () => json({ message: 'untrusted' }, 401)
    })
    await expect(protectedClient.get()).rejects.toThrow(/TENANT_ADMIN_ID_TOKEN/)
  })

  it('reads JSON from stdin and skips a deterministic no-op apply', async () => {
    const source = JSON.stringify({ values: DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1 })
    const input = await readDeploymentConfigPut('-', Readable.from([source]))
    const current = admin({ configured: true, revision: 7, updatedAt: '2026-08-05T00:00:00.000Z' })
    const client = {
      get: vi.fn(async () => current),
      put: vi.fn(async () => {
        throw new Error('must not write')
      })
    }

    await expect(applyDeploymentConfig(client, input)).resolves.toMatchObject({
      changed: false,
      previousRevision: 7,
      revision: 7,
      restartRequired: false,
      config: current
    })
    expect(client.put).not.toHaveBeenCalled()
  })

  it('applies a changed document and returns only the redacted response', async () => {
    const plaintext = 'write-only-client-secret'
    const input = {
      values: DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1,
      secrets: { 'github.clientSecret': plaintext }
    } as const
    const updated = admin({
      configured: true,
      revision: 1,
      updatedAt: '2026-08-05T00:00:00.000Z',
      restartRequired: true
    })
    const client = {
      get: vi.fn(async () => admin()),
      put: vi.fn(async () => updated)
    }

    const result = await applyDeploymentConfig(client, input)
    expect(client.put).toHaveBeenCalledWith(input, 0)
    expect(result).toMatchObject({ changed: true, previousRevision: 0, revision: 1, restartRequired: true })
    expect(JSON.stringify(result)).not.toContain(plaintext)
  })

  it('reads the redacted Logto diagnostic endpoint without requiring a bootstrap token', async () => {
    const result: LogtoCheckResult = {
      schemaVersion: '1',
      checkedAt: '2026-08-05T00:00:00.000Z',
      findings: [
        {
          id: 'logto.configuration',
          status: 'fail',
          message: 'Logto Management API configuration is incomplete.'
        },
        {
          id: 'logto.client_credentials',
          status: 'unknown',
          message: 'The Logto Management API is unavailable.'
        }
      ],
      summary: { pass: 0, fail: 1, unknown: 1 }
    }
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.method).toBe('GET')
      expect(init?.headers).not.toHaveProperty('authorization')
      return json(result)
    })

    await expect(new TenantAdminClient(undefined, { idToken: '', fetch: fetcher }).checkLogto()).resolves.toEqual(
      result
    )
    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:8091/api/v1/check/logto',
      expect.objectContaining({ method: 'GET', redirect: 'error' })
    )
  })

  it('rejects inconsistent Logto diagnostic summaries', async () => {
    const client = new TenantAdminClient(undefined, {
      fetch: async () =>
        json({
          schemaVersion: '1',
          checkedAt: '2026-08-05T00:00:00.000Z',
          findings: [{ id: 'logto.admin_role', status: 'fail', message: 'ADMIN is missing.' }],
          summary: { pass: 1, fail: 0, unknown: 0 }
        })
    })

    await expect(client.checkLogto()).rejects.toThrow(/invalid response/)
  })
})

describe('provider desired-state merges', () => {
  it('merges GitHub metadata and write-only secrets while preserving other settings', () => {
    const current = admin({
      configured: true,
      revision: 4,
      values: {
        ...DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1,
        publicUrls: {
          ...DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1.publicUrls,
          web: 'https://console.example.test',
          controlPlane: 'https://api.example.test',
          relay: 'https://relay.example.test'
        },
        features: { presetAgentsEnabled: false, waitlistMode: true }
      }
    })
    const put = githubDeploymentPut(current, {
      appId: '123',
      slug: 'agentconnect-oss',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      privateKeyBase64: 'private-key',
      webhookSecret: 'webhook-secret'
    })

    expect(put.values).toMatchObject({
      publicUrls: {
        web: 'https://console.example.test',
        controlPlane: 'https://api.example.test',
        relay: 'https://relay.example.test'
      },
      github: { appId: 123, slug: 'agentconnect-oss', clientId: 'client-id' },
      features: { presetAgentsEnabled: false, waitlistMode: true }
    })
    expect(put.secrets).toEqual({
      'github.privateKeyB64': 'private-key',
      'github.webhookSecret': 'webhook-secret',
      'github.clientSecret': 'client-secret'
    })
  })

  it('stores the login GitHub App identity separately from its write-only client secret', () => {
    const current = admin({
      configured: true,
      revision: 2,
      values: {
        ...DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1,
        logto: {
          managementEndpoint: 'http://login.agentconnect.localhost:3001',
          managementAppId: 'management-app',
          managementResource: 'https://default.logto.app/api',
          browser: {
            endpoint: 'http://login.agentconnect.localhost:3001',
            applicationName: 'AgentConnect',
            apiResource: null,
            socialProviders: ['github']
          },
          githubConnector: null
        }
      }
    })

    const put = logtoGithubConnectorPut(current, {
      appId: '123',
      slug: 'agentconnect-login',
      clientId: 'login-client',
      clientSecret: 'login-secret'
    })

    expect(put.values.logto?.githubConnector).toEqual({
      appId: 123,
      slug: 'agentconnect-login',
      clientId: 'login-client'
    })
    expect(put.secrets).toEqual({ 'logto.githubConnectorClientSecret': 'login-secret' })
  })

  it('merges Slack metadata and credentials without replacing GitHub state', () => {
    const current = admin({
      configured: true,
      values: {
        ...DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1,
        publicUrls: {
          ...DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1.publicUrls,
          web: 'https://old-console.example.test',
          controlPlane: 'https://old-api.example.test',
          relay: 'https://old-relay.example.test'
        },
        github: { appId: 7, slug: 'existing', clientId: null }
      }
    })
    const put = slackDeploymentPut(current, {
      appId: 'A123',
      clientId: 'slack-client',
      clientSecret: 'slack-secret',
      signingSecret: 'signing-secret'
    })

    expect(put.values.github).toEqual(current.values.github)
    expect(put.values.slack).toEqual({ appId: 'A123', clientId: 'slack-client' })
    expect(put.values.publicUrls).toEqual(current.values.publicUrls)
    expect(put.secrets).toEqual({
      'slack.clientSecret': 'slack-secret',
      'slack.signingSecret': 'signing-secret'
    })
  })
})
