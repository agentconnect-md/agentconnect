/**
 * Server-side Slack app manifest for the config-token auto-install funnel
 * (docs/designs/slack-install-smoothing.md §Tier B).
 *
 * In the MANUAL flow the console builds the manifest and deep-links the user to
 * Slack (packages/web/src/components/console/platforms/slack/manifest.ts). In the
 * AUTO flow the CP creates the app itself via `apps.manifest.create`, so it must build the same manifest —
 * PLUS `oauth_config.redirect_urls` pointing at the CP's own OAuth callback. The
 * CP owns that field on purpose: a client-supplied redirect URL would be an
 * open-redirect / token-theft hole.
 *
 * The shared protocol module owns the canonical desired state. This module adds
 * Control Plane URL helpers and merge rules for already-installed Apps.
 */
import {
  buildSlackAppManifest,
  DEFAULT_SLACK_APP_NAME,
  PLATFORM_APP_DESCRIPTION,
  SLACK_BOT_EVENTS,
  SLACK_BOT_SCOPES,
  SLACK_CAPABILITY_BOT_SCOPES,
  SLACK_MANIFEST_BOT_SCOPES,
  slackEventsRequestUrl,
  slackInteractionsRequestUrl
} from '@agentconnect.md/protocol/slack-app-manifest'

export {
  DEFAULT_SLACK_APP_NAME,
  SLACK_BOT_EVENTS,
  SLACK_BOT_SCOPES,
  SLACK_CAPABILITY_BOT_SCOPES,
  SLACK_MANIFEST_BOT_SCOPES,
  slackEventsRequestUrl,
  slackInteractionsRequestUrl
}

/**
 * Whether an installation actually granted every bot scope AgentConnect requires.
 *
 * `unknown` is NOT a short grant. Slack reports the granted scopes only in the
 * `x-oauth-scopes` response header of `auth.test`, and it does not always send
 * one — an absent header means "we could not tell". Callers MUST NOT refuse an
 * install on it: that would break installs for a reason that has nothing to do
 * with permissions. Only a positively-known short grant is actionable.
 */
export type SlackBotScopeGrant = { status: 'unknown' } | { status: 'complete' } | { status: 'short'; missing: string[] }

/**
 * The required bot scopes an installation is missing — the ONE place that diff
 * lives. Both install funnels fence on it (a short grant never becomes a bot),
 * and the Settings refresh reports it as `reinstall_required`; keeping the
 * comparison here is what stops those three from drifting, in particular on the
 * `null`-means-unknown rule above.
 *
 * Slack's initial authorization does not reliably apply every bot permission an
 * app's manifest declares — the app installs cleanly and the shortfall surfaces
 * much later, as a scoped call failing with `missing_scope`.
 */
export function checkSlackBotScopes(granted: readonly string[] | null | undefined): SlackBotScopeGrant {
  if (!granted) return { status: 'unknown' }
  const held = new Set(granted)
  const missing = SLACK_BOT_SCOPES.filter((scope) => !held.has(scope))
  return missing.length > 0 ? { status: 'short', missing } : { status: 'complete' }
}

type ManifestRecord = Record<string, unknown>

function asRecord(value: unknown): ManifestRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as ManifestRecord) : {}
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function unionStrings(current: unknown, required: readonly string[]): string[] {
  return [...new Set([...stringList(current), ...required])]
}

function mergeManagedShortcuts(current: unknown, managed: unknown): unknown[] {
  const required = Array.isArray(managed) ? managed : []
  const callbackIds = new Set(required.map((shortcut) => asRecord(shortcut).callback_id))
  const existing = Array.isArray(current)
    ? current.filter((shortcut) => !callbackIds.has(asRecord(shortcut).callback_id))
    : []
  return [...required, ...existing]
}

/** AgentConnect-owned defaults without an OAuth redirect URL. Existing-app refresh
 *  adds the current CP callback only when one is configured, while create always
 *  supplies it through `buildInstallManifest` below.
 *
 *  `options.httpRelayBase` set ⇒ HTTP-mode (slack-http-mode): `socket_mode_enabled:false`
 *  and the Events API / interactivity `request_url`s point at the relay pool. Absent
 *  ⇒ classic Socket Mode.
 *
 *  `options.backgroundColor` (a `#rrggbb`, from the owning agent's icon) sets the app's
 *  `display_information.background_color` — Slack has no API to set the app's image
 *  itself, so this is the closest we get to "give the app the agent's icon". */
export interface SlackManifestOptions {
  httpRelayBase?: string
  backgroundColor?: string
  additionalRedirectUrls?: readonly string[]
}

function buildManagedManifest(name: string, options: SlackManifestOptions = {}): ManifestRecord {
  return buildSlackAppManifest(name, {
    ...(options.httpRelayBase ? { relayUrl: options.httpRelayBase } : {}),
    ...(options.backgroundColor ? { backgroundColor: options.backgroundColor } : {})
  })
}

/**
 * Build the app manifest object for `apps.manifest.create`. `redirectUrl` is the
 * CP's OAuth callback (`<PUBLIC_CP_URL>/v1/integrations/slack/oauth/callback`)
 * and is declared as the app's sole redirect URL so the ensuing OAuth install
 * lands back on us. `name` falls back to the default when blank.
 * `options.httpRelayBase` set ⇒ HTTP-mode (Events API request_urls + Socket Mode
 * off); absent ⇒ Socket Mode.
 */
export function buildInstallManifest(
  name: string,
  redirectUrl: string,
  options: SlackManifestOptions = {}
): Record<string, unknown> {
  const managed = buildManagedManifest(name, options)
  return {
    ...managed,
    oauth_config: {
      ...asRecord(managed.oauth_config),
      redirect_urls: [...new Set([redirectUrl, ...(options.additionalRedirectUrls ?? [])])]
    }
  }
}

