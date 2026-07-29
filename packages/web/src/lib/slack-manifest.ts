// The Slack app manifest AgentConnect installs from. The create-app link includes
// it for Slack's documented prefill flow; the UI also copies it as a fallback for
// Slack's newer creation dialog, which currently drops the prefilled value.
//
// TWO transports, selected via `buildSlackManifest`'s `mode` option:
//   - `socket` (default): the daemon opens a Socket Mode connection with the
//     bot + app-level tokens (see packages/daemon/src/slack/connection.ts) —
//     hence `socket_mode_enabled: true` and no request_url.
//   - `http`: Slack delivers the SAME events over the Events API to the relay's
//     public HTTPS endpoints (`socket_mode_enabled: false` + request_urls). The
//     bot events / scopes are identical — only the delivery channel differs.
//
// Keep the bot scopes / events in lock-step with what the daemon actually uses:
//   - reads channels/threads/history + user profiles for context assembly,
//   - chat:write to post/stream replies, chat:write.customize to label channel
//     messages with their owning AgentConnect agent name, reactions:write for ack,
//   - files:read/write for attachment download + upload,
//   - message.* / app_mention drive inbound delivery, with assistant_thread_started
//     preserving Agent/assistant DM thread coordinates.
//
// app_home enables the messages tab with read-only OFF so users can DM the bot
// out of the box; without it Slack shows "Sending messages to this app has been
// turned off" and the message.im event never fires.
//
// agent_view turns on Slack's Agent experience for newly-created apps (side panel,
// app threads, and agent-oriented thread affordances).

/** Kept in lock-step with the protocol callback consumed by daemon + relay. */
export const SLACK_MANAGE_SESSION_SHORTCUT_CALLBACK_ID = 'ac_manage_session'

/** Bot token scopes the daemon's Slack adapter requires. */
export const SLACK_BOT_SCOPES = [
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
  'reactions:write',
  'assistant:write',
  'users:read'
] as const

/** Bot events the daemon subscribes to: message.* / app_mention drive inbound
 *  delivery, assistant_thread_started preserves Agent/assistant DM thread roots,
 *  and membership events drive the console's per-channel trigger config. */
export const SLACK_BOT_EVENTS = [
  'app_mention',
  'assistant_thread_started',
  'message.channels',
  'message.groups',
  'message.im',
  'member_joined_channel',
  'channel_left',
  'group_left'
] as const

/** Fallback name so the manifest / deep link are always valid before the user types one. */
export const DEFAULT_SLACK_APP_NAME = 'agentconnect'

export interface SlackAppManifest {
  display_information: { name: string; background_color?: string }
  features: {
    bot_user: { display_name: string; always_online: boolean }
    app_home: { home_tab_enabled: boolean; messages_tab_enabled: boolean; messages_tab_read_only_enabled: boolean }
    agent_view: { agent_description: string; suggested_prompts: { title: string; message: string }[] }
    shortcuts: { name: string; type: 'message'; callback_id: string; description: string }[]
  }
  oauth_config: { scopes: { bot: string[] }; pkce_enabled: boolean }
  settings: {
    // `request_url` is present only for the http (Events API) transport.
    event_subscriptions: { request_url?: string; bot_events: string[] }
    // `request_url` / `message_menu_options_url` are present only for http; both
    // point at the relay's interactions endpoint (block_suggestion options are
    // answered synchronously there).
    interactivity: { is_enabled: boolean; request_url?: string; message_menu_options_url?: string }
    org_deploy_enabled: boolean
    socket_mode_enabled: boolean
    token_rotation_enabled: boolean
    is_mcp_enabled: boolean
  }
}

/** Transport-aware manifest options. `mode` selects Socket Mode (default) vs HTTP
 *  (Events API via the relay); `relayUrl` is the relay's public base the http
 *  request_urls point at (normalized to https, no trailing slash). */
export interface SlackManifestOpts {
  mode?: 'socket' | 'http'
  relayUrl?: string
  /** `#rrggbb` from the owning agent's icon → `display_information.background_color`,
   *  branding the created app with the agent's avatar color (Slack has no API to set
   *  the app image itself). Mirrors the CP auto-install funnel. */
  backgroundColor?: string
}

