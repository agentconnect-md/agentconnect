import { describe, expect, it } from 'vitest'
import type { DeploymentConfigRuntime } from '../persistence/deployment-config.js'
import { applyDeploymentEnvironment } from './deployment.js'
import { loadConfig } from './env.js'

const bootstrap = {
  DATABASE_URL: 'postgresql://agentconnect:agentconnect@localhost:5432/agentconnect',
  API_KEY_PEPPER: 'a'.repeat(32)
}

function runtime(overrides: Partial<DeploymentConfigRuntime> = {}): DeploymentConfigRuntime {
  return {
    schemaVersion: 1,
    revision: 1,
    values: {
      publicUrls: {
        controlPlane: 'https://api.example.test',
        relay: 'https://relay.example.test',
        web: 'https://console.example.test',
        mcp: null
      },
      auth: { mode: 'none' },
      github: null,
      slack: null,
      logto: null,
      features: { presetAgentsEnabled: true, waitlistMode: false }
    },
    secrets: {},
    updatedAt: new Date(0),
    ...overrides
  }
}

describe('applyDeploymentEnvironment', () => {
  it('lets a persisted row clear stale env configuration', () => {
    const config = loadConfig(
      applyDeploymentEnvironment(
        {
          ...bootstrap,
          OIDC_ISSUER: 'https://old-login.example.test/oidc',
          GITHUB_APP_ID: '123',
          GITHUB_APP_SLUG: 'old-app',
          GITHUB_APP_PRIVATE_KEY_B64: 'old-key',
          SLACK_PLATFORM_APP_ID: 'AOLD'
        },
        runtime()
      )
    )

    expect(config).toMatchObject({
      PUBLIC_CP_URL: 'https://api.example.test',
      PUBLIC_RELAY_URL: 'https://relay.example.test',
      PUBLIC_WEB_URL: 'https://console.example.test',
      CORS_ORIGIN: 'https://console.example.test',
      PRESET_AGENTS_ENABLED: true,
      WAITLIST_MODE: false
    })
    expect(config.OIDC_ISSUER).toBeUndefined()
    expect(config.GITHUB_APP_ID).toBeUndefined()
    expect(config.SLACK_PLATFORM_APP_ID).toBeUndefined()
  })

  it('projects provider identities and only their runtime secrets', () => {
    const base = runtime()
    const config = loadConfig(
      applyDeploymentEnvironment(
        bootstrap,
        runtime({
          values: {
            ...base.values,
            auth: {
              mode: 'oidc',
              issuer: 'https://login.example.test/oidc',
              audience: 'https://api.example.test',
              browserClient: {
                endpoint: 'https://login.example.test',
                appId: 'web-app',
                apiResource: 'https://api.example.test'
              },
              socialProviders: ['github']
            },
            github: { appId: 123, slug: 'agentconnect-example', clientId: 'Iv1.example' },
            slack: { appId: 'A123', clientId: '123.456' },
            logto: {
              managementEndpoint: 'https://login.example.test',
              managementAppId: 'm2m-app',
              managementResource: 'https://login.example.test/api'
            },
            features: { presetAgentsEnabled: false, waitlistMode: true }
          },
          secrets: {
            'github.privateKeyB64': 'github-key',
            'github.webhookSecret': 'relay-only',
            'github.clientSecret': 'connector-only',
            'slack.clientSecret': 'slack-client-secret',
            'slack.signingSecret': 'slack-signing-secret',
            'logto.managementAppSecret': 'logto-secret'
          }
        })
      )
    )

    expect(config).toMatchObject({
      OIDC_ISSUER: 'https://login.example.test/oidc',
      OIDC_AUDIENCE: 'https://api.example.test',
      GITHUB_APP_ID: 123,
      GITHUB_APP_PRIVATE_KEY_B64: 'github-key',
      SLACK_PLATFORM_CLIENT_SECRET: 'slack-client-secret',
      LOGTO_MGMT_APP_SECRET: 'logto-secret',
      PRESET_AGENTS_ENABLED: false,
      WAITLIST_MODE: true
    })
    expect(config).not.toHaveProperty('GITHUB_APP_WEBHOOK_SECRET')
  })
})
