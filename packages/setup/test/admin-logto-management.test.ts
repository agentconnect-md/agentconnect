import { describe, expect, it } from 'vitest'
import { LogtoAdminClaimClient, LogtoManagementError } from '../src/admin/logto-management.js'

const config = {
  endpoint: 'https://login.example.test',
  appId: 'management-app',
  appSecret: 'management-secret',
  resource: 'https://login.example.test/api'
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

describe('Logto ADMIN claim', () => {
  it('uses HTTP Basic client authentication for the M2M token grant', async () => {
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input))
      if (url.pathname === '/oidc/token') {
        expect(init?.headers).toEqual({
          authorization: `Basic ${Buffer.from('management-app:management-secret').toString('base64')}`,
          'content-type': 'application/x-www-form-urlencoded'
        })
        const body = new URLSearchParams(String(init?.body))
        expect(Object.fromEntries(body)).toEqual({
          grant_type: 'client_credentials',
          resource: 'https://login.example.test/api',
          scope: 'all'
        })
        return response({ access_token: 'management-token', expires_in: 3600 })
      }
      return response({}, 404)
    }

    await expect(new LogtoAdminClaimClient(config, fetcher).verifyClientCredentials()).resolves.toBeUndefined()
  })

  it('adds the shared ADMIN role to every operator that claims it', async () => {
    const assignments: string[] = []
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input))
      if (url.pathname === '/oidc/token') return response({ access_token: 'management-token', expires_in: 3600 })
      if (url.pathname === '/api/roles') {
        return response([{ id: 'admin-role', name: 'ADMIN', type: 'User', isDefault: false }])
      }
      if (url.pathname.startsWith('/api/users/')) {
        assignments.push(url.pathname)
        expect(init?.method).toBe('POST')
        expect(JSON.parse(String(init?.body))).toEqual({ roleIds: ['admin-role'] })
        return response({})
      }
      return response({}, 404)
    }
    const client = new LogtoAdminClaimClient(config, fetcher)

    await client.assignAdmin('operator-1')
    await client.assignAdmin('operator-2')

    expect(assignments).toEqual(['/api/users/operator-1/roles', '/api/users/operator-2/roles'])
  })

  it('creates an exact non-default User ADMIN role when it is absent', async () => {
    const roleBodies: unknown[] = []
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input))
      if (url.pathname === '/oidc/token') return response({ access_token: 'management-token', expires_in: 3600 })
      if (url.pathname === '/api/roles' && url.search) return response([])
      if (url.pathname === '/api/roles') {
        roleBodies.push(JSON.parse(String(init?.body)))
        return response({ id: 'new-admin-role', name: 'ADMIN', type: 'User', isDefault: false }, 201)
      }
      if (url.pathname === '/api/users/operator/roles') return response({})
      return response({}, 404)
    }

    await new LogtoAdminClaimClient(config, fetcher).assignAdmin('operator')

    expect(roleBodies).toEqual([
      {
        name: 'ADMIN',
        description: 'AgentConnect deployment administrators',
        type: 'User',
        isDefault: false
      }
    ])
  })

  it('reports whether the exact ADMIN role is non-default', async () => {
    const signals: AbortSignal[] = []
    const fetcher: typeof fetch = async (input, init) => {
      if (init?.signal instanceof AbortSignal) signals.push(init.signal)
      const url = new URL(String(input))
      if (url.pathname === '/oidc/token') return response({ access_token: 'management-token', expires_in: 3600 })
      if (url.pathname === '/api/roles') {
        return response([{ id: 'admin-role', name: 'ADMIN', type: 'User', isDefault: false }])
      }
      return response({}, 404)
    }

    await expect(new LogtoAdminClaimClient(config, fetcher).inspectAdminRole()).resolves.toEqual({
      exists: true,
      type: 'User',
      isDefault: false
    })
    expect(signals).toHaveLength(2)
  })

  it('does not reuse a default ADMIN role', async () => {
    const fetcher: typeof fetch = async (input) => {
      const url = new URL(String(input))
      if (url.pathname === '/oidc/token') return response({ access_token: 'management-token', expires_in: 3600 })
      if (url.pathname === '/api/roles') {
        return response([{ id: 'admin-role', name: 'ADMIN', type: 'User', isDefault: true }])
      }
      return response({}, 404)
    }

    await expect(new LogtoAdminClaimClient(config, fetcher).assignAdmin('operator')).rejects.toMatchObject({
      code: 'ADMIN_ROLE_TYPE_INVALID'
    })
  })

  it('rejects a created ADMIN role unless Logto confirms it is non-default', async () => {
    const fetcher: typeof fetch = async (input) => {
      const url = new URL(String(input))
      if (url.pathname === '/oidc/token') return response({ access_token: 'management-token', expires_in: 3600 })
      if (url.pathname === '/api/roles' && url.search) return response([])
      if (url.pathname === '/api/roles') {
        return response({ id: 'new-admin-role', name: 'ADMIN', type: 'User', isDefault: true }, 201)
      }
      return response({}, 404)
    }

    await expect(new LogtoAdminClaimClient(config, fetcher).assignAdmin('operator')).rejects.toMatchObject({
      code: 'LOGTO_UNAVAILABLE'
    })
  })

  it('times out outbound requests as LOGTO_UNAVAILABLE', async () => {
    const fetcher: typeof fetch = async (_input, init) => {
      const signal = init?.signal
      if (!signal) throw new Error('expected a server-side timeout signal')
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
      throw new Error('unreachable')
    }
    const client = new LogtoAdminClaimClient(config, fetcher, Date.now, 5)

    await expect(client.verifyClientCredentials()).rejects.toSatisfy(
      (error: unknown) => error instanceof LogtoManagementError && error.code === 'LOGTO_UNAVAILABLE'
    )
  })
})

