import type { SetupConfig } from './config.js'

export const SLACK_CONFIG_TOKEN_ENV = 'SLACK_CONFIG_TOKEN'

export const SLACK_DEPLOYMENT_ENV_KEYS = [
  'SLACK_PLATFORM_APP_ID',
  'SLACK_PLATFORM_CLIENT_ID',
  'SLACK_PLATFORM_CLIENT_SECRET',
  'SLACK_PLATFORM_SIGNING_SECRET'
] as const

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

type SlackManifest = Record<string, unknown>
type ExternalSetupWithRelay = Extract<SetupConfig, { mode: 'external' }> & {
  services: Extract<SetupConfig, { mode: 'external' }>['services'] & { relay: string; web: string }
}
export interface ProviderAppConfig {
  services: {
    web?: string
    controlPlane: string
    relay?: string
  }
}
type ProviderAppConfigWithRelay = ProviderAppConfig & {
  services: ProviderAppConfig['services'] & { relay: string; web: string }
}

export interface SlackAppCredentials {
  appId: string
  clientId: string
  clientSecret: string
  signingSecret: string
}

export interface SlackAppCreateOptions {
  fetch?: typeof fetch
  timeoutMs?: number
}

function appendPath(base: string, path: string): string {
  return `${base.replace(/\/$/, '')}/${path.replace(/^\//, '')}`
}

export function requireExternalRelay(config: SetupConfig): asserts config is ExternalSetupWithRelay {
  if (config.mode !== 'external' || !config.services.relay || !config.services.web) {
    throw new Error('legacy env-file App creation requires external mode with HTTPS --web-url and --relay-url')
  }
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
export function buildSlackDeploymentManifest(config: ProviderAppConfig, name: string): SlackManifest {
  requireProviderAppEndpoints(config)
  const displayName = name.trim() || 'AgentConnect'
  const redirectUrl = appendPath(config.services.controlPlane, '/v1/integrations/slack/platform/callback')
  const eventsUrl = appendPath(config.services.relay, '/slack/events')
  const interactionsUrl = appendPath(config.services.relay, '/slack/interactions')

  return {
    display_information: { name: displayName },
    features: {
      bot_user: { display_name: displayName, always_online: true },
      app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
      agent_view: {
        agent_description: 'AI agent powered by AgentConnect.',
        suggested_prompts: []
      },
      shortcuts: [
        {
          name: 'Manage session',
          type: 'message',
          callback_id: 'ac_manage_session',
          description: 'View or update the AgentConnect session for this conversation'
        }
      ]
    },
    oauth_config: {
      scopes: { bot: [...SLACK_BOT_SCOPES] },
      redirect_urls: [redirectUrl]
    },
    settings: {
      event_subscriptions: { bot_events: [...SLACK_BOT_EVENTS], request_url: eventsUrl },
      interactivity: {
        is_enabled: true,
        request_url: interactionsUrl,
        message_menu_options_url: interactionsUrl
      },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
      is_mcp_enabled: false
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function slackError(body: unknown): string {
  const candidate = asRecord(body).error
  return typeof candidate === 'string' && /^[a-z0-9_]+$/i.test(candidate) ? candidate : 'unknown_error'
}

async function postSlack(
  method: 'apps.manifest.create' | 'apps.manifest.export',
  form: Record<string, string>,
  options: SlackAppCreateOptions
): Promise<Record<string, unknown>> {
  const fetcher = options.fetch ?? fetch
  let response: Response
  try {
    response = await fetcher(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form),
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000)
    })
  } catch {
    throw new Error(`Slack ${method} is unreachable`)
  }

  if (!response.ok) throw new Error(`Slack ${method} returned HTTP ${response.status}`)
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new Error(`Slack ${method} returned an invalid response`)
  }
  const record = asRecord(body)
  if (record.ok !== true) throw new Error(`Slack ${method} failed: ${slackError(body)}`)
  return record
}

export async function createSlackApp(
  configToken: string,
  manifest: SlackManifest,
  options: SlackAppCreateOptions = {}
): Promise<SlackAppCredentials> {
  const body = await postSlack(
    'apps.manifest.create',
    { token: configToken, manifest: JSON.stringify(manifest) },
    options
  )
  const credentials = asRecord(body.credentials)
  if (
    typeof body.app_id !== 'string' ||
    typeof credentials.client_id !== 'string' ||
    typeof credentials.client_secret !== 'string' ||
    typeof credentials.signing_secret !== 'string'
  ) {
    throw new Error('Slack apps.manifest.create returned incomplete credentials')
  }
  return {
    appId: body.app_id,
    clientId: credentials.client_id,
    clientSecret: credentials.client_secret,
    signingSecret: credentials.signing_secret
  }
}

export async function exportSlackManifest(
  configToken: string,
  appId: string,
  options: SlackAppCreateOptions = {}
): Promise<SlackManifest> {
  const body = await postSlack('apps.manifest.export', { token: configToken, app_id: appId }, options)
  const manifest = asRecord(body.manifest)
  if (Object.keys(manifest).length === 0) throw new Error('Slack apps.manifest.export returned an invalid manifest')
  return manifest
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
