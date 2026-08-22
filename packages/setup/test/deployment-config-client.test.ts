import { describe, expect, it } from 'vitest'
import { DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1 } from '@agentconnect.md/control-plane/deployment-config-store'
import { gitlabDeploymentPut, localAuthLogtoPut } from '../src/deployment-config-client.js'

describe('localAuthLogtoPut', () => {
  it('stores an explicit Logto Management API resource', () => {
    const result = localAuthLogtoPut(
      { values: DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1 },
      {
        managementAppId: 'cloud-m2m-app',
        managementAppSecret: 'secret',
        managementResource: 'https://tenant-id.logto.app/api'
      }
    )

    expect(result.values.logto?.managementResource).toBe('https://tenant-id.logto.app/api')
  })
})

describe('gitlabDeploymentPut', () => {
  const current = { values: DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1 }

  it('stores the application id as configuration and the secret as a write-only entry', () => {
    const result = gitlabDeploymentPut(current, { clientId: 'application-id', clientSecret: 'application-secret' })

    expect(result.values.gitlab).toEqual({ clientId: 'application-id' })
    expect(result.secrets).toEqual({ 'gitlab.clientSecret': 'application-secret' })
    expect(JSON.stringify(result.values)).not.toContain('application-secret')
  })

  it('requires a secret for a new application id and keeps the sealed one otherwise', () => {
    expect(() => gitlabDeploymentPut(current, { clientId: 'application-id' })).toThrow(/secret is required/)

    const saved = { values: { ...DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1, gitlab: { clientId: 'application-id' } } }
    expect(gitlabDeploymentPut(saved, { clientId: 'application-id' }).secrets).toBeUndefined()
  })

  it('clears the application and its secret together', () => {
    const saved = { values: { ...DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1, gitlab: { clientId: 'application-id' } } }
    const result = gitlabDeploymentPut(saved, null)

    expect(result.values.gitlab).toBeNull()
    expect(result.secrets).toEqual({ 'gitlab.clientSecret': null })
  })
})
