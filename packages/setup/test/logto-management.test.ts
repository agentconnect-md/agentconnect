import { describe, expect, it } from 'vitest'
import { LogtoAdminClaimClient, LogtoManagementError } from '../src/server/logto-management.js'

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
  it('creates the managed SPA, social connectors, sign-in method, and ADMIN role idempotently', async () => {
    let application: Record<string, unknown> | undefined
    const connectors: Record<string, unknown>[] = []
    let signInExperience: Record<string, unknown> = {
      signIn: {
        methods: [{ identifier: 'username', password: true, verificationCode: false, isPasswordPrimary: true }]
      },
      signUp: { identifiers: ['username'], password: true, verify: false },
      socialSignIn: { automaticAccountLinking: false, skipRequiredIdentifiers: false },
      socialSignInConnectorTargets: [],
      signInMode: 'SignInAndRegister'
    }
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
        const target =
          body.connectorId === 'google-universal'
            ? 'google'
            : body.connectorId === 'slack-universal'
              ? 'slack'
              : 'github'
        const connector = { ...body, target }
        connectors.push(connector)
        return response(connector)
      }
      if (url.pathname === '/api/connectors') return response(connectors)
      if (url.pathname === '/api/sign-in-exp' && init?.method === 'PATCH') {
        signInExperience = { ...signInExperience, ...JSON.parse(String(init.body)) }
        return response(signInExperience)
      }
      if (url.pathname === '/api/sign-in-exp') {
        return response(signInExperience)
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
      socialProviders: ['github', 'google', 'slack'],
      github: { clientId: 'github-client', clientSecret: 'github-secret' },
      google: { clientId: 'google-client', clientSecret: 'google-secret' },
      slack: {
        clientId: 'slack-client',
        clientSecret: 'slack-secret',
        scope: 'openid profile email'
      }
    }

    await expect(client.reconcileSetup(desired)).resolves.toMatchObject({
      changed: true,
      application: { id: 'browser-app', created: true },
      connectors: [
        { target: 'github', id: 'agentconnect-github', created: true },
        { target: 'google', id: 'agentconnect-google', created: true },
        { target: 'slack', id: 'agentconnect-slack', created: true }
      ],
      signInExperienceChanged: true,
      adminRoleCreated: true
    })
    await expect(client.reconcileSetup(desired)).resolves.toMatchObject({
      changed: false,
      application: { id: 'browser-app', created: false, changed: false },
      connectors: [
        { target: 'github', id: 'agentconnect-github', created: false },
        { target: 'google', id: 'agentconnect-google', created: false },
        { target: 'slack', id: 'agentconnect-slack', created: false }
      ],
      signInExperienceChanged: false,
      adminRoleCreated: false
    })
    expect(signInExperience).toMatchObject({
      signIn: { methods: [] },
      signUp: { identifiers: [], password: false, verify: false, secondaryIdentifiers: [] },
      socialSignIn: { automaticAccountLinking: false, skipRequiredIdentifiers: false },
      socialSignInConnectorTargets: ['github', 'google', 'slack'],
      signInMode: 'SignInAndRegister'
    })
  })

  it('deletes the Logto Cloud demo connectors parked on the managed social targets', async () => {
    // A Logto Cloud tenant ships demo connectors sitting on real targets. Logto answers 404 to a
    // PATCH and 422 to a create while one holds the target, so setup has to delete it first.
    const connectors: Record<string, unknown>[] = [
      { id: 'demo-github', connectorId: 'logto-social-demo', target: 'github', isDemo: true, config: {} },
      { id: 'demo-google', connectorId: 'logto-social-demo', target: 'google', isDemo: true, config: {} }
    ]
    const deleted: string[] = []
    let application: Record<string, unknown> | undefined
    let role: Record<string, unknown> | undefined
    let signInExperience: Record<string, unknown> = {
      signIn: { methods: [] },
      signUp: { identifiers: [], password: false, verify: false, secondaryIdentifiers: [] },
      socialSignInConnectorTargets: ['github', 'google'],
      signInMode: 'SignInAndRegister'
    }
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input))
      if (url.pathname === '/oidc/token') return response({ access_token: 'management-token', expires_in: 3600 })
      if (url.pathname === '/api/applications' && init?.method === 'POST') {
        application = { id: 'browser-app', ...JSON.parse(String(init.body)) }
        return response(application)
      }
      if (url.pathname === '/api/applications') return response(application ? [application] : [])
      const connectorId = url.pathname.startsWith('/api/connectors/')
        ? decodeURIComponent(url.pathname.slice('/api/connectors/'.length))
        : undefined
      if (connectorId && init?.method === 'DELETE') {
        const index = connectors.findIndex((connector) => connector.id === connectorId)
        // Logto hides demo connectors from every by-id read, so only a delete may reach one.
        if (index < 0) return response({ code: 'connector.not_found' }, 404)
        connectors.splice(index, 1)
        deleted.push(connectorId)
        return new Response(null, { status: 204 })
      }
      if (connectorId) return response({ code: 'connector.not_found' }, 404)
      if (url.pathname === '/api/connectors' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        const target = body.connectorId === 'google-universal' ? 'google' : 'github'
        // Logto rejects a create while another social connector holds the same target.
        if (connectors.some((connector) => connector.target === target)) {
          return response({ code: 'connector.multiple_target_with_same_platform' }, 422)
        }
        const connector = { ...body, target }
        connectors.push(connector)
        return response(connector)
      }
      if (url.pathname === '/api/connectors') return response(connectors)
      if (url.pathname === '/api/sign-in-exp' && init?.method === 'PATCH') {
        signInExperience = { ...signInExperience, ...JSON.parse(String(init.body)) }
        return response(signInExperience)
      }
      if (url.pathname === '/api/sign-in-exp') return response(signInExperience)
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
      redirectUris: ['http://localhost:3000/auth/callback'],
      postLogoutRedirectUris: ['http://localhost:3000/login'],
      socialProviders: ['github', 'google'],
      github: { clientId: 'github-client', clientSecret: 'github-secret' },
      google: { clientId: 'google-client', clientSecret: 'google-secret' }
    }

    // The demo connectors are obstacles, not connectors to adopt: the inspection reports both the
    // pending removal and the missing managed connector.
    await expect(client.inspectSetup(desired)).resolves.toMatchObject({
      connectors: [
        {
          target: 'github',
          id: null,
          exists: false,
          matches: false,
          diff: [
            { field: 'github demo connector', current: 'logto-social-demo', expected: 'Removed' },
            { field: 'github connector', current: 'Missing', expected: 'agentconnect-github' }
          ]
        },
        { target: 'google', id: null, exists: false, matches: false }
      ]
    })

    await expect(client.reconcileSetup(desired)).resolves.toMatchObject({
      changed: true,
      connectors: [
        { target: 'github', id: 'agentconnect-github', created: true, changed: true },
        { target: 'google', id: 'agentconnect-google', created: true, changed: true }
      ]
    })
    expect(deleted).toEqual(['demo-github', 'demo-google'])
    expect(connectors.map((connector) => connector.id)).toEqual(['agentconnect-github', 'agentconnect-google'])

    // Second pass: nothing left to delete, and the managed connectors are adopted as-is.
    await expect(client.reconcileSetup(desired)).resolves.toMatchObject({
      changed: false,
      connectors: [
        { target: 'github', id: 'agentconnect-github', created: false, changed: false },
        { target: 'google', id: 'agentconnect-google', created: false, changed: false }
      ]
    })
    expect(deleted).toEqual(['demo-github', 'demo-google'])
  })

  it('reports a demo connector blocking a social target it cannot recreate', async () => {
    const connectors = [
      { id: 'demo-feishu', connectorId: 'logto-social-demo', target: 'feishu', isDemo: true, config: {} }
    ]
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input))
      if (url.pathname === '/oidc/token') return response({ access_token: 'management-token', expires_in: 3600 })
      if (url.pathname === '/api/applications' && init?.method === 'POST') {
        return response({ id: 'browser-app', ...JSON.parse(String(init.body)) })
      }
      if (url.pathname === '/api/applications') return response([])
      if (url.pathname === '/api/connectors') return response(connectors)
      return response({}, 404)
    }

    await expect(
      new LogtoAdminClaimClient(config, fetcher).reconcileSetup({
        applicationName: 'AgentConnect',
        redirectUris: ['http://localhost:3000/auth/callback'],
        postLogoutRedirectUris: ['http://localhost:3000/login'],
        socialProviders: ['feishu']
      })
    ).rejects.toMatchObject({ code: 'SOCIAL_CONNECTOR_UNSUPPORTED' })
    // Setup cannot create a Feishu connector, so it must not delete the one occupying the target.
    expect(connectors).toHaveLength(1)
  })
})
