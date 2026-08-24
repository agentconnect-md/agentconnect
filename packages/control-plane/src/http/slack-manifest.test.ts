import { describe, it, expect } from 'vitest'
import {
  buildInstallManifest,
  checkSlackBotScopes,
  mergeManagedSlackManifest,
  slackOAuthRedirectUri,
  SLACK_BOT_SCOPES,
  SLACK_BOT_EVENTS,
  DEFAULT_SLACK_APP_NAME
} from './slack-manifest.js'
import { SLACK_MANAGE_SESSION_SHORTCUT_CALLBACK_ID } from '@agentconnect.md/protocol'
import { PLATFORM_APP_DESCRIPTION } from './platform-app-description.js'

// The PUBLIC form — `/v1`, not the internal `/api/v1` (see SLACK_OAUTH_CALLBACK_PATH).
const REDIRECT = 'https://cp.example/v1/integrations/slack/oauth/callback'

describe('buildInstallManifest', () => {
  it('declares our callback as the sole OAuth redirect URL', () => {
    const m = buildInstallManifest('acme-bot', REDIRECT) as {
      oauth_config: { redirect_urls: string[]; scopes: { bot: string[] } }
    }
    expect(m.oauth_config.redirect_urls).toEqual([REDIRECT])
  })

  it('enables Socket Mode and carries the daemon scopes + events', () => {
    const m = buildInstallManifest('acme-bot', REDIRECT) as {
      features: { shortcuts: { callback_id: string; type: string }[] }
      oauth_config: { scopes: { bot: string[] } }
      settings: { socket_mode_enabled: boolean; event_subscriptions: { bot_events: string[] } }
    }
    expect(m.settings.socket_mode_enabled).toBe(true)
    expect(m.oauth_config.scopes.bot).toEqual([...SLACK_BOT_SCOPES])
    expect(m.settings.event_subscriptions.bot_events).toEqual([...SLACK_BOT_EVENTS])
    expect(m.features.shortcuts).toEqual([
      expect.objectContaining({
        callback_id: SLACK_MANAGE_SESSION_SHORTCUT_CALLBACK_ID,
        type: 'message'
      })
    ])
  })

  it('http mode: disables Socket Mode and points the Events API request_urls at the relay', () => {
    const m = buildInstallManifest('acme-bot', REDIRECT, { httpRelayBase: 'https://relay.example' }) as {
      settings: {
        socket_mode_enabled: boolean
        event_subscriptions: { request_url: string; bot_events: string[] }
        interactivity: { is_enabled: boolean; request_url: string; message_menu_options_url: string }
      }
    }
    expect(m.settings.socket_mode_enabled).toBe(false)
    expect(m.settings.event_subscriptions.request_url).toBe('https://relay.example/slack/events')
    expect(m.settings.interactivity.request_url).toBe('https://relay.example/slack/interactions')
    expect(m.settings.interactivity.message_menu_options_url).toBe('https://relay.example/slack/interactions')
    // still carries the same scopes + events (only the transport differs).
    expect(m.settings.event_subscriptions.bot_events).toEqual([...SLACK_BOT_EVENTS])
  })

  it('falls back to the default app name when blank', () => {
    const m = buildInstallManifest('   ', REDIRECT) as { display_information: { name: string } }
    expect(m.display_information.name).toBe(DEFAULT_SLACK_APP_NAME)
  })

  it('brands the app with the given background_color, and omits it otherwise', () => {
    const plain = buildInstallManifest('acme-bot', REDIRECT) as {
      display_information: Record<string, unknown>
    }
    expect(plain.display_information.background_color).toBeUndefined()
    const branded = buildInstallManifest('acme-bot', REDIRECT, { backgroundColor: '#c62a78' }) as {
      display_information: { background_color: string }
    }
    expect(branded.display_information.background_color).toBe('#c62a78')
  })

  it('uses the generic public app description', () => {
    const manifest = buildInstallManifest('acme-bot', REDIRECT) as {
      features: { agent_view: { agent_description: string } }
    }

    expect(manifest.features.agent_view.agent_description).toBe(PLATFORM_APP_DESCRIPTION)
  })

  // Drift guard: these scopes/events MUST stay in lock-step with the manual manifest
  // (packages/web/src/lib/slack-manifest.ts) and what the daemon's Slack adapter uses.
  // A change here is deliberate — update the pins AND the other two places.
  it('pins the exact bot scopes (drift guard)', () => {
    expect([...SLACK_BOT_SCOPES]).toEqual([
      'files:read',
      'app_mentions:read',
      'channels:history',
      'channels:read',
      'commands',
      'chat:write',
      'chat:write.customize',
      'files:write',
      'groups:history',
      'groups:read',
      'im:history',
      'im:write',
      'mpim:history',
      'mpim:read',
      'reactions:write',
      'assistant:write',
      'users:read'
    ])
  })

  it('pins the exact bot events (drift guard)', () => {
    expect([...SLACK_BOT_EVENTS]).toEqual([
      'agent_session_stopped',
      'app_mention',
      'app_uninstalled',
      'assistant_thread_started',
      'message.channels',
      'message.groups',
      'message.im',
      'message.mpim',
      'member_joined_channel',
      'channel_left',
      'group_left',
      'tokens_revoked'
    ])
  })
})

