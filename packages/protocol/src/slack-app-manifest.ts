// ⚠️ NO RELATIVE IMPORTS — a bundler compiles this from source; web's protocol-imports.leaf.test.ts enforces it.

/** App-level Slack message shortcut for opening the controls of the session that
 * owns the selected message's conversation. Direct apps receive it over Socket
 * Mode; shared apps receive the same callback through the relay HTTP edge.
 *
 * Declared to Slack by {@link buildSlackAppManifest} below, which is why it lives
 * here rather than beside the runtime Block Kit action ids in `frames/relay-cp.ts`:
 * those name controls on messages we post, this one names a manifest feature. */
export const SLACK_MANAGE_SESSION_SHORTCUT_CALLBACK_ID = 'ac_manage_session'

/** Public platform profile copy. Never derive this from an Agent description. */
export const PLATFORM_APP_DESCRIPTION = 'AI agent powered by AgentConnect.'

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
  'im:write',
  'mpim:history',
  'mpim:read',
  'reactions:write',
  'assistant:write',
  'users:read'
] as const

export const SLACK_BOT_EVENTS = [
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
] as const

export const DEFAULT_SLACK_APP_NAME = 'agentconnect'

export interface SlackAppManifest extends Record<string, unknown> {
  display_information: { name: string; background_color?: string }
  features: {
    bot_user: { display_name: string; always_online: boolean }
    app_home: { home_tab_enabled: boolean; messages_tab_enabled: boolean; messages_tab_read_only_enabled: boolean }
    agent_view: { agent_description: string; suggested_prompts: { title: string; message: string }[] }
    shortcuts: { name: string; type: 'message'; callback_id: string; description: string }[]
  }
  oauth_config: {
    scopes: { bot: string[] }
    redirect_urls?: string[]
    pkce_enabled?: boolean
  }
  settings: {
    event_subscriptions: { request_url?: string; bot_events: string[] }
    interactivity: { is_enabled: boolean; request_url?: string; message_menu_options_url?: string }
    org_deploy_enabled: boolean
    socket_mode_enabled: boolean
    token_rotation_enabled: boolean
    is_mcp_enabled: boolean
  }
}

export interface SlackAppManifestOptions {
  displayName?: string
  relayUrl?: string
  backgroundColor?: string
  redirectUrls?: readonly string[]
  pkceEnabled?: boolean
}

export function slackEventsRequestUrl(relayUrl: string): string {
  return `${normalizeSlackRelayUrl(relayUrl)}/slack/events`
}

export function slackInteractionsRequestUrl(relayUrl: string): string {
  return `${normalizeSlackRelayUrl(relayUrl)}/slack/interactions`
}

function normalizeSlackRelayUrl(relayUrl: string): string {
  return relayUrl.replace(/^ws(s?):\/\//i, 'http$1://').replace(/\/+$/, '')
}

/** One canonical Slack manifest shared by browser, Control Plane, and Setup Server. */
export function buildSlackAppManifest(name: string, options: SlackAppManifestOptions = {}): SlackAppManifest {
  const appName = name.trim() || DEFAULT_SLACK_APP_NAME
  const displayName = options.displayName?.trim() || appName
  const relayUrl = options.relayUrl ? normalizeSlackRelayUrl(options.relayUrl) : undefined
  const http = Boolean(relayUrl)
  const redirectUrls = [...new Set(options.redirectUrls ?? [])]

  return {
    display_information: {
      name: appName,
      ...(options.backgroundColor ? { background_color: options.backgroundColor } : {})
    },
    features: {
      bot_user: { display_name: displayName, always_online: true },
      app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
      agent_view: {
        agent_description: PLATFORM_APP_DESCRIPTION,
        suggested_prompts: []
      },
      shortcuts: [
        {
          name: 'Manage session',
          type: 'message',
          callback_id: SLACK_MANAGE_SESSION_SHORTCUT_CALLBACK_ID,
          description: 'View or update the AgentConnect session for this conversation'
        }
      ]
    },
    oauth_config: {
      scopes: { bot: [...SLACK_BOT_SCOPES] },
      ...(redirectUrls.length > 0 ? { redirect_urls: redirectUrls } : {}),
      ...(options.pkceEnabled !== undefined ? { pkce_enabled: options.pkceEnabled } : {})
    },
    settings: {
      event_subscriptions: {
        bot_events: [...SLACK_BOT_EVENTS],
        ...(relayUrl ? { request_url: slackEventsRequestUrl(relayUrl) } : {})
      },
      interactivity: {
        is_enabled: true,
        ...(relayUrl
          ? {
              request_url: slackInteractionsRequestUrl(relayUrl),
              message_menu_options_url: slackInteractionsRequestUrl(relayUrl)
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
