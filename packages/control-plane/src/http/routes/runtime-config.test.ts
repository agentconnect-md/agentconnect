import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { installZod } from '../plugins/zod.js'
import { runtimeConfigRoutes } from './runtime-config.js'

describe('runtime config route', () => {
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
      }
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
      revision: null,
      config: { auth: null, gitlab: { instanceUrl: 'https://gitlab.example.test' } }
    })
  })

  it('keeps env-only deployments compatible', async () => {
    const app = Fastify()
    installZod(app)
    await app.register(runtimeConfigRoutes({}), { prefix: '/api/v1' })
    const response = await app.inject({ method: 'GET', url: '/api/v1/runtime-config' })
    expect(response.json()).toEqual({ schemaVersion: '1', revision: null, config: null })
  })
})
