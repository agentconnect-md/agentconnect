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
      auth: { mode: 'none' },
      github: null,
      slack: null,
      logto: null,
      features: { presetAgentsEnabled: true, maxOrgsPerNonAdminUser: 1 }
    },
    secrets: {},
    updatedAt: new Date(0),
    ...overrides
  }
}

describe('applyDeploymentEnvironment', () => {
  it('leaves public service topology owned by the startup environment', () => {
    const env = applyDeploymentEnvironment(
      {
        ...bootstrap,
        PUBLIC_WEB_URL: 'https://console.example.test/',
        CORS_ORIGIN: 'https://console.example.test'
      },
      runtime()
    )

    expect(env.PUBLIC_WEB_URL).toBe('https://console.example.test/')
    expect(env.CORS_ORIGIN).toBe('https://console.example.test')
  })

  it('lets a persisted row clear stale DB-owned env configuration', () => {
    const config = loadConfig(
      applyDeploymentEnvironment(
        {
          ...bootstrap,
          PUBLIC_CP_URL: 'https://api.example.test',
          PUBLIC_RELAY_URL: 'https://relay.example.test',
          PUBLIC_WEB_URL: 'https://console.example.test',
          CORS_ORIGIN: 'https://console.example.test',
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
    expect(config.OIDC_ISSUER).toBe('https://old-login.example.test/oidc')
    expect(config.GITHUB_APP_ID).toBeUndefined()
    expect(config.SLACK_PLATFORM_APP_ID).toBeUndefined()
  })

  it('projects provider identities and only their runtime secrets', () => {
    const base = runtime()
    const config = loadConfig(
      applyDeploymentEnvironment(
        {
          ...bootstrap,
          OIDC_ISSUER: 'https://login.example.test/oidc',
          LOGTO_MGMT_ENDPOINT: 'https://login.example.test'
        },
        runtime({
          values: {
            ...base.values,
            auth: {
              mode: 'oidc',
              audience: 'https://api.example.test',
              browserClient: {
                appId: 'web-app',
                apiResource: 'https://api.example.test'
              },
              socialProviders: ['github']
            },
            github: { appId: 123, slug: 'agentconnect-example', clientId: 'Iv1.example' },
            slack: { appId: 'A123', clientId: '123.456' },
            feishu: { loginAppId: 'cli_feishu' },
            lark: { loginAppId: 'cli_lark' },
            logto: {
              managementAppId: 'm2m-app',
              managementResource: 'https://login.example.test/api',
              browser: null,
              githubConnector: null
            },
            features: { presetAgentsEnabled: false, maxOrgsPerNonAdminUser: 1 }
          },
          secrets: {
            'github.privateKeyB64': 'github-key',
            'github.webhookSecret': 'relay-only',
            'github.clientSecret': 'connector-only',
            'slack.clientSecret': 'slack-client-secret',
            'slack.signingSecret': 'slack-signing-secret',
            'feishu.loginAppSecret': 'feishu-secret',
            'lark.loginAppSecret': 'lark-secret',
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
      FEISHU_PLATFORM_APP_ID: 'cli_feishu',
      FEISHU_PLATFORM_APP_SECRET: 'feishu-secret',
      LARK_PLATFORM_APP_ID: 'cli_lark',
      LARK_PLATFORM_APP_SECRET: 'lark-secret',
      LOGTO_MGMT_ENDPOINT: 'https://login.example.test',
      LOGTO_MGMT_APP_SECRET: 'logto-secret',
      PRESET_AGENTS_ENABLED: false,
      WAITLIST_MODE: false
    })
    expect(config).not.toHaveProperty('GITHUB_APP_WEBHOOK_SECRET')
  })

  it('keeps regional Login Apps owned by the deployment document', () => {
    const base = runtime()
    const managed = applyDeploymentEnvironment(
      {
        ...bootstrap,
        FEISHU_PLATFORM_APP_ID: 'startup-feishu',
        FEISHU_PLATFORM_APP_SECRET: 'startup-secret',
        LARK_PLATFORM_APP_ID: 'startup-lark',
        LARK_PLATFORM_APP_SECRET: 'startup-secret'
      },
      runtime({
        values: { ...base.values, feishu: null, lark: { loginAppId: 'cli_lark' } },
        secrets: { 'lark.loginAppSecret': 'db-secret' }
      })
    )
    expect(managed.FEISHU_PLATFORM_APP_ID).toBeUndefined()
    expect(managed.FEISHU_PLATFORM_APP_SECRET).toBeUndefined()
    expect(managed.LARK_PLATFORM_APP_ID).toBe('cli_lark')
    expect(managed.LARK_PLATFORM_APP_SECRET).toBe('db-secret')
  })
})