// The one place the "did this install actually get every scope" comparison
// lives — both install funnels fence on it and the Settings refresh reports it.
// Grants are built FROM `SLACK_BOT_SCOPES` rather than spelled out, so adding a
// required scope never has to be mirrored here.
describe('checkSlackBotScopes', () => {
  it('accepts a grant that carries every required scope', () => {
    expect(checkSlackBotScopes([...SLACK_BOT_SCOPES])).toEqual({ status: 'complete' })
  })

  it('ignores extra scopes the workspace happens to have granted', () => {
    expect(checkSlackBotScopes([...SLACK_BOT_SCOPES, 'bookmarks:read'])).toEqual({ status: 'complete' })
  })

  it('names exactly the required scopes a short grant is missing', () => {
    const withheld = [SLACK_BOT_SCOPES[0], SLACK_BOT_SCOPES[SLACK_BOT_SCOPES.length - 1]!]
    const granted = SLACK_BOT_SCOPES.filter((scope) => !withheld.includes(scope))
    expect(checkSlackBotScopes(granted)).toEqual({ status: 'short', missing: withheld })
  })

  it('reports an empty grant as short rather than complete', () => {
    expect(checkSlackBotScopes([])).toEqual({ status: 'short', missing: [...SLACK_BOT_SCOPES] })
  })

  // Slack does not always send `x-oauth-scopes`. "We could not tell" must never
  // be read as "the grant is short" — that would fail installs for a reason
  // that has nothing to do with permissions.
  it('treats an unreported grant as unknown, not short', () => {
    expect(checkSlackBotScopes(null)).toEqual({ status: 'unknown' })
    expect(checkSlackBotScopes(undefined)).toEqual({ status: 'unknown' })
  })
})

