import { describe, expect, it } from 'vitest'
import { DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1 } from '@agentconnect.md/control-plane/deployment-config-store'
import { localAuthLogtoPut } from '../src/deployment-config-client.js'

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
