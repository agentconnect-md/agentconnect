import { describe, expect, it, vi } from 'vitest'
import { buildInstallManifest } from '../../control-plane/src/http/slack-manifest.js'
import { createSetupConfig } from '../src/config.js'
import {
  buildGithubAppManifest,
  buildGithubLoginAppManifest,
  convertGithubManifest,
  startGithubManifestFlow
} from '../src/github-app.js'
import {
  auditSlackManifest,
  buildSlackDeploymentManifest,
  createSlackApp,
  exportSlackManifest
} from '../src/slack-app.js'

const externalConfig = createSetupConfig('external', {
  web: 'https://console.example.test',
  controlPlane: 'https://api.example.test',
  relay: 'https://relay.example.test',
  issuer: 'https://login.example.test/oidc'
})

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

describe('Slack App bootstrap', () => {
  it('uses the runtime manifest contract and verifies Slack export', async () => {
    const manifest = buildSlackDeploymentManifest(externalConfig, 'AgentConnect OSS')
    expect(manifest).toEqual(
      buildInstallManifest('AgentConnect OSS', 'https://api.example.test/v1/integrations/slack/platform/callback', {
        httpRelayBase: 'https://relay.example.test'
      })
    )

    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)
      if (url.endsWith('/apps.manifest.create')) {
        return json({
          ok: true,
          app_id: 'A012345',
          credentials: {
            client_id: 'client-id',
            client_secret: 'client-secret',
            signing_secret: 'signing-secret'
          },
          oauth_authorize_url: 'https://slack.com/oauth/v2/authorize'
        })
      }
      return json({ ok: true, manifest })
    })

    const credentials = await createSlackApp('temporary-config-token', manifest, { fetch: fetcher })
    const exported = await exportSlackManifest('temporary-config-token', credentials.appId, { fetch: fetcher })
    expect(credentials.appId).toBe('A012345')
    expect(auditSlackManifest(exported, manifest)).toEqual([])
    expect(fetcher.mock.calls.map(([input]) => String(input))).toEqual([
      'https://slack.com/api/apps.manifest.create',
      'https://slack.com/api/apps.manifest.export'
    ])
  })
})

describe('GitHub App bootstrap', () => {
  it('serves the official browser manifest flow on loopback', async () => {
    const flow = await startGithubManifestFlow(externalConfig, 'AgentConnect OSS', 'agentconnect-md', {
      timeoutMs: 5_000
    })
    try {
      const start = await fetch(flow.startUrl)
      const html = await start.text()
      const action = /<form[^>]+action="([^"]+)"/.exec(html)?.[1]
      expect(action).toBeDefined()
      const state = new URL(action!).searchParams.get('state')
      const callback = new URL('/callback', flow.startUrl)
      callback.searchParams.set('state', state!)
      callback.searchParams.set('code', 'one-time-code')
      expect((await fetch(callback)).status).toBe(200)
      expect(await flow.code).toBe('one-time-code')
    } finally {
      await flow.close()
    }
  })

  it('maps external endpoints and converts the one-time credentials without returning PEM', async () => {
    expect(buildGithubAppManifest(externalConfig, 'AgentConnect OSS', 'http://127.0.0.1:1234/callback')).toMatchObject({
      url: 'https://console.example.test',
      redirect_url: 'http://127.0.0.1:1234/callback',
      setup_url: 'https://api.example.test/v1/github/setup/callback',
      public: true,
      request_oauth_on_install: false,
      hook_attributes: { url: 'https://relay.example.test/webhooks/github', active: true },
      default_permissions: {
        metadata: 'read',
        contents: 'write',
        issues: 'write',
        pull_requests: 'write',
        actions: 'write',
        checks: 'write',
        workflows: 'write'
      }
    })

    const pem = '-----BEGIN RSA PRIVATE KEY-----\nprivate\n-----END RSA PRIVATE KEY-----\n'
    const fetcher = vi.fn<typeof fetch>(async () =>
      json({
        id: 123,
        slug: 'agentconnect-oss',
        client_id: 'client-id',
        client_secret: 'client-secret',
        webhook_secret: 'webhook-secret',
        pem
      })
    )
    const converted = await convertGithubManifest('one-time/code', { fetch: fetcher })
    expect(converted).toEqual({
      appId: '123',
      slug: 'agentconnect-oss',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      webhookSecret: 'webhook-secret',
      privateKeyBase64: Buffer.from(pem).toString('base64')
    })
    expect(fetcher).toHaveBeenCalledWith(
      'https://api.github.com/app-manifests/one-time%2Fcode/conversions',
      expect.objectContaining({ method: 'POST' })
    )
  })

  it('builds a login-only App with Logto callbacks and only email read access', () => {
    expect(
      buildGithubLoginAppManifest(
        {
          webUrl: 'http://localhost:3000',
          logtoEndpoint: 'http://login.agentconnect.localhost:3001',
          connectorId: 'agentconnect-github'
        },
        'AgentConnect Login',
        'http://127.0.0.1:1234/callback'
      )
    ).toEqual({
      name: 'AgentConnect Login',
      description: 'Sign in to AgentConnect with GitHub.',
      url: 'http://localhost:3000',
      redirect_url: 'http://127.0.0.1:1234/callback',
      callback_urls: [
        'http://login.agentconnect.localhost:3001/callback/agentconnect-github',
        'http://login.agentconnect.localhost:3001/account/callback/social/agentconnect-github'
      ],
      public: true,
      request_oauth_on_install: false,
      default_permissions: { emails: 'read' },
      default_events: []
    })
  })
})