describe('mergeManagedSlackManifest', () => {
  it('adds required scopes, events, and callback without deleting user-owned fields', () => {
    const current = {
      _metadata: { major_version: 1, minor_version: 1 },
      display_information: { name: 'Custom app', description: 'Keep this description' },
      features: {
        bot_user: { display_name: 'Custom bot', always_online: false },
        app_home: { home_tab_enabled: true },
        agent_view: { agent_description: 'Keep this agent description' },
        slash_commands: [{ command: '/custom', description: 'Keep me' }],
        shortcuts: [
          { name: 'Keep shortcut', type: 'message', callback_id: 'custom_shortcut' },
          { name: 'Old managed name', type: 'message', callback_id: SLACK_MANAGE_SESSION_SHORTCUT_CALLBACK_ID }
        ]
      },
      oauth_config: {
        redirect_urls: ['https://custom.example/slack/callback'],
        scopes: { bot: ['bookmarks:read'], user: ['users.profile:read'] }
      },
      settings: {
        socket_mode_enabled: false,
        token_rotation_enabled: true,
        event_subscriptions: {
          request_url: 'https://custom.example/slack/events',
          bot_events: ['app_home_opened'],
          user_events: ['reaction_added']
        },
        interactivity: { is_enabled: false, request_url: 'https://custom.example/slack/actions' }
      },
      custom_future_field: { keep: true }
    }

    const merged = mergeManagedSlackManifest(current, 'fallback-name', REDIRECT) as {
      display_information: { name: string; description: string }
      features: {
        bot_user: { display_name: string; always_online: boolean }
        app_home: {
          home_tab_enabled: boolean
          messages_tab_enabled: boolean
          messages_tab_read_only_enabled: boolean
        }
        agent_view: { agent_description: string }
        slash_commands: unknown[]
        shortcuts: { name: string; callback_id: string }[]
      }
      oauth_config: { redirect_urls: string[]; scopes: { bot: string[]; user: string[] } }
      settings: {
        socket_mode_enabled: boolean
        token_rotation_enabled: boolean
        event_subscriptions: { request_url: string; bot_events: string[]; user_events: string[] }
        interactivity: { is_enabled: boolean; request_url: string }
      }
      custom_future_field: { keep: boolean }
    }

    expect(merged.display_information).toEqual({ name: 'Custom app', description: 'Keep this description' })
    expect(merged.features.bot_user).toEqual({ display_name: 'Custom bot', always_online: true })
    expect(merged.features.slash_commands).toEqual(current.features.slash_commands)
    expect(merged.features.shortcuts).toEqual([
      expect.objectContaining({
        name: 'Manage session',
        callback_id: SLACK_MANAGE_SESSION_SHORTCUT_CALLBACK_ID
      }),
      current.features.shortcuts[0]
    ])
    expect(merged.features.app_home.home_tab_enabled).toBe(true)
    expect(merged.features.app_home.messages_tab_enabled).toBe(true)
    expect(merged.features.app_home.messages_tab_read_only_enabled).toBe(false)
    expect(merged.features.agent_view.agent_description).toBe(PLATFORM_APP_DESCRIPTION)
    expect(merged.oauth_config.redirect_urls).toEqual(['https://custom.example/slack/callback', REDIRECT])
    expect(merged.oauth_config.scopes.bot).toEqual(expect.arrayContaining(['bookmarks:read', ...SLACK_BOT_SCOPES]))
    expect(merged.oauth_config.scopes.user).toEqual(['users.profile:read'])
    expect(merged.settings.socket_mode_enabled).toBe(true)
    expect(merged.settings.token_rotation_enabled).toBe(false)
    expect(merged.settings.event_subscriptions.request_url).toBe('https://custom.example/slack/events')
    expect(merged.settings.event_subscriptions.bot_events).toEqual(
      expect.arrayContaining(['app_home_opened', ...SLACK_BOT_EVENTS])
    )
    expect(merged.settings.event_subscriptions.user_events).toEqual(['reaction_added'])
    expect(merged.settings.interactivity).toEqual({
      is_enabled: true,
      request_url: 'https://custom.example/slack/actions'
    })
    expect(merged.custom_future_field).toEqual({ keep: true })
  })

  it('does not invent a redirect URL when the control plane has no public callback', () => {
    const merged = mergeManagedSlackManifest({}, 'acme-bot') as { oauth_config: { redirect_urls?: string[] } }
    expect(merged.oauth_config.redirect_urls).toBeUndefined()
  })
})

describe('slackOAuthRedirectUri', () => {
  it('joins the callback path, trimming a trailing slash on the base', () => {
    expect(slackOAuthRedirectUri('https://cp.example')).toBe(REDIRECT)
    expect(slackOAuthRedirectUri('https://cp.example/')).toBe(REDIRECT)
  })
})
