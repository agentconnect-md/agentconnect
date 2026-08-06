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
  it('offers Google only when both Logto and Web use HTTPS', async () => {
    const bootstrapInfo = async (logtoScheme: 'http' | 'https', webScheme: 'http' | 'https') => {
      const server = buildTenantAdminServer({
        store,
        publicUrl: 'http://localhost:8091',
        localAuthBootstrap: {
          issuer: `${logtoScheme}://login.example.test/oidc`,
          services: {
            web: `${webScheme}://app.example.test`,
            controlPlane: 'https://api.example.test',
            relay: 'https://relay.example.test'
          }
        }
      })
      servers.push(server)
      const response = await server.inject({ method: 'GET', url: '/api/v1/bootstrap-info' })
      expect(response.statusCode).toBe(200)
      return response.json<{ googleAvailable: boolean }>()
    }

    await expect(bootstrapInfo('http', 'https')).resolves.toMatchObject({ googleAvailable: false })
    await expect(bootstrapInfo('https', 'http')).resolves.toMatchObject({ googleAvailable: false })
    await expect(bootstrapInfo('https', 'https')).resolves.toMatchObject({ googleAvailable: true })
  })
})
