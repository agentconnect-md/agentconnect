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

/**
 * Every bot scope the app requests, and the exact set an installation must hold.
 *
 * There was briefly a required/capability split here, on the theory that a scope backing one
 * optional tool should not mark an older installation broken. It did not survive contact: the
 * "required" half was not required either — the app receives and answers messages without
 * several of them — so the line was invented rather than observed, and it bought a second
 * constant, an extra API field, extra console branches, and a message that said six permissions
 * were missing without naming them. One list is both simpler and more honest: these are the
 * scopes AgentConnect needs, an install short of any of them is incomplete, and the console
 * says exactly which to add.
 */
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
  'reactions:read',
  'reactions:write',
  'assistant:write',
  'users:read',
  'canvases:read',
  'canvases:write',
  // `conversations.leave` has always needed one of these two; the manifest never asked.
  'channels:manage',
  'groups:write',
  'mpim:write'
  // No `search:read.*` here: the tool that needs them is not on main yet. A scope in this list
  // makes every existing install incomplete, so it may only arrive WITH the capability that
  // uses it — otherwise operators reinstall to grant permissions nothing can call.
] as const

// Both transports advertise the same events: Socket Mode receives them directly, and the relay's
// HTTP ingress forwards the ones this app acts on to the daemon that owns the conversation.
export const SLACK_BOT_EVENTS = [
  // The native stop button on an agent session; without the subscription Slack never shows it.
  'agent_session_stopped',
  // Subscribed but not handled yet, so title sync can land without a second manifest refresh.
  'agent_session_title_changed',
  'app_mention',
  'app_uninstalled',
  'assistant_thread_started',
  // Same: the shipping context signal for an assistant thread, pre-provisioned and inert today.
  'assistant_thread_context_changed',
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
