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

import {
  buildSlackAppManifest,
  DEFAULT_SLACK_APP_NAME,
  PLATFORM_APP_DESCRIPTION,
  SLACK_BOT_EVENTS,
  SLACK_BOT_SCOPES,
  SLACK_MANAGE_SESSION_SHORTCUT_CALLBACK_ID,
  SLACK_SOCKET_ONLY_BOT_EVENTS,
  type SlackAppManifest
} from '@agentconnect.md/protocol/slack-app-manifest'

export {
  DEFAULT_SLACK_APP_NAME,
  PLATFORM_APP_DESCRIPTION,
  SLACK_BOT_EVENTS,
  SLACK_BOT_SCOPES,
  SLACK_MANAGE_SESSION_SHORTCUT_CALLBACK_ID,
  SLACK_SOCKET_ONLY_BOT_EVENTS,
  type SlackAppManifest
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
  return buildSlackAppManifest(names.name, {
    ...(names.displayName ? { displayName: names.displayName } : {}),
    ...(opts?.mode === 'http' && opts.relayUrl ? { relayUrl: opts.relayUrl } : {}),
    ...(opts?.backgroundColor ? { backgroundColor: opts.backgroundColor } : {}),
    pkceEnabled: false
  })
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

/**
 * Deep link to an app's settings home (Basic Information) — for managing the
 * app. Without an app id (a bot installed before the id was recorded) this lands
 * on the app INDEX, which is still the right place to finish the job: that is
 * the delete dialog's long-standing fallback, and the settings row simply never
 * renders the link without an id.
 */
export function slackAppSettingsUrl(appId?: string | null): string {
  return appId ? `https://api.slack.com/apps/${encodeURIComponent(appId)}` : 'https://api.slack.com/apps'
}

/** Deep link to Slack's own "install to a workspace" flow for an app — the remedy
 *  when an authorization granted fewer bot scopes than the app declares, since
 *  reinstalling is what makes Slack apply the full set. Mirrors the `reinstallUrl`
 *  the CP's Slack refresh DTO hands the settings fragment. */
export function slackAppReinstallUrl(appId: string): string {
  return `https://api.slack.com/apps/${encodeURIComponent(appId)}/install-on-team?`
}
