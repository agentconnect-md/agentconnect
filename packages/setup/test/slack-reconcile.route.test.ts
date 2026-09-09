/**
 * `POST /api/v1/reconcile/slack`: the write-side twin of `check/slack`. The deployment
 * Slack App keeps the scope set it was created with while `SLACK_BOT_SCOPES` grows; this
 * route brings the app's manifest to the expected one with the caller's config token.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import {
  DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1,
  type DeploymentConfigStore,
  type DeploymentConfigValuesV1
} from '@agentconnect.md/control-plane/deployment-config-store'
import type {
  SlackManifestExportResult,
  SlackManifestUpdateResult
} from '@agentconnect.md/control-plane/slack-config-api'
import { buildSetupServer } from '../src/server/index.js'

const STALE_MANIFEST = {
  display_information: { name: 'AgentConnect Test', description: 'keep me' },
  oauth_config: {
    redirect_urls: ['https://api.example.test/v1/integrations/slack/platform/callback'],
    scopes: { bot: ['chat:write', 'channels:history'], user: ['openid', 'email', 'profile'] }
  },
  settings: {
    event_subscriptions: { bot_events: ['app_mention'], request_url: 'https://relay.example.test/slack/events' },
    interactivity: { is_enabled: true, request_url: 'https://relay.example.test/slack/interactions' },
    socket_mode_enabled: false
  }
}

/** Slack's manifest store, in memory: export reads it, update replaces it. */
class FakeSlackConfigApi {
  manifest: Record<string, unknown> = structuredClone(STALE_MANIFEST)
  updates: Record<string, unknown>[] = []
  exportCalls: string[] = []
  async createApp() {
    return { ok: false as const, error: 'unused' }
  }
  async exportApp(configToken: string): Promise<SlackManifestExportResult> {
    this.exportCalls.push(configToken)
    return { ok: true, manifest: this.manifest }
  }
  async updateApp(_token: string, _appId: string, manifest: unknown): Promise<SlackManifestUpdateResult> {
    this.updates.push(manifest as Record<string, unknown>)
    this.manifest = manifest as Record<string, unknown>
    return { ok: true, permissionsUpdated: true }
  }
}

let running: FastifyInstance | undefined
afterEach(async () => {
  await running?.close()
  running = undefined
})

function server(values: DeploymentConfigValuesV1): { app: FastifyInstance; slack: FakeSlackConfigApi } {
  const admin = {
    schemaVersion: 1 as const,
    revision: 4,
    values,
    secrets: [] as { key: string; configured: boolean; fingerprint: string | null; updatedAt: Date | null }[],
    adminClaimedFor: null,
    updatedAt: new Date('2026-09-01T00:00:00.000Z')
  }
  const store = {
    getAdmin: async () => admin,
    getRuntime: async () => null,
    markAdminClaimed: async () => {}
  } as unknown as DeploymentConfigStore
  const slack = new FakeSlackConfigApi()
  const app = buildSetupServer({
    store,
    publicUrl: 'http://localhost:8091',
    slackConfigApi: slack,
    localAuthBootstrap: {
      issuer: 'https://auth.example.test',
      services: {
        web: 'https://console.example.test',
        controlPlane: 'https://api.example.test',
        relay: 'https://relay.example.test'
      }
    }
  })
  running = app
  return { app, slack }
}

const CONFIGURED: DeploymentConfigValuesV1 = {
  ...DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1,
  slack: { appId: 'A0DEPLOY', clientId: '1.1' }
}

const reconcile = (app: FastifyInstance, configToken = 'xoxe.xoxp-temporary') =>
  app.inject({ method: 'POST', url: '/api/v1/reconcile/slack', payload: { configToken } })

describe('POST /api/v1/reconcile/slack', () => {
  it('applies the diff the check reports, keeps user-owned fields, and re-reads the result', async () => {
    const { app, slack } = server(CONFIGURED)

    const res = await reconcile(app)

    expect(res.statusCode).toBe(200)
    const body = res.json() as { status: string; applied: string[]; missing: string[]; permissionsUpdated: boolean }
    expect(body.status).toBe('pass')
    expect(body.missing).toEqual([])
    expect(body.applied).toEqual(expect.arrayContaining(['scope:lists:read', 'scope:im:read', 'event:message.im']))
    expect(body.permissionsUpdated).toBe(true)
    expect(slack.updates).toHaveLength(1)
    const submitted = slack.updates[0]!
    expect((submitted.display_information as { description: string }).description).toBe('keep me')
    expect((submitted.oauth_config as { scopes: { user: string[] } }).scopes.user).toEqual([
      'openid',
      'email',
      'profile'
    ])
    // Export before the write and again after it: the answer is what Slack kept.
    expect(slack.exportCalls).toEqual(['xoxe.xoxp-temporary', 'xoxe.xoxp-temporary'])
    // The token never reaches the browser.
    expect(JSON.stringify(body)).not.toContain('xoxe')
  })

  it('writes nothing when the app already matches', async () => {
    const { app, slack } = server(CONFIGURED)
    await reconcile(app)
    slack.updates = []

    const res = await reconcile(app)

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ status: 'pass', applied: [], permissionsUpdated: false })
    expect(slack.updates).toEqual([])
  })

  it('needs a config token and a configured deployment app', async () => {
    const { app, slack } = server(CONFIGURED)
    expect((await app.inject({ method: 'POST', url: '/api/v1/reconcile/slack', payload: {} })).statusCode).toBe(400)
    expect(slack.updates).toEqual([])

    const bare = server(DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1)
    expect((await reconcile(bare.app)).statusCode).toBe(409)
    expect(bare.slack.updates).toEqual([])
  })
})
