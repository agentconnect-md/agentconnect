import { describe, expect, it } from 'vitest'
import {
  buildSlackManifest,
  slackCreateAppUrl,
  SLACK_BOT_SCOPES,
  SLACK_BOT_EVENTS,
  SLACK_SOCKET_ONLY_BOT_EVENTS,
  SLACK_MANAGE_SESSION_SHORTCUT_CALLBACK_ID,
  PLATFORM_APP_DESCRIPTION
} from './manifest'

// The manual manifest must request exactly what the CP's auto-install manifest does, or
// an app a user creates by hand is short a permission the daemon needs. The two lists
// live in separate packages, so each pins the same literal: changing one side alone
// fails its own drift guard, here or in
// packages/control-plane/src/http/slack-manifest.test.ts.
describe('manifest parity with the Control Plane', () => {
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

describe('buildSlackManifest', () => {
  it('brands the app with the given background_color, and omits it otherwise', () => {
    // No color ⇒ no background_color key (mirrors the CP auto-install manifest).
    expect(buildSlackManifest({ name: 'acme' }).display_information.background_color).toBeUndefined()
    // A color (from the owning agent's icon) ⇒ display_information.background_color.
    const branded = buildSlackManifest({ name: 'acme' }, { backgroundColor: '#c62a78' })
    expect(branded.display_information.background_color).toBe('#c62a78')
  })

  // The stop button is a Socket Mode capability: the relay's HTTP ingress forwards chat and
  // finalization events only, so an http app advertising it would show a control that goes nowhere.
  it('advertises the socket-only events on socket, and withholds them over http', () => {
    const socket = buildSlackManifest({ name: 'acme' })
    const http = buildSlackManifest({ name: 'acme' }, { mode: 'http', relayUrl: 'https://relay.example' })

    expect(socket.settings.socket_mode_enabled).toBe(true)
    expect(socket.settings.event_subscriptions.bot_events).toEqual([...SLACK_BOT_EVENTS])
    expect(http.settings.socket_mode_enabled).toBe(false)
    expect(http.settings.event_subscriptions.bot_events).toEqual(
      [...SLACK_BOT_EVENTS].filter((event) => !SLACK_SOCKET_ONLY_BOT_EVENTS.includes(event))
    )
    expect(http.settings.event_subscriptions.bot_events).not.toContain('agent_session_stopped')
  })

  it('pins the socket-only event list (drift guard)', () => {
    expect([...SLACK_SOCKET_ONLY_BOT_EVENTS]).toEqual(['agent_session_stopped'])
  })

  it('uses the generic public app description', () => {
    const manifest = buildSlackManifest({ name: 'acme' })

    expect(manifest.features.agent_view.agent_description).toBe(PLATFORM_APP_DESCRIPTION)
  })

  it('prefills the Slack create-app link with the manifest', () => {
    const url = new URL(slackCreateAppUrl({ name: 'acme' }))

    expect(url.searchParams.get('new_app')).toBe('1')
    expect(JSON.parse(url.searchParams.get('manifest_json')!)).toEqual(buildSlackManifest({ name: 'acme' }))
  })

  it('declares the message shortcut and its required commands scope', () => {
    const manifest = buildSlackManifest({ name: 'acme' })

    expect(manifest.oauth_config.scopes.bot).toContain('commands')
    expect(manifest.features.shortcuts[0]!.name.length).toBeLessThanOrEqual(24)
    expect(manifest.features.shortcuts).toEqual([
      {
        name: 'Manage session',
        type: 'message',
        callback_id: SLACK_MANAGE_SESSION_SHORTCUT_CALLBACK_ID,
        description: 'View or update the AgentConnect session for this conversation'
      }
    ])
  })
})
