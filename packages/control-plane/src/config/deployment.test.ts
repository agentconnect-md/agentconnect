import { describe, expect, it } from 'vitest'
import type { DeploymentConfigRuntime } from '../persistence/deployment-config.js'
import { googleChatClaimAnchor } from '../platforms/googlechat/provider.js'
import { applyDeploymentEnvironment, relayDeploymentSnapshot } from './deployment.js'
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
          GITHUB_APP_CLIENT_SECRET: 'old-client-secret',
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
    expect(config.GITHUB_APP_CLIENT_SECRET).toBeUndefined()
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
      GITHUB_APP_CLIENT_SECRET: 'connector-only',
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

  it('projects the deployment-owned Google Chat app with its key, and clears stale startup values', () => {
    const base = runtime()
    const key = '{"type":"service_account","project_id":"example-project"}'
    const managed = applyDeploymentEnvironment(
      { ...bootstrap, GOOGLE_CHAT_PLATFORM_PROJECT_ID: 'startup-project' },
      runtime({
        values: { ...base.values, googleChat: { projectId: 'example-project', projectNumber: '123456789012' } },
        secrets: { 'googleChat.serviceAccountKey': key }
      })
    )
    expect(managed.GOOGLE_CHAT_PLATFORM_PROJECT_ID).toBe('example-project')
    expect(managed.GOOGLE_CHAT_PLATFORM_PROJECT_NUMBER).toBe('123456789012')
    expect(managed.GOOGLE_CHAT_PLATFORM_SERVICE_ACCOUNT_KEY).toBe(key)

    const cleared = applyDeploymentEnvironment(
      { ...bootstrap, GOOGLE_CHAT_PLATFORM_PROJECT_ID: 'startup-project' },
      runtime()
    )
    expect(cleared.GOOGLE_CHAT_PLATFORM_PROJECT_ID).toBeUndefined()
    expect(cleared.GOOGLE_CHAT_PLATFORM_SERVICE_ACCOUNT_KEY).toBeUndefined()
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

describe('relayDeploymentSnapshot', () => {
  const app = { projectNumber: '100000000000' }
  const consoleUrl = 'https://console.example.test'
  const anchor = { projectNumber: '100000000000', claimUrl: 'https://console.example.test/googlechat/claim' }

  it('carries the Google Chat anchor exactly when the app and an https console URL are configured', () => {
    const stored = runtime({ revision: 7 })
    expect(relayDeploymentSnapshot(stored, googleChatClaimAnchor(app, consoleUrl))).toEqual({
      revision: 7,
      googleChatAnchor: anchor
    })
    // Configured from the startup environment alone, it still reaches the relay.
    expect(relayDeploymentSnapshot(undefined, googleChatClaimAnchor(app, consoleUrl))).toEqual({
      revision: 0,
      googleChatAnchor: anchor
    })
    for (const missing of [googleChatClaimAnchor(undefined, consoleUrl), googleChatClaimAnchor(app, undefined)]) {
      expect(relayDeploymentSnapshot(stored, missing)).toEqual({ revision: 7 })
      expect(relayDeploymentSnapshot(undefined, missing)).toBeUndefined()
    }
  })

  it('keeps the GitHub webhook secret only while the GitHub App is configured', () => {
    const secrets = { 'github.webhookSecret': 'ghw_secret' }
    const github = { appId: 123, slug: 'agentconnect-example', clientId: 'Iv1.example' }
    const base = runtime()
    expect(relayDeploymentSnapshot(runtime({ values: { ...base.values, github }, secrets }), undefined)).toEqual({
      revision: 1,
      githubWebhookSecret: 'ghw_secret'
    })
    expect(relayDeploymentSnapshot(runtime({ secrets }), undefined)).toEqual({ revision: 1 })
  })
})
