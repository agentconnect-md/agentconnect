import type { DeploymentConfigRuntime } from '../persistence/deployment-config.js'

/**
 * Environment-shaped runtime projection for the deployment settings stored in
 * Postgres. The Control Plane still has one validated `AppConfig`; this helper
 * simply overlays the persisted desired state before `loadConfig()` parses it.
 *
 * A persisted row owns every key below, including absence. This matters during
 * the migration from env configuration: disabling OIDC or a provider in the
 * deployment document must not silently fall back to stale container env.
 */
const MANAGED_KEYS = [
  'PUBLIC_CP_URL',
  'PUBLIC_RELAY_URL',
  'PUBLIC_WEB_URL',
  'PUBLIC_MCP_URL',
  'CORS_ORIGIN',
  'OIDC_ISSUER',
  'OIDC_AUDIENCE',
  'GITHUB_APP_ID',
  'GITHUB_APP_SLUG',
  'GITHUB_APP_CLIENT_ID',
  'GITHUB_APP_PRIVATE_KEY_B64',
  'SLACK_PLATFORM_APP_ID',
  'SLACK_PLATFORM_CLIENT_ID',
  'SLACK_PLATFORM_CLIENT_SECRET',
  'SLACK_PLATFORM_SIGNING_SECRET',
  'LOGTO_MGMT_ENDPOINT',
  'LOGTO_MGMT_APP_ID',
  'LOGTO_MGMT_APP_SECRET',
  'LOGTO_MGMT_RESOURCE',
  'PRESET_AGENTS_ENABLED',
  'WAITLIST_MODE'
] as const

export function applyDeploymentEnvironment(
  base: NodeJS.ProcessEnv,
  deployment: DeploymentConfigRuntime
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base }
  for (const key of MANAGED_KEYS) delete env[key]

  const { values, secrets } = deployment
  const set = (key: string, value: string | null | undefined): void => {
    if (value !== null && value !== undefined) env[key] = value
  }

  set('PUBLIC_CP_URL', values.publicUrls.controlPlane)
  set('PUBLIC_RELAY_URL', values.publicUrls.relay)
  set('PUBLIC_WEB_URL', values.publicUrls.web)
  set('PUBLIC_MCP_URL', values.publicUrls.mcp)
  // The deployment document has one browser origin in v1. Keep the existing
  // CORS machinery as the consumer rather than introducing a second policy.
  set('CORS_ORIGIN', values.publicUrls.web)

  if (values.auth.mode === 'oidc') {
    set('OIDC_ISSUER', values.auth.issuer)
    set('OIDC_AUDIENCE', values.auth.audience)
  }

  if (values.github) {
    set('GITHUB_APP_ID', String(values.github.appId))
    set('GITHUB_APP_SLUG', values.github.slug)
    set('GITHUB_APP_CLIENT_ID', values.github.clientId)
    set('GITHUB_APP_PRIVATE_KEY_B64', secrets['github.privateKeyB64'])
  }

  if (values.slack) {
    set('SLACK_PLATFORM_APP_ID', values.slack.appId)
    set('SLACK_PLATFORM_CLIENT_ID', values.slack.clientId)
    set('SLACK_PLATFORM_CLIENT_SECRET', secrets['slack.clientSecret'])
    set('SLACK_PLATFORM_SIGNING_SECRET', secrets['slack.signingSecret'])
  }

  if (values.logto) {
    set('LOGTO_MGMT_ENDPOINT', values.logto.managementEndpoint)
    set('LOGTO_MGMT_APP_ID', values.logto.managementAppId)
    set('LOGTO_MGMT_APP_SECRET', secrets['logto.managementAppSecret'])
    set('LOGTO_MGMT_RESOURCE', values.logto.managementResource)
  }

  env.PRESET_AGENTS_ENABLED = String(values.features.presetAgentsEnabled)
  env.WAITLIST_MODE = String(values.features.waitlistMode)
  return env
}