/** The two names the manifest carries — mirrors the agent's naming model:
 *  `name` (the slug) fills `display_information.name` (the Slack app name), and
 *  `displayName` fills `bot_user.display_name` (what shows in channels),
 *  falling back to `name` when unset. */
export interface SlackAppNames {
  name: string
  displayName?: string
}

/** Build the Slack app manifest (names trimmed; empty name falls back to the
 *  default). `opts.mode` defaults to `socket`; `http` requires a `relayUrl` to
 *  aim the request_urls at (missing ⇒ falls back to the socket shape rather than
 *  emit an http manifest with an empty request_url). */
export function buildSlackManifest(names: SlackAppNames, opts?: SlackManifestOpts): SlackAppManifest {
  const name = names.name.trim() || DEFAULT_SLACK_APP_NAME
  const displayName = names.displayName?.trim() || name
  // Normalize a ws(s):// relay base to http(s):// and strip a trailing slash — the
  // manifest request_url must be an https origin (mirror of api.ts's http→ws flip).
  const relayUrl = opts?.relayUrl?.replace(/^ws/, 'http').replace(/\/+$/, '')
  const http = opts?.mode === 'http' && !!relayUrl
  return {
    display_information: { name, ...(opts?.backgroundColor ? { background_color: opts.backgroundColor } : {}) },
    features: {
      bot_user: { display_name: displayName, always_online: true },
      app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
      agent_view: {
        agent_description: `${displayName} is an AgentConnect agent that responds to Slack conversations and works in threads.`,
        suggested_prompts: []
      },
      shortcuts: [
        {
          name: 'Manage AgentConnect session',
          type: 'message',
          callback_id: SLACK_MANAGE_SESSION_SHORTCUT_CALLBACK_ID,
          description: 'View or update the AgentConnect session for this conversation'
        }
      ]
    },
    oauth_config: { scopes: { bot: [...SLACK_BOT_SCOPES] }, pkce_enabled: false },
    settings: {
      event_subscriptions: {
        ...(http ? { request_url: `${relayUrl}/slack/events` } : {}),
        bot_events: [...SLACK_BOT_EVENTS]
      },
      interactivity: {
        is_enabled: true,
        ...(http
          ? {
              request_url: `${relayUrl}/slack/interactions`,
              message_menu_options_url: `${relayUrl}/slack/interactions`
            }
          : {})
      },
      org_deploy_enabled: false,
      socket_mode_enabled: !http,
      token_rotation_enabled: false,
      is_mcp_enabled: false
    }
  }
}

/** Pretty-printed manifest JSON — for the "Copy manifest" affordance. */
export function slackManifestJson(names: SlackAppNames, opts?: SlackManifestOpts): string {
  return JSON.stringify(buildSlackManifest(names, opts), null, 2)
}

/**
 * Slack's documented "create a new app from a manifest" deep link. Slack's newer
 * creation dialog currently drops the prefilled value, so callers should also
 * offer the manifest on the clipboard as a fallback.
 */
export function slackCreateAppUrl(names: SlackAppNames, opts?: SlackManifestOpts): string {
  const manifest = encodeURIComponent(JSON.stringify(buildSlackManifest(names, opts)))
  return `https://api.slack.com/apps?new_app=1&manifest_json=${manifest}`
}

/** The app id (`A…`) embedded in an app-level token `xapp-1-{APP_ID}-{epoch}-{hex}`,
 *  or null when the shape is unexpected. Mirrors the CP's `slackAppIdFromAppToken`, so
 *  once the user pastes their app-level token the console can deep-link straight to
 *  that specific app's Slack settings pages instead of making them hunt for it. */
export function slackAppIdFromAppToken(appToken: string): string | null {
  const seg = appToken.trim().split('-')[2]
  return seg && /^A[A-Z0-9]+$/.test(seg) ? seg : null
}

/** Deep link to an app's "OAuth & Permissions" page — where the Bot User OAuth Token
 *  (`xoxb-…`) lives after the app is installed to a workspace. */
export function slackAppOAuthUrl(appId: string): string {
  return `https://api.slack.com/apps/${appId}/oauth`
}

/** Deep link to an app's settings home (Basic Information) — for managing the app. */
export function slackAppSettingsUrl(appId: string): string {
  return `https://api.slack.com/apps/${appId}`
}
