import { describe, expect, it } from 'vitest'
import { buildInstallManifest } from '@agentconnect.md/control-plane/slack-manifest'
import { diffSlackManifest, reconcileSlackManifest } from '../src/slack-app.js'

const expected = buildInstallManifest(
  'AgentConnect',
  'https://api.example.test/v1/integrations/slack/platform/callback',
  {
    httpRelayBase: 'https://relay.example.test',
    additionalRedirectUrls: [
      'https://auth.example.test/callback/slack',
      'https://console.example.test/auth/social/callback'
    ]
  }
)
const expectedCodeChannels = { enabled: true, slash_command_url: 'https://relay.example.test/slack/interactions' }

/** A deployment app created by an older release: fewer scopes and events, Socket Mode, a hand-edited description. */
const stale = {
  display_information: { name: 'AgentConnect Test', description: 'hand-written, keep me' },
  features: { bot_user: { display_name: 'AgentConnect Test', always_online: true } },
  oauth_config: {
    redirect_urls: ['https://api.example.test/v1/integrations/slack/platform/callback'],
    scopes: { bot: ['chat:write', 'channels:history', 'not:required'], user: ['openid', 'email', 'profile'] }
  },
  settings: {
    event_subscriptions: { bot_events: ['app_mention'], request_url: 'https://old.example.test/slack/events' },
    interactivity: { is_enabled: true, request_url: 'https://old.example.test/slack/interactions' },
    socket_mode_enabled: true
  }
}

describe('reconcileSlackManifest', () => {
  it('brings every field the check inspects to the expected value and keeps the rest', () => {
    const reconciled = reconcileSlackManifest(stale, expected)

    expect(diffSlackManifest(reconciled, expected)).toEqual([])
    expect(diffSlackManifest(stale, expected)).toContainEqual({
      id: 'features.code_channels.enabled',
      field: 'Slack Code enabled',
      current: null,
      expected: true
    })
    expect(reconciled.features).toEqual({ ...stale.features, code_channels: expectedCodeChannels })
    const display = reconciled.display_information as Record<string, unknown>
    expect(display.description).toBe('hand-written, keep me')
    const scopes = (reconciled.oauth_config as { scopes: { bot: string[]; user: string[] } }).scopes
    // Additive: the extra bot scope and the sign-in user scopes survive.
    expect(scopes.bot).toContain('not:required')
    expect(scopes.user).toEqual(['openid', 'email', 'profile'])
    const settings = reconciled.settings as { socket_mode_enabled: boolean; interactivity: { is_enabled: boolean } }
    expect(settings.socket_mode_enabled).toBe(false)
    expect(settings.interactivity.is_enabled).toBe(true)
  })

  it('is a no-op on a manifest that already matches', () => {
    expect(diffSlackManifest(expected, expected)).toEqual([])
    expect(reconcileSlackManifest(expected, expected)).toEqual(expected)
  })

  it('re-enables code channels without replacing unrelated feature settings', () => {
    const disabled = {
      ...expected,
      features: {
        ...stale.features,
        code_channels: { ...expectedCodeChannels, enabled: false, custom_future_field: true }
      }
    }
    expect(diffSlackManifest(disabled, expected)).toEqual([
      { id: 'features.code_channels.enabled', field: 'Slack Code enabled', current: false, expected: true }
    ])
    const reconciled = reconcileSlackManifest(disabled, expected)
    expect(reconciled.features).toEqual({
      ...stale.features,
      code_channels: { ...expectedCodeChannels, custom_future_field: true }
    })
    expect(diffSlackManifest(reconciled, expected)).toEqual([])
  })
})
