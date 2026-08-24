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

    expect(result.values.gitlab).toEqual({ clientId: 'application-id', baseUrl: null })
    expect(result.secrets).toEqual({ 'gitlab.clientSecret': 'application-secret' })
    expect(JSON.stringify(result.values)).not.toContain('application-secret')
  })

  it('carries the instance base URL and keeps it across a save that does not move it', () => {
    const result = gitlabDeploymentPut(current, {
      clientId: 'application-id',
      clientSecret: 'application-secret',
      baseUrl: 'https://gitlab.example.test/gitlab'
    })
    expect(result.values.gitlab).toEqual({ clientId: 'application-id', baseUrl: 'https://gitlab.example.test/gitlab' })

    // Re-saving the same identity does not demand the secret again, and the axis
    // survives the write — dropping it would silently retarget the deployment.
    const saved = { values: { ...result.values } }
    const again = gitlabDeploymentPut(saved, {
      clientId: 'application-id',
      baseUrl: 'https://gitlab.example.test/gitlab'
    })
    expect(again.values.gitlab).toEqual({ clientId: 'application-id', baseUrl: 'https://gitlab.example.test/gitlab' })
    expect(again.secrets).toBeUndefined()
  })

  it('treats a different instance as a different application and demands its secret', () => {
    const saved = {
      values: {
        ...DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1,
        gitlab: { clientId: 'application-id', baseUrl: 'https://gitlab.example.test' }
      }
    }
    expect(() => gitlabDeploymentPut(saved, { clientId: 'application-id' })).toThrow(/secret is required/)
    expect(() =>
      gitlabDeploymentPut(saved, { clientId: 'application-id', baseUrl: 'https://other.example.test' })
    ).toThrow(/secret is required/)
  })

  it('requires a secret for a new application id and keeps the sealed one otherwise', () => {
    expect(() => gitlabDeploymentPut(current, { clientId: 'application-id' })).toThrow(/secret is required/)

    const saved = {
      values: { ...DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1, gitlab: { clientId: 'application-id', baseUrl: null } }
    }
    expect(gitlabDeploymentPut(saved, { clientId: 'application-id' }).secrets).toBeUndefined()
  })

  it('clears the application and its secret together', () => {
    const saved = { values: { ...DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1, gitlab: { clientId: 'application-id' } } }
    const result = gitlabDeploymentPut(saved, null)

    expect(result.values.gitlab).toBeNull()
    expect(result.secrets).toEqual({ 'gitlab.clientSecret': null })
  })
})
