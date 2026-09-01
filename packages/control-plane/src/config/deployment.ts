import type { DeploymentConfigRuntime } from '../persistence/deployment-config.js'

/**
 * Environment-shaped runtime projection for the deployment settings stored in
 * Postgres. The Control Plane still has one validated `AppConfig`; this helper
 * simply overlays persisted provider/auth state before `loadConfig()` parses it.
 *
 * Public service URLs, database/bootstrap/Vault settings, and CORS remain
 * process topology owned by the startup environment. A persisted row owns
 * every key below, including absence, so disabling OIDC or a provider does not
 * silently fall back to stale container env.
 */
const MANAGED_KEYS = [
  'OIDC_AUDIENCE',
  'GITHUB_APP_ID',
  'GITHUB_APP_SLUG',
  'GITHUB_APP_CLIENT_ID',
  'GITHUB_APP_PRIVATE_KEY_B64',
  'GITLAB_CLIENT_ID',
  'GITLAB_CLIENT_SECRET',
  'GITLAB_BASE_URL',
  'SLACK_PLATFORM_APP_ID',
  'SLACK_PLATFORM_CLIENT_ID',
  'SLACK_PLATFORM_CLIENT_SECRET',
  'SLACK_PLATFORM_SIGNING_SECRET',
  'LINEAR_PLATFORM_CLIENT_ID',
  'LINEAR_PLATFORM_CLIENT_SECRET',
  'LINEAR_PLATFORM_SIGNING_SECRET',
  'FEISHU_PLATFORM_APP_ID',
  'FEISHU_PLATFORM_APP_SECRET',
  'LARK_PLATFORM_APP_ID',
  'LARK_PLATFORM_APP_SECRET',
  'LOGTO_MGMT_APP_ID',
  'LOGTO_MGMT_APP_SECRET',
  'LOGTO_MGMT_RESOURCE',
  'PRESET_AGENTS_ENABLED'
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

  if (values.auth.mode === 'oidc') {
    if (!base.OIDC_ISSUER?.trim() && !base.LOGTO_ENDPOINT?.trim()) {
      throw new Error('OIDC_ISSUER or LOGTO_ENDPOINT startup environment is required when deployment auth is oidc')
    }
    set('OIDC_AUDIENCE', values.auth.audience)
  }

  if (values.github) {
    set('GITHUB_APP_ID', String(values.github.appId))
    set('GITHUB_APP_SLUG', values.github.slug)
    set('GITHUB_APP_CLIENT_ID', values.github.clientId)
    set('GITHUB_APP_PRIVATE_KEY_B64', secrets['github.privateKeyB64'])
  }

  if (values.gitlab) {
    set('GITLAB_CLIENT_ID', values.gitlab.clientId)
    set('GITLAB_CLIENT_SECRET', secrets['gitlab.clientSecret'])
    set('GITLAB_BASE_URL', values.gitlab.baseUrl)
  }

  if (values.slack) {
    set('SLACK_PLATFORM_APP_ID', values.slack.appId)
    set('SLACK_PLATFORM_CLIENT_ID', values.slack.clientId)
    set('SLACK_PLATFORM_CLIENT_SECRET', secrets['slack.clientSecret'])
    set('SLACK_PLATFORM_SIGNING_SECRET', secrets['slack.signingSecret'])
  }

  // All three or none: a partial set fails fast in resolveLinearPlatformAppConfig.
  if (values.linear) {
    set('LINEAR_PLATFORM_CLIENT_ID', values.linear.clientId)
    set('LINEAR_PLATFORM_CLIENT_SECRET', secrets['linear.clientSecret'])
    set('LINEAR_PLATFORM_SIGNING_SECRET', secrets['linear.signingSecret'])
  }

  if (values.feishu) {
    set('FEISHU_PLATFORM_APP_ID', values.feishu.loginAppId)
    set('FEISHU_PLATFORM_APP_SECRET', secrets['feishu.loginAppSecret'])
  }
  if (values.lark) {
    set('LARK_PLATFORM_APP_ID', values.lark.loginAppId)
    set('LARK_PLATFORM_APP_SECRET', secrets['lark.loginAppSecret'])
  }

  if (values.logto) {
    set('LOGTO_MGMT_APP_ID', values.logto.managementAppId)
    set('LOGTO_MGMT_APP_SECRET', secrets['logto.managementAppSecret'])
    set('LOGTO_MGMT_RESOURCE', values.logto.managementResource)
  }

  env.PRESET_AGENTS_ENABLED = String(values.features.presetAgentsEnabled)
  return env
}
