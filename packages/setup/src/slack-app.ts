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
  if (loginRedirectUrl && new URL(loginRedirectUrl).protocol !== 'https:') {
    throw new Error('Slack sign-in requires an HTTPS Logto endpoint')
  }
  return buildInstallManifest(name, redirectUrl, {
    httpRelayBase: config.services.relay,
    ...(loginRedirectUrl ? { additionalRedirectUrls: [loginRedirectUrl] } : {})
  })
}

export function slackConfiguredUrls(manifest: SlackManifest): SlackConfiguredUrls {
  const oauth = asRecord(manifest.oauth_config)
  const settings = asRecord(manifest.settings)
  const events = asRecord(settings.event_subscriptions)
  const interactivity = asRecord(settings.interactivity)
  const redirects = asStrings(oauth.redirect_urls)
  if (
    (redirects.length !== 1 && redirects.length !== 2) ||
    typeof events.request_url !== 'string' ||
    typeof interactivity.request_url !== 'string'
  ) {
    throw new Error('Slack App manifest is missing managed URLs')
  }
  return {
    oauthRedirectUrl: redirects[0]!,
    eventsUrl: events.request_url,
    interactionsUrl: interactivity.request_url,
    ...(redirects[1] ? { loginRedirectUrl: redirects[1] } : {})
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

/** Returns stable field names only; it never includes provider response values. */
export function auditSlackManifest(actual: SlackManifest, expected: SlackManifest): string[] {
  const missing: string[] = []
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
    if (!asStrings(asRecord(actualScopes).bot).includes(scope)) missing.push(`scope:${scope}`)
  }
  for (const event of asStrings(expectedEvents.bot_events)) {
    if (!asStrings(actualEvents.bot_events).includes(event)) missing.push(`event:${event}`)
  }
  for (const [field, expectedValue] of [
    ['oauth_config.redirect_urls', expectedOauth.redirect_urls],
    ['settings.event_subscriptions.request_url', expectedEvents.request_url],
    ['settings.interactivity.request_url', expectedInteractivity.request_url],
    ['settings.interactivity.message_menu_options_url', expectedInteractivity.message_menu_options_url],
    ['settings.socket_mode_enabled', expectedSettings.socket_mode_enabled]
  ] as const) {
    const actualValue =
      field === 'oauth_config.redirect_urls'
        ? actualOauth.redirect_urls
        : field === 'settings.event_subscriptions.request_url'
          ? actualEvents.request_url
          : field === 'settings.interactivity.request_url'
            ? actualInteractivity.request_url
            : field === 'settings.interactivity.message_menu_options_url'
              ? actualInteractivity.message_menu_options_url
              : actualSettings.socket_mode_enabled
    if (JSON.stringify(actualValue) !== JSON.stringify(expectedValue)) missing.push(field)
  }
  return missing
}
