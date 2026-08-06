import { afterEach, describe, expect, it } from 'vitest'
import type { DeploymentConfigStore } from '@agentconnect.md/control-plane/deployment-config-store'
import { buildTenantAdminServer } from '../src/admin/server.js'

const store: DeploymentConfigStore = {
  getAdmin: async () => null,
  getRuntime: async () => null,
  replace: async () => {
    throw new Error('not used')
  },
  markAdminClaimed: async () => undefined
}

const servers: ReturnType<typeof buildTenantAdminServer>[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => await server.close()))
})

describe('Tenant Admin provider bootstrap', () => {
  it('publishes bare localhost and keeps only Slack disabled on local HTTP', async () => {
    const server = buildTenantAdminServer({
      store,
      publicUrl: 'http://localhost:8091',
      localAuthBootstrap: {
        issuer: 'http://localhost:3001/oidc',
        internalOidcEndpoint: 'http://logto:3001/oidc',
        managementEndpoint: 'http://localhost:3001',
        internalManagementEndpoint: 'http://logto:3001',
        adminEndpoint: 'http://localhost:3002',
        services: {
          web: 'http://localhost:3000',
          controlPlane: 'http://localhost:8080',
          relay: 'http://localhost:8090'
        }
      }
    })
    servers.push(server)

    const response = await server.inject({ method: 'GET', url: '/api/v1/bootstrap-info' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      services: {
        web: 'http://localhost:3000',
        controlPlane: 'http://localhost:8080',
        relay: 'http://localhost:8090'
      },
      logtoEndpoint: 'http://localhost:3001',
      logtoManagementEndpoint: 'http://localhost:3001',
      logtoAdminEndpoint: 'http://localhost:3002',
      slackAvailable: false
    })
    expect(response.json()).not.toHaveProperty('googleAvailable')
  })
})