describe('Logto setup reconciliation', () => {
  it('creates the managed SPA, GitHub connector, sign-in method, and ADMIN role idempotently', async () => {
    let application: Record<string, unknown> | undefined
    let connector: Record<string, unknown> | undefined
    let signInTargets: string[] = []
    let role: Record<string, unknown> | undefined
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input))
      if (url.pathname === '/oidc/token') return response({ access_token: 'management-token', expires_in: 3600 })
      if (url.pathname === '/api/applications' && init?.method === 'POST') {
        application = { id: 'browser-app', ...JSON.parse(String(init.body)) }
        return response(application)
      }
      if (url.pathname === '/api/applications') return response(application ? [application] : [])
      if (url.pathname === '/api/connectors' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        connector = { ...body, target: 'github' }
        return response(connector)
      }
      if (url.pathname === '/api/connectors') return response(connector ? [connector] : [])
      if (url.pathname === '/api/sign-in-exp' && init?.method === 'PATCH') {
        signInTargets = (JSON.parse(String(init.body)) as { socialSignInConnectorTargets: string[] })
          .socialSignInConnectorTargets
        return response({ socialSignInConnectorTargets: signInTargets })
      }
      if (url.pathname === '/api/sign-in-exp') {
        return response({ socialSignInConnectorTargets: signInTargets })
      }
      if (url.pathname === '/api/roles' && url.search) return response(role ? [role] : [])
      if (url.pathname === '/api/roles') {
        role = { id: 'admin-role', ...JSON.parse(String(init?.body)) }
        return response(role)
      }
      return response({}, 404)
    }
    const client = new LogtoAdminClaimClient(config, fetcher)
    const desired = {
      applicationName: 'AgentConnect',
      redirectUris: ['http://localhost:3000/auth/callback', 'http://localhost:8091/auth/callback'],
      postLogoutRedirectUris: ['http://localhost:3000/login'],
      corsAllowedOrigins: ['http://localhost:3000', 'http://localhost:8091'],
      socialProviders: ['github'],
      github: { clientId: 'github-client', clientSecret: 'github-secret' }
    }

    await expect(client.reconcileSetup(desired)).resolves.toMatchObject({
      changed: true,
      application: { id: 'browser-app', created: true },
      connectors: [{ target: 'github', id: 'agentconnect-github', created: true }],
      signInExperienceChanged: true,
      adminRoleCreated: true
    })
    await expect(client.reconcileSetup(desired)).resolves.toMatchObject({
      changed: false,
      application: { id: 'browser-app', created: false, changed: false },
      connectors: [{ target: 'github', id: 'agentconnect-github', created: false }],
      signInExperienceChanged: false,
      adminRoleCreated: false
    })
  })
})
