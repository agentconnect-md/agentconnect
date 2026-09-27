import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1,
  DeploymentConfigValuesV1Schema,
  deploymentSecretsRequiringRefresh,
  type DeploymentConfigValuesV1
} from './deployment-config.js'

const base: DeploymentConfigValuesV1 = {
  ...DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1,
  github: { appId: 1, slug: 'agentconnect', clientId: 'Iv1.first' },
  slack: { appId: 'A1', clientId: '1.1' },
  logto: {
    managementAppId: 'm2m-1',
    managementResource: 'https://default.logto.app/api',
    browser: null,
    githubConnector: null
  }
}

describe('DeploymentConfigValuesV1Schema', () => {
  it('defaults the non-admin organization quota and accepts zero', () => {
    const legacy = DeploymentConfigValuesV1Schema.parse({
      ...DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1,
      features: { presetAgentsEnabled: true }
    })
    expect(legacy.features.maxOrgsPerNonAdminUser).toBe(1)

    const zero = DeploymentConfigValuesV1Schema.parse({
      ...DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1,
      features: { presetAgentsEnabled: true, maxOrgsPerNonAdminUser: 0 }
    })
    expect(zero.features.maxOrgsPerNonAdminUser).toBe(0)
  })

  it('accepts a Google Chat project and refuses a non-numeric project number', () => {
    const googleChat = { projectId: 'example-project', projectNumber: '123456789012' }
    expect(DeploymentConfigValuesV1Schema.parse({ ...base, googleChat }).googleChat).toEqual(googleChat)
    expect(
      DeploymentConfigValuesV1Schema.safeParse({ ...base, googleChat: { ...googleChat, projectNumber: '12ab' } })
        .success
    ).toBe(false)
    expect(
      DeploymentConfigValuesV1Schema.safeParse({ ...base, googleChat: { ...googleChat, projectId: 'Not A Project' } })
        .success
    ).toBe(false)
  })

  it('keeps the Google Chat multi-tenant switch, absent on documents written before it', () => {
    const googleChat = { projectId: 'example-project', projectNumber: '123456789012', multiTenant: true }
    expect(DeploymentConfigValuesV1Schema.parse({ ...base, googleChat }).googleChat).toEqual(googleChat)
    expect(
      DeploymentConfigValuesV1Schema.safeParse({ ...base, googleChat: { ...googleChat, multiTenant: 'yes' } }).success
    ).toBe(false)
  })
})

describe('deploymentSecretsRequiringRefresh', () => {
  it('binds write-only secrets only to provider identity fields', () => {
    expect(
      deploymentSecretsRequiringRefresh(base, {
        ...base,
        github: { ...base.github!, slug: 'renamed' },
        logto: { ...base.logto!, managementResource: 'https://custom.example.test/api' }
      })
    ).toEqual([])
    expect(deploymentSecretsRequiringRefresh(base, { ...base, github: null })).toEqual([])
    expect(
      deploymentSecretsRequiringRefresh(base, {
        ...base,
        logto: {
          ...base.logto!,
          githubConnector: {
            appId: 3,
            slug: 'agentconnect-login',
            clientId: 'Iv1.login'
          }
        }
      })
    ).toEqual(['logto.githubConnectorClientSecret'])
    expect(
      deploymentSecretsRequiringRefresh(base, {
        ...base,
        logto: {
          ...base.logto!,
          googleConnector: {
            clientId: 'google-client'
          }
        }
      })
    ).toEqual(['logto.googleConnectorClientSecret'])
    expect(
      deploymentSecretsRequiringRefresh(base, {
        ...base,
        logto: {
          ...base.logto!,
          slackConnector: { appId: 'A1', clientId: '1.1' }
        }
      })
    ).toEqual([])

    expect(
      deploymentSecretsRequiringRefresh(base, {
        ...base,
        feishu: { loginAppId: 'cli_feishu' },
        lark: { loginAppId: 'cli_lark' },
        github: { appId: 2, slug: 'renamed', clientId: 'Iv1.second' },
        slack: { appId: 'A2', clientId: '2.2' },
        logto: { ...base.logto!, managementAppId: 'm2m-2' }
      })
    ).toEqual([
      'github.privateKeyB64',
      'github.webhookSecret',
      'github.clientSecret',
      'slack.clientSecret',
      'slack.signingSecret',
      'feishu.loginAppSecret',
      'lark.loginAppSecret',
      'logto.managementAppSecret'
    ])
  })

  it('asks for a new Google Chat key only when the project changes', () => {
    const withChat = { ...base, googleChat: { projectId: 'example-project', projectNumber: '123456789012' } }
    expect(deploymentSecretsRequiringRefresh(base, withChat)).toEqual(['googleChat.serviceAccountKey'])
    expect(
      deploymentSecretsRequiringRefresh(withChat, {
        ...withChat,
        googleChat: { projectId: 'example-project', projectNumber: '210987654321' }
      })
    ).toEqual([])
    expect(
      deploymentSecretsRequiringRefresh(withChat, {
        ...withChat,
        googleChat: { projectId: 'other-example-project', projectNumber: '123456789012' }
      })
    ).toEqual(['googleChat.serviceAccountKey'])
  })
})
