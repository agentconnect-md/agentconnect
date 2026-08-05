import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1,
  deploymentSecretsRequiringRefresh,
  type DeploymentConfigValuesV1
} from './deployment-config.js'

const base: DeploymentConfigValuesV1 = {
  ...DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1,
  github: { appId: 1, slug: 'agentconnect', clientId: 'Iv1.first' },
  slack: { appId: 'A1', clientId: '1.1' },
  logto: {
    managementEndpoint: 'https://login.example.test',
    managementAppId: 'm2m-1',
    managementResource: 'https://default.logto.app/api',
    browser: null,
    githubConnector: null
  }
}

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
          githubConnector: { appId: 3, slug: 'agentconnect-login', clientId: 'Iv1.login' }
        }
      })
    ).toEqual(['logto.githubConnectorClientSecret'])
    expect(
      deploymentSecretsRequiringRefresh(base, {
        ...base,
        logto: {
          ...base.logto!,
          googleConnector: {
            clientId: 'google-client',
            configuredRedirectUris: ['https://login.example.test/callback/agentconnect-google']
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
})
