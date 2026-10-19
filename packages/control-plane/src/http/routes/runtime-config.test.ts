import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { installZod } from '../plugins/zod.js'
import { runtimeConfigRoutes } from './runtime-config.js'

describe('runtime config route', () => {
  it.each([
    { enabled: false, publicAccess: false },
    { enabled: true, publicAccess: false },
    { enabled: true, publicAccess: true }
  ])('projects secret-free AHP availability independently of the legacy browser default: %j', async (ahp) => {
    const app = Fastify()
    installZod(app)
    const internal = { ...ahp, testKeyIds: ['private-key-id'], credential: 'never-public' }
    await app.register(runtimeConfigRoutes({ ahp: internal }), { prefix: '/api/v1' })
    const response = await app.inject({ method: 'GET', url: '/api/v1/runtime-config' })
    expect(response.json()).toMatchObject({ webchatProtocol: 'legacy', ahp })
    expect(response.json().ahp).toEqual(ahp)
    expect(response.body).not.toContain('private-key-id')
    expect(response.body).not.toContain('never-public')
    await app.close()
  })

  it('publishes the server-selected Webchat protocol without credentials', async () => {
    const app = Fastify()
    installZod(app)
    await app.register(runtimeConfigRoutes({ webchatProtocol: 'ahp' }), { prefix: '/api/v1' })
    const response = await app.inject({ method: 'GET', url: '/api/v1/runtime-config' })
    expect(response.json()).toEqual({
      schemaVersion: '1',
      webchatProtocol: 'ahp',
      ahp: { enabled: false, publicAccess: false },
      revision: null,
      config: null,
      fileTransfer: null
    })
    await app.close()
  })

  it('returns only the explicit secret-free auth projection', async () => {
    const app = Fastify()
    installZod(app)
    await app.register(
      runtimeConfigRoutes({
        deploymentRevision: 7,
        publicRuntimeConfig: {
          auth: {
            endpoint: 'https://login.example.test',
            issuer: 'https://login.example.test/oidc',
            appId: 'web-app',
            apiResource: 'https://api.example.test',
            socialProviders: ['github']
          },
          gitlab: { instanceUrl: 'https://gitlab.example.test' }
        }
      }),
      { prefix: '/api/v1' }
    )

    const response = await app.inject({ method: 'GET', url: '/api/v1/runtime-config' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      schemaVersion: '1',
      webchatProtocol: 'legacy',
      ahp: { enabled: false, publicAccess: false },
      revision: 7,
      config: {
        auth: {
          endpoint: 'https://login.example.test',
          issuer: 'https://login.example.test/oidc',
          appId: 'web-app',
          apiResource: 'https://api.example.test',
          socialProviders: ['github']
        },
        gitlab: { instanceUrl: 'https://gitlab.example.test' }
      },
      fileTransfer: null
    })
  })

  it('serves the GitLab instance alone when only the code host is configured', async () => {
    const app = Fastify()
    installZod(app)
    await app.register(
      runtimeConfigRoutes({
        publicRuntimeConfig: { auth: null, gitlab: { instanceUrl: 'https://gitlab.example.test' } }
      }),
      { prefix: '/api/v1' }
    )
    const response = await app.inject({ method: 'GET', url: '/api/v1/runtime-config' })
    expect(response.json()).toEqual({
      schemaVersion: '1',
      webchatProtocol: 'legacy',
      ahp: { enabled: false, publicAccess: false },
      revision: null,
      config: { auth: null, gitlab: { instanceUrl: 'https://gitlab.example.test' } },
      fileTransfer: null
    })
  })

  it('keeps env-only deployments compatible', async () => {
    const app = Fastify()
    installZod(app)
    await app.register(runtimeConfigRoutes({}), { prefix: '/api/v1' })
    const response = await app.inject({ method: 'GET', url: '/api/v1/runtime-config' })
    expect(response.json()).toEqual({
      schemaVersion: '1',
      webchatProtocol: 'legacy',
      ahp: { enabled: false, publicAccess: false },
      revision: null,
      config: null,
      fileTransfer: null
    })
  })

  it('tells the console it may transfer files, and the cap, without any other deployment config', async () => {
    const app = Fastify()
    installZod(app)
    await app.register(runtimeConfigRoutes({ fileTransfer: { maxBytes: 1024 } }), { prefix: '/api/v1' })
    const response = await app.inject({ method: 'GET', url: '/api/v1/runtime-config' })
    expect(response.json()).toEqual({
      schemaVersion: '1',
      webchatProtocol: 'legacy',
      ahp: { enabled: false, publicAccess: false },
      revision: null,
      config: null,
      fileTransfer: { maxBytes: 1024 }
    })
  })
})