/** Merge AgentConnect's required Slack configuration into an exported manifest.
 *
 * `apps.manifest.update` replaces the ENTIRE manifest, so refresh must preserve
 * user-owned fields (display description, commands, extra scopes/events, redirect
 * URLs, and future fields we do not know about). Required scopes/events and the CP
 * OAuth callback are additive. The Agent view description is AgentConnect-owned
 * public copy and is always reset to the generic safe value. */
export function mergeManagedSlackManifest(
  exported: unknown,
  name: string,
  redirectUrl?: string,
  httpRelayBase?: string
): Record<string, unknown> {
  const http = !!httpRelayBase
  const current = asRecord(exported)
  const managed = buildManagedManifest(name, { ...(httpRelayBase ? { httpRelayBase } : {}) })

  const currentDisplay = asRecord(current.display_information)
  const managedDisplay = asRecord(managed.display_information)

  const currentFeatures = asRecord(current.features)
  const managedFeatures = asRecord(managed.features)
  const currentBotUser = asRecord(currentFeatures.bot_user)
  const managedBotUser = asRecord(managedFeatures.bot_user)
  const currentAppHome = asRecord(currentFeatures.app_home)
  const managedAppHome = asRecord(managedFeatures.app_home)
  const currentAgentView = asRecord(currentFeatures.agent_view)
  const managedAgentView = asRecord(managedFeatures.agent_view)

  const currentOauth = asRecord(current.oauth_config)
  const managedOauth = asRecord(managed.oauth_config)
  const currentScopes = asRecord(currentOauth.scopes)
  const managedScopes = asRecord(managedOauth.scopes)
  const redirectUrls = redirectUrl
    ? unionStrings(currentOauth.redirect_urls, [redirectUrl])
    : stringList(currentOauth.redirect_urls)

  const currentSettings = asRecord(current.settings)
  const managedSettings = asRecord(managed.settings)
  const currentEvents = asRecord(currentSettings.event_subscriptions)
  const managedEvents = asRecord(managedSettings.event_subscriptions)
  const currentInteractivity = asRecord(currentSettings.interactivity)

  return {
    ...current,
    display_information: { ...managedDisplay, ...currentDisplay },
    features: {
      ...currentFeatures,
      bot_user: { ...managedBotUser, ...currentBotUser, always_online: true },
      app_home: {
        ...managedAppHome,
        ...currentAppHome,
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false
      },
      agent_view: {
        ...managedAgentView,
        ...currentAgentView,
        agent_description: PLATFORM_APP_DESCRIPTION
      },
      shortcuts: mergeManagedShortcuts(currentFeatures.shortcuts, managedFeatures.shortcuts)
    },
    oauth_config: {
      ...managedOauth,
      ...currentOauth,
      ...(redirectUrls.length > 0 ? { redirect_urls: redirectUrls } : {}),
      scopes: {
        ...managedScopes,
        ...currentScopes,
        bot: unionStrings(currentScopes.bot, SLACK_BOT_SCOPES)
      }
    },
    settings: {
      ...managedSettings,
      ...currentSettings,
      event_subscriptions: {
        ...managedEvents,
        ...currentEvents,
        bot_events: unionStrings(currentEvents.bot_events, SLACK_BOT_EVENTS),
        // HTTP mode: force the relay pool's Events API request_url (a socket refresh
        // leaves the exported value — there is none — untouched).
        ...(http ? { request_url: slackEventsRequestUrl(httpRelayBase!) } : {})
      },
      interactivity: {
        ...currentInteractivity,
        is_enabled: true,
        ...(http
          ? {
              request_url: slackInteractionsRequestUrl(httpRelayBase!),
              message_menu_options_url: slackInteractionsRequestUrl(httpRelayBase!)
            }
          : {})
      },
      // HTTP bots run over the relay's Events API endpoint, not Socket Mode.
      socket_mode_enabled: !http,
      token_rotation_enabled: false
    }
  }
}

/** The CP's OAuth callback path AS SEEN FROM OUTSIDE, joined to PUBLIC_CP_URL to
 *  form both the manifest redirect URL and the OAuth `redirect_uri` — they MUST be
 *  byte-identical (Slack rejects a mismatch). `/v1` is the public prefix of the
 *  versioned API. A deployment may rewrite it to the internal `/api/v1`, while a
 *  direct-hit CP serves it through the `/v1` alias in `server.ts`. */
export const SLACK_OAUTH_CALLBACK_PATH = '/v1/integrations/slack/oauth/callback'

/** `<publicCpUrl>/v1/integrations/slack/oauth/callback`, trimming a trailing slash. */
export function slackOAuthRedirectUri(publicCpUrl: string): string {
  return `${publicCpUrl.replace(/\/$/, '')}${SLACK_OAUTH_CALLBACK_PATH}`
}

/** The PLATFORM (distributed) app's OAuth callback path (preset-agents.md §5.3),
 *  public `/v1` form for the same rewrite/alias reasons as the sibling above. It
 *  must be registered as a redirect URL on the platform Slack app. */
export const SLACK_PLATFORM_OAUTH_CALLBACK_PATH = '/v1/integrations/slack/platform/callback'

/** `<publicCpUrl>/v1/integrations/slack/platform/callback`, trimming a trailing slash. */
export function slackPlatformOAuthRedirectUri(publicCpUrl: string): string {
  return `${publicCpUrl.replace(/\/$/, '')}${SLACK_PLATFORM_OAUTH_CALLBACK_PATH}`
}
