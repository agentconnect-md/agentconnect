import { buildInstallManifest, slackPlatformOAuthRedirectUri } from '@agentconnect.md/control-plane/slack-manifest'
import type { ProviderAppConfig } from './provider-app.js'

type SlackManifest = Record<string, unknown>
type ProviderAppConfigWithRelay = ProviderAppConfig & {
  services: ProviderAppConfig['services'] & { relay: string; web: string }
}

export interface SlackConfiguredUrls {
  oauthRedirectUrl: string
  eventsUrl: string
  interactionsUrl: string
  loginRedirectUrl?: string
  socialLinkRedirectUrl?: string
}

export interface SlackLoginAppConfig {
  logtoEndpoint: string
  connectorId: string
}

function appendPath(base: string, path: string): string {
  return `${base.replace(/\/$/, '')}/${path.replace(/^\//, '')}`
}

export function requireProviderAppEndpoints(config: ProviderAppConfig): asserts config is ProviderAppConfigWithRelay {
  const entries = [
    ['Web', config.services.web],
    ['Control Plane', config.services.controlPlane],
    ['Relay', config.services.relay]
  ] as const
  for (const [label, value] of entries) {
    if (!value || new URL(value).protocol !== 'https:') {
      throw new Error(`app creation requires a saved HTTPS ${label} public URL`)
    }
  }
}

/** Keep this deployment manifest aligned with the Control Plane's install manifest. */
export function buildSlackDeploymentManifest(
  config: ProviderAppConfig,
  name: string,
  login?: SlackLoginAppConfig
): SlackManifest {
  requireProviderAppEndpoints(config)
  const redirectUrl = slackPlatformOAuthRedirectUri(config.services.controlPlane)
  const loginRedirectUrl = login ? appendPath(login.logtoEndpoint, `/callback/${login.connectorId}`) : undefined
  const socialLinkRedirectUrl = login ? appendPath(config.services.web, '/auth/social/callback') : undefined
  if (loginRedirectUrl && new URL(loginRedirectUrl).protocol !== 'https:') {
    throw new Error('Slack sign-in requires an HTTPS Logto endpoint')
  }
  return buildInstallManifest(name, redirectUrl, {
    httpRelayBase: config.services.relay,
    ...(loginRedirectUrl && socialLinkRedirectUrl
      ? { additionalRedirectUrls: [loginRedirectUrl, socialLinkRedirectUrl] }
      : {})
  })
}

export function slackConfiguredUrls(manifest: SlackManifest): SlackConfiguredUrls {
  const oauth = asRecord(manifest.oauth_config)
  const settings = asRecord(manifest.settings)
  const events = asRecord(settings.event_subscriptions)
  const interactivity = asRecord(settings.interactivity)
  const redirects = asStrings(oauth.redirect_urls)
  if (
    (redirects.length !== 1 && redirects.length !== 3) ||
    typeof events.request_url !== 'string' ||
    typeof interactivity.request_url !== 'string'
  ) {
    throw new Error('Slack App manifest is missing managed URLs')
  }
  return {
    oauthRedirectUrl: redirects[0]!,
    eventsUrl: events.request_url,
    interactionsUrl: interactivity.request_url,
    ...(redirects[1] ? { loginRedirectUrl: redirects[1] } : {}),
    ...(redirects[2] ? { socialLinkRedirectUrl: redirects[2] } : {})
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function sameStrings(left: unknown, right: unknown): boolean {
  return JSON.stringify([...asStrings(left)].sort()) === JSON.stringify([...asStrings(right)].sort())
}

export interface SlackManifestDiff {
  id: string
  field: string
  current: unknown
  expected: unknown
}

/** Returns only public App settings; secrets never appear in this diff. */
export function diffSlackManifest(actual: SlackManifest, expected: SlackManifest): SlackManifestDiff[] {
  const diff: SlackManifestDiff[] = []
  const actualOauth = asRecord(actual.oauth_config)
  const expectedOauth = asRecord(expected.oauth_config)
  const actualScopes = asRecord(actualOauth.scopes)
  const expectedScopes = asRecord(expectedOauth.scopes)
  const actualSettings = asRecord(actual.settings)
  const expectedSettings = asRecord(expected.settings)
  const actualEvents = asRecord(actualSettings.event_subscriptions)
  const expectedEvents = asRecord(expectedSettings.event_subscriptions)
  const actualInteractivity = asRecord(actualSettings.interactivity)
  const expectedInteractivity = asRecord(expectedSettings.interactivity)

  for (const scope of asStrings(asRecord(expectedScopes).bot)) {
    if (!asStrings(asRecord(actualScopes).bot).includes(scope)) {
      diff.push({ id: `scope:${scope}`, field: `Bot scope: ${scope}`, current: 'Missing', expected: 'Required' })
    }
  }
  for (const event of asStrings(expectedEvents.bot_events)) {
    if (!asStrings(actualEvents.bot_events).includes(event)) {
      diff.push({ id: `event:${event}`, field: `Bot event: ${event}`, current: 'Missing', expected: 'Required' })
    }
  }
  for (const [id, field, expectedValue] of [
    ['oauth_config.redirect_urls', 'OAuth redirect URLs', expectedOauth.redirect_urls],
    ['settings.event_subscriptions.request_url', 'Events request URL', expectedEvents.request_url],
    ['settings.interactivity.request_url', 'Interactivity request URL', expectedInteractivity.request_url],
    [
      'settings.interactivity.message_menu_options_url',
      'Message menu options URL',
      expectedInteractivity.message_menu_options_url
    ],
    ['settings.socket_mode_enabled', 'Socket Mode enabled', expectedSettings.socket_mode_enabled]
  ] as const) {
    const actualValue =
      id === 'oauth_config.redirect_urls'
        ? actualOauth.redirect_urls
        : id === 'settings.event_subscriptions.request_url'
          ? actualEvents.request_url
          : id === 'settings.interactivity.request_url'
            ? actualInteractivity.request_url
            : id === 'settings.interactivity.message_menu_options_url'
              ? actualInteractivity.message_menu_options_url
              : actualSettings.socket_mode_enabled
    const matches =
      id === 'oauth_config.redirect_urls'
        ? sameStrings(actualValue, expectedValue)
        : JSON.stringify(actualValue) === JSON.stringify(expectedValue)
    if (!matches) diff.push({ id, field, current: actualValue ?? null, expected: expectedValue ?? null })
  }
  return diff
}

/** Returns stable field names only; it never includes provider response values. */
export function auditSlackManifest(actual: SlackManifest, expected: SlackManifest): string[] {
  return diffSlackManifest(actual, expected).map((item) => item.id)
}
