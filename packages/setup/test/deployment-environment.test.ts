import { describe, expect, it } from 'vitest'
import { loadDeploymentEnvironment } from '../src/deployment-environment.js'

describe('deployment environment', () => {
  it('uses bare localhost for every browser-facing local service', () => {
    expect(loadDeploymentEnvironment({})).toEqual({
      services: {
        web: 'http://localhost:3000',
        controlPlane: 'http://localhost:8080',
        relay: 'http://localhost:8090'
      },
      issuer: 'http://localhost:3001/oidc',
      managementEndpoint: 'http://localhost:3001'
    })
  })

  it('keeps container-only Logto routes separate from the public issuer', () => {
    expect(
      loadDeploymentEnvironment({
        OIDC_ISSUER: 'http://localhost:3001/oidc',
        OIDC_INTERNAL_ENDPOINT: 'http://logto:3001/oidc',
        LOGTO_MGMT_ENDPOINT: 'http://localhost:3001',
        LOGTO_INTERNAL_ENDPOINT: 'http://logto:3001'
      })
    ).toMatchObject({
      issuer: 'http://localhost:3001/oidc',
      internalOidcEndpoint: 'http://logto:3001/oidc',
      managementEndpoint: 'http://localhost:3001',
      internalManagementEndpoint: 'http://logto:3001'
    })
  })
})
